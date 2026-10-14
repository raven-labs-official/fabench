import { readFileSync } from "node:fs";

export function normalizeQuestionId(id: string): string {
  return id.trim().replace(/^braven::/i, "").toLowerCase();
}

/** Only an omitted subset uses default sampling; an explicit empty subset is an error. */
export function selectedQuestionIds(
  ids: string | undefined,
  idsFile: string | undefined,
): string[] | undefined {
  if (ids === undefined && idsFile === undefined) return undefined;
  if (ids !== undefined && idsFile !== undefined) {
    throw new Error("Use either --ids or --ids-file, not both");
  }

  let text = ids ?? "";
  if (idsFile !== undefined) {
    if (!idsFile.trim()) throw new Error("--ids-file requires a file path");
    try {
      text = readFileSync(idsFile, "utf8");
    } catch (error) {
      throw new Error(`Cannot read --ids-file: ${idsFile}`, { cause: error });
    }
  }
  const selected = text
    .split(/\r?\n/)
    .filter(line => idsFile === undefined || !line.trimStart().startsWith("#"))
    .flatMap(line => line.split(/[\s,]+/))
    .filter(Boolean);
  if (!selected.length) {
    throw new Error("--ids/--ids-file selects no questions; no experiment will be registered");
  }
  return selected;
}
