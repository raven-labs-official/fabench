import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from browser_fallback import run_browser, apply_browser
from article_content import digest


class BrowserTest(unittest.TestCase):
    def test_inline_article_date_is_visible_once_with_original_dom_position(self):
        from article_content import extract_article
        raw=b'<main><h1>Report</h1><div class="article_date-time"><span class="article_date-text">01/28/2026</span></div><p>Today the company reported its financial results. '+b'Important historical text. '*15+b'</p><time datetime="2027-01-01"></time></main><footer><span class="date">09/13/2026</span></footer>'
        body,document=extract_article(raw,'https://example.test')
        self.assertEqual(body.count('01/28/2026'),1);self.assertNotIn('09/13/2026',body);self.assertNotIn('2027-01-01',body)
        block=next(b for b in document['blocks'] if b['kind']=='article-time')
        self.assertTrue(block['xpath'].endswith('/span'));self.assertEqual(body[block['start']:block['end']],'01/28/2026')

    def test_delayed_article_preserves_dom_response_table_notes_and_unicode(self):
        article = '<h1>Fictional measurement report</h1><p>On January 20, 2026, the fictional agency published its provisional annual observations. These values use the same instruments and reporting period as the preceding report.</p><table><tr><th colspan="2">Revenue in millions</th></tr><tr><td>2025</td><td>12.5*</td></tr></table><p>* Provisional estimate; includes overseas operations. 中文单位。</p>'
        raw = ('<html><head><meta charset="utf-8"></head><body><nav>Unrelated headline September 2026 99999</nav><article id="report"></article><script>setTimeout(() => { document.getElementById("report").innerHTML = '+__import__('json').dumps(article)+'; }, 1200);</script></body></html>').encode()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*a): pass
            def do_GET(self):
                self.send_response(200);self.end_headers()
                self.wfile.write(b'User-agent: *\nAllow: /\n' if self.path=='/robots.txt' else raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                url=f'http://127.0.0.1:{server.server_port}/report'
                result=run_browser(url,directory)
                self.assertTrue(result['ok'],result)
                origin=next(c for c in result['captures'] if c['kind']=='browser-document-response-decoded')
                self.assertEqual(gzip.decompress(Path(origin['path']).read_bytes()),raw)
                out={'url':url,'text':'','title':''}
                self.assertTrue(apply_browser(out,result))
                self.assertEqual(out['source'],'browser')
                self.assertIn('12.5*',out['text']);self.assertIn('中文单位',out['text'])
                self.assertIn('Provisional estimate',out['text']);self.assertNotIn('99999',out['text'])
                self.assertEqual(out['content_document']['source_format'],'browser-rendered-html')
                self.assertEqual(out['content_document']['body_sha256'],digest(out['text']))
                self.assertEqual(len(out['content_document']['table_blocks']),1)
        finally: server.shutdown();server.server_close();thread.join()

    def test_browser_challenge_or_truncated_dom_does_not_replace_direct_body(self):
        from article_content import archive_capture
        with tempfile.TemporaryDirectory() as directory:
            capture=archive_capture(b'<main><h1>Verify you are human</h1><p>Please verify you are human to continue accessing this website. </p></main>',directory,'browser-rendered-dom')
            out={'url':'https://example.test','text':'valid direct body'}
            result={'ok':True,'captures':[capture],'dom_capture':capture}
            self.assertFalse(apply_browser(out,result));self.assertEqual(out['text'],'valid direct body')
            capture['truncated']=True
            with self.assertRaises(ValueError): apply_browser(out,result)

    def test_undated_complete_direct_article_does_not_trigger_browser_or_reader(self):
        spec=importlib.util.spec_from_file_location('date_helper_test',Path(__file__).with_name('date-and-text.py'))
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        raw=b'<article><h1>Synthetic undated explanation</h1><p>'+b'This article explains the instruments and measurement methodology in detail. '*7+b'</p></article>'
        import io
        response=io.BytesIO(raw);response.headers={'Content-Type':'text/html'}
        with tempfile.TemporaryDirectory() as directory, patch.object(helper,'ARTICLE_MODE',True), patch.object(helper,'RAW_DIRECTORY',directory), patch.object(helper,'BROWSER_ON',True), patch.object(helper,'open_response',return_value=response), patch.object(helper,'find_date',return_value=None), patch.object(helper,'fallback') as fallback:
            out=helper.one('https://example.test/report')
            fallback.assert_not_called();self.assertGreater(len(out['text']),200);self.assertIsNone(out['date'])
            self.assertTrue(out['content_document']['usable'])

    def test_page_browser_failure_uses_reader_but_broken_installation_stops(self):
        spec=importlib.util.spec_from_file_location('date_fallback_test',Path(__file__).with_name('date-and-text.py'))
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        with patch.object(helper,'BROWSER_ON',True), patch.object(helper,'READER_ON',True), patch('browser_fallback.run_browser',return_value={'ok':False,'error':'browser-deadline'}), patch.object(helper,'via_reader',side_effect=lambda url,out:out) as reader:
            out=helper.fallback('https://example.test',{'text':'direct'})
            reader.assert_called_once();self.assertEqual(out['attempts'][0]['error'],'browser-deadline')
        with patch.object(helper,'BROWSER_ON',True), patch('browser_fallback.run_browser',side_effect=RuntimeError('missing executable')), patch.object(helper,'via_reader') as reader:
            out=helper.fallback('https://example.test',{'text':'direct'})
            reader.assert_not_called();self.assertIn('missing executable',out['quality_error'])


if __name__=='__main__':unittest.main()
