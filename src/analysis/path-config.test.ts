import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { SHARED_RATE_DB } from "../llm/shared-rate-limit.js";
import {
  configuredPath, configuredSetting, CURRENT_RELEASE, dataRoot, FROZEN_SHARED_CACHE, SHARED_BENCH_DIR,
  SHARED_REGISTRY_PATH, SHARED_RESULTS_DIR, SHARED_ROOT, SHARED_RUNS_ROOT, SITE_CONFIG_FILE, TEAM_CONFIG_DIR,
  UNCONFIGURED_DATA_ROOT, UNCONFIGURED_SHARED_ROOT,
} from "../path-config.js";
import { projectEnv } from "../env-names.js";

const SHARED_PATHS = {
  SHARED_ROOT, SHARED_RUNS_ROOT, SHARED_BENCH_DIR, SHARED_RESULTS_DIR, SHARED_REGISTRY_PATH,
  TEAM_CONFIG_DIR, CURRENT_RELEASE, FROZEN_SHARED_CACHE,
};

test("Node and Python name the same shared paths, all below one root", () => {
  assert.deepEqual(SHARED_PATHS, {
    SHARED_ROOT,
    SHARED_RUNS_ROOT: `${SHARED_ROOT}/runs`,
    SHARED_BENCH_DIR: `${SHARED_ROOT}/runs/raven-bench`,
    SHARED_RESULTS_DIR: `${SHARED_ROOT}/runs/raven-bench/results`,
    SHARED_REGISTRY_PATH: `${SHARED_ROOT}/runs/raven-bench/registry.sqlite`,
    TEAM_CONFIG_DIR: `${SHARED_ROOT}/config/raven-bench`,
    CURRENT_RELEASE: `${SHARED_ROOT}/current/raven-bench`,
    FROZEN_SHARED_CACHE: `${SHARED_ROOT}/cache/frozen-query/cache.sqlite`,
  });
  const names = Object.keys(SHARED_PATHS);
  const python = spawnSync("python3", ["-c",
    "import json, sys, path_config; print(json.dumps({n: getattr(path_config, n) for n in sys.argv[1:]}))", ...names], {
    env: { ...process.env, PYTHONPATH: resolve("tools") },
    encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), SHARED_PATHS);
  // tools/shared-environment.sh exports this admission database; the retrieval module opens it.
  assert.equal(SHARED_RATE_DB, `${SHARED_BENCH_DIR}/api-admission.sqlite`);
});

test("without a configured root the shared paths sit where nothing can be created", () => {
  if (!projectEnv("FABENCH_SHARED_ROOT") && !projectEnv("FABENCH_PATHS_CONFIG") && !existsSync(SITE_CONFIG_FILE))
    assert.equal(SHARED_ROOT, UNCONFIGURED_SHARED_ROOT);
  if (existsSync(SITE_CONFIG_FILE) && !projectEnv("FABENCH_SHARED_ROOT") && !projectEnv("FABENCH_PATHS_CONFIG")) {
    const site = JSON.parse(readFileSync(SITE_CONFIG_FILE, "utf8")) as { sharedRoot?: string };
    if (site.sharedRoot) assert.equal(SHARED_ROOT, resolve(dirname(SITE_CONFIG_FILE), site.sharedRoot));
  }
  for (const root of [UNCONFIGURED_SHARED_ROOT, UNCONFIGURED_DATA_ROOT]) {
    assert.equal(existsSync(join(root, "runs")), false);
    assert.throws(() => mkdirSync(join(root, "runs"), { recursive: true }), /ENOTDIR/);
  }
});

test("settings come from the environment, then FABENCH_PATHS_CONFIG, then the site file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-site-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const site = join(directory, "site.json");
  const paths = join(directory, "paths.json");
  writeFileSync(site, JSON.stringify({ sharedRoot: "site-root", siteName: "site-server", dataRoot: "/data-from-site" }));
  writeFileSync(paths, JSON.stringify({ sharedRoot: "paths-root" }));
  assert.equal(configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", {}, site), join(directory, "site-root"));
  assert.equal(configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", { FABENCH_PATHS_CONFIG: paths }, site), join(directory, "paths-root"));
  assert.equal(configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", { FABENCH_PATHS_CONFIG: paths, FABENCH_SHARED_ROOT: "/env" }, site), "/env");
  assert.equal(configuredSetting("siteName", "FABENCH_SITE_NAME", { FABENCH_PATHS_CONFIG: paths }, site), "site-server",
    "a key the paths file omits falls through to the site file");
  assert.equal(configuredSetting("siteName", "FABENCH_SITE_NAME", { FABENCH_SITE_NAME: " env-server " }, site), "env-server");
  assert.equal(configuredPath("resultsDir", "FABENCH_RESULTS_DIR", {}, site), undefined);
  assert.equal(configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", {}, join(directory, "absent.json")), undefined);
  assert.equal(dataRoot({ FABENCH_DATA_ROOT: "/env-data" }), "/env-data");
  // Former RAVEN_* names still configure an installation when the FABENCH_* name is unset.
  assert.equal(configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", { RAVEN_PATHS_CONFIG: paths }, site), join(directory, "paths-root"));
  assert.equal(configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", { RAVEN_SHARED_ROOT: "/old-env" }, site), "/old-env");
  assert.equal(configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", { FABENCH_SHARED_ROOT: "/env", RAVEN_SHARED_ROOT: "/old-env" }, site), "/env");
  assert.equal(dataRoot({ RAVEN_DATA_ROOT: "/old-data" }), "/old-data");
  writeFileSync(site, JSON.stringify({ siteName: "" }));
  assert.throws(() => configuredSetting("siteName", "FABENCH_SITE_NAME", {}, site), /siteName must be a nonempty string/);
  writeFileSync(site, "broken JSON");
  assert.throws(() => configuredPath("sharedRoot", "FABENCH_SHARED_ROOT", {}, site), /Cannot read path configuration/);
});

test("Node and Python resolve config paths relative to the config file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-paths-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "paths.json");
  writeFileSync(file, JSON.stringify({ resultsDir: "../output with spaces", registryPath: "snapshot.sqlite" }));
  const expected = resolve(directory, "../output with spaces");
  assert.equal(configuredPath("resultsDir", "FABENCH_RESULTS_DIR", { FABENCH_PATHS_CONFIG: file }), expected);
  const python = spawnSync("python3", ["-c",
    "from path_config import required_path; print(required_path('resultsDir', 'FABENCH_RESULTS_DIR'))"], {
    cwd: directory,
    env: { ...process.env, PYTHONPATH: resolve("tools"), FABENCH_PATHS_CONFIG: file, FABENCH_RESULTS_DIR: "" },
    encoding: "utf8",
  });
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), expected);
  const node = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    "import { RESULTS_DIR } from './src/paths.ts'; import { defaultRegistryPath } from './src/experiments/registry.ts'; " +
    "console.log(JSON.stringify([RESULTS_DIR, defaultRegistryPath()]))"], {
    env: { ...process.env, FABENCH_PATHS_CONFIG: file, FABENCH_RESULTS_DIR: "", FABENCH_EXPERIMENT_REGISTRY: "" },
    encoding: "utf8",
  });
  assert.equal(node.status, 0, node.stderr);
  assert.deepEqual(JSON.parse(node.stdout), [expected, join(directory, "snapshot.sqlite")]);
});

test("explicit environment paths override a broken optional config", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-paths-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "paths.json");
  writeFileSync(file, "broken JSON");
  assert.equal(configuredPath("resultsDir", "FABENCH_RESULTS_DIR", {
    FABENCH_PATHS_CONFIG: file, FABENCH_RESULTS_DIR: directory,
  }), directory);
  assert.throws(() => configuredPath("resultsDir", "FABENCH_RESULTS_DIR", {
    FABENCH_PATHS_CONFIG: file,
  }), /Cannot read path configuration/);
  assert.equal(configuredPath("resultsDir", "FABENCH_RESULTS_DIR", {}), undefined);
});
