import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Real loopback HTTP exercises the production gate. Each configuration gets a
// process because a run's recorded policy must stay fixed for its lifetime.
test('HTTP budget is shared by provider instances and releases slots after failures',async(t)=>{
  for(const cap of [1,16,32,64]){
    const script=`
      import assert from 'node:assert/strict';
      import {createServer} from 'node:http';
      import {HttpProvider,configureSearchHttpConcurrency} from ${JSON.stringify(new URL('./search-providers.ts',import.meta.url).href)};
      const cap=${cap};
      for(const n of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>configureSearchHttpConcurrency(n),/positive safe integer/);
      assert.equal(configureSearchHttpConcurrency(cap).max_in_flight,cap);
      assert.equal(configureSearchHttpConcurrency().max_in_flight,cap);
      assert.throws(()=>configureSearchHttpConcurrency(cap+1),/fixed for this process/);
      let active=0,peak=0,count=0;const received=[],firstWave=[];
      const server=createServer((req,res)=>{
        let body=''; req.on('data',part=>body+=part); req.on('end',()=>{
          const input=JSON.parse(body);received.push(input);count++;active++;peak=Math.max(peak,active);
          const finish=()=>{active--;res.writeHead(input.q==='failure'?400:200,{'content-type':'application/json'});
            res.end(JSON.stringify(input.q==='failure'?{error:{message:'invalid query'}}:{organic:[{url:input.q,title:input.q}]}));};
          if(count<=cap){firstWave.push(finish);if(count===cap)firstWave.forEach(done=>setTimeout(done,30));}
          else setTimeout(finish,30);
        });
      });
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      class LocalProvider extends HttpProvider {
        name='loopback';
        async search(query,n){return (await this.post('http://127.0.0.1:'+server.address().port,{}, {q:query,n})).organic;}
      }
      try {
        const providers=[new LocalProvider(),new LocalProvider()];
        const queries=Array.from({length:cap*2+3},(_,i)=>i===0?'failure':'query-'+i);
        const results=await Promise.allSettled(queries.map((q,i)=>providers[i%2].search(q,7)));
        assert.equal(peak,cap);assert.equal(count,queries.length);assert.equal(active,0);
        assert.equal(results.filter(r=>r.status==='rejected').length,1);
        results.slice(1).forEach((r,i)=>{assert.equal(r.status,'fulfilled');assert.equal(r.value[0].url,queries[i+1]);});
        assert.ok(received.every(r=>r.n===7));
        assert.equal((await providers[0].search('after-failure',7))[0].url,'after-failure');
        assert.equal(configureSearchHttpConcurrency(cap).max_in_flight,cap);
        assert.throws(()=>configureSearchHttpConcurrency(cap+1),/fixed for this process/);
        console.log(JSON.stringify({configured:cap,observed_peak:peak,requests:count,failures:1}));
      } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
    `;
    const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',script],{timeout:30000});
    const observed=JSON.parse(result.stdout.trim());
    t.diagnostic(JSON.stringify(observed));
    assert.equal(observed.configured,cap);assert.equal(observed.observed_peak,cap);
  }
});

test('legacy environment default is recorded and cannot drift after configuration',async()=>{
  const script=`
    import assert from 'node:assert/strict';
    import {configureSearchHttpConcurrency} from ${JSON.stringify(new URL('./search-providers.ts',import.meta.url).href)};
    process.env.SEARCH_CONCURRENCY='invalid';
    assert.throws(()=>configureSearchHttpConcurrency(),/positive safe integer/);
    process.env.SEARCH_CONCURRENCY='7';
    assert.equal(configureSearchHttpConcurrency().max_in_flight,7);
    process.env.SEARCH_CONCURRENCY='32';
    assert.equal(configureSearchHttpConcurrency().max_in_flight,7);
    assert.throws(()=>configureSearchHttpConcurrency(32),/fixed for this process/);
  `;
  await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',script],{timeout:10000});
});
