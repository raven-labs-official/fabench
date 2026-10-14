import test from 'node:test';
import assert from 'node:assert/strict';
import {withTiming,timed,summarizeTiming,type TimingEvent} from './timeline.js';

test('parallel work preserves correlation and union coverage reports an explicit residual',async()=>{
 const events:TimingEvent[]=[];
 await withTiming({questionId:'q'},event=>events.push(event),()=>timed('question',async()=>{
   await Promise.all([timed('one',()=>new Promise(r=>setTimeout(r,20)),{toolCallId:'t1'}),timed('two',()=>new Promise(r=>setTimeout(r,20)),{toolCallId:'t2'})]);
   await new Promise(r=>setTimeout(r,5));
 }));
 const report=summarizeTiming(events),root=report.roots[0]!;
 assert.equal(report.incompleteSpans,0);assert.ok(root.unattributedMs>0);assert.ok(root.coveredMs<=root.elapsedMs);
 assert.ok(report.stages.one!.workMs+report.stages.two!.workMs>root.coveredMs);
 assert.ok(events.every(e=>e.questionId==='q'));
 await assert.rejects(withTiming({},e=>events.push(e),()=>timed('failure',async()=>{throw new Error('test');})),/test/);
 assert.equal(events.at(-1)?.status,'failed');
});
