import { buildFrozenIndex } from '../src/corpus/frozen-index.js';
const [source,index,anchor]=process.argv.slice(2);
if(!source||!index||!anchor)throw new Error('source.db frozen-index.db exact-anchor required');
const abort=new AbortController();
process.on('SIGTERM',()=>abort.abort());process.on('SIGINT',()=>abort.abort());
await buildFrozenIndex(source,index,anchor,{signal:abort.signal,onProgress:m=>console.log(JSON.stringify(m))});
