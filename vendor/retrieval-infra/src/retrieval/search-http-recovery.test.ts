import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {HttpProvider,searchTransportCounters} from './search-providers.js';
import {withTiming,type TimingEvent} from '../observability/timeline.js';

test('real HTTP transport retries transient Serper responses, preserves input and stops on terminal errors',async()=>{
  let responses:number[]=[],requests:string[]=[],headers:Record<string,string>={};
  const server=createServer((req,res)=>{
    let body='';req.on('data',data=>body+=data);req.on('end',()=>{
      requests.push(body);const status=responses.shift()??200;
      res.writeHead(status,{'content-type':'application/json',...headers});
      res.end(status===200?JSON.stringify({organic:[{link:'https://example.test/original',title:'Original report'}]}):JSON.stringify({error:{message:'Recorded HTTP status',code:status===402?'USAGE_LIMIT_EXCEEDED':'temporary'}}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  class ActualHttpProvider extends HttpProvider {
    readonly name='serper';
    async search(query:string,n:number){const result=await this.post(`http://127.0.0.1:${(address as {port:number}).port}/search`,{}, {q:query,num:n});return result.organic;}
  }
  try{
    const provider=new ActualHttpProvider();const events:TimingEvent[]=[];responses=[503,200];
    const result=await withTiming({traceId:'real-http-retry'},event=>events.push(event),()=>provider.search('Original query',5));
    assert.equal(result[0].link,'https://example.test/original');assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
    assert.equal(provider.stats().requests,1);assert.equal(provider.stats().http_attempts,2);assert.equal(provider.stats().retries,1);assert.equal(provider.stats().failed,0);
    assert.deepEqual(searchTransportCounters(provider),{search_http_attempts:2,search_http_retries:1,search_http_503:1});
    assert.equal(events.filter(e=>e.stage==='search.http'&&e.phase==='finished'&&e.status==='failed').length,1);
    assert.equal(events.filter(e=>e.stage==='search.retry'&&e.phase==='finished').length,1);
    for(const status of [401,402,400]){
      responses=[status,200];requests=[];
      await assert.rejects(new ActualHttpProvider().search('Original query',5));assert.equal(requests.length,1);
    }
    responses=[503,503,503,200];requests=[];
    const unavailable=new ActualHttpProvider();await assert.rejects(unavailable.search('Original query',5),/503/);
    assert.equal(requests.length,3);assert.equal(unavailable.stats().failed,1);assert.equal(unavailable.stats().retries,2);
    // Do not ignore a server's long Retry-After by retrying earlier than requested.
    responses=[503,200];requests=[];headers={'retry-after':'120'};
    await assert.rejects(new ActualHttpProvider().search('Original query',5));assert.equal(requests.length,1);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
