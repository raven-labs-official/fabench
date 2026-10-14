import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { createRetrievalSession } from '../src/api/session.js';
import { projectEnv } from "../src/env-names.js";

const args = process.argv.slice(2);
// pnpm may preserve its separator before the command, or after the script's
// fixed 'search' command. Only remove these launcher separators.
if (args[0] === '--') args.shift();
if (args[1] === '--') args.splice(1, 1);
const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
  mode: {type:'string',default:'frozen'}, 'frozen-workers':{type:'string'},'frozen-queue':{type:'string'},'as-of': {type:'string'}, query: {type:'string'}, url: {type:'string'},
  n: {type:'string',default:'10'}, corpus: {type:'string'}, archive: {type:'string'},
  reviewer: {type:'string'}, provider: {type:'string'}, 'no-reader': {type:'boolean'},
  'content-processing': {type:'string'}, 'query-expansion-model': {type:'string'}, 'wiki-cache': {type:'string'}, 'wiki-manifest': {type:'string'}, 'wiki-index': {type:'string'}, browser: {type:'boolean'}, 'candidate-concurrency': {type:'string'}, 'review-concurrency': {type:'string'},
  'search-http-concurrency': {type:'string'}, 'cleaning-concurrency': {type:'string'}, scheduling: {type:'string'}, 'source-manifest':{type:'string'},'shared-review-cache':{type:'string'},'fixed-document-manifest':{type:'string'},
  question: {type:'string'}, criteria: {type:'string'}, help: {type:'boolean'},
  profile: {type:'string',default:'quality-v1'}, 'evidence-dir': {type:'string'}, 'return-chars': {type:'string'},
  offset: {type:'string',default:'0'}, 'aliases-file': {type:'string'},
  entity: {type:'string'}, since: {type:'string'}, until: {type:'string'}, cursor: {type:'string'}, limit: {type:'string'},
}});
if (values.help || !positionals.length) {
  console.log('fabench-retrieval search|fetch|browse --mode frozen|web-filter --as-of ISO_TIMESTAMP [--query TEXT|--url URL] [--n 10] [--corpus DB] [--archive JSONL] [--question TEXT] [--criteria TEXT]\nBrowse frozen captures: browse --entity TEXT [--since ISO_DATE_OR_TIMESTAMP] [--until ISO_DATE_OR_TIMESTAMP] [--cursor TOKEN] [--limit 20]. Browse returns every matching capture across pages, including full stored bodies. URL fetch returns the newest selected capture; older captures are read directly from their browse rows.\nOptional: --content-processing single-pass|whole-document|integrated (default single-pass); --source-manifest JSON; --query-expansion-model provider:model (bounded paid equivalent phrases, frozen); --wiki-cache DB [--wiki-manifest JSON [--wiki-index DB] for frozen joint search]; --search-http-concurrency N (process-wide HTTP requests, default 16; separate from provider limits) --candidate-concurrency N --review-concurrency N --cleaning-concurrency N --scheduling rolling|batches; --browser (opt-in rendered-page fallback); --evidence-dir DIR [--return-chars N] [--offset N] [--aliases-file JSON]. Current retrieval is the default. Artifacts default to FABENCH_RETRIEVAL_EVIDENCE_DIR or results/retrieval-artifacts under FABENCH_RESULTS_DIR/current working directory. Web mode uses one content-processing completion per uncached ordinary page; registered sources and historical revisions bypass it. Legacy replication only: --profile baseline; old diagnostic flags remain under pnpm search:legacy.');
} else {
  let session: ReturnType<typeof createRetrievalSession> | undefined;
  try {
    const command = positionals[0];
    if (positionals.length !== 1 || !['search','fetch','browse'].includes(command!)) throw new Error('expected search, fetch, or browse');
    if (!values['as-of']) throw new Error('--as-of is required');
    if (values.mode !== 'frozen' && values.mode !== 'web-filter') throw new Error('invalid mode');
    if (!['baseline', 'quality-v1'].includes(values.profile)) throw new Error('invalid profile');
    session = createRetrievalSession({ mode: values.mode, asOf: values['as-of'],
      sharedCacheDirectory:values['shared-review-cache'],fixedDocumentManifestFile:values['fixed-document-manifest'],
      frozenWorkers:values['frozen-workers']===undefined?undefined:Number(values['frozen-workers']),frozenQueue:values['frozen-queue']===undefined?undefined:Number(values['frozen-queue']),
      corpusPath: values.corpus ?? projectEnv("FABENCH_CORPUS_DB"), archiveFile: values.archive,
      searchHttpConcurrency: values['search-http-concurrency'] === undefined ? undefined : Number(values['search-http-concurrency']),
      reviewer: values.reviewer, searchProvider: values.provider, reader: !values['no-reader'],
      browser: values.browser, queryExpansionModel: values['query-expansion-model'], wikiCachePath: values['wiki-cache'], wikiManifestFile: values['wiki-manifest'], wikiIndexFile: values['wiki-index'],
      webExecution: values['candidate-concurrency'] !== undefined || values.scheduling !== undefined ? {
        candidateConcurrency: values['candidate-concurrency'] === undefined ? undefined : Number(values['candidate-concurrency']),
        scheduling: values.scheduling as 'rolling' | 'batches' | undefined } : undefined,
      evidenceReview: values['review-concurrency']===undefined&&values['content-processing']===undefined&&values['source-manifest']===undefined ? undefined : { concurrency: values['review-concurrency']===undefined?undefined:Number(values['review-concurrency']), processing:values['content-processing'] as 'whole-document'|'integrated'|'single-pass'|undefined,sourceManifestFile:values['source-manifest'] },
      cleaningConcurrency: values['cleaning-concurrency'] === undefined ? undefined : Number(values['cleaning-concurrency']),
      profile: values.profile as 'baseline' | 'quality-v1', evidenceDirectory: values['evidence-dir'],
      returnChars: values['return-chars'] === undefined ? undefined : Number(values['return-chars']),
      queryAliases: values['aliases-file'] ? JSON.parse(readFileSync(values['aliases-file'], 'utf8')) : undefined,
      context: {question:values.question,resolutionCriteria:values.criteria} });
    const payload = command === 'search' ? {results: await session.search(values.query ?? '', Number(values.n))}
      : command === 'browse' ? await session.browse({ entity: values.entity ?? '', since: values.since,
        until: values.until, cursor: values.cursor, limit: values.limit === undefined ? undefined : Number(values.limit) })
      : {doc: await session.fetch(values.url ?? '', Number(values.offset))};
    const version = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
    console.log(JSON.stringify({schema:'raven.retrieval-response.v1',infra_version:version,identity:session.identity,...payload,stats:session.stats()}));
  } catch (error) {
    console.error(JSON.stringify({error:error instanceof Error ? error.message : String(error)})); process.exitCode=1;
  } finally {session?.close();}
}
