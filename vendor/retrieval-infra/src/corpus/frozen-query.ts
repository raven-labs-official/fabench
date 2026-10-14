import type { CorpusStore } from './store.js';
import type { WikiSnapshot } from './wikipedia-cache.js';
import { type QueryPlan, type QueryAliases, type RankFeatureCache } from './query-plan.js';
import { timedSync } from '../observability/timeline.js';

export function frozenQueryRoutes(originalPlan:QueryPlan,expandedPlan:QueryPlan) {
  const requests=new Map<string,{limit:number;original:boolean}>();
  for(const plan of [originalPlan,expandedPlan])for(const expression of plan.expressions){
    const prior=requests.get(expression);
    requests.set(expression,{limit:Math.max(prior?.limit??0,plan.perRoute),original:prior?.original===true||plan===originalPlan});
  }
  return [...requests].map(([expression,request])=>({expression,...request}));
}
/** Shared synchronous algorithm for direct checks and read-only workers. */
export function queryFrozen(store:CorpusStore,wiki:WikiSnapshot|undefined,query:string,n:number,asOf:string,aliases:QueryAliases[]=[],features?:RankFeatureCache) {
  wiki?.assertAnchor(asOf);
  const originalPlan=timedSync('frozen.plan',()=>store.plan(query,asOf,term=>wiki?.frequency(term)??0));
  const plan=aliases.length?timedSync('frozen.plan',()=>store.plan(query,asOf,term=>wiki?.frequency(term)??0,aliases)):originalPlan;
  const routes=frozenQueryRoutes(originalPlan,plan).map(({expression,...request})=>{
    const started=performance.now();const news=timedSync('frozen.news',()=>store.searchRaw(expression,asOf,request.limit)),extra=wiki?timedSync('frozen.wiki',()=>wiki.searchRaw(expression,asOf,request.limit)):[];
    return {expression,...request,news:news.length,wiki:extra.length,ms:performance.now()-started,candidate_urls:[...news,...extra].map(d=>d.url),hits:[...news,...extra]};
  });
  const started=performance.now(),ranked=timedSync('frozen.rank',()=>store.rankVerified(routes.flatMap(r=>r.hits),plan,n,features));
  // Wiki members are ranked on their indexed text and shown as their manifest presents them.
  const hits=wiki?ranked.map(h=>wiki.present(h)):ranked;
  return {hits,plan,original_plan:originalPlan,routes:routes.map(({hits,...r})=>r),wiki_identity:wiki?.identity??null,ranking_ms:performance.now()-started};
}
