import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type TimingContext = {traceId:string;spanId?:string;questionId?:string;toolCallId?:string;candidateId?:string};
export type TimingEvent = TimingContext & {spanId:string;parentId?:string;stage:string;phase:'queued'|'admitted'|'started'|'finished';
  atUtc:string;monotonicMs:number;status?:'success'|'failed';errorName?:string;
  python?:{processId:number;threadId:string;captureSha256?:string;captureKind?:string}};
type Scope = {context:TimingContext;sink:(event:TimingEvent)=>void};
const scopes=new AsyncLocalStorage<Scope>();
export const monotonicMs=()=>performance.timeOrigin+performance.now();
export const timingContext=()=>scopes.getStore()?.context;
export const emitTiming=(event:TimingEvent)=>scopes.getStore()?.sink(event);
export function withTiming<T>(context:Partial<TimingContext>,sink:(event:TimingEvent)=>void,work:()=>T):T {
  return scopes.run({context:{...context,traceId:context.traceId??randomUUID()},sink},work);
}
export function timingSpan(stage:string,attributes:Partial<TimingContext>={}) {
  const scope=scopes.getStore(),parent=scope?.context;
  const context:TimingContext={traceId:parent?.traceId??randomUUID(),...parent,...attributes,spanId:randomUUID()};
  let ended=false;
  const emit=(phase:TimingEvent['phase'],error?:unknown)=>{
    if(ended)return;
    scope?.sink({...context,spanId:context.spanId!,parentId:parent?.spanId,stage,phase,atUtc:new Date().toISOString(),monotonicMs:monotonicMs(),
      ...(phase==='finished'?{status:error?'failed' as const:'success' as const,...(error?{errorName:error instanceof Error?error.name:'Error'}:{})}:{})});
    if(phase==='finished')ended=true;
  };
  return {context,queued:()=>emit('queued'),admitted:()=>emit('admitted'),start:()=>emit('started'),end:(error?:unknown)=>emit('finished',error),
    run:<T>(work:()=>T):T=>scope?scopes.run({context,sink:scope.sink},work):work()};
}
export async function timed<T>(stage:string,work:()=>Promise<T>|T,attributes:Partial<TimingContext>={}):Promise<T>{
  const span=timingSpan(stage,attributes);span.start();
  try{const result=await span.run(work);span.end();return result;}catch(error){span.end(error);throw error;}
}
export function timedSync<T>(stage:string,work:()=>T):T {
  const span=timingSpan(stage);span.start();
  try{const value=span.run(work);span.end();return value;}catch(error){span.end(error);throw error;}
}
/** Wall coverage uses interval unions; cumulative work may exceed elapsed time. */
export function summarizeTiming(events:TimingEvent[]) {
  const spans=new Map<string,TimingEvent[]>();for(const e of events){const list=spans.get(e.spanId)??[];list.push(e);spans.set(e.spanId,list);}
  const complete=[...spans.values()].flatMap(rows=>{const first=rows.find(e=>e.phase==='queued')??rows.find(e=>e.phase==='started'),end=rows.find(e=>e.phase==='finished');
    if(!first||!end)return [];const start=rows.find(e=>e.phase==='started')??first,admitted=rows.find(e=>e.phase==='admitted')??start;
    return [{id:first.spanId,parent:first.parentId,stage:first.stage,begin:first.monotonicMs,end:end.monotonicMs,waitMs:Math.max(0,admitted.monotonicMs-first.monotonicMs),workMs:Math.max(0,end.monotonicMs-start.monotonicMs)}];});
  const roots=complete.filter(s=>!s.parent),stages:Record<string,{count:number;waitMs:number;workMs:number}>={};
  for(const s of complete){const total=stages[s.stage]??={count:0,waitMs:0,workMs:0};total.count++;total.waitMs+=s.waitMs;total.workMs+=s.workMs;}
  const coverage=roots.map(root=>{const intervals=complete.filter(s=>s.parent===root.id).map(s=>[Math.max(root.begin,s.begin),Math.min(root.end,s.end)]).filter(([a,b])=>b!>=a!).sort((a,b)=>a[0]!-b[0]!);
    let covered=0,end=root.begin;for(const [a,b] of intervals){covered+=Math.max(0,b!-Math.max(end,a!));end=Math.max(end,b!);}
    return {spanId:root.id,elapsedMs:root.end-root.begin,coveredMs:covered,unattributedMs:Math.max(0,root.end-root.begin-covered)};});
  return {stages,roots:coverage,incompleteSpans:spans.size-complete.length};
}
