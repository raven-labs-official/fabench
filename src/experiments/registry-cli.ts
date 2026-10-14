import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ExperimentRegistry } from "./registry.js";

function usage(message?: string): never {
  if (message) console.error(`\n${message}`);
  console.error(
    `\nusage:\n` +
      `  tools/shared-experiment-status.sh [--mine] [--running] [--json] [--registry-path PATH]  # shared release\n` +
      `  pnpm exp:status -- [--mine] [--running] [--json] [--registry-path PATH]\n` +
      `  pnpm exp:registry-import -- <trace-directory-or-root> [...] [--registry-path PATH]\n` +
      `  pnpm exp:registry-promote-none -- <trace-directory> --condition-id ID ` +
      `--model MODEL --reason TEXT [--registry-path PATH]\n` +
      `  pnpm exp:registry-promote-equivalent -- --source-condition ID ` +
      `--target-preview FILE --arm ARM --reason TEXT [--registry-path PATH]\n`,
  );
  process.exit(2);
}

function age(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function traceDirectories(path: string): string[] {
  const absolute = resolve(path);
  if (!existsSync(absolute)) usage(`Does not exist: ${absolute}`);
  if (existsSync(join(absolute, "manifest.json"))) return [absolute];
  if (!statSync(absolute).isDirectory()) usage(`Not a directory: ${absolute}`);
  return readdirSync(absolute)
    .map((name) => join(absolute, name))
    .filter((candidate) => existsSync(join(candidate, "manifest.json")));
}

const argv = process.argv.slice(2).filter((arg) => arg !== "--");
const command = argv.shift() ?? "status";

function takeOption(name: string): string | undefined {
  const equalsIndex = argv.findIndex((arg) => arg.startsWith(`${name}=`));
  const plainIndex = argv.indexOf(name);
  if (equalsIndex >= 0 && plainIndex >= 0) usage(`${name} may be given only once`);
  if (equalsIndex >= 0) {
    const [arg] = argv.splice(equalsIndex, 1);
    const value = arg!.slice(name.length + 1);
    if (!value) usage(`${name} requires a path`);
    return value;
  }
  if (plainIndex < 0) return undefined;
  const value = argv[plainIndex + 1];
  if (!value || value.startsWith("--")) usage(`${name} requires a path`);
  argv.splice(plainIndex, 2);
  return value;
}

const registryPath = takeOption("--registry-path");
const registry = new ExperimentRegistry(registryPath);

try {
  if (command === "status") {
    const mine = argv.includes("--mine");
    const active = argv.includes("--running");
    const json = argv.includes("--json");
    const unknown = argv.filter((arg) => !["--mine", "--running", "--json"].includes(arg));
    if (unknown.length) usage(`Unknown arguments: ${unknown.join(", ")}`);
    const runs = registry.listRuns({ mine, active });
    if (json) {
      console.log(JSON.stringify({ registry: registry.path, runs }, null, 2));
    } else {
      console.log(`registry: ${registry.path}`);
      console.log(`OWNER      MODEL              TAG                    PROGRESS       STATE       HEARTBEAT`);
      for (const run of runs) {
        const model = String(run.config?.llm ?? (run.configError ? "[invalid config]" : "?"));
        const done = run.reusedCells + run.succeededCells + run.failedCells + run.interruptedCells;
        console.log(
          `${run.owner.padEnd(10).slice(0, 10)} ` +
            `${model.padEnd(18).slice(0, 18)} ` +
            `${run.tag.padEnd(22).slice(0, 22)} ` +
            `${`${done}/${run.expectedCells}`.padEnd(14)} ` +
            `${run.status.padEnd(11)} ${age(run.lastHeartbeatUtc).padStart(8)}`,
        );
        if (run.traceDirectory) console.log(`  ↳ ${run.traceDirectory}`);
        if (run.configError) console.log(`  Configuration unavailable: ${run.configError}`);
      }
      if (!runs.length) console.log("(no matching experiments; import old traces with exp:registry-import first)");
    }
  } else if (command === "import") {
    if (!argv.length) usage(`import needs at least one trace directory or traces root directory`);
    let archives = 0;
    let cells = 0;
    let reusable = 0;
    for (const root of argv) {
      for (const directory of traceDirectories(root)) {
        const result = registry.importTraceArchive(directory);
        archives++;
        cells += result.cells;
        reusable += result.reusable;
        console.log(
          `${basename(directory)}: ${result.cells} cells · ${result.reusable} reusable · run=${result.runId}`,
        );
      }
    }
    console.log(
      `imported ${archives} archives / ${cells} cells / ${reusable} reusable → ${registry.path}`,
    );
  } else if (command === "promote-none") {
    const conditionId = takeOption("--condition-id")?.trim();
    const expectedModel = takeOption("--model")?.trim();
    const reason = takeOption("--reason")?.trim();
    if (argv.length !== 1)
      usage(`promote-none takes exactly one source trace directory`);
    if (!conditionId) usage(`promote-none requires --condition-id`);
    if (!expectedModel) usage(`promote-none requires --model`);
    if (!reason) usage(`promote-none requires --reason`);
    const result = registry.promoteLegacyClosedBook({
      directory: argv[0]!,
      conditionId,
      expectedModel,
      reason,
    });
    console.log(
      `promoted legacy closed-book run=${result.sourceRunId}: ` +
        `${result.inserted} inserted · ${result.alreadyPresent} already present · ` +
        `${result.rejected} rejected → ${registry.path}`,
    );
  } else if (command === "promote-equivalent") {
    const sourceConditionId = takeOption("--source-condition")?.trim();
    const targetPreview = takeOption("--target-preview")?.trim();
    const arm = takeOption("--arm")?.trim();
    const reason = takeOption("--reason")?.trim();
    if (argv.length) usage(`promote-equivalent takes no positional arguments: ${argv.join(", ")}`);
    if (!sourceConditionId) usage(`promote-equivalent requires --source-condition`);
    if (!targetPreview) usage(`promote-equivalent requires --target-preview`);
    if (!arm) usage(`promote-equivalent requires --arm`);
    if (!reason) usage(`promote-equivalent requires --reason`);
    const previewPath = resolve(targetPreview);
    if (!existsSync(previewPath)) usage(`Target preview does not exist: ${previewPath}`);
    const preview = JSON.parse(readFileSync(previewPath, "utf8")) as Record<string, unknown>;
    const conditions = Array.isArray(preview.conditions)
      ? preview.conditions as Array<Record<string, unknown>>
      : [];
    const matches = conditions.filter((condition) => condition.arm === arm);
    if (matches.length !== 1)
      usage(`Target preview has ${matches.length} conditions with arm=${arm}; exactly 1 is required`);
    const result = registry.promoteEquivalentCondition({
      sourceConditionId,
      targetCondition: matches[0]!,
      reason,
    });
    console.log(JSON.stringify({ registry: registry.path, ...result }, null, 2));
  } else {
    usage(`Unknown command: ${command}`);
  }
} finally {
  registry.close();
}
