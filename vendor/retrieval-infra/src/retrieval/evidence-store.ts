import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

/** Immutable, hash-checked research artifacts. Never put this directory in source control. */
export class EvidenceStore {
  readonly directory: string;
  constructor(directory: string) {
    if (!directory.trim()) throw new Error('an evidence directory is required');
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true, mode: 0o2750 });
  }
  put(value: unknown): string {
    const raw = JSON.stringify(value), id = sha256(raw);
    const temporary = join(this.directory, `.${id}-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, raw, { flag: 'wx', mode: 0o640 });
      try { linkSync(temporary, join(this.directory, `${id}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; this.get(id); }
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    return id;
  }
  get<T = unknown>(id: string): T {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid artifact ID');
    const raw = readFileSync(join(this.directory, `${id}.json`), 'utf8');
    if (sha256(raw) !== id) throw new Error('evidence artifact hash mismatch');
    return JSON.parse(raw) as T;
  }
}
