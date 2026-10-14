import gzip
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import unittest

from env_names import project_env


TOOLS = Path(__file__).resolve().parent
FIXTURES = TOOLS / 'fixtures' / 'met-office-extraction'


class NativeDiagnostics(unittest.TestCase):
    def test_real_http_captures_follow_the_reused_python_worker(self):
        records = json.loads((FIXTURES / 'manifest.json').read_text())
        raws = [gzip.decompress((FIXTURES / record['file']).read_bytes()) for record in records[:2]]
        self.assertEqual(len(raws), 2)

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                raw = raws[int(self.path[1:])]
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                env = dict(os.environ, FABENCH_CONTENT_POLICY='article-blocks-tables-v1',
                           FABENCH_RAW_PAGES_DIR=directory, FETCH_CONCURRENCY='1',
                           JINA_READER='0', FABENCH_BROWSER_FALLBACK='0')
                requests = [{'id': index + 1, 'urls': [f'http://127.0.0.1:{server.server_port}/{index}'],
                             'timing': {'traceId': 'native-inputs', 'questionId': str(index)}}
                            for index in range(2)]
                process = subprocess.run([sys.executable, str(TOOLS / 'date-and-text.py')],
                                         input=''.join(json.dumps(row) + '\n' for row in requests),
                                         text=True, capture_output=True, env=env, timeout=30, check=True)
                messages = [json.loads(line) for line in process.stdout.splitlines()]
                threads = set()
                for index, raw in enumerate(raws):
                    digest = hashlib.sha256(raw).hexdigest()
                    events = [row['timing'] for row in messages if row.get('id') == index + 1 and 'timing' in row]
                    started = [event for event in events if event['stage'] == 'python.page' and event['phase'] == 'started']
                    self.assertEqual(len(started), 1)
                    self.assertNotIn('captureSha256', started[0]['python'])
                    native = [event for event in events if event['stage'] in ('document.extract', 'document.date.published', 'document.date.modified')]
                    self.assertEqual(len(native), 6)
                    for event in native:
                        self.assertEqual(event['python']['captureSha256'], digest)
                        self.assertEqual(event['python']['captureKind'], 'origin-response')
                        self.assertGreater(event['python']['processId'], 0)
                        int(event['python']['threadId'], 16)
                        threads.add(event['python']['threadId'])
                    reply = next(row for row in messages if row.get('id') == index + 1 and 'results' in row)
                    page = reply['results'][0]
                    self.assertEqual(hashlib.sha256(page['text'].encode()).hexdigest(), records[index]['body_sha256'])
                    self.assertTrue(page['content_document']['usable'])
                self.assertEqual(len(threads), 1, 'The second page must exercise reuse of the first worker')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    @unittest.skipIf(sys.platform == 'darwin' and project_env('FABENCH_RUN_NATIVE_CRASH_TESTS', None) != '1',
                     'intentional Python crash; set FABENCH_RUN_NATIVE_CRASH_TESTS=1 to opt in on macOS')
    def test_real_sigabrt_thread_matches_the_capture_event(self):
        record = json.loads((FIXTURES / 'manifest.json').read_text())[0]
        source = '''import faulthandler,gzip,importlib.util,json,os,pathlib,resource,sys
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
faulthandler.enable(all_threads=True)
tools=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(tools))
spec=importlib.util.spec_from_file_location('dater',tools/'date-and-text.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
d._REQUEST_CONTEXT.request_id=1
d._REQUEST_CONTEXT.timing={'traceId':'real-native-abort'}
raw=gzip.decompress(pathlib.Path(sys.argv[2]).read_bytes())
assert d.capture({},raw,'origin-response')
with d.stage('native.abort'):
    os.abort()
'''
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, FABENCH_CONTENT_POLICY='article-blocks-tables-v1',
                       FABENCH_RAW_PAGES_DIR=directory, JINA_READER='0')
            process = subprocess.run([sys.executable, '-c', source, str(TOOLS), str(FIXTURES / record['file'])],
                                     text=True, capture_output=True, env=env, timeout=20)
            self.assertEqual(process.returncode, -signal.SIGABRT)
            events = [json.loads(line)['timing'] for line in process.stdout.splitlines()]
            event = next(row for row in events if row['stage'] == 'native.abort')
            match = re.search(r'Current thread (0x[0-9a-f]+)', process.stderr)
            self.assertIsNotNone(match, process.stderr[-1000:])
            self.assertEqual(int(event['python']['threadId'], 16), int(match.group(1), 16))
            self.assertEqual(event['python']['captureSha256'], record['raw_sha256'])


if __name__ == '__main__':
    unittest.main()
