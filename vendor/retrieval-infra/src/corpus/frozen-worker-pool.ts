import {RetrievalInfrastructureError} from '../retrieval/infrastructure-error.js';
import { Worker } from 'node:worker_threads';
import type { CorpusStore } from './store.js';
import { prepareBrowse, type BrowseOptions } from './browse.js';
import { RetrievalInputError } from '../retrieval/input-error.js';
import type { QueryAliases } from './query-plan.js';
import type { queryFrozen } from './frozen-query.js';
import { timingSpan, emitTiming } from '../observability/timeline.js';
import { defaultFrozenWorkers } from './frozen-execution.js';
import { randomUUID } from 'node:crypto';
import { releaseFrozenCacheOwner } from './frozen-route-cache.js';

export type FrozenPoolOptions={corpusPath:string;strategy?:'concept'|'rarity';aliases?:QueryAliases[];wikiCachePath?:string;wikiManifestFile?:string;wikiIndexFile?:string;workers?:number;maxQueue?:number;sharedCachePath?:string;sharedCacheSlots?:number};
export type FrozenRequest={method:'qualitySearch';args:[string,number,string,QueryAliases[]]}|{method:'search';args:Parameters<CorpusStore['search']>}|
  {method:'browse';args:Parameters<CorpusStore['browse']>}|{method:'getByUrlBefore';args:Parameters<CorpusStore['getByUrlBefore']>};
type Job={id:number;request:FrozenRequest;resolve:(value:any)=>void;reject:(error:unknown)=>void;span:ReturnType<typeof timingSpan>;cleanup:()=>void;settled:boolean};
type Slot={worker:Worker;ready:boolean;job?:Job;retired:boolean;cacheOwner:string};
/** Bounded FIFO. A run owns one pool. A crash fails the pool instead of retrying invisible work. */
export class FrozenWorkerPool {
  readonly execution:{workers:number;maxQueue:number};
  private slots:Slot[]=[];private queue:Job[]=[];private nextId=0;private stopped:Error|undefined;
  private completed=0;private rejected=0;
  constructor(private readonly options:FrozenPoolOptions){
    // This argument guard is not a machine-capacity claim; size the pool from measured CPU/I/O.
    const workers=options.workers??defaultFrozenWorkers(),maxQueue=options.maxQueue??64;
    if(!Number.isSafeInteger(workers)||workers<1||workers>32)throw new Error('frozen workers must be 1–32');
    if(!Number.isSafeInteger(maxQueue)||maxQueue<1)throw new Error('frozen queue must be a positive safe integer');
    if(options.sharedCacheSlots!==undefined&&(!options.sharedCachePath||!Number.isSafeInteger(options.sharedCacheSlots)||options.sharedCacheSlots<1||options.sharedCacheSlots>32))throw new Error('shared frozen slots require a cache path and 1–32 slots');
    if(options.wikiIndexFile&&!options.wikiManifestFile)throw new Error('Wiki index requires manifest');
    if(options.wikiManifestFile&&!options.wikiCachePath)throw new Error('Wiki manifest requires cache');
    this.execution={workers,maxQueue};
    for(let i=0;i<workers;i++){
      const cacheOwner=randomUUID();
      const worker=new Worker(new URL('./frozen-worker-entry.mjs',import.meta.url),{workerData:{...options,cacheOwner},execArgv:[]});
      const slot:Slot={worker,ready:false,retired:false,cacheOwner};this.slots.push(slot);worker.unref();
      worker.on('message',message=>{
        if(this.stopped||slot.retired)return;
        if(message.ready){slot.ready=true;this.dispatch();return;}
        const job=slot.job;if(!job||job.id!==message.id){this.fail(new Error('Frozen worker response identity mismatch'));return;}
        if(message.event){job.span.run(()=>emitTiming(message.event));return;}
        slot.job=undefined;slot.worker.unref();
        if(!job.settled){job.cleanup();job.settled=true;
          if(message.error){const error=message.error.kind==='input'
            ?new RetrievalInputError(message.error.message)
            :new RetrievalInfrastructureError("frozen-index","worker_query_failed",message.error.message);job.span.end(error);job.reject(error);this.rejected++;}
          else {job.span.end();job.resolve(message.result);this.completed++;}}
        this.dispatch();
      });
      worker.on('error',error=>{if(!slot.retired)this.fail(error instanceof Error?error:new Error(String(error)));});
      worker.on('exit',code=>{if(!slot.retired&&!this.stopped)this.fail(new Error(`Frozen worker exited (${code})`));});
      worker.unref();
    }
  }
  private dispatch(){
    if(this.stopped)return;
    for(const slot of this.slots)if(slot.ready&&!slot.job){const job=this.queue.shift();if(!job){slot.worker.unref();continue;}slot.worker.ref();slot.job=job;job.span.admitted();job.span.start();
      slot.worker.postMessage({id:job.id,request:job.request,context:job.span.context});}
  }
  private fail(error:Error){
    if(this.stopped)return;error=new RetrievalInfrastructureError("frozen-index","worker_unavailable",error.message,{cause:error});this.stopped=error;
    for(const job of [...this.queue,...this.slots.flatMap(s=>s.job?[s.job]:[])])if(!job.settled){job.settled=true;job.cleanup();job.span.end(error);job.reject(error);this.rejected++;}
    this.queue=[];for(const slot of this.slots){slot.retired=true;slot.job=undefined;
      void slot.worker.terminate().then(()=>{
        if(this.options.sharedCachePath)releaseFrozenCacheOwner(this.options.sharedCachePath,slot.cacheOwner);
      }).catch(()=>{/* A dead process is also reaped by shared admission; never throw an unhandled close rejection. */});}
  }
  request<T>(request:FrozenRequest,signal?:AbortSignal):Promise<T>{
    if(this.stopped)return Promise.reject(this.stopped);if(signal?.aborted)return Promise.reject(signal.reason);
    // Validate bounded caller input before it waits behind expensive SQL work.
    // Corpus/worker faults still follow the infrastructure-error path.
    if(request.method==='browse'){
      try{prepareBrowse(...request.args);}catch(error){this.rejected++;return Promise.reject(error);}
    }
    if(this.queue.length>=this.execution.maxQueue)return Promise.reject(new RetrievalInfrastructureError("frozen-index","worker_queue_full","Frozen worker queue is full"));
    for(const slot of this.slots)slot.worker.ref();
    const span=timingSpan('frozen.worker');span.queued();
    return new Promise<T>((resolve,reject)=>{
      const job:Job={id:++this.nextId,request,resolve,reject,span,settled:false,cleanup:()=>signal?.removeEventListener('abort',abort)};
      const abort=()=>{
        if(job.settled)return;
        const index=this.queue.indexOf(job);
        if(index>=0){this.queue.splice(index,1);job.settled=true;job.cleanup();span.end(signal?.reason);reject(signal?.reason);this.rejected++;this.dispatch();}
        else this.fail(new Error('Active frozen request cancelled; pool closed',{cause:signal?.reason}));
      };
      signal?.addEventListener('abort',abort,{once:true});this.queue.push(job);this.dispatch();
    });
  }
  qualitySearch(query:string,n:number,anchor:string,aliases:QueryAliases[]=[]){return this.request<ReturnType<typeof queryFrozen>>({method:'qualitySearch',args:[query,n,anchor,aliases]});}
  search(query:string,anchor:string,n=10){return this.request<ReturnType<CorpusStore['search']>>({method:'search',args:[query,anchor,n]});}
  browse(options:BrowseOptions,anchor:string){return this.request<ReturnType<CorpusStore['browse']>>({method:'browse',args:[options,anchor]});}
  getByUrlBefore(url:string,anchor:string){return this.request<ReturnType<CorpusStore['getByUrlBefore']>>({method:'getByUrlBefore',args:[url,anchor]});}
  stats(){return {active:this.slots.filter(s=>s.job).length,queued:this.queue.length,completed:this.completed,rejected:this.rejected};}
  close(){this.fail(new Error('Frozen worker pool is closed'));}
}
