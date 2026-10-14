import { DatabaseSync } from "node:sqlite";
import type { RegistryData } from "./records.js";

/** Load the registry records used by the Beta Raven analysis. */
export function readRegistryData(path: string): RegistryData {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = <T>(sql: string) => db.prepare(sql).all() as unknown as T[];
  try {
    return {
      runs: rows("SELECT * FROM runs ORDER BY started_at_utc"),
      canonicalCells: rows(
        "SELECT * FROM canonical_cells WHERE question_id LIKE 'braven::%' ORDER BY condition_id, question_id",
      ),
      statusRows: rows("SELECT run_id, condition_id, status FROM run_cells"),
    };
  } finally {
    db.close();
  }
}
