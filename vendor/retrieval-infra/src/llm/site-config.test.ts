import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HISTORICAL_USER_AGENT } from "../http-identity.js";
import { SHARED_RATE_DB } from "./shared-rate-limit.js";
import {
  formerVariableNames, SHARED_ROOT, SITE_CONFIG_FILE, siteSetting, TEAM_CONFIG_DIR, UNCONFIGURED_SHARED_ROOT,
} from "../site-config.js";
import { projectEnv } from "../env-names.js";

test("settings come from the environment, then FABENCH_PATHS_CONFIG, then the deployment's site file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fabench-site-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, "site.json");
  const paths = join(dir, "nested", "paths.json");
  writeFileSync(site, JSON.stringify({ sharedRoot: "shared-from-site", httpUserAgent: "Site/1.0" }));
  const read = (env: NodeJS.ProcessEnv) => ({
    root: siteSetting("sharedRoot", "FABENCH_SHARED_ROOT", { path: true, env, siteFile: site }),
    agent: siteSetting("httpUserAgent", "FABENCH_HTTP_USER_AGENT", { env, siteFile: site }),
  });
  assert.deepEqual(read({}), { root: join(dir, "shared-from-site"), agent: "Site/1.0" });
  rmSync(site);
  assert.deepEqual(read({}), { root: undefined, agent: undefined }, "no layer sets a value");
  writeFileSync(site, JSON.stringify({ sharedRoot: "/site/root" }));
  writeFileSync(join(dir, "paths.json"), "{}");
  assert.equal(read({ FABENCH_PATHS_CONFIG: join(dir, "paths.json") }).root, "/site/root", "a key the paths file omits falls through");
  writeFileSync(join(dir, "paths.json"), JSON.stringify({ sharedRoot: "relative/root" }));
  assert.equal(read({ FABENCH_PATHS_CONFIG: join(dir, "paths.json") }).root, join(dir, "relative/root"));
  assert.equal(read({ FABENCH_PATHS_CONFIG: join(dir, "paths.json"), FABENCH_SHARED_ROOT: " /env/root " }).root, "/env/root");
  assert.equal(read({ FABENCH_HTTP_USER_AGENT: "Env/2.0" }).agent, "Env/2.0");
  assert.equal(read({ RAVEN_HTTP_USER_AGENT: "Former/1.0" }).agent, "Former/1.0", "a former RAVEN_* name still works");
  assert.equal(read({ FABENCH_HTTP_USER_AGENT: "Env/2.0", RAVEN_HTTP_USER_AGENT: "Former/1.0" }).agent, "Env/2.0");
  assert.equal(read({ RAVEN_PATHS_CONFIG: join(dir, "paths.json") }).root, join(dir, "relative/root"), "former paths file name");
  assert.throws(() => read({ FABENCH_PATHS_CONFIG: paths }), /Cannot read path configuration/);
  writeFileSync(join(dir, "paths.json"), JSON.stringify({ sharedRoot: "" }));
  assert.throws(() => read({ FABENCH_PATHS_CONFIG: join(dir, "paths.json") }), /sharedRoot must be a nonempty path/);
  writeFileSync(join(dir, "paths.json"), "[]");
  assert.throws(() => read({ FABENCH_PATHS_CONFIG: join(dir, "paths.json") }), /must be a JSON object/);
});

test("shared locations derive from one root, and an unset root names a path that cannot exist", () => {
  assert.equal(TEAM_CONFIG_DIR, `${SHARED_ROOT}/config/raven-bench`);
  assert.equal(SHARED_RATE_DB, `${SHARED_ROOT}/runs/raven-bench/api-admission.sqlite`);
  if (!projectEnv("FABENCH_SHARED_ROOT") && !projectEnv("FABENCH_PATHS_CONFIG") && !existsSync(SITE_CONFIG_FILE))
    assert.equal(SHARED_ROOT, UNCONFIGURED_SHARED_ROOT);
  assert.equal(existsSync(join(UNCONFIGURED_SHARED_ROOT, "config")), false);
  if (!projectEnv("FABENCH_HTTP_USER_AGENT") && !projectEnv("FABENCH_PATHS_CONFIG") && !existsSync(SITE_CONFIG_FILE))
    assert.equal(HISTORICAL_USER_AGENT, "FABench/0.1 (research)");
  assert.match(HISTORICAL_USER_AGENT, /\(research/);
});

test("former variable names come only from the configuration files and must be variable names", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fabench-aliases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, "site.json");
  const write = (body: unknown) => writeFileSync(site, JSON.stringify(body));
  const read = (env: NodeJS.ProcessEnv = {}) => formerVariableNames("NEW_KEY", { env, siteFile: site });
  assert.deepEqual(read(), [], "no file");
  write({ envAliases: { NEW_KEY: ["OLD_KEY", "OLDER_KEY"] } });
  assert.deepEqual(read(), ["OLD_KEY", "OLDER_KEY"]);
  assert.deepEqual(formerVariableNames("OTHER", { env: {}, siteFile: site }), []);
  writeFileSync(join(dir, "paths.json"), JSON.stringify({ envAliases: { NEW_KEY: [] } }));
  assert.deepEqual(read({ FABENCH_PATHS_CONFIG: join(dir, "paths.json") }), [], "the paths file wins");
  write({ envAliases: { NEW_KEY: "OLD_KEY" } });
  assert.throws(() => read(), /envAliases.NEW_KEY must list environment variable names/);
  write({ envAliases: ["OLD_KEY"] });
  assert.throws(() => read(), /envAliases must map a variable name/);
});
