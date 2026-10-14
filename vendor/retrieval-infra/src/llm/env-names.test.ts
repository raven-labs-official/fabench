import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearProjectEnv, describeProjectEnv, formerEnvName, projectEnv, projectEnvName } from "../env-names.js";
import { getEnvKey } from "./load-env.js";

test("a FABENCH_* variable falls back to its former RAVEN_* name only when it is unset", () => {
  assert.equal(formerEnvName("FABENCH_RESULTS_DIR"), "RAVEN_RESULTS_DIR");
  assert.equal(formerEnvName("DEEPSEEK_API_KEY"), undefined);
  assert.equal(projectEnv("FABENCH_RESULTS_DIR", {}), undefined);
  assert.equal(projectEnv("FABENCH_RESULTS_DIR", { RAVEN_RESULTS_DIR: "/old" }), "/old");
  assert.equal(projectEnvName("FABENCH_RESULTS_DIR", { RAVEN_RESULTS_DIR: "/old" }), "RAVEN_RESULTS_DIR");
  assert.equal(projectEnv("FABENCH_RESULTS_DIR", { FABENCH_RESULTS_DIR: "/new", RAVEN_RESULTS_DIR: "/old" }), "/new");
  assert.equal(projectEnv("FABENCH_RESULTS_DIR", { FABENCH_RESULTS_DIR: "", RAVEN_RESULTS_DIR: "/old" }), "",
    "an empty new name is used as written");
  assert.equal(projectEnvName("FABENCH_RESULTS_DIR", {}), "FABENCH_RESULTS_DIR");
  assert.equal(projectEnv("DEEPSEEK_API_KEY", { DEEPSEEK_API_KEY: "k" }), "k");
  const env: Record<string, string | undefined> = { FABENCH_AS_OF: "a", RAVEN_AS_OF: "b", OTHER: "c" };
  clearProjectEnv("FABENCH_AS_OF", env);
  assert.deepEqual(env, { OTHER: "c" });
  assert.equal(describeProjectEnv("FABENCH_CORPUS_DB"), "FABENCH_CORPUS_DB (or the former RAVEN_CORPUS_DB)");
});

test("getEnvKey reads a former name from the process and from the team env file", (t) => {
  const names = ["FABENCH_TEAM_ENV_FILE", "RAVEN_TEAM_ENV_FILE", "FABENCH_ENV_NAMES_TEST", "RAVEN_ENV_NAMES_TEST"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const dir = mkdtempSync(join(tmpdir(), "env-names-"));
  t.after(() => {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    rmSync(dir, { recursive: true, force: true });
  });
  for (const name of names) delete process.env[name];
  writeFileSync(join(dir, "team.env"), "RAVEN_ENV_NAMES_TEST=from-file\n");
  process.env.RAVEN_TEAM_ENV_FILE = join(dir, "team.env");
  assert.equal(getEnvKey("FABENCH_ENV_NAMES_TEST"), "from-file", "former team env path and former name in the file");
  process.env.RAVEN_ENV_NAMES_TEST = "from-process";
  assert.equal(getEnvKey("FABENCH_ENV_NAMES_TEST"), "from-process");
  writeFileSync(join(dir, "new.env"), "FABENCH_ENV_NAMES_TEST=new-name-in-file\n");
  process.env.FABENCH_TEAM_ENV_FILE = join(dir, "new.env");
  assert.equal(getEnvKey("FABENCH_ENV_NAMES_TEST"), "new-name-in-file", "the new name wins wherever it is set");
});
