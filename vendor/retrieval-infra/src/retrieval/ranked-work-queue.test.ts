import test from 'node:test';
import assert from 'node:assert/strict';
import {rankedWork} from './ranked-work-queue.js';

test('completed duplicate pages release slots before a slow higher rank; selection stays ranked',async()=>{
 let release!:()=>void;const slow=new Promise<void>(r=>release=r),started:number[]=[],selected:string[]=[];
 const job=rankedWork(['slow','copy','copy','replacement'],{concurrency:3,scheduling:'rolling'},async(value,index)=>{
   started.push(index);if(index===0)await slow;if(index===3)release();return value;
 },value=>{if(!selected.includes(value))selected.push(value);},()=>3-selected.length,(a,b)=>a===b);
 await job;assert.deepEqual(started,[0,1,2,3]);assert.deepEqual(selected,['slow','copy','replacement']);
});

test('fatal errors drain all already-started pages before the caller can close logging',async()=>{
 const events:string[]=[];
 await assert.rejects(rankedWork([0,1,2],{concurrency:2,scheduling:'rolling'},async(index)=>{
   if(!index)throw new Error('provider unavailable');await new Promise(r=>setTimeout(r,20));events.push('drained');return index;
 },()=>{},()=>3),/provider unavailable/);
 assert.deepEqual(events,['drained']);
});
