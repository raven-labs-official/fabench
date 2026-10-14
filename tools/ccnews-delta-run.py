#!/usr/bin/env python3
"""Extract an explicit CC-NEWS delta and write a verifiable per-shard receipt.
Uses cc-news-to-jsonl.py's extraction/language policy, with an exact capture cutoff.
Only complete gzip+receipt pairs are resumable; failures make the command fail.
"""
import argparse,datetime,gzip,hashlib,importlib.util,importlib.metadata,json,os,sys,time
from pathlib import Path
from multiprocessing import Pool
spec=importlib.util.spec_from_file_location('cc_extract',Path(__file__).with_name('cc-news-to-jsonl.py'))
extract=importlib.util.module_from_spec(spec);sys.modules[spec.name]=extract;spec.loader.exec_module(extract)

def work(task):
 key,out,lid,cutoff,download_cap=task
 receipt=Path(out+'.receipt.json')
 if receipt.exists():
  prior=json.loads(receipt.read_text())
  if prior['key']!=key or prior['capture_before']!=cutoff:raise ValueError('shard receipt identity mismatch')
  with open(out,'rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
  if prior['sha256']!=digest:raise ValueError('completed shard hash changed')
  return prior
 if not Path(out).exists():extract.process_warc(key,out,200,0,download_cap)
 count=0;excluded=0;first=None;last=None;days={};tmp=out+'.filtered.partial'
 boundary=datetime.datetime.fromisoformat(cutoff.replace('Z','+00:00'))
 with gzip.open(out,'rt',encoding='utf8') as fin,gzip.open(tmp,'wt',encoding='utf8') as fout:
  for line in fin:
   row=json.loads(line);dt=datetime.datetime.fromisoformat(row['crawlDate'].replace('Z','+00:00'))
   if dt>=boundary:excluded+=1;continue
   if not row['url'] or not row['body']:raise ValueError('incomplete extracted record')
   fout.write(line);count+=1;stamp=dt.isoformat();first=min(first,stamp) if first else stamp;last=max(last,stamp) if last else stamp;day=dt.date().isoformat();days[day]=days.get(day,0)+1
 os.replace(tmp,out)
 with open(out,'rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
 provenance={'extractor_sha256':hashlib.sha256(Path(extract.__file__).read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'dependencies':{name:importlib.metadata.version(name) for name in ['fastwarc','resiliparse','fasttext-wheel','numpy']}}
 info={'extraction_provenance':provenance,'key':key,'capture_before':cutoff,'documents':count,'excluded_at_or_after_cutoff':excluded,'first_capture_utc':first,'last_capture_utc':last,'days':days,'sha256':digest,'bytes':Path(out).stat().st_size,'completed_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 tmp_receipt=receipt.with_suffix('.partial');tmp_receipt.write_text(json.dumps(info,indent=2)+'\n');tmp_receipt.replace(receipt);return info

def main():
 p=argparse.ArgumentParser();p.add_argument('--keys-file',required=True);p.add_argument('--out',required=True);p.add_argument('--lid',required=True);p.add_argument('--workers',type=int,default=4);p.add_argument('--download-mib-per-second',type=float,default=0);p.add_argument('--capture-before',default='2026-09-17T00:00:00Z');a=p.parse_args()
 keys=json.loads(Path(a.keys_file).read_text());keys=keys['keys'] if isinstance(keys,dict) else keys
 if not keys:raise ValueError('empty explicit input list')
 if len(keys)!=len(set(keys)):raise ValueError('duplicate WARC keys')
 Path(a.out).mkdir(parents=True,exist_ok=True);tasks=[(k,str(Path(a.out)/Path(k).name.replace('.warc.gz','.jsonl.gz')),a.lid,a.capture_before,int(a.download_mib_per_second*1024**2)) for k in keys]
 if any(not k.startswith('crawl-data/CC-NEWS/') or not k.endswith('.warc.gz') for k in keys):raise ValueError('invalid WARC key')
 began=time.time();done=[]
 with Pool(a.workers,initializer=extract._init_worker,initargs=(a.lid,)) as pool:
  for r in pool.imap_unordered(work,tasks):
   done.append(r);Path(a.out,'progress.json').write_text(json.dumps({'status':'running','completed':len(done),'total':len(keys),'documents':sum(x['documents'] for x in done),'elapsed_s':time.time()-began})+'\n');print(json.dumps({'completed':len(done),'total':len(keys),'key':r['key'],'documents':r['documents']}),flush=True)
 Path(a.out,'manifest.json').write_text(json.dumps({'status':'complete','capture_before':a.capture_before,'shards':sorted(done,key=lambda r:r['key']),'elapsed_s':time.time()-began},indent=2)+'\n')
if __name__=='__main__':main()
