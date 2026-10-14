import json,os,pathlib,sqlite3,tempfile,unittest
try:
 from tantivy_frozen import build,Reader,epoch
except ModuleNotFoundError:
 build=Reader=epoch=None

@unittest.skipIf(Reader is None, "optional Tantivy dependency not installed")
class TantivyTests(unittest.TestCase):
 def test_cutoff_versions_free_text_and_source_future_invariance(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);source=root/'source.db';c=sqlite3.connect(source)
   c.executescript('CREATE TABLE docs(id INTEGER PRIMARY KEY,url TEXT,title TEXT,body TEXT,crawl_date TEXT,crawl_ms INTEGER);CREATE INDEX urls ON docs(url)')
   rows=[('https://a','Acme fiscal 2026 earnings','Old forecast','2026-01-01'),('https://a','Acme fiscal 2026 earnings','Revised guidance 1.74 to 1.99','2026-02-01'),('https://b','Other entity','Unrelated results','2026-02-01'),('https://boundary','Acme guidance','Exactly at boundary','2026-03-01')]
   c.executemany('INSERT INTO docs(url,title,body,crawl_date,crawl_ms) VALUES(?,?,?,?,?)',[(*r,epoch(r[-1])) for r in rows]);c.commit()
   a=build(str(source),str(root/'one'),'2026-03-01');reader=Reader(root/'one',verify=True)
   req={'query':'Acme FY2026 guidance','as_of':'2026-03-01','n':10};hits=reader.query(req)['hits']
   self.assertEqual(hits[0]['body'],'Revised guidance 1.74 to 1.99')
   self.assertFalse(any(r['url']=='https://boundary' for r in hits))
   self.assertEqual(reader.query({'operation':'fetch','url':'https://a','as_of':'2026-03-01'})['hits'][0]['body'],hits[0]['body'])
   with self.assertRaises(ValueError):reader.query({**req,'as_of':'2026-02-01'})
   self.assertEqual(reader.query({**req,'query':'!!!'})['hits'],[])
   c.execute('INSERT INTO docs(url,title,body,crawl_date,crawl_ms) VALUES(?,?,?,?,?)',('https://future','Acme results','Future outcome','2026-07-01',epoch('2026-07-01')));c.commit();c.close()
   b=build(str(source),str(root/'two'),'2026-03-01')
   self.assertEqual(a['records_sha256'],b['records_sha256']);self.assertEqual(hits,Reader(root/'two').query(req)['hits'])
   # Restore directory write permission solely for TemporaryDirectory cleanup.
   for name in ('one','two'):(root/name).chmod(0o750)
