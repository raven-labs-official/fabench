#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { auditExposure } from "./exposure-audit.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const list = args[args.indexOf("--traces") + 1],
  output = args[args.indexOf("--output") + 1];
if (
  !args.includes("--traces") ||
  !args.includes("--output") ||
  !list ||
  !output
)
  throw new Error(
    "usage: pnpm trace:exposure -- --traces paths.txt --output audit.jsonl",
  );
const paths = [
  ...new Set(
    readFileSync(list, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
const rows = paths.map((path) => {
  try {
    return auditExposure(path);
  } catch (error) {
    return {
      trace: path,
      issues: [{ error: (error as Error).message }],
      findings: [],
    };
  }
});
writeFileSync(
  output,
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    traces: rows.length,
    with_findings: rows.filter((r) => r.findings.length).length,
    with_read_issues: rows.filter((r) => r.issues.length).length,
  }),
);
