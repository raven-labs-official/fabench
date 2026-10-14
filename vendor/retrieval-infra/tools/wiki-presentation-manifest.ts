/** Writes a presentation manifest for an existing fixed Wiki manifest.
 *
 *   wiki-presentation-manifest.ts cache.sqlite manifest.json out.json
 *
 * The page set and revisions stay exactly as in the input. Each revision gains the title shown
 * to the model (with its evidence), the titles that open it through an ordinary /wiki/ address,
 * and the snapshot shows plain text instead of wikitext. The output is a new manifest, so
 * experiments using it form a new condition; the input file is not touched.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { WikipediaCache, withWikiPresentation, type WikiManifest } from '../src/corpus/wikipedia-cache.js';

const [cachePath, manifestPath, outPath] = process.argv.slice(2);
if (!cachePath || !manifestPath || !outPath) throw new Error('cache.sqlite manifest.json out.json required');
const cache = new WikipediaCache(cachePath, true);
try {
  const { manifest, report } = withWikiPresentation(cache, JSON.parse(readFileSync(manifestPath, 'utf8')) as WikiManifest);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ out: outPath, ...report }));
} finally { cache.close(); }
