/**
 * Resolve run parameters from layers, later layers winning key by key:
 *
 *   built-in defaults (schema) → environment → preset → --config files (in order)
 *   → --concurrency-file → command line
 *
 * An environment variable overrides only the built-in default. The result records the layer
 * of every value, validates every value against the schema, and renders the canonical
 * argument list the runner parses. Both the shared launcher's admission and the direct runner
 * call this one function, so the same arguments resolve to the same values on either path.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getEnvKey } from "../../llm/load-env.js";
import { dataRoot } from "../../path-config.js";
import { PKG_ROOT, RESULTS_DIR } from "../../paths.js";
import { readConcurrencyFile } from "../../resources/concurrency-config.js";
import { canonicalArmSpec } from "../experiment-identity.js";
import { selectedQuestionIds } from "../question-selection.js";
import {
  CATEGORIES,
  type Category,
  type Condition,
  type DeriveContext,
  FLAG_ALIASES,
  PARAMETERS_BY_FLAG,
  PARAMETERS_BY_KEY,
  type ParameterSpec,
  REMOVED_FLAGS,
  RUN_PARAMETERS,
  sharedFrozenCacheAvailable,
  type Value,
} from "./schema.js";
import { projectEnvName } from "../../env-names.js";

export const PARAMETERS_SCHEMA_VERSION = "raven.run-parameters.v1";
const PRESET_SCHEMA = "raven.run-preset.v1";
const DEFAULT_PRESET_SCHEMA = "raven.default-preset.v1";
const CONFIG_SCHEMA = "raven.run-config.v1";
const ARM_BRANCHES = new Set(["none", "frozen", "web-filter", "backsearch", "provided", "both"]);

export type LayerKind = "default" | "env" | "preset" | "config" | "cli";

export interface ResolvedEntry {
  value: Value;
  kind: LayerKind;
  /** The layer, e.g. `preset:july-2026-formal` or `config:/abs/override.json`. */
  source: string;
  /** False when the value does not apply to the selected arms or retrieval profile. */
  applies: boolean;
}

export interface ResolveContext {
  /** Release or checkout root holding config/presets; defaults to this checkout. */
  root?: string;
  /** Environment to read instead of process.env plus the team env file. */
  env?: NodeJS.ProcessEnv;
  sharedFrozenCacheAvailable?: boolean;
  resultsDir?: string;
  cwd?: string;
}

export interface RunPreset {
  name: string;
  file: string;
  description: string;
  admissionProfile: "formal-232" | "custom";
  allowedArms: string[] | null;
  locked: string[];
  forbidden: string[];
  values: Map<string, Value>;
  baseline: { locked: string[]; values: Map<string, Value> } | null;
}

export interface ParameterSummary {
  schema: typeof PARAMETERS_SCHEMA_VERSION;
  preset: string;
  layers: string[];
  warnings: string[];
  values: Record<Category, Record<string, { value: Value; source: string; applies?: false }>>;
}

export class ResolvedRunParameters {
  constructor(
    readonly preset: RunPreset,
    readonly layers: string[],
    readonly entries: ReadonlyMap<string, ResolvedEntry>,
    readonly args: string[],
    readonly warnings: string[],
    /** The arguments this resolution was made from. */
    readonly raw: readonly string[],
  ) {}

  value(key: string): Value {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Unknown run parameter ${key}`);
    return entry.value;
  }

  /** Set by a preset, an override file or the command line (not a built-in or environment value). */
  isExplicit(key: string): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry && entry.value !== null && ["preset", "config", "cli"].includes(entry.kind));
  }

  /** Emitted arguments as flag → string, the shape admission receipts record. */
  get selected(): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < this.args.length; i += 2) out[this.args[i]!.slice(2)] = this.args[i + 1]!;
    return out;
  }

  summary(): ParameterSummary {
    const values = Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, {}])) as ParameterSummary["values"];
    for (const spec of RUN_PARAMETERS) {
      if (spec.meta) continue;
      const entry = this.entries.get(spec.key)!;
      values[spec.category][spec.key] = {
        value: entry.value,
        source: entry.source,
        ...(entry.applies ? {} : { applies: false as const }),
      };
    }
    return { schema: PARAMETERS_SCHEMA_VERSION, preset: this.preset.name, layers: [...this.layers],
      warnings: [...this.warnings], values };
  }
}

// ---------------------------------------------------------------------------------------------
// Values

const DIGITS = String.raw`\d(?:_?\d)*`;
/** The literals Python's float() and int() accept from text (after stripping whitespace). */
const PYTHON_FLOAT = new RegExp(
  `^[+-]?(?:(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:e[+-]?${DIGITS})?|inf(?:inity)?|nan)$`, "i");
const PYTHON_INT = new RegExp(`^[+-]?${DIGITS}$`);

const plural = (values: readonly string[]) =>
  values.length === 1 ? values[0]! : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
const label = (spec: ParameterSpec) => (spec.flag ? `--${spec.flag}` : spec.env ? `${spec.env}` : spec.key);

/** Parse one textual value (command line, environment, or a JSON scalar) for a parameter. */
export function parseValue(spec: ParameterSpec, raw: string, where = label(spec)): Value {
  const type = spec.type;
  switch (type.kind) {
    case "boolean": {
      // Environment-only switches are read elsewhere as exactly "1"; accept only 0 and 1 there.
      const envOnly = !spec.flag;
      if (raw === "1" || (!envOnly && raw === "true")) return true;
      if (raw === "0" || (!envOnly && raw === "false")) return false;
      throw new Error(envOnly ? `${where} must be 0 or 1, got ${JSON.stringify(raw)}`
        : `${where} must be 0 or 1 (true or false is also accepted), got ${JSON.stringify(raw)}`);
    }
    case "integer": {
      const n = /^-?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
      const range = type.max !== undefined ? `an integer from ${type.min ?? 0} to ${type.max}`
        : type.min === 0 ? "a non-negative safe integer" : type.min === 1 ? "a positive safe integer" : "a safe integer";
      if (!Number.isSafeInteger(n) || (type.min !== undefined && n < type.min) || (type.max !== undefined && n > type.max))
        throw new Error(`${where} must be ${range}, got ${JSON.stringify(raw)}`);
      return n;
    }
    case "number": {
      const n = raw.trim() === "" ? Number.NaN : Number(raw);
      if (!Number.isFinite(n) || (type.positive && n <= 0) || (type.nonNegative && n < 0))
        throw new Error(`${where} must be a ${type.positive ? "positive" : type.nonNegative ? "non-negative" : "finite"} number, got ${JSON.stringify(raw)}`);
      return n;
    }
    case "enum":
      if (!type.values.includes(raw)) throw new Error(`${where} must be ${plural(type.values)}, got ${JSON.stringify(raw)}`);
      return raw;
    case "model":
      if (!/^[A-Za-z0-9_.-]+(?::\S+)?$/.test(raw)) throw new Error(`${where} must name provider or provider:model, got ${JSON.stringify(raw)}`);
      return raw;
    case "url": {
      let ok = false;
      try { ok = ["http:", "https:"].includes(new URL(raw).protocol); } catch { ok = false; }
      if (!ok) throw new Error(`${where} must be an http(s) URL`);
      return raw;
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error(`${where} must be an ISO date, got ${JSON.stringify(raw)}`);
      return raw;
    case "time-zone":
      try { new Intl.DateTimeFormat("en", { timeZone: raw }); } catch { throw new Error(`${where} must be an IANA time zone, got ${JSON.stringify(raw)}`); }
      return raw;
    case "python-float":
      if (!PYTHON_FLOAT.test(raw.trim())) throw new Error(`${where} must be a number Python float() reads (e.g. 600, 0.5, inf), got ${JSON.stringify(raw)}`);
      return raw;
    case "python-int":
      if (!PYTHON_INT.test(raw.trim())) throw new Error(`${where} must be an integer Python int() reads, got ${JSON.stringify(raw)}`);
      return raw;
    default:
      return raw;
  }
}

/** Canonical command-line text for a value. */
export function formatValue(value: Value): string {
  if (value === true) return "1";
  if (value === false) return "0";
  return String(value);
}

function samePath(a: string, b: string): boolean {
  const canonical = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return canonical(a) === canonical(b);
}

function sameValue(spec: ParameterSpec, a: Value, b: Value): boolean {
  if (spec.type.kind === "path" && typeof a === "string" && typeof b === "string" && a && b) return samePath(a, b);
  return a === b;
}

/** ${RAVEN_DATA_ROOT} is the former spelling, still accepted in existing override files. */
const DATA_ROOT_PLACEHOLDERS = ["${FABENCH_DATA_ROOT}", "${RAVEN_DATA_ROOT}"];

/**
 * A path in a preset or override file may start with ${FABENCH_DATA_ROOT}, the configured data
 * root (FABENCH_DATA_ROOT or dataRoot; see docs/configuration.md). Nothing else is expanded.
 */
export function expandDataRoot(value: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const placeholder of DATA_ROOT_PLACEHOLDERS)
    if (value === placeholder || value.startsWith(`${placeholder}/`)) return dataRoot(env) + value.slice(placeholder.length);
  return value;
}

/** A JSON scalar from a preset or override file, checked with the same rules as the command line. */
function jsonValue(spec: ParameterSpec, raw: unknown, where: string, baseDirectory: string): Value {
  if (raw === null) return null;
  const kind = spec.type.kind;
  const expected = kind === "integer" || kind === "number" ? "number"
    : kind === "boolean" ? "boolean" : "string";
  const ok = typeof raw === expected || (kind === "boolean" && (raw === 0 || raw === 1));
  if (!ok) throw new Error(`${where}: ${spec.key} must be a JSON ${expected}${kind === "boolean" ? " (or 0/1)" : ""}`);
  const value = parseValue(spec, String(raw), `${where}: ${spec.key}`);
  return kind === "path" && typeof value === "string" && value ? resolve(baseDirectory, expandDataRoot(value)) : value;
}

// ---------------------------------------------------------------------------------------------
// Files

function readJsonObject(path: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${what} ${path}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${what} ${path} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Category sections → flat key/value map; unknown categories and keys fail. */
function readSections(body: Record<string, unknown>, where: string, baseDirectory: string, reserved: Set<string>) {
  const values = new Map<string, Value>();
  for (const [section, content] of Object.entries(body)) {
    if (reserved.has(section)) continue;
    if (!Object.hasOwn(CATEGORIES, section))
      throw new Error(`${where}: unknown section "${section}"; expected ${plural(Object.keys(CATEGORIES))}`);
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error(`${where}: ${section} must be an object`);
    for (const [key, raw] of Object.entries(content as Record<string, unknown>)) {
      const spec = PARAMETERS_BY_KEY.get(key);
      if (!spec) throw new Error(`${where}: unknown parameter "${key}"${suggest(key, [...PARAMETERS_BY_KEY.keys()])}`);
      if (spec.category !== section) throw new Error(`${where}: ${key} belongs in "${spec.category}", not "${section}"`);
      if (spec.meta || !spec.flag)
        throw new Error(`${where}: ${key} cannot be set from a file${spec.env ? ` (set ${spec.env} in the environment)` : ""}`);
      values.set(key, jsonValue(spec, raw, where, baseDirectory));
    }
  }
  return values;
}

export function presetDirectory(root = PKG_ROOT): string {
  return join(root, "config", "presets");
}

export function listPresets(root = PKG_ROOT): string[] {
  const dir = presetDirectory(root);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
}

/** The preset a run uses without --preset, named in config/default-preset.json of the checkout. */
export function defaultPreset(root = PKG_ROOT): string {
  const file = join(root, "config", "default-preset.json");
  const body = readJsonObject(file, "default preset file");
  if (body.schema !== DEFAULT_PRESET_SCHEMA || typeof body.preset !== "string" || !body.preset)
    throw new Error(`default preset file ${file}: needs schema ${DEFAULT_PRESET_SCHEMA} and a preset name`);
  return body.preset;
}

export function loadPreset(name: string, root = PKG_ROOT): RunPreset {
  const available = listPresets(root);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !available.includes(name))
    throw new Error(`Unknown preset "${name}"; available: ${available.join(", ") || "(none)"}`);
  const file = join(presetDirectory(root), `${name}.json`);
  const body = readJsonObject(file, "preset");
  const where = `preset ${name}`;
  const meta = new Set(["schema", "name", "description", "admission_profile", "allowed_arms", "locked", "forbidden", "baseline_profile"]);
  if (body.schema !== PRESET_SCHEMA) throw new Error(`${where}: schema must be ${PRESET_SCHEMA}`);
  if (body.name !== name) throw new Error(`${where}: name must equal the file name`);
  if (body.admission_profile !== "formal-232" && body.admission_profile !== "custom")
    throw new Error(`${where}: admission_profile must be formal-232 or custom`);
  const keys = (field: string, raw: unknown): string[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string" || !PARAMETERS_BY_KEY.has(k)))
      throw new Error(`${where}: ${field} must list parameter keys`);
    return raw as string[];
  };
  const values = readSections(body, where, dirname(file), meta);
  const locked = keys("locked", body.locked);
  let baseline: RunPreset["baseline"] = null;
  if (body.baseline_profile !== undefined) {
    const raw = body.baseline_profile as Record<string, unknown>;
    baseline = {
      locked: keys("baseline_profile.locked", raw.locked),
      values: readSections(raw, `${where} baseline_profile`, dirname(file), new Set(["locked"])),
    };
    for (const key of baseline.locked)
      if (!baseline.values.has(key)) throw new Error(`${where}: baseline_profile locks ${key} without a value`);
  }
  for (const key of locked) if (!values.has(key)) throw new Error(`${where}: locks ${key} without a value`);
  const allowedArms = body.allowed_arms === undefined ? null : body.allowed_arms;
  if (allowedArms !== null && (!Array.isArray(allowedArms) || allowedArms.some((a) => typeof a !== "string")))
    throw new Error(`${where}: allowed_arms must be a list of arm names`);
  return {
    name, file, description: String(body.description ?? ""), admissionProfile: body.admission_profile,
    allowedArms: allowedArms as string[] | null, locked, forbidden: keys("forbidden", body.forbidden), values, baseline,
  };
}

function readConfigFile(path: string): Map<string, Value> {
  const file = resolve(path);
  const body = readJsonObject(file, "configuration file");
  if (body.schema !== CONFIG_SCHEMA) throw new Error(`configuration file ${file}: schema must be ${CONFIG_SCHEMA}`);
  return readSections(body, `configuration file ${file}`, dirname(file), new Set(["schema", "description"]));
}

// ---------------------------------------------------------------------------------------------
// Command line

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

function suggest(name: string, candidates: string[]): string {
  const best = candidates.map((c) => [c, editDistance(name, c)] as const).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= Math.max(2, Math.floor(name.length / 4)) ? `; did you mean ${best[0]}?` : "";
}

interface CommandLine {
  values: Map<string, { flag: string; text: string }>;
  configs: string[];
}

/** `--flag value` and `--flag=value`; unknown, removed, duplicate or valueless flags fail. */
export function tokenize(raw: readonly string[]): CommandLine {
  const values = new Map<string, { flag: string; text: string }>();
  const configs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--") continue;
    const match = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(raw[i]!);
    if (!match) throw new Error(`Expected named experiment arguments, got ${JSON.stringify(raw[i])}`);
    const written = match[1]!;
    if (REMOVED_FLAGS[written]) throw new Error(REMOVED_FLAGS[written]);
    const flag = FLAG_ALIASES[written] ?? written;
    const spec = PARAMETERS_BY_FLAG.get(flag);
    if (!spec)
      throw new Error(`Unknown experiment argument --${written}${suggest(written, [...PARAMETERS_BY_FLAG.keys()].map((f) => f))}` +
        `; list them with pnpm exp:params`);
    const text = match[2] ?? raw[++i];
    if (text === undefined || text.startsWith("--")) throw new Error(`--${written} requires a value`);
    if (spec.repeatable) {
      configs.push(text);
      continue;
    }
    const previous = values.get(spec.key);
    if (previous)
      throw new Error(`Duplicate argument --${written}` +
        (previous.flag !== written ? ` (--${previous.flag} sets the same parameter)` : ""));
    values.set(spec.key, { flag: written, text });
  }
  return { values, configs };
}

// ---------------------------------------------------------------------------------------------
// Arms

/** Canonical comma list (`web` → `web-filter`, `mixed` → `both`) and the features it uses. */
export function canonicalCompare(spec: string, warnings: string[] = []) {
  const arms = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (!arms.length) throw new Error("--settings names no settings");
  let legacyWeb = false;
  const canonical = arms.map((arm) => {
    const result = canonicalArmSpec(arm);
    legacyWeb ||= result.usedLegacyWebAlias;
    const branches = result.canonical.replace(/\+expand$/, "").split("+");
    for (const branch of branches)
      if (!ARM_BRANCHES.has(branch))
        throw new Error(`unknown evidence source "${arm}" — expected none, frozen, web-filter, backsearch, provided or both, ` +
          `joined with "+" for a merged arm, optionally with a +expand suffix`);
    return result.canonical;
  });
  if (new Set(canonical).size !== canonical.length) throw new Error("Duplicate experiment arms (mixed is an alias for both)");
  if (legacyWeb) warnings.push(`"web" is now called "web-filter"; the old name is accepted, but manifests and results use the new name`);
  const parts = canonical.flatMap((arm) => arm.split("+"));
  return {
    compare: canonical.join(","),
    arms: canonical,
    frozen: parts.includes("frozen") || parts.includes("both"),
    webFilter: parts.includes("web-filter") || parts.includes("both"),
    expand: canonical.some((arm) => arm.endsWith("+expand")),
    backsearch: parts.includes("backsearch"),
  };
}

// ---------------------------------------------------------------------------------------------
// Resolution

export function resolveRunParameters(raw: readonly string[], context: ResolveContext = {}): ResolvedRunParameters {
  const root = context.root ?? PKG_ROOT;
  const cwd = context.cwd ?? process.cwd();
  const warnings: string[] = [];
  const commandLine = tokenize(raw);
  // A FABENCH_* variable may still be set under its former RAVEN_* name (see env-names.ts); the
  // record names the variable that was actually read.
  const envLookup = (spec: ParameterSpec): { name: string; text: string } | undefined => {
    const name = spec.envFile ? spec.env! : projectEnvName(spec.env!, context.env ?? process.env);
    const text = context.env ? context.env[name] : spec.envFile ? getEnvKey(name) : process.env[name];
    return text?.trim() ? { name, text } : undefined;
  };

  // Command-line values first: a malformed flag fails before any file is read.
  const cli = new Map<string, Value>();
  for (const [key, { flag, text }] of commandLine.values) {
    const spec = PARAMETERS_BY_KEY.get(key)!;
    if (spec.meta) continue;
    const value = parseValue(spec, text, `--${flag}`);
    cli.set(key, spec.type.kind === "path" && typeof value === "string" && value ? resolve(cwd, value) : value);
  }
  const presetName = commandLine.values.get("preset")?.text ?? defaultPreset(root);
  const preset = loadPreset(presetName, root);

  const entries = new Map<string, ResolvedEntry>();
  const layers: string[] = ["default"];
  for (const spec of RUN_PARAMETERS)
    if (!spec.meta) entries.set(spec.key, { value: spec.default, kind: "default", source: "default", applies: true });
  // Environment values replace only the built-in default. A malformed one is held back until
  // it is known whether this run reads the variable (see below).
  const envErrors = new Map<string, Error>();
  for (const spec of RUN_PARAMETERS) {
    if (!spec.env) continue;
    const found = envLookup(spec);
    if (found === undefined) continue;
    try {
      const value = parseValue(spec, found.text, `environment variable ${found.name}`);
      entries.set(spec.key, { value, kind: "env", source: `env:${found.name}`, applies: true });
    } catch (error) {
      envErrors.set(spec.key, error as Error);
    }
  }
  if ([...entries.values()].some((e) => e.kind === "env")) layers.push("env");
  // What a key resolves to when no preset, file or flag sets it; `null` in a file returns here.
  const base = new Map([...entries].map(([key, e]) => [key, { ...e }]));
  // Keys a later layer than the preset touched, including a reset: preset locks apply to them.
  const overridden = new Set<string>();
  const apply = (values: Map<string, Value>, kind: LayerKind, source: string) => {
    for (const [key, value] of values) {
      if (kind !== "preset") overridden.add(key);
      entries.set(key, value === null && kind === "config"
        ? { ...base.get(key)!, source: `${base.get(key)!.source} (reset by ${source})` }
        : { value, kind, source, applies: true });
    }
  };
  layers.push(`preset:${preset.name}`);
  apply(preset.values, "preset", `preset:${preset.name}`);
  for (const path of commandLine.configs) {
    const file = resolve(cwd, path);
    layers.push(`config:${file}`);
    apply(readConfigFile(file), "config", `config:${file}`);
  }
  const concurrencyFile = commandLine.values.get("concurrency_file")?.text;
  if (concurrencyFile) {
    const file = resolve(cwd, concurrencyFile);
    layers.push(`concurrency-file:${file}`);
    const values = new Map<string, Value>();
    for (const [key, value] of Object.entries(readConcurrencyFile(file)))
      values.set(key, parseValue(PARAMETERS_BY_KEY.get(key)!, String(value), `${file}: ${key}`));
    apply(values, "config", `concurrency-file:${file}`);
  }
  if (cli.size) layers.push("cli");
  apply(cli, "cli", "cli");

  const entry = (key: string) => entries.get(key)!;
  const value = (key: string) => entry(key).value;

  // Arms decide which settings apply; they are validated before anything depends on them.
  const arms = canonicalCompare(String(value("compare")), warnings);
  entry("compare").value = arms.compare;
  const quality = value("retrieval_profile") === "quality-v1";
  const uses = (condition: Condition): boolean => {
    switch (condition) {
      case "quality": return quality;
      case "baseline": return !quality;
      case "frozen": return arms.frozen;
      case "web-filter": return arms.webFilter;
      case "expand": return arms.expand;
      case "backsearch": return arms.backsearch;
    }
  };
  if (preset.allowedArms && arms.arms.some((arm) => !preset.allowedArms!.includes(arm)))
    throw new Error(`Preset ${preset.name} allows only ${plural(preset.allowedArms)} arms; got ${arms.compare}`);
  if (!quality && preset.baseline)
    for (const [key, required] of preset.baseline.values)
      if (!overridden.has(key)) entries.set(key, { value: required, kind: "preset", source: `preset:${preset.name}`, applies: true });

  // Applicability, then computed defaults for keys no layer set (or a file reset).
  const derive: DeriveContext = {
    value, uses,
    sharedFrozenCacheAvailable: context.sharedFrozenCacheAvailable ?? sharedFrozenCacheAvailable(),
    resultsDir: context.resultsDir ?? RESULTS_DIR,
  };
  for (const spec of RUN_PARAMETERS) {
    if (spec.meta) continue;
    const current = entry(spec.key);
    current.applies = (spec.when ?? []).every(uses);
    if (spec.derived && current.kind === "default")
      current.value = current.applies ? spec.derived.compute(derive) : null;
  }

  // Preset rules on the final values: fixed values and keys the preset leaves out.
  const enforce = (key: string, required: Value, what: string) => {
    const spec = PARAMETERS_BY_KEY.get(key)!, current = entry(key);
    if (overridden.has(key) && (current.applies || current.kind === "cli") && !sameValue(spec, current.value, required))
      throw new Error(`${what} requires --${spec.flag} ${formatValue(required)} (got ${current.value === null ? "no value" : formatValue(current.value)} from ` +
        `${current.source}); choose another preset (for example --preset custom) for a different setting`);
  };
  for (const key of preset.locked) enforce(key, preset.values.get(key)!, `Preset ${preset.name}`);
  if (!quality && preset.baseline)
    for (const key of preset.baseline.locked) enforce(key, preset.baseline.values.get(key)!, `Preset ${preset.name} under baseline`);
  for (const key of preset.forbidden)
    if (overridden.has(key) && value(key) !== null)
      throw new Error(`--${PARAMETERS_BY_KEY.get(key)!.flag} is not part of the ${preset.name} preset`);

  // A malformed environment variable stops the run only if the run reads it.
  const providers = new Set(["llm", "leak_llm", "leak_fallback_llm", "query_expansion_model"]
    .map((key) => value(key)).filter((v): v is string => typeof v === "string").map((v) => v.split(":")[0]!));
  if (arms.expand) providers.add("deepseek"); // +expand rewrites queries with DeepSeek Flash.
  for (const [key, error] of envErrors) {
    const spec = PARAMETERS_BY_KEY.get(key)!, current = entry(key);
    const usage = spec.usedBy ?? { conditions: spec.when ?? [] };
    const shadowed = current.kind !== "default";
    const used = (usage.conditions ?? []).every(uses) && (!usage.providers || usage.providers.some((p) => providers.has(p)));
    if (used && !shadowed) throw error;
    warnings.push(`${error.message}; ${shadowed ? `replaced by ${current.source}` : "this run does not read it"}; ignored`);
  }

  // Values a preset or file set that these arms or this retrieval profile do not use.
  const dropped = RUN_PARAMETERS.filter((spec) => {
    const current = entries.get(spec.key);
    return current && !current.applies && current.value !== null && (current.kind === "preset" || current.kind === "config");
  }).map((spec) => `${spec.key} (${entry(spec.key).source})`);
  if (dropped.length)
    warnings.push(`These values do not apply to --settings ${arms.compare} (${quality ? "quality-v1" : "baseline"}) and are not passed to the runner: ${dropped.join(", ")}`);

  // Cross-parameter rules shared by every entry path.
  const text = (key: string) => (typeof value(key) === "string" ? (value(key) as string) : undefined);
  if (value("ids") !== null || value("ids_file") !== null) selectedQuestionIds(text("ids"), text("ids_file"));
  const reason = text("replicate_reason")?.trim() ?? "";
  if (value("replicate") === true && !reason)
    throw new Error("--replicate 1 requires a nonempty --replicate-reason");
  if (reason && value("replicate") !== true)
    throw new Error("--replicate-reason requires --replicate 1; otherwise successful cells would be reused");
  if (value("search_provider") === "auto" && arms.webFilter)
    warnings.push("--search-provider auto takes the first of anthropic, serper, zhipu that has a key; formal experiments should name serper");

  // Pass on every value the runner should see. Environment values stay in the environment;
  // a default, preset or override-file value that does not apply to these arms is recorded
  // but not passed on; a command-line value always is, so the runner rejects a misplaced flag.
  const args = ["--preset", preset.name];
  for (const spec of RUN_PARAMETERS) {
    const current = entry(spec.key);
    if (!spec.flag || spec.meta || current.value === null || current.kind === "env") continue;
    if (!current.applies && current.kind !== "cli") continue;
    if (current.kind === "default" && spec.emitDefault === false) continue;
    args.push(`--${spec.flag}`, formatValue(current.value));
  }
  return new ResolvedRunParameters(preset, layers, entries, args, warnings, [...raw]);
}

/** Write bench defaults the vendor would otherwise fill differently (GLM endpoint). */
export function applyEnvironmentDefaults(resolved: ResolvedRunParameters, env: NodeJS.ProcessEnv = process.env): void {
  for (const spec of RUN_PARAMETERS) {
    if (!spec.exportDefault || !spec.env) continue;
    const current = resolved.entries.get(spec.key)!;
    if (current.kind === "default" && current.value !== null && !env[spec.env]) env[spec.env] = formatValue(current.value);
  }
}
