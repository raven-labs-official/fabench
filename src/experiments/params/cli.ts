/**
 * pnpm exp:params                      every run parameter, grouped by category
 * pnpm exp:params presets              the presets under config/presets/
 * pnpm exp:params resolve <run args>   the values a run would use and the layer of each
 * Add --json right after the command for machine-readable output. Nothing here calls a model,
 * reads a question bank or writes a file.
 */
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { defaultPreset, formatValue, listPresets, loadPreset, resolveRunParameters } from "./resolve.js";
import { CATEGORIES, describeType, type ParameterSpec, RUN_PARAMETERS } from "./schema.js";

const show = (value: unknown) => (value === null || value === undefined ? "—" : value === "" ? '""' : formatValue(value as never));

function defaultText(spec: ParameterSpec): string {
  if (spec.derived) return spec.derived.text;
  if (spec.default === null) return spec.defaultText ? `unset (${spec.defaultText})` : "unset";
  return show(spec.default);
}

function schemaRows() {
  return RUN_PARAMETERS.map((spec) => ({
    key: spec.key, category: spec.category, flag: spec.flag ? `--${spec.flag}` : null, env: spec.env ?? null,
    type: describeType(spec.type), default: spec.derived ? null : spec.default, default_text: defaultText(spec),
    affects_results: spec.affectsResults, in_condition: spec.inCondition, applies_when: spec.when ?? [], meaning: spec.meaning,
  }));
}

function printSchema() {
  for (const [category, title] of Object.entries(CATEGORIES)) {
    const specs = RUN_PARAMETERS.filter((s) => s.category === category);
    console.log(`\n## ${category} — ${title} (${specs.length})`);
    for (const spec of specs) {
      const names = [spec.flag && `--${spec.flag}`, spec.env].filter(Boolean).join(" / ");
      const marks = [spec.affectsResults ? "affects results" : "", spec.inCondition ? "enters condition" : "",
        spec.when ? `used for ${spec.when.join("+")}` : ""].filter(Boolean).join(", ");
      console.log(`  ${names}\n      ${describeType(spec.type)}; default ${defaultText(spec)}${marks ? `; ${marks}` : ""}\n      ${spec.meaning}`);
    }
  }
  console.log(`\n${RUN_PARAMETERS.length} parameters. Presets: ${listPresets().join(", ")} (default ${defaultPreset()}). Details: docs/operations/parameters.md`);
}

function printPresets(json: boolean) {
  const presets = listPresets().map((name) => loadPreset(name));
  if (json) {
    console.log(JSON.stringify(presets.map((p) => ({ name: p.name, description: p.description, admission_profile: p.admissionProfile,
      allowed_arms: p.allowedArms, locked: p.locked, forbidden: p.forbidden, values: Object.fromEntries(p.values) })), null, 2));
    return;
  }
  for (const p of presets) {
    console.log(`\n${p.name}  (admission profile ${p.admissionProfile})\n  ${p.description}`);
    for (const [key, value] of p.values) console.log(`    ${key} = ${show(value)}${p.locked.includes(key) ? "  [locked]" : ""}`);
    if (p.forbidden.length) console.log(`    not allowed: ${p.forbidden.join(", ")}`);
  }
}

function printResolved(args: string[], json: boolean) {
  const resolved = resolveRunParameters(args);
  if (json) {
    console.log(JSON.stringify({ ...resolved.summary(), effective_args: resolved.args, warnings: resolved.warnings }, null, 2));
    return;
  }
  console.log(`preset ${resolved.preset.name}; layers: ${resolved.layers.join(" → ")}`);
  for (const category of Object.keys(CATEGORIES)) {
    console.log(`\n## ${category}`);
    for (const spec of RUN_PARAMETERS.filter((s) => s.category === category && !s.meta)) {
      const entry = resolved.entries.get(spec.key)!;
      if (entry.value === null && entry.kind === "default") continue;
      console.log(`  ${spec.key.padEnd(30)} ${show(entry.value).padEnd(28)} ${entry.source}${entry.applies ? "" : "  (does not apply to the selected arms; not passed to the runner)"}`);
    }
  }
  console.log(`\neffective arguments:\n  ${resolved.args.join(" ")}`);
  for (const warning of resolved.warnings) console.error(`[WARN] ${warning}`);
}

export function main(argv = process.argv.slice(2)) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "schema";
  const rest = command === args[0] ? args.slice(1) : args;
  const json = rest[0] === "--json";
  const tail = json ? rest.slice(1) : rest;
  if (command === "schema") {
    if (tail.length) throw new Error("usage: pnpm exp:params [schema|presets|resolve] [--json] [run arguments]");
    if (json) console.log(JSON.stringify({ categories: CATEGORIES, parameters: schemaRows() }, null, 2));
    else printSchema();
  } else if (command === "presets") printPresets(json);
  else if (command === "resolve") printResolved(tail, json);
  else throw new Error(`Unknown command ${command}; use schema, presets or resolve`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
