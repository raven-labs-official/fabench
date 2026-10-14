/** Compact storage for corpus article bodies.
 *
 * A body is stored either as plain TEXT (every row written before compaction) or as a BLOB:
 * the bytes "RB", codec 1, a big-endian uint32 dictionary id, then a raw-deflate stream
 * compressed against that preset dictionary. Each body is compressed on its own, so one
 * article can still be read by id. Dictionaries live in the corpus itself, so a copied
 * corpus remains readable without side files.
 *
 * Decoding returns the exact original string. Frozen reads still compare the decoded body
 * with the captured hash, so a codec fault fails the read instead of changing evidence.
 * Deflate is used because Node and Python both ship it as a stable API.
 */
import type { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const BODY_DICTIONARY_TABLE = 'corpus_body_dictionaries';
export const BODY_CODEC_DEFLATE_DICTIONARY = 1;
const MAGIC = [0x52, 0x42] as const;
const HEADER_BYTES = 7;
/** Deflate addresses at most 32 KiB of history, so a longer dictionary would be truncated. */
export const MAX_DICTIONARY_BYTES = 32 * 1024;

export interface BodyDictionary { id: number; codec: number; sha256: string; dictionary: Buffer }

export const dictionarySha256 = (dictionary: Uint8Array) => createHash('sha256').update(dictionary).digest('hex');

export function createBodyDictionaryTable(db: DatabaseSync, schema = 'main') {
  db.exec(`CREATE TABLE IF NOT EXISTS ${schema}.${BODY_DICTIONARY_TABLE} (
    id INTEGER PRIMARY KEY, codec INTEGER NOT NULL, sha256 TEXT NOT NULL,
    dictionary BLOB NOT NULL, created_at TEXT NOT NULL)`);
}

export class BodyCodec {
  private readonly dictionaries: ReadonlyMap<number, Buffer>;
  /** Dictionary used for new rows: the most recent one. */
  readonly encodeWith: number;

  constructor(dictionaries: Iterable<BodyDictionary>, private readonly level = 9) {
    const byId = new Map<number, Buffer>();
    for (const d of dictionaries) {
      if (d.codec !== BODY_CODEC_DEFLATE_DICTIONARY) throw new Error(`unsupported body codec ${d.codec}`);
      if (!Number.isInteger(d.id) || d.id < 1 || d.id > 0xffffffff) throw new Error('invalid body dictionary id');
      if (!d.dictionary.length || d.dictionary.length > MAX_DICTIONARY_BYTES) throw new Error('invalid body dictionary size');
      if (dictionarySha256(d.dictionary) !== d.sha256) throw new Error(`body dictionary ${d.id} differs from its recorded hash`);
      byId.set(d.id, d.dictionary);
    }
    if (!byId.size) throw new Error('a body codec needs at least one dictionary');
    this.dictionaries = byId;
    this.encodeWith = Math.max(...byId.keys());
  }

  /** The corpus's codec, or null when it holds only plain-text bodies. */
  static load(db: DatabaseSync, schema = 'main', level?: number): BodyCodec | null {
    const table = db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(BODY_DICTIONARY_TABLE);
    if (!table) return null;
    const rows = db.prepare(`SELECT id, codec, sha256, dictionary FROM ${schema}.${BODY_DICTIONARY_TABLE} ORDER BY id`).all() as
      { id: number; codec: number; sha256: string; dictionary: Uint8Array }[];
    if (!rows.length) return null;
    return new BodyCodec(rows.map(r => ({ ...r, dictionary: Buffer.from(r.dictionary) })), level);
  }

  encode(text: string): Uint8Array {
    if (typeof text !== 'string') throw new Error('only text bodies can be encoded');
    const dictionary = this.dictionaries.get(this.encodeWith)!;
    const payload = deflateRawSync(Buffer.from(text, 'utf8'), { level: this.level, dictionary });
    const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
    out[0] = MAGIC[0]; out[1] = MAGIC[1]; out[2] = BODY_CODEC_DEFLATE_DICTIONARY;
    out.writeUInt32BE(this.encodeWith, 3);
    payload.copy(out, HEADER_BYTES);
    return out;
  }

  decode(value: unknown): string {
    return decodeBody(value, this);
  }

  dictionary(id: number): Buffer | undefined { return this.dictionaries.get(id); }
}

/** Makes unqualified `docs` return decoded bodies on this connection: a temporary view over
 * main.docs shadows the table. Writes must name main.docs. Returns null for a plain-text corpus. */
export function installBodyView(db: DatabaseSync): BodyCodec | null {
  const codec = BodyCodec.load(db, 'main');
  if (!codec) return null;
  db.function('raven_corpus_body', { deterministic: true }, (body) => decodeBody(body, codec));
  db.exec(`CREATE TEMP VIEW docs AS SELECT id, url, title, raven_corpus_body(body) AS body,
    crawl_date, crawl_ms, wire, source FROM main.docs`);
  return codec;
}

/** Plain TEXT passes through unchanged, so uncompressed corpora need no codec. */
export function decodeBody(value: unknown, codec: BodyCodec | null): string {
  if (typeof value === 'string') return value;
  if (!(value instanceof Uint8Array)) throw new Error('corpus body is neither text nor an encoded blob');
  if (value.length < HEADER_BYTES || value[0] !== MAGIC[0] || value[1] !== MAGIC[1] || value[2] !== BODY_CODEC_DEFLATE_DICTIONARY)
    throw new Error('corpus body blob has an unknown encoding');
  const id = Buffer.from(value.buffer, value.byteOffset, value.byteLength).readUInt32BE(3);
  const dictionary = codec?.dictionary(id);
  if (!dictionary) throw new Error(`corpus body needs missing dictionary ${id}`);
  return inflateRawSync(value.subarray(HEADER_BYTES), { dictionary }).toString('utf8');
}

/** Builds a preset dictionary from sample bodies: the most frequent 64-byte fragments,
 * least frequent first, because deflate reaches the end of a dictionary most cheaply. */
export function trainBodyDictionary(samples: Iterable<string>, size = MAX_DICTIONARY_BYTES): Buffer {
  if (!Number.isInteger(size) || size < 1024 || size > MAX_DICTIONARY_BYTES) throw new Error('dictionary size must be 1–32 KiB');
  const counts = new Map<string, number>();
  for (const text of samples) {
    const bytes = Buffer.from(text, 'utf8');
    for (let i = 0; i + 64 <= bytes.length; i += 32) {
      const key = bytes.subarray(i, i + 64).toString('latin1');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const frequent = [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const chosen: Buffer[] = [];
  let total = 0;
  for (const [key] of frequent) {
    if (total + 64 > size) break;
    chosen.push(Buffer.from(key, 'latin1'));
    total += 64;
  }
  if (!chosen.length) throw new Error('samples share no repeated fragments; cannot train a dictionary');
  return Buffer.concat(chosen.reverse());
}
