import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BAILIAN_CODING_PLAN_MODELS, createLlmClient } from "./providers.js";

async function withPlanEnv(fn: () => Promise<void>) {
  const values = {
    BAILIAN_CODING_PLAN_API_KEY: "test-plan-secret",
    BAILIAN_CODING_PLAN_BASE_URL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    BAILIAN_API_KEY: "test-payg-secret",
    BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Bailian routes exactly the six authorized models to the plan credential", async (t) => {
  await withPlanEnv(async () => {
    assert.deepEqual([...BAILIAN_CODING_PLAN_MODELS], [
      "qwen3.8-max", "qwen3.8-flash", "qwen-image-3.0-pro",
      "qwen3.7-plus", "qwen3.7-max", "qwen3.6-flash",
    ]);
    const calls: { url: string; auth: string | null; model: string }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization"), model: JSON.parse(String(init?.body)).model });
      return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { status: 200 });
    });
    for (const model of BAILIAN_CODING_PLAN_MODELS) {
      const client = createLlmClient("bailian", model);
      await client.complete({ prompt: "test" });
      assert.equal(calls.at(-1)?.auth, "Bearer test-plan-secret");
      assert.equal(calls.at(-1)?.url, process.env.BAILIAN_CODING_PLAN_BASE_URL + "/chat/completions");
      assert.equal(calls.at(-1)?.model, model);
      assert.equal(client.traceMetadata?.credential_resource, "bailian-coding-plan-team");
      assert.equal((client.traceMetadata?.pricing as { known: boolean }).known, false);
      assert.doesNotMatch(JSON.stringify(client.traceMetadata), /test-plan-secret|test-payg-secret/);
    }
    for (const model of ["qwen3.8-27b", "qwen3.8-flash-snapshot", "glm-5.3", "deepseek-v4-pro"]) {
      await createLlmClient("bailian", model).complete({ prompt: "test" });
      assert.equal(calls.at(-1)?.auth, "Bearer test-payg-secret");
      assert.equal(calls.at(-1)?.url, process.env.BAILIAN_BASE_URL + "/chat/completions");
    }
  });
});

test("Bailian cannot bypass credential selection with a request model override", async (t) => {
  await withPlanEnv(async () => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network call"); });
    for (const [configured, override] of [
      ["qwen3.8-flash", "glm-5.3"],
      ["qwen3.8-flash", "qwen3.6-flash"],
      ["qwen3.8-27b", "qwen3.8-flash"],
    ]) {
      await assert.rejects(createLlmClient("bailian", configured).complete({ prompt: "test", model: override }), /credential scope/);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

test("Bailian plan fails closed for a missing key or an unrelated endpoint", async () => {
  await withPlanEnv(async () => {
    process.env.BAILIAN_CODING_PLAN_API_KEY = "";
    assert.throws(() => createLlmClient("bailian", "qwen3.8-flash"), /BAILIAN_CODING_PLAN_API_KEY/);
    process.env.BAILIAN_CODING_PLAN_API_KEY = "test-plan-secret";
    process.env.BAILIAN_CODING_PLAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    assert.throws(() => createLlmClient("bailian", "qwen3.8-flash"), /official Token Plan endpoint/);
  });
});

test("Bailian Qwen3.8 27B records the Beijing CNY price card without inventing USD", () => {
  const previousKey = process.env.BAILIAN_API_KEY;
  const previousBaseUrl = process.env.BAILIAN_BASE_URL;
  process.env.BAILIAN_API_KEY = "test-only";
  delete process.env.BAILIAN_BASE_URL;
  try {
    const qwen = createLlmClient("bailian", "qwen3.8-27b");
    assert.deepEqual(qwen.traceMetadata?.pricing, {
      known: true,
      currency: "CNY",
      usd_cost_known: false,
      input_per_million_tokens: 3,
      cached_input_per_million_tokens: 0.6,
      output_per_million_tokens: 12,
    });

    const unknown = createLlmClient("bailian", "future-unpriced-model");
    assert.equal(
      (unknown.traceMetadata?.pricing as { known?: boolean } | undefined)?.known,
      false,
    );
  } finally {
    if (previousKey === undefined) delete process.env.BAILIAN_API_KEY;
    else process.env.BAILIAN_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.BAILIAN_BASE_URL;
    else process.env.BAILIAN_BASE_URL = previousBaseUrl;
  }
});

test("the GLM Coding Plan endpoint is recorded as a subscription without per-token prices", () => {
  const saved = { base: process.env.GLM_BASE_URL, key: process.env.GLM_API_KEY };
  process.env.GLM_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
  process.env.GLM_API_KEY = "fixture";
  try {
    const plan = createLlmClient("glm", "glm-5.3-flash");
    assert.equal(plan.id, "glm:glm-5.3-flash");
    assert.equal((plan.traceMetadata?.pricing as { known: boolean }).known, false);
    process.env.GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
    const payg = createLlmClient("glm", "glm-4.7");
    assert.equal((payg.traceMetadata?.pricing as { known: boolean; input_per_million_tokens: number }).known, true);
    assert.equal((payg.traceMetadata?.pricing as { input_per_million_tokens: number }).input_per_million_tokens, 0.6);
  } finally {
    for (const [k, v] of [["GLM_BASE_URL", saved.base], ["GLM_API_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("GLM reads GLM_API_KEY first and a former name from envAliases only when it is unset", async (t) => {
  const names = ["GLM_BASE_URL", "GLM_API_KEY", "FORMER_GLM_API_KEY", "FABENCH_PATHS_CONFIG", "FABENCH_TEAM_ENV_FILE"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const dir = mkdtempSync(join(tmpdir(), "fabench-glm-alias-"));
  const auth: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("Authorization"));
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { status: 200 });
  });
  try {
    writeFileSync(join(dir, "paths.json"), JSON.stringify({ envAliases: { GLM_API_KEY: ["FORMER_GLM_API_KEY"] } }));
    process.env.FABENCH_PATHS_CONFIG = join(dir, "paths.json");
    // An empty team env file keeps a machine's real keys out of the lookup.
    writeFileSync(join(dir, "team.env"), "");
    process.env.FABENCH_TEAM_ENV_FILE = join(dir, "team.env");
    process.env.GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
    process.env.GLM_API_KEY = "current-name";
    process.env.FORMER_GLM_API_KEY = "former-name";
    await createLlmClient("glm", "glm-4.7").complete({ prompt: "test" });
    delete process.env.GLM_API_KEY;
    await createLlmClient("glm", "glm-4.7").complete({ prompt: "test" });
    // Compare labels, so a failure never prints a real key.
    const label = (value: string | null) =>
      value === "Bearer current-name" ? "current" : value === "Bearer former-name" ? "former" : "other";
    assert.deepEqual(auth.map(label), ["current", "former"]);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
