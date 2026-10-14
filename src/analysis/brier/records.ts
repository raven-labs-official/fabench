import type { ResultScope } from "../result-scope.js";

export interface Policy {
  schema_version: string;
  minimum_expected_questions: number;
  primary_coverage_threshold: number;
  invalid_conditions: Record<string, string>;
  diagnostic_conditions: Record<string, string>;
}

export interface RegistryRun {
  run_id: string;
  tag: string;
  owner: string;
  status: string;
  expected_cells: number;
  reused_cells: number;
  succeeded_cells: number;
  failed_cells: number;
  interrupted_cells: number;
  config_json: string;
  trace_directory: string | null;
  started_at_utc: string;
  last_heartbeat_utc: string;
  finished_at_utc: string | null;
  error: string | null;
}

export interface RunConfig {
  llm?: string;
  dataset?: string;
  question_set_id?: string;
  question_sample_id?: string;
  selected_question_ids?: string[];
  conditions?: ConditionConfig[];
  llm_client?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  conc?: number;
  reader?: string;
  code_identity?: Record<string, unknown>;
}

export interface ConditionConfig {
  condition_id: string;
  arm: string;
  question_set_id?: string;
  question_sample_id?: string;
  model?: string;
  reasoning_mode?: string | null;
  thinking_effort?: string | null;
  requested_thinking_effort?: string | null;
  reasoning_source?: string;
  harness?: string;
  search_type?: string;
  search_expansion?: boolean;
  max_tool_calls?: number;
  max_search_calls?: number;
  max_fetch_calls?: number;
  max_results_per_search?: number | null;
  budget_scope?: string;
  filter_model?: string | null;
  filter_fallback_model?: string | null;
  filter_policy?: Record<string, unknown> | null;
  search_provider?: string | null;
  code_fingerprint_sha256?: string;
}

export interface CanonicalCell {
  condition_id: string;
  question_id: string;
  arm: string;
  probability: number;
  source_run_id: string;
  trace_path: string | null;
  summary_json: string;
  completed_at_utc: string;
}

export interface FailedCellCount {
  condition_id: string;
  failed: number;
  interrupted: number;
  running: number;
  claimed: number;
}

export type PublicationStatus =
  | "primary"
  | "smoke"
  | "running-partial"
  | "diagnostic-only"
  | "invalid"
  | "superseded";

export interface GroupDraft {
  group_id: string;
  condition_id: string;
  model: string;
  provider: string;
  model_name: string;
  mode: string;
  question_set_id: string;
  question_sample_id: string | null;
  expected_question_ids: string[];
  expected_questions: number;
  answered_questions: number;
  coverage: number;
  failed_cells: number;
  interrupted_cells: number;
  running_cells: number;
  claimed_cells: number;
  latest_run_status: string;
  result_scope: ResultScope;
  publication_status: PublicationStatus;
  validity_reason: string | null;
  representative_run_id: string;
  representative_tag: string;
  source_run_ids: string[];
  owners: string[];
  started_at_utc: string;
  finished_at_utc: string | null;
  condition: ConditionConfig;
  llm_client: Record<string, unknown> | null;
  reasoning: Record<string, unknown> | null;
  concurrency: number | null;
  reader: string | null;
  code_identity: Record<string, unknown> | null;
  cells: CanonicalCell[];
}

export interface CellStatus {
  run_id: string;
  condition_id: string;
  status: string;
}
export interface RegistryData {
  runs: RegistryRun[];
  canonicalCells: CanonicalCell[];
  statusRows: CellStatus[];
}
