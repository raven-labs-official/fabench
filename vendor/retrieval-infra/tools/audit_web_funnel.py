#!/usr/bin/env python3
"""Aggregate archived tool funnels without reading model reasoning into the output."""
import argparse,collections,json,pathlib
p=argparse.ArgumentParser();p.add_argument('root');a=p.parse_args();root=pathlib.Path(a.root)
counts=collections.Counter();dispositions=collections.Counter();queries=[];cells=0
for file in sorted((root/'cells').glob('*.jsonl')):
 cells+=1
 for line in file.open():
  x=json.loads(line)
  if x.get('type')!='tool_call_finished':continue
  d=x.get('data',{});f=d.get('funnel')
  if not f:continue
  counts['search_calls']+=1
  for k,v in f.items():
   if isinstance(v,(int,float)) and not isinstance(v,bool):counts[k]+=v
  counts['zero_served_calls']+=int(f.get('served',0)==0)
  if len(queries)<8 and f.get('pages_undated',0)>0:
   queries.append({'cell':file.name,'query':d.get('args',{}).get('query'),'funnel':f})
print(json.dumps({'trace_root':str(root),'cells':cells,'counts':dict(counts),'examples':queries}))
