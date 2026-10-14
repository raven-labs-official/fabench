import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DocumentReader,wikipediaTarget,UnsupportedWikipediaUrlError} from './document-reader.js';
import {EvidenceStore} from './evidence-store.js';

test('language-variant Wikipedia search URLs resolve article titles without changing the historical host',()=>{
  assert.deepEqual(wikipediaTarget('https://zh.wikipedia.org/zh-tw/BLG%E7%94%B5%E5%AD%90%E7%AB%9E%E6%8A%80%E4%BF%B1%E4%B9%90%E9%83%A8'),{host:'https://zh.wikipedia.org',title:'BLG电子竞技俱乐部'});
  assert.deepEqual(wikipediaTarget('https://sr.m.wikipedia.org/sr-el/Beograd'),{host:'https://sr.wikipedia.org',title:'Beograd'});
  assert.deepEqual(wikipediaTarget('https://kk.wikipedia.org/kk-cyrl/Алматы'),{host:'https://kk.wikipedia.org',title:'Алматы'});
  assert.deepEqual(wikipediaTarget('https://en.wikipedia.org/wiki/AC/DC'),{host:'https://en.wikipedia.org',title:'AC/DC'});
  assert.deepEqual(wikipediaTarget('https://en.wikipedia.org/w/index.php?oldid=123'),{host:'https://en.wikipedia.org',revision:'123'});
  for(const url of ['https://en.wikipedia.org/','https://en.wikipedia.org/wiki/','https://en.wikipedia.org/w/api.php','https://zh.wikipedia.org/zh-cn/%E0%A4'])assert.throws(()=>wikipediaTarget(url),UnsupportedWikipediaUrlError);
});

test('unreadable Wikipedia URLs are recorded per candidate and never fall back to current text',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'fabench-wiki-url-'));
  const reader=new DocumentReader(async()=>{throw new Error('current page fetch must not run');},new EvidenceStore(directory),async()=>{throw new Error('API must not run for unsupported paths');});
  try{
    for(const url of ['https://en.wikipedia.org/','https://en.wikipedia.org/w/api.php','https://zh.wikipedia.org/zh-cn/%E0%A4','not a URL'])
      assert.equal(await reader.read(url,'2026-03-01T00:00:00Z'),null);
    assert.equal(reader.failures.length,4);
    assert.ok(reader.failures[0]!.reason.includes('unsupported Wikipedia article URL'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
