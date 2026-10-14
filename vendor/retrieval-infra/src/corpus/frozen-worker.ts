import { parentPort,workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { CorpusStore } from './store.js';
import { WikipediaCache,WikiSnapshot } from './wikipedia-cache.js';
import { queryFrozen } from './frozen-query.js';
import { timed,withTiming } from '../observability/timeline.js';
import type { FrozenPoolOptions, FrozenRequest } from './frozen-worker-pool.js';
import { isRetrievalInputError } from '../retrieval/input-error.js';
import { RankFeatureCache } from './query-plan.js';

const options=workerData as FrozenPoolOptions & {cacheOwner:string};
const store=new CorpusStore(options.corpusPath,options.strategy??'concept','auto',{aliases:options.aliases,
  sharedFrozenCachePath:options.sharedCachePath,sharedFrozenCacheSlots:options.sharedCacheSlots,cacheOwner:options.cacheOwner});
const features=new RankFeatureCache();
let wiki:WikiSnapshot|undefined;
if(options.wikiManifestFile){
  const cache=new WikipediaCache(options.wikiCachePath!,true);
  try{wiki=new WikiSnapshot(cache,JSON.parse(readFileSync(options.wikiManifestFile,'utf8')),options.wikiIndexFile);}finally{cache.close();}
}
parentPort!.on('message',async({id,request,context}:{id:number;request:FrozenRequest;context:import('../observability/timeline.js').TimingContext})=>{
  try{
    const result=await withTiming(context,event=>parentPort!.postMessage({id,event}),()=>timed('frozen.query',()=>{
      switch(request.method){
        case 'qualitySearch':return queryFrozen(store,wiki,...request.args,features);
        case 'search':return store.search(...request.args);
        case 'browse':return store.browse(...request.args);
        case 'getByUrlBefore':return wiki?.getByUrlBefore(...request.args)??store.getByUrlBefore(...request.args);
      }
    }));
    parentPort!.postMessage({id,result});
  }catch(error){parentPort!.postMessage({id,error:{kind:isRetrievalInputError(error)?'input':'infrastructure',name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message:String(error)}});}
});
parentPort!.postMessage({ready:true});
