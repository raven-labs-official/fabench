import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCleaningSamples,checkCleaningOutput} from './reader-cleaning-eval.js';
test('cleaning evaluation validates distinct source documents and reports retention/removal separately',()=>{
  const checks=[{action:'keep' as const,quote:'Revenue 123',reason:'main fact'}, {action:'drop' as const,quote:'Recommended article',reason:'separate card'}];
  const sample={id:'example',document_id:'a'.repeat(64),checks};
  validateCleaningSamples({evidence_directory:'/evidence',samples:[sample]});
  assert.throws(()=>validateCleaningSamples({evidence_directory:'/evidence',samples:[sample,sample]}));
  assert.throws(()=>validateCleaningSamples({evidence_directory:'/evidence',samples:[{...sample,checks:[]}]}));
  assert.deepEqual(checkCleaningOutput('Revenue 123',checks).map(c=>c.passed),[true,true]);
  assert.deepEqual(checkCleaningOutput('Recommended article',checks).map(c=>c.passed),[false,false]);
});
