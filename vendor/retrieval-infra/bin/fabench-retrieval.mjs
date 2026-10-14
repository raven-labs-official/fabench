#!/usr/bin/env node
import { register } from 'tsx/esm/api';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Standalone releases own .venv; a bench-vendored release uses its enclosing
// bench .venv. An explicitly selected interpreter always takes precedence.
if (!process.env.HTMLDATE_PYTHON) {
  for (const relative of ['../.venv/bin/python', '../../../.venv/bin/python']) {
    const python = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(python)) { process.env.HTMLDATE_PYTHON = python; break; }
  }
}
register();
await import('../tools/infra-cli.ts');
