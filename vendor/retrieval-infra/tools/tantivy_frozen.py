#!/usr/bin/env python3
"""Build/search an immutable, cutoff-specific Tantivy index from the frozen SQLite store."""
import argparse,datetime,hashlib,importlib.metadata,json,os,pathlib,re,sqlite3,sys,time
import tantivy
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from corpus_body import install_body_view  # compacted corpora store encoded bodies
POLICY='tantivy-strict-cutoff-bm25-title3-body1-v2'

def epoch(iso):
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}',iso): iso+='T23:59:59.999Z'
    dt=datetime.datetime.fromisoformat(iso.replace('Z','+00:00'))
    if dt.tzinfo is None: raise ValueError('anchor must include timezone')
    return int(dt.timestamp()*1000)

def build(source,output,anchor):
    target=pathlib.Path(output);partial=pathlib.Path(output+'.partial')
    if target.exists() or partial.exists():raise ValueError('output already exists; choose a new directory')
    partial.mkdir(parents=True)
    b=tantivy.SchemaBuilder()
    for field in ('title','body'):b.add_text_field(field,stored=True)
    for field in ('url','crawlDate'):b.add_text_field(field,stored=True,tokenizer_name='raw')
    schema=b.build();idx=tantivy.Index(schema,path=str(partial));writer=idx.writer(heap_size=128_000_000,num_threads=1)
    c=sqlite3.connect('file:'+str(pathlib.Path(source).resolve())+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;install_body_view(c);c.execute('BEGIN')
    ms=epoch(anchor);h=hashlib.sha256();count=0
    sql='''SELECT d.url,d.title,d.body,d.crawl_date AS crawlDate FROM docs d
        WHERE d.crawl_ms<? AND NOT EXISTS (SELECT 1 FROM docs newer WHERE newer.url=d.url AND newer.crawl_ms<?
        AND (newer.crawl_ms>d.crawl_ms OR (newer.crawl_ms=d.crawl_ms AND newer.id>d.id))) ORDER BY d.id'''
    try:
        for row in c.execute(sql,(ms,ms)):
            record=dict(row);h.update((json.dumps(record,sort_keys=True,ensure_ascii=False)+'\n').encode())
            writer.add_document(tantivy.Document(**record));count+=1
            if count%100000==0:print(json.dumps({'indexed':count}),file=sys.stderr,flush=True)
        writer.commit();writer.wait_merging_threads()
    finally:c.rollback();c.close()
    del writer;del idx
    def digest_file(path):
        with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
    files={p.name:digest_file(p) for p in sorted(partial.iterdir()) if p.is_file() and not p.name.endswith('.lock')}
    manifest={'schema':'raven.tantivy-snapshot.v1','policy':POLICY,'anchor_ms':ms,'as_of':anchor,
        'source':str(pathlib.Path(source).resolve()),'documents':count,'records_sha256':h.hexdigest(),
        'tantivy_version':importlib.metadata.version('tantivy'),'files':files}
    (partial/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    os.rename(partial,target)
    for p in target.iterdir():
        if p.is_file():p.chmod(0o660 if p.name.endswith(".lock") else 0o440)
    target.chmod(0o550)
    return manifest

def expression(query):
    # Free text is tokenized instead of executed as the engine's query language.
    stop=set('the a an of to in on for and or is are will would by with at as be this that its from was were has have had per'.split())
    tokens=list(dict.fromkeys(t.lower() for t in re.findall(r'[^\W_]+',query,re.UNICODE) if t.lower() not in stop))
    clauses=[]
    for t in tokens:
        m=re.fullmatch(r'fy(20\d\d)',t)
        clauses.append(f'("{t}" OR "fiscal {m[1]}" OR "fiscal year {m[1]}" OR "fy {m[1]}")' if m else '"'+t+'"')
    return ' OR '.join(clauses)

class Reader:
    def __init__(self,path,verify=False):
        self.path=pathlib.Path(path);self.manifest=json.loads((self.path/'manifest.json').read_text())
        if self.manifest['policy']!=POLICY:raise ValueError('unsupported snapshot policy')
        if self.manifest['tantivy_version']!=importlib.metadata.version('tantivy'):
            raise ValueError('runtime Tantivy version differs from snapshot')
        if verify:
            for name,digest in self.manifest['files'].items():
                with (self.path/name).open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
                if actual!=digest:raise ValueError('snapshot checksum mismatch: '+name)
        self.index=tantivy.Index.open(str(self.path));self.searcher=self.index.searcher()
    def query(self,request):
        if epoch(request['as_of'])!=self.manifest['anchor_ms']:raise ValueError('snapshot requires its exact anchor')
        start=time.monotonic();op=request.get('operation','search');n=int(request.get('n',10))
        if not 1<=n<=100:raise ValueError('n must be between 1 and 100')
        if op=='fetch':
            url=request['url'];q=tantivy.Query.term_query(self.index.schema,'url',url,index_option='basic');n=1
        elif op=='search':
            expr=expression(request['query'])
            if not expr:return {'hits':[],'seconds':0}
            q=self.index.parse_query(expr,['title','body'],field_boosts={'title':3.0,'body':1.0})
        else:raise ValueError('unsupported operation')
        matches=self.searcher.search(q,limit=min(n*5,500),count=False);rows=[];seen=set()
        for score,address in matches.hits:
            d=self.searcher.doc(address).to_dict();r={k:v[0] for k,v in d.items()}
            digest=hashlib.sha256(r['body'].encode()).hexdigest()
            if digest in seen:continue
            seen.add(digest);r['score']=score;rows.append(r)
            if len(rows)>=n:break
        return {'hits':rows,'seconds':time.monotonic()-start,'total_matches':None}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);s=p.add_subparsers(dest='command',required=True)
    b=s.add_parser('build');b.add_argument('--source',required=True);b.add_argument('--out',required=True);b.add_argument('--as-of',required=True)
    r=s.add_parser('query');r.add_argument('--index',required=True);r.add_argument('--verify',action='store_true')
    a=p.parse_args()
    if a.command=='build':print(json.dumps(build(a.source,a.out,a.as_of)))
    else:print(json.dumps(Reader(a.index,a.verify).query(json.load(sys.stdin))))
