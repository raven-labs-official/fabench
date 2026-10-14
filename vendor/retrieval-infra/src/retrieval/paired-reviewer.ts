import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceReviewer, EvidenceReview } from './evidence-reviewer.js';
import type { EvidenceDocument } from './document-reader.js';
import type { LeakReviewContext } from './leak-filter.js';
import { EvidenceStore, sha256 } from './evidence-store.js';

export type ReviewService = Pick<EvidenceReviewer,
  'review'|'configuration'|'semanticConfiguration'|'snapshot'|'close'|'searchDelivery'>;
export const PAIRED_REVIEW_POLICY = 'parallel-primary-authoritative-v1';

/** Both policies see one immutable candidate; only the primary can admit content. */
export class PairedReviewer implements ReviewService {
  readonly searchDelivery;
  private jobs = new Map<string, Promise<EvidenceReview>>();
  private counts = { pairs: 0, primaryErrors: 0, shadowErrors: 0 };
  private index: string;
  constructor(readonly primary: ReviewService, readonly shadow: ReviewService, private artifacts: EvidenceStore) {
    if (primary.searchDelivery !== shadow.searchDelivery) throw new Error('Paired reviewers need the same delivery mode');
    this.searchDelivery = primary.searchDelivery;
    const directory = join(artifacts.directory, 'paired-review');
    mkdirSync(directory, {recursive:true,mode:0o2750});
    this.index = join(directory,'index.jsonl');
  }
  configuration() { return { ...this.primary.configuration(), shadow_review: {
    policy: PAIRED_REVIEW_POLICY, configuration: this.shadow.configuration(),
    delivery: 'primary-only', completion: 'await-both',
  } }; }
  semanticConfiguration() { return { ...this.primary.semanticConfiguration(), shadow_review: {
    policy: PAIRED_REVIEW_POLICY, configuration: this.shadow.semanticConfiguration(),
    delivery: 'primary-only', completion: 'await-both',
  } }; }
  snapshot() { return { ...this.primary.snapshot(), paired: {...this.counts}, shadow: this.shadow.snapshot() }; }
  close() { this.primary.close(); this.shadow.close(); }
  async review(doc: EvidenceDocument, anchor: string, context: LeakReviewContext = {}): Promise<EvidenceReview> {
    const key = sha256(JSON.stringify({candidate:doc,anchor,configuration:this.semanticConfiguration()}));
    const pending = this.jobs.get(key);
    if (pending) {
      const result = await pending;
      return {...result,costUsd:0,modelCalls:0,searchCalls:0,readCalls:0,cacheHit:true};
    }
    const startedAtUtc = new Date().toISOString();
    const job = (async () => {
      const timing: Record<string,{startedAtUtc:string;finishedAtUtc?:string;elapsedMs?:number}> = {};
      const call = (role:'primary'|'shadow',reviewer:ReviewService) => Promise.resolve().then(async()=>{
        const began=performance.now();timing[role]={startedAtUtc:new Date().toISOString()};
        try{return await reviewer.review(doc,anchor,context);}
        finally{timing[role]!.finishedAtUtc=new Date().toISOString();timing[role]!.elapsedMs=performance.now()-began;}
      });
      // Balance initiation order across candidates; both promises start before awaiting either.
      const shadowFirst=parseInt(key[0]!,16)%2===1;
      const promises=shadowFirst?[call('shadow',this.shadow),call('primary',this.primary)]
        :[call('primary',this.primary),call('shadow',this.shadow)];
      const outcomes = await Promise.allSettled(promises);
      if(shadowFirst)outcomes.reverse();
      this.counts.pairs++;
      if(outcomes[0]!.status==='rejected')this.counts.primaryErrors++;
      if(outcomes[1]!.status==='rejected')this.counts.shadowErrors++;
      const recorded = outcomes.map(outcome=>outcome.status==='fulfilled'
        ? {state:'completed',result:outcome.value}
        : {state:'error',error:{name:outcome.reason?.name??'Error',message:String(outcome.reason?.message??outcome.reason)}});
      const record = {policy:PAIRED_REVIEW_POLICY,key,candidateId:doc.id,bodySha256:doc.bodySha256,
        url:doc.url,anchor,startedAtUtc,finishedAtUtc:new Date().toISOString(),
        configuration:this.configuration(),startOrder:shadowFirst?'shadow-first':'primary-first',timing,
        primary:recorded[0],shadow:recorded[1]};
      const artifactId = this.artifacts.put(record);
      appendFileSync(this.index,JSON.stringify({key,artifactId,candidateId:doc.id,anchor})+'\n',{mode:0o640});
      const primary = outcomes[0]!;
      if(primary.status==='rejected')throw primary.reason;
      return primary.value;
    })();
    this.jobs.set(key,job);
    return job;
  }
}
