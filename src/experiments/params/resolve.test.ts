import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PKG_ROOT } from "../../paths.js";
import { formalArguments } from "../environment-check.js";
import { readForecastOptions } from "../forecast/options.js";
import { loadForecastQuestions } from "../forecast/questions.js";
import { dataRoot } from "../../path-config.js";
import { needsFormalSet, SYNTHETIC_GRADING, SYNTHETIC_QUESTIONS } from "../../datasets/test-fixtures.js";
import { applyEnvironmentDefaults, defaultPreset, expandDataRoot, formatValue, listPresets, parseValue, resolveRunParameters } from "./resolve.js";
import { CATEGORIES, PARAMETERS_BY_KEY, RUN_PARAMETERS } from "./schema.js";

const custom = ["--preset", "custom", "--questions-file", SYNTHETIC_QUESTIONS, "--grading-file", SYNTHETIC_GRADING];
const offline = { env: {}, sharedFrozenCacheAvailable: false };
const resolve = (args: string[], env: NodeJS.ProcessEnv = {}) => resolveRunParameters(args, { ...offline, env });

function withFiles(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "run-parameters-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name: string, body: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(body));
    return file;
  };
}

test("the schema is one consistent list: unique keys, flags derived from keys, valid defaults, no secrets", () => {
  const keys = RUN_PARAMETERS.map((p) => p.key), envs = RUN_PARAMETERS.flatMap((p) => (p.env ? [p.env] : []));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(envs).size, envs.length);
  for (const spec of RUN_PARAMETERS) {
    assert.ok(spec.flag || spec.env, `${spec.key} has neither flag nor environment variable`);
    // `compare` keeps its key so recorded conditions keep their ids; its flag is --settings.
    if (spec.flag) assert.equal(spec.flag, spec.key === "compare" ? "settings" : spec.key.replaceAll("_", "-"));
    assert.ok(spec.meaning.trim(), `${spec.key} needs a meaning`);
    if (spec.default !== null && !spec.meta)
      assert.equal(parseValue(spec, formatValue(spec.default)), spec.default, `${spec.key} default`);
    assert.doesNotMatch(spec.env ?? "", /(KEY|SECRET|TOKEN|WEBHOOK|PASSWORD)$/, `${spec.key} must not be a credential`);
  }
  for (const category of Object.keys(CATEGORIES))
    assert.ok(RUN_PARAMETERS.some((p) => p.category === category), category);
  // The team checkout adds formal-232, its default; the public tree defaults to july-2026-formal.
  assert.deepEqual(listPresets().filter((name) => name !== "formal-232"), ["custom", "july-2026-formal", "july-2026-paper"]);
  assert.ok(listPresets().includes(defaultPreset()), "the default preset exists");
});

test("the paper preset runs all 287 questions with exactly the July protocol", () => {
  const read = (name: string) => JSON.parse(readFileSync(join(PKG_ROOT, "config", "presets", `${name}.json`), "utf8"));
  const july = read("july-2026-formal");
  const paper = read("july-2026-paper");
  assert.equal(paper.design.n, 287);
  assert.match(paper.design.questions_file, /july-2026-paper-287\/raven-july-all-model-test\.jsonl$/);
  assert.match(paper.design.grading_file, /july-2026-paper-287\/raven-july-all-grading-key\.jsonl$/);
  const protocol = (preset: Record<string, unknown>) => {
    const { name, description, design, ...rest } = preset;
    const { n, questions_file, grading_file, ...values } = design as Record<string, unknown>;
    return { ...rest, design: values };
  };
  assert.deepEqual(protocol(paper), protocol(july));
});

test("--compare is the former spelling of --settings and resolves the same run", () => {
  const settings = resolve([...custom, "--llm", "x:y", "--settings", "none,frozen"]);
  const former = resolve([...custom, "--llm", "x:y", "--compare", "none,frozen"]);
  assert.deepEqual(former.args, settings.args);
  assert.equal(former.value("compare"), "none,frozen");
  assert.ok(settings.args.includes("--settings") && !settings.args.includes("--compare"));
  assert.throws(() => resolve([...custom, "--llm", "x:y", "--settings", "none", "--compare", "frozen"]),
    /--settings sets the same parameter|--compare sets the same parameter/);
});

test("layers merge key by key in order and record where every value came from", (t) => {
  const file = withFiles(t);
  const a = file("a.json", { schema: "raven.run-config.v1", efficiency: { review_concurrency: 5, candidate_concurrency: 3 } });
  const b = file("b.json", { schema: "raven.run-config.v1", efficiency: { review_concurrency: 7 } });
  const resolved = resolve([...custom, "--config", a, "--config", b, "--frozen-queue=99", "--llm", "x:y", "--settings", "none"],
    { FETCH_CONCURRENCY: "40" });
  const source = (key: string) => resolved.entries.get(key)!.source;
  assert.equal(resolved.value("review_concurrency"), 7);
  assert.equal(source("review_concurrency"), `config:${b}`);
  assert.equal(resolved.value("candidate_concurrency"), 3);
  assert.equal(source("candidate_concurrency"), `config:${a}`);
  assert.equal(resolved.value("frozen_queue"), 99);
  assert.equal(source("frozen_queue"), "cli");
  assert.equal(source("questions_file"), "cli");
  assert.equal(source("max_tool_calls"), "default");
  assert.equal(resolved.value("fetch_concurrency"), 40);
  assert.equal(source("fetch_concurrency"), "env:FETCH_CONCURRENCY");
  assert.equal(resolved.args.includes("--fetch-concurrency"), false, "the environment keeps its own values");
  assert.deepEqual(resolved.layers, ["default", "env", "preset:custom", `config:${a}`, `config:${b}`, "cli"]);
  const summary = resolved.summary();
  assert.deepEqual(summary.values.efficiency.review_concurrency, { value: 7, source: `config:${b}` });
  assert.equal(summary.values.design.review_effort!.applies, false);
});

test("--flag=value equals --flag value; unknown, removed, duplicate and valueless flags fail", () => {
  const base = [...custom, "--llm", "x:y", "--settings", "none"];
  assert.deepEqual(resolve([...base, "--n=7", "--ids=A,B"]).args, resolve([...base, "--n", "7", "--ids", "A,B"]).args);
  assert.throws(() => resolve([...base, "--review-efort", "low"]), /Unknown experiment argument --review-efort; did you mean review-effort/);
  assert.throws(() => resolve([...base, "--arms", "none"]), /--arms was removed/);
  assert.throws(() => resolve([...base, "--max-searches", "20"]), /use --max-tool-calls/);
  assert.throws(() => resolve([...base, "--n", "5", "--n=6"]), /Duplicate argument --n/);
  assert.throws(() => resolve(["--profile", "custom", "--preset", "custom"]), /Duplicate argument --preset \(--profile sets the same parameter\)/);
  assert.throws(() => resolve([...base, "--conc"]), /--conc requires a value/);
  assert.throws(() => resolve([...base, "stray"]), /Expected named experiment arguments/);
});

test("booleans read 1/0/true/false the same everywhere and are passed on as 1 or 0", () => {
  const base = [...custom, "--llm", "x:y", "--settings", "none"];
  for (const [text, value] of [["1", "1"], ["true", "1"], ["0", "0"], ["false", "0"]] as const) {
    const selected = resolve([...base, "--reader", text, "--ledger", text]).selected;
    assert.equal(selected.reader, value);
    assert.equal(selected.ledger, value);
  }
  for (const bad of ["yes", "on", "TRUE", "2", ""])
    assert.throws(() => resolve([...base, "--reader", bad]), /--reader must be 0 or 1/);
  // Before, the direct runner read `--reader true` as off.
  assert.equal(readForecastOptions([...base, "--reader", "true"], offline).readerEnabled, true);
});

test("environment variables a run reads are validated; malformed unused ones only warn", () => {
  const none = [...custom, "--llm", "x:y", "--settings", "none"];
  const web = [...custom, "--llm", "x:y", "--settings", "web-filter"];
  // Read by every run (the page dater and cost accounting are always built).
  assert.throws(() => resolve(none, { FABENCH_PEAK_MULTIPLIER: "abc" }), /FABENCH_PEAK_MULTIPLIER must be a non-negative number/);
  assert.throws(() => resolve(none, { READER_TIMEOUT_S: "-1" }), /READER_TIMEOUT_S must be a positive number/);
  assert.throws(() => resolve(none, { FETCH_CONCURRENCY: "NaN" }), /FETCH_CONCURRENCY must be a positive safe integer/);
  assert.throws(() => resolve(none, { FABENCH_SHARED_LIFECYCLE: "true" }), /FABENCH_SHARED_LIFECYCLE must be 0 or 1/);
  assert.throws(() => resolve(none, { FABENCH_PROGRESS_TIME_ZONE: "Mars/Olympus" }), /IANA time zone/);
  // Read only by the arms or providers that use them.
  assert.throws(() => resolve(web, { SEARCH_CONCURRENCY: "NaN" }), /SEARCH_CONCURRENCY must be a positive safe integer/);
  assert.throws(() => resolve(web, { DIRECT_TIMEOUT_S: "soon" }), /DIRECT_TIMEOUT_S must be a number Python float\(\) reads/);
  assert.throws(() => resolve([...custom, "--llm", "glm:glm-5.3", "--settings", "none"], { GLM_BASE_URL: "open.bigmodel.cn" }),
    /GLM_BASE_URL must be an http\(s\) URL/);
  assert.throws(() => resolve([...custom, "--llm", "x:y", "--settings", "backsearch"], { BACKSEARCH_COVERAGE_START: "soon" }),
    /BACKSEARCH_COVERAGE_START must be an ISO date/);
  const unused = resolve(none, { SEARCH_CONCURRENCY: "NaN", GLM_BASE_URL: "open.bigmodel.cn", CUSTOM_BASE_URL: "nowhere",
    BACKSEARCH_BASE: "nowhere", BACKSEARCH_COVERAGE_START: "soon", LEAK_REVIEW_CHARS: "lots", DIRECT_TIMEOUT_S: "soon" });
  for (const name of ["SEARCH_CONCURRENCY", "GLM_BASE_URL", "CUSTOM_BASE_URL", "BACKSEARCH_BASE", "BACKSEARCH_COVERAGE_START",
    "LEAK_REVIEW_CHARS", "DIRECT_TIMEOUT_S"])
    assert.match(unused.warnings.join("\n"), new RegExp(`${name}.*this run does not read it`), name);
  assert.equal(unused.value("glm_base_url"), "https://open.bigmodel.cn/api/coding/paas/v4", "the malformed value is not used");
  assert.equal(unused.summary().warnings.length, unused.warnings.length);
  // A malformed value a preset or flag replaces is reported, not fatal.
  const shadowed = resolve([...web, "--search-concurrency", "8"], { SEARCH_CONCURRENCY: "NaN" });
  assert.equal(shadowed.value("search_concurrency"), 8);
  assert.match(shadowed.warnings.join("\n"), /SEARCH_CONCURRENCY.*replaced by cli/);
  assert.equal(resolve(none, { FABENCH_PEAK_MULTIPLIER: "0", LEAK_REVIEW_CHARS: "" }).value("peak_multiplier"), 0);
  // A former RAVEN_* name is read when the FABENCH_* name is unset, and the record names it.
  const former = resolve(none, { RAVEN_PEAK_MULTIPLIER: "2" });
  assert.equal(former.value("peak_multiplier"), 2);
  assert.equal(former.entries.get("peak_multiplier")!.source, "env:RAVEN_PEAK_MULTIPLIER");
  assert.equal(resolve(none, { FABENCH_PEAK_MULTIPLIER: "3", RAVEN_PEAK_MULTIPLIER: "2" }).value("peak_multiplier"), 3);
  assert.throws(() => resolve(none, { RAVEN_PEAK_MULTIPLIER: "abc" }), /RAVEN_PEAK_MULTIPLIER must be a non-negative number/);
});

test("Python-side variables accept every value the helper's float() and int() accept", () => {
  const web = [...custom, "--llm", "x:y", "--settings", "web-filter"];
  const env = { PAGE_DATER_CPU_STAGE_LIMIT_S: "inf", BOUNDED_HTTP_MAX_WORKERS: "0", BOUNDED_HTTP_IDLE_S: "0", DIRECT_TIMEOUT_S: "1_000" };
  const resolved = resolve(web, env);
  assert.deepEqual(resolved.warnings, []);
  assert.equal(resolved.value("page_dater_cpu_stage_limit_s"), "inf", "kept as written for Python");
  assert.equal(resolved.value("bounded_http_max_workers"), "0");
  for (const text of ["nan", "-inf", "1e3", ".5", "5.", "-2", " 7 "]) resolve(web, { BOUNDED_HTTP_IDLE_S: text });
  for (const text of ["-5", "+3", "1_000"]) resolve(web, { BOUNDED_HTTP_MAX_WORKERS: text });
  for (const [name, text] of [["BOUNDED_HTTP_IDLE_S", "1__0"], ["BOUNDED_HTTP_IDLE_S", "0x10"], ["BOUNDED_HTTP_MAX_WORKERS", "1.5"]])
    assert.throws(() => resolve(web, { [name!]: text! }), new RegExp(name!));
});

test("search uses serper unless auto is asked for explicitly", () => {
  const web = [...custom, "--llm", "x:y", "--settings", "web-filter"];
  const resolved = resolve(web, { ANTHROPIC_API_KEY: "not-read" });
  assert.equal(resolved.selected["search-provider"], "serper");
  assert.deepEqual(resolved.warnings, []);
  const auto = resolve([...web, "--search-provider", "auto"]);
  assert.equal(auto.selected["search-provider"], "auto");
  assert.match(auto.warnings.join("\n"), /auto/);
  assert.throws(() => resolve([...web, "--search-provider", "bing"]), /must be serper, brave, anthropic, zhipu or auto/);
});

test("the GLM endpoint default is the shared launcher's, on every path", () => {
  const launcherDefault = PARAMETERS_BY_KEY.get("glm_base_url")!.default;
  // A source tree without the shared launcher (the public export) checks the other paths only.
  const launcher = join(PKG_ROOT, "tools/shared-environment.sh");
  if (existsSync(launcher)) assert.equal(/GLM_BASE_URL:=([^}]+)\}/.exec(readFileSync(launcher, "utf8"))![1], launcherDefault);
  const env: NodeJS.ProcessEnv = {};
  applyEnvironmentDefaults(resolve([...custom, "--llm", "glm:glm-5.3", "--settings", "none"]), env);
  assert.equal(env.GLM_BASE_URL, launcherDefault);
  const configured: NodeJS.ProcessEnv = { GLM_BASE_URL: "https://example.test/v4" };
  applyEnvironmentDefaults(resolve([...custom, "--llm", "glm:glm-5.3", "--settings", "none"], configured), configured);
  assert.equal(configured.GLM_BASE_URL, "https://example.test/v4");
});

test("--ids=a,b selects questions in a direct run regardless of the process argv", (t) => {
  const argv = process.argv;
  t.after(() => { process.argv = argv; });
  process.argv = [argv[0]!, "forecast-value.ts"];
  const options = readForecastOptions([...custom, "--llm", "x:y", "--settings", "none", "--ids=SYN-01,SYN-03"], offline);
  assert.deepEqual(options.idSelection, ["SYN-01", "SYN-03"]);
  t.mock.method(console, "log", () => {});
  assert.deepEqual(loadForecastQuestions(options, { offline: true }).questions.map((q) => q.question_id).sort(), ["SYN-01", "SYN-03"]);
});

test("presets fix their protocol values, drop settings the chosen arms do not use, and accept null overrides", async (t) => {
  const file = withFiles(t);
  await t.test("the default formal-232 preset", { skip: needsFormalSet }, () => {
    assert.throws(() => resolve(["--llm", "x:y", "--settings", "none", "--n", "20"]), /Preset formal-232 requires --n 232/);
    assert.throws(() => resolve(["--llm", "x:y", "--settings", "frozen+expand"]), /allows only none, frozen, web-filter or both/);
    assert.throws(() => resolve(["--preset", "nonexistent"]), /Unknown preset "nonexistent"; available: custom, formal-232, july-2026-formal/);
  });
  assert.throws(() => resolve(["--preset", "nonexistent"]), /Unknown preset "nonexistent"; available: custom, /);
  const july = ["--preset", "july-2026-formal", "--llm", "x:y"];
  assert.throws(() => resolve([...july, "--settings", "web-filter", "--search-delivery", "fulltext"]), /requires --search-delivery summary/);
  const locked = file("locked.json", { schema: "raven.run-config.v1", design: { review_effort: "high" } });
  assert.throws(() => resolve([...july, "--settings", "web-filter", "--config", locked]), /requires --review-effort low/);
  const none = resolve([...july, "--settings", "none"]);
  for (const flag of ["review-effort", "review-thinking", "wiki-manifest", "shared-frozen-cache", "frozen-corpus-file", "shared-review-cache"])
    assert.equal(none.selected[flag], undefined, flag);
  assert.equal(none.summary().values.design.review_effort!.applies, false);
  assert.equal(none.selected["search-delivery"], "summary");
  const frozen = resolve([...july, "--settings", "frozen"]);
  assert.equal(frozen.selected["wiki-manifest"], `${dataRoot()}/index/wiki/manifests/wiki-2026-07-01T00-00-00.000Z.json`);
  assert.equal(frozen.selected["frozen-queue"], "1280");
  assert.equal(frozen.selected["review-effort"], undefined);
  const newsOnly = file("news-only.json", { schema: "raven.run-config.v1", design: { wiki_manifest: null } });
  assert.equal(resolve([...july, "--settings", "frozen", "--config", newsOnly]).selected["wiki-manifest"], undefined);
});

test("preset and override paths may start with ${FABENCH_DATA_ROOT}, the configured data root", (t) => {
  const file = withFiles(t);
  assert.equal(expandDataRoot("${FABENCH_DATA_ROOT}/index/a.db", { FABENCH_DATA_ROOT: "/srv/data" }), "/srv/data/index/a.db");
  assert.equal(expandDataRoot("${FABENCH_DATA_ROOT}", { FABENCH_DATA_ROOT: "/srv/data" }), "/srv/data");
  for (const untouched of ["relative/${FABENCH_DATA_ROOT}/a", "${FABENCH_DATA_ROOTS}/a", "/abs/a", "${HOME}/a"])
    assert.equal(expandDataRoot(untouched, { FABENCH_DATA_ROOT: "/srv/data" }), untouched);
  // The former placeholder and variable name keep working in existing override files.
  assert.equal(expandDataRoot("${RAVEN_DATA_ROOT}/index/a.db", { RAVEN_DATA_ROOT: "/srv/old" }), "/srv/old/index/a.db");
  assert.equal(expandDataRoot("${FABENCH_DATA_ROOT}/a", { FABENCH_DATA_ROOT: "/srv/new", RAVEN_DATA_ROOT: "/srv/old" }), "/srv/new/a");
  const override = file("data-root.json", { schema: "raven.run-config.v1", design: { frozen_corpus_file: "${FABENCH_DATA_ROOT}/index/x.db" } });
  const frozen = resolve(["--preset", "july-2026-formal", "--llm", "x:y", "--settings", "frozen", "--config", override]);
  assert.equal(frozen.selected["frozen-corpus-file"], `${dataRoot()}/index/x.db`);
  assert.equal(frozen.selected["shared-frozen-cache"], `${dataRoot()}/cache/frozen-query/cache.sqlite`);
});

test("null in an override file resets a key as if no layer had set it, so derived values recompute", async (t) => {
  const file = withFiles(t);
  const config = (body: Record<string, unknown>) => file(`${Object.keys(body.design ?? body.efficiency ?? {})[0]}-${Math.random()}.json`,
    { schema: "raven.run-config.v1", ...body });
  const same = (plain: string[], overridden: string[], key: string, expected: string) => {
    const a = resolve(plain), b = resolve(overridden);
    assert.deepEqual(b.args, a.args, key);
    assert.deepEqual(Object.fromEntries([...b.entries].map(([k, e]) => [k, e.value])),
      Object.fromEntries([...a.entries].map(([k, e]) => [k, e.value])), key);
    assert.equal(b.selected[key], expected, key);
    return b;
  };
  // tool_delivery reset → frozen results again lead under the formal preset.
  await t.test("under the default formal-232 preset", { skip: needsFormalSet }, () => {
    const frozen = ["--llm", "x:y", "--settings", "frozen"];
    const inline = config({ design: { tool_delivery: "inline" } }), reset = config({ design: { tool_delivery: null } });
    const b = same(frozen, [...frozen, "--config", inline, "--config", reset], "frozen-search-delivery", "lead");
    assert.match(b.entries.get("tool_delivery")!.source, /^default \(reset by config:.*\)$/);
    assert.equal(b.isExplicit("tool_delivery"), false);
  });
  // content_processing reset → web results again summary.
  const web = [...custom, "--llm", "x:y", "--settings", "web-filter"];
  same(web, [...web, "--config", config({ design: { content_processing: "whole-document" } }),
    "--config", config({ design: { content_processing: null } })], "search-delivery", "summary");
  // leak_filter reset → the reviewer default is low again.
  same(web, [...web, "--config", config({ design: { leak_filter: false } }),
    "--config", config({ design: { leak_filter: null } })], "review-effort", "low");
  // leak_availability_policy reset under baseline → the date gate is content again.
  const baseline = [...web, "--retrieval-profile", "baseline"];
  same(baseline, [...baseline, "--config", config({ design: { leak_availability_policy: "issued-information-v3" } }),
    "--config", config({ design: { leak_availability_policy: null } })], "date-gate", "content");
  // Resetting a value a preset fixes is checked like any other change of it: an error unless
  // the default would give the same value (review effort falls back to the same low).
  const july = ["--preset", "july-2026-formal", "--llm", "x:y", "--settings", "web-filter"];
  assert.throws(() => resolve([...july, "--config", config({ design: { review_thinking: null } })]), /requires --review-thinking enabled/);
  assert.throws(() => resolve([...july, "--config", config({ design: { n: null } })]), /requires --n 254 \(got 20 from default/);
  assert.equal(resolve([...july, "--config", config({ design: { review_effort: null } })]).selected["review-effort"], "low");
});

test("values from a preset or file that the chosen arms do not use are reported", (t) => {
  const file = withFiles(t);
  const none = resolve(["--preset", "july-2026-formal", "--llm", "x:y", "--settings", "none"]);
  const dropped = none.warnings.find((w) => w.includes("not passed to the runner"))!;
  for (const key of ["review_effort", "review_thinking", "wiki_manifest", "shared_frozen_cache", "shared_review_cache"])
    assert.match(dropped, new RegExp(`${key} \\(preset:july-2026-formal\\)`), key);
  assert.ok(none.summary().warnings.includes(dropped));
  const baseline = resolve([...custom, "--llm", "x:y", "--settings", "web-filter", "--retrieval-profile", "baseline",
    "--config", file("q.json", { schema: "raven.run-config.v1", efficiency: { search_concurrency: 8 } })]);
  assert.match(baseline.warnings.join("\n"), /search_concurrency \(config:.*q\.json\)/);
  assert.equal(baseline.selected["search-concurrency"], undefined);
  assert.deepEqual(resolve(["--preset", "july-2026-formal", "--llm", "x:y", "--settings", "both"]).warnings, [],
    "every July value applies to the both arm");
});

test("override files reject unknown sections, keys, misplaced keys, wrong types and environment-only settings", (t) => {
  const file = withFiles(t);
  const run = (body: unknown) => resolve([...custom, "--llm", "x:y", "--settings", "none", "--config", file("c.json", body)]);
  assert.throws(() => run({ efficiency: {} }), /schema must be raven.run-config.v1/);
  assert.throws(() => run({ schema: "raven.run-config.v1", speed: {} }), /unknown section "speed"/);
  assert.throws(() => run({ schema: "raven.run-config.v1", efficiency: { review_concurreny: 3 } }), /unknown parameter "review_concurreny"; did you mean review_concurrency/);
  assert.throws(() => run({ schema: "raven.run-config.v1", design: { review_concurrency: 3 } }), /belongs in "efficiency"/);
  assert.throws(() => run({ schema: "raven.run-config.v1", efficiency: { review_concurrency: "3" } }), /must be a JSON number/);
  assert.throws(() => run({ schema: "raven.run-config.v1", efficiency: { review_concurrency: 0 } }), /positive safe integer/);
  assert.throws(() => run({ schema: "raven.run-config.v1", services: { reader_timeout_s: 9 } }), /set READER_TIMEOUT_S in the environment/);
  assert.equal(run({ schema: "raven.run-config.v1", design: { ledger: 1 } }).selected.ledger, "1");
});

test("the shared admission and the direct runner resolve the same arguments to the same values", async (t) => {
  const same = (raw: string[]) => {
    const admitted = formalArguments(raw, PKG_ROOT, offline);
    assert.deepEqual(admitted.args, readForecastOptions(raw, offline).parameters.args);
    assert.deepEqual(admitted.args, resolve(admitted.args).args, "admitted arguments resolve to themselves");
  };
  same(["--preset", "july-2026-formal", "--llm", "x:y", "--settings", "both", "--conc", "4"]);
  await t.test("under the default formal-232 preset", { skip: needsFormalSet }, () => {
    const web = ["--llm", "x:y", "--settings", "web-filter", "--leak-llm", "deepseek:deepseek-flash", "--conc", "4"];
    same(web);
    same(["--llm", "x:y", "--settings", "none,frozen", "--conc", "4"]);
    const selected = formalArguments(web, PKG_ROOT, offline).selected;
    assert.equal(selected["review-effort"], "low");
    assert.equal(selected["search-provider"], "serper");
  });
});
