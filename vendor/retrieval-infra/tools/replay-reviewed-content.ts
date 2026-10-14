/** Re-run deterministic removal validation over an archived model reply. No model/client construction. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {EvidenceStore,sha256} from '../src/retrieval/evidence-store.js';
import {selectSinglePassText} from '../src/retrieval/single-pass-content.js';
import {splitReaderBlocks} from '../src/retrieval/reader-cleaner.js';
const [run,out]=process.argv.slice(2);if(!run||!out)throw new Error('Usage: replay-reviewed-content.ts ARCHIVED_RUN OUTPUT_JSON');
const manifest=JSON.parse(readFileSync(join(run,'manifest.json'),'utf8'));
const artifacts=new EvidenceStore(manifest.config.artifacts_directory);
const rows=JSON.parse(readFileSync(join(run,'sample-results.json'),'utf8')) as {sample_id:string;document_id:string}[];
const results=rows.map(row=>{
 const receipt=JSON.parse(readFileSync(join(run,row.sample_id,'receipt.json'),'utf8'));
 const responseId=receipt.trace.findLast((item:any)=>item.responseId)?.responseId;
 const candidate=readFileSync(join(run,row.sample_id,'candidate.md'),'utf8');
 if(!responseId)return {sample:row.sample_id,status:'no-model-response',recordedStatus:receipt.status};
 const response=artifacts.get<any>(responseId),blocks=splitReaderBlocks(candidate);
 try{
  const selected=selectSinglePassText(response.completion.text,blocks),admitted=join(run,row.sample_id,'admitted.md');
  return {sample:row.sample_id,responseId,candidateSha256:sha256(candidate),status:selected.decision.status,recordedStatus:receipt.status,
   removed:selected.removed,outputSha256:sha256(selected.body),matchesRecordedDelivery:existsSync(admitted)?selected.body===readFileSync(admitted,'utf8'):null,
   protectedBlocks:blocks.filter(b=>b.protected).length,protectedPreserved:blocks.filter(b=>b.protected).every(b=>selected.body.includes(b.text))};
 }catch(error){return {sample:row.sample_id,responseId,status:'validation-error',recordedStatus:receipt.status,error:error instanceof Error?error.message:String(error)};}
});
writeFileSync(out,JSON.stringify({newModelCalls:0,sourceRun:manifest.run_id,results},null,2)+'\n',{flag:'wx',mode:0o640});
console.log(JSON.stringify({samples:results.length,mismatches:results.filter(r=>r.matchesRecordedDelivery===false).length,newModelCalls:0}));
