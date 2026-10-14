import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {summarizeTiming,type TimingEvent} from '../src/observability/timeline.js';
const [root,out]=process.argv.slice(2);if(!root||!out)throw new Error('Usage: summarize-stage-timing.ts ARTIFACT_DIRECTORY OUTPUT_JSON');
const events:TimingEvent[]=[];
for(const name of readdirSync(root).sort())if(/^[a-f0-9]{64}\.json$/.test(name)){
 const row=JSON.parse(readFileSync(join(root,name),'utf8'));
 if(row.operation==='stage-timing')events.push(row.event);
}
writeFileSync(out,JSON.stringify({eventCount:events.length,...summarizeTiming(events)},null,2)+'\n',{flag:'wx'});
