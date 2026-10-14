import assert from 'node:assert/strict';
import test from 'node:test';
import {validateRetrievalSamples} from './retrieval-validation-eval.js';

test('review diagnostics require immutable documents and exact anchors; reject answer context',()=>{
  const input={mode:'review',evidence_directory:'/srv/shared/runs/fixtures',samples:[{id:'one',document_id:'a'.repeat(64),anchor:'2026-03-01T00:00:00Z',context:{question:'Synthetic question'}}]};
  assert.doesNotThrow(()=>validateRetrievalSamples(input));
  assert.doesNotThrow(()=>validateRetrievalSamples({...input,concurrency:128,review_concurrency:256}));
  assert.throws(()=>validateRetrievalSamples({...input,review_concurrency:Number.MAX_SAFE_INTEGER+1}));
  assert.throws(()=>validateRetrievalSamples({...input,samples:[{...input.samples[0],anchor:'2026-03-01'}]}));
  assert.throws(()=>validateRetrievalSamples({...input,samples:[{...input.samples[0],context:{answer:0.9}}]}));
  assert.throws(()=>validateRetrievalSamples({...input,samples:[input.samples[0],input.samples[0]]}));
});
test('acquisition diagnostic rejects non-HTTP and credential-bearing URLs',()=>{
  const input={mode:'acquisition',samples:[{id:'one',url:'https://example.test/report'}]};
  assert.doesNotThrow(()=>validateRetrievalSamples(input));
  for(const url of ['file:///etc/passwd','https://user:pass@example.test'])assert.throws(()=>validateRetrievalSamples({...input,samples:[{id:'one',url}]}));
});

test('non-thinking diagnostics are explicit archived Flash reviews with bounded optional output',()=>{
  const input={mode:'review',review_model:'deepseek:deepseek-flash',review_thinking:'disabled',review_max_output_tokens:4096,
    evidence_directory:'/srv/shared/runs/fixtures',samples:[{id:'one',document_id:'a'.repeat(64),anchor:'2026-03-01T00:00:00Z'}]};
  assert.doesNotThrow(()=>validateRetrievalSamples(input));
  assert.doesNotThrow(()=>validateRetrievalSamples({...input,review_max_output_tokens:undefined}));
  for(const change of [{mode:'search'},{review_model:'glm:glm-5.3-flash'},{review_thinking:'enabled'},
    {review_fallback_model:'glm:glm-5.3-flash'},{review_thinking:undefined},{review_max_output_tokens:0},{review_max_output_tokens:1.5},{review_max_output_tokens:384001}])
    assert.throws(()=>validateRetrievalSamples({...input,...change}));
});

// Archived failing probe used entity browse arguments as a keyword query.
test('capacity diagnostics distinguish real entity browse from keyword search',()=>{
  const input={mode:'frozen',corpus_file:'/data/index.db',frozen_queue:320,replicate:1,replicate_reason:'Measure actual execution rather than reuse results',samples:[{id:'fed',entity:'Federal Reserve',since:'2026-02-15',until:'2026-03-01',anchor:'2026-03-01T00:00:00Z',n:20}]};
  assert.doesNotThrow(()=>validateRetrievalSamples({...input,frozen_workers:8}));
  for(const slots of [4,8,12,28])assert.doesNotThrow(()=>validateRetrievalSamples({...input,frozen_workers:28,shared_frozen_cache:'/tmp/cache',frozen_global_slots:slots}));
  for(const slots of [0,1.5,33])assert.throws(()=>validateRetrievalSamples({...input,shared_frozen_cache:'/tmp/cache',frozen_global_slots:slots}));
  assert.throws(()=>validateRetrievalSamples({...input,frozen_global_slots:4}));
  assert.throws(()=>validateRetrievalSamples({...input,frozen_workers:33}));
  assert.throws(()=>validateRetrievalSamples({...input,replicate_reason:''}));
  assert.throws(()=>validateRetrievalSamples({...input,mode:'search',corpus_file:undefined,frozen_queue:undefined}));
  assert.throws(()=>validateRetrievalSamples({...input,samples:[{...input.samples[0],query:'Federal Reserve'}]}));
  assert.throws(()=>validateRetrievalSamples({...input,samples:[{...input.samples[0],until:'2025-01-01'}]}));
});
