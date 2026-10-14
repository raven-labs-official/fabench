#!/usr/bin/env node
import { resolve } from "node:path";
import { verifyTraceArchive } from "./trace-archive.js";

const path = process.argv.slice(2).find((arg) => arg !== "--");
if (!path) {
  console.error("usage: pnpm trace:verify -- results/traces/<run>");
  process.exitCode = 2;
} else {
  const directory = resolve(path);
  const result = verifyTraceArchive(directory);
  console.log(
    `${result.ok ? "✓" : "✗"} ${directory}: ${result.traces} traces, ` +
      `${result.completeTraces} complete`,
  );
  for (const issue of result.issues) console.error(`  - ${issue}`);
  if (!result.ok) process.exitCode = 1;
}
