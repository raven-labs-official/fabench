#!/usr/bin/env python3
"""Read-only entity slice for separating corpus availability from search failures.
Outputs gzip JSON, including full stored bodies. This is an audit slice, not a new corpus.
"""
import argparse, datetime, gzip, json, sqlite3, sys, time, hashlib
import pathlib
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from corpus_body import install_body_view  # compacted corpora store encoded bodies
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--db',required=True);p.add_argument('--entity',required=True)
p.add_argument('--anchor',required=True);p.add_argument('--since',required=True)
p.add_argument('--timeout',type=int,default=90)
a=p.parse_args();start=time.monotonic()
c=sqlite3.connect('file:'+a.db+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;install_body_view(c)
c.execute('PRAGMA query_only=ON');c.execute('BEGIN')
c.set_progress_handler(lambda: int(time.monotonic()-start>a.timeout),10000)
ms=lambda x:int(datetime.datetime.fromisoformat(x.replace('Z','+00:00')).timestamp()*1000)
expr='"'+a.entity.replace('"','""')+'"'
rows=[dict(r) for r in c.execute('SELECT d.* FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ? AND d.crawl_ms>=? AND d.crawl_ms<=? ORDER BY d.id',(expr,ms(a.since),ms(a.anchor)))]
for r in rows:r['body_sha256']=hashlib.sha256(r['body'].encode()).hexdigest()
c.rollback();c.close()
out={'captured_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'db':a.db,'entity':a.entity,'since':a.since,'anchor':a.anchor,'read_only':True,'seconds':time.monotonic()-start,'rows':rows}
sys.stdout.buffer.write(gzip.compress(json.dumps(out,ensure_ascii=False).encode()))
