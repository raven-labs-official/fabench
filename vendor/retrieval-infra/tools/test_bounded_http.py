import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import bounded_http
from bounded_http import open_response, HTTPDeadlineExceeded


PROXY_VARIABLES = ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY')


class BoundedHTTP(unittest.TestCase):
    def setUp(self):
        # Workers inherit the environment; a developer proxy would turn local errors into 502s.
        self.environment = patch.dict(os.environ, {'no_proxy': '*', 'NO_PROXY': '*'})
        self.environment.start()
        for name in PROXY_VARIABLES:
            os.environ.pop(name, None)
        bounded_http._POOL = None
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/ok')
                    self.end_headers()
                    return
                self.send_response(403 if self.path == '/error-drip' else 200)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Last-Modified', 'Thu, 01 Jan 2026 00:00:00 GMT')
                self.end_headers()
                try:
                    if 'drip' in self.path:
                        for _ in range(100):
                            self.wfile.write(b'x')
                            self.wfile.flush()
                            time.sleep(.05)
                    else:
                        self.wfile.write(b'<html><title>Historical report</title><p>Complete body.</p></html>')
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        bounded_http._POOL = None
        self.environment.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_slow_success_and_error_bodies_have_a_total_deadline(self):
        for path in ['/drip', '/error-drip']:
            start = time.monotonic()
            with self.assertRaisesRegex(HTTPDeadlineExceeded, 'response-body'):
                open_response(urllib.request.Request(self.url+path), timeout=.45, max_bytes=1024)
            self.assertLess(time.monotonic()-start, 1.5)
        with open_response(urllib.request.Request(self.url+'/redirect'), timeout=2, max_bytes=1024) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.geturl(), self.url+'/ok')
            self.assertIn(b'Complete body.', response.read())
            self.assertEqual(response.headers.get('Last-Modified'), 'Thu, 01 Jan 2026 00:00:00 GMT')

    def test_timed_out_page_releases_the_real_helper_worker(self):
        env = dict(os.environ, DIRECT_TIMEOUT_S='.45', JINA_READER='0',
                   FABENCH_CONTENT_POLICY='', FETCH_CONCURRENCY='1')
        requests = [{'id': 1, 'urls': [self.url+'/drip', self.url+'/ok']}]
        start = time.monotonic()
        process = subprocess.run([sys.executable, str(Path(__file__).with_name('date-and-text.py'))],
                                 input=''.join(json.dumps(r)+'\n' for r in requests), text=True,
                                 capture_output=True, env=env, timeout=8, check=True)
        reply = next(json.loads(line) for line in process.stdout.splitlines() if 'results' in json.loads(line))
        self.assertIn('timeout', reply['results'][0]['why'])
        self.assertIn('response-body', reply['results'][0]['why'])
        self.assertIn('Complete body.', reply['results'][1]['text'])
        self.assertLess(time.monotonic()-start, 4)

    def fresh_pool(self, **env):
        bounded_http._POOL = None
        with patch.dict(os.environ, env):
            return bounded_http._pool()

    def fetch(self, path, timeout=2, headers=None):
        with open_response(urllib.request.Request(self.url + path, headers=headers or {}),
                           timeout=timeout, max_bytes=1024) as response:
            return response.read()

    def test_one_worker_serves_sequential_requests(self):
        pool = self.fresh_pool()
        self.assertIn(b'Complete body.', self.fetch('/ok'))
        first = [w.process.pid for w in pool.idle]
        for _ in range(5):
            self.assertIn(b'Complete body.', self.fetch('/ok'))
        self.assertEqual(len(first), 1)
        self.assertEqual([w.process.pid for w in pool.idle], first)
        self.assertEqual(pool.total, 1)

    def test_timeout_discards_the_worker_and_the_next_request_succeeds(self):
        pool = self.fresh_pool()
        self.fetch('/ok')
        old = pool.idle[0].process
        with self.assertRaisesRegex(HTTPDeadlineExceeded, r'timed out after 0.3s \(response-body\)'):
            self.fetch('/drip', timeout=.3)
        self.assertIsNotNone(old.poll(), 'the timed-out worker must be killed')
        self.assertEqual(pool.total, 0)
        self.assertIn(b'Complete body.', self.fetch('/ok'))
        self.assertNotEqual(pool.idle[0].process.pid, old.pid)

    def test_concurrent_callers_share_the_pool(self):
        pool = self.fresh_pool()
        results, errors = [], []
        def work():
            try:
                for _ in range(4):
                    results.append(self.fetch('/ok'))
            except Exception as error:  # surfaced by the assertion below
                errors.append(error)
        threads = [threading.Thread(target=work) for _ in range(12)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 48)
        self.assertTrue(all(b'Complete body.' in body for body in results))
        self.assertLessEqual(pool.total, 12)
        self.assertEqual(len(pool.idle), pool.total)

    def test_waiting_for_a_worker_counts_toward_the_deadline(self):
        self.fresh_pool(BOUNDED_HTTP_MAX_WORKERS='1')
        holder = threading.Thread(target=lambda: self.assertRaises(HTTPDeadlineExceeded, self.fetch, '/drip', 1.5))
        holder.start()
        time.sleep(.3)
        start = time.monotonic()
        with self.assertRaisesRegex(HTTPDeadlineExceeded, 'before-response-headers'):
            self.fetch('/ok', timeout=.3)
        self.assertLess(time.monotonic() - start, 1)
        holder.join()
        self.assertIn(b'Complete body.', self.fetch('/ok'))

    def test_credentials_stay_out_of_worker_arguments(self):
        pool = self.fresh_pool()
        self.fetch('/ok', headers={'Authorization': 'Bearer test-secret-value'})
        pid = pool.idle[0].process.pid
        cmdline = Path(f'/proc/{pid}/cmdline').read_bytes() if Path(f'/proc/{pid}').exists() else b''
        self.assertNotIn(b'test-secret-value', cmdline)

    def test_http_errors_and_transport_errors_map_as_before(self):
        self.fresh_pool()
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.fetch('/error-drip', timeout=10)
        self.assertEqual(caught.exception.code, 403)
        closed = http.server.ThreadingHTTPServer(('127.0.0.1', 0), http.server.BaseHTTPRequestHandler)
        port = closed.server_port
        closed.server_close()
        with self.assertRaises(urllib.error.URLError) as caught:
            open_response(urllib.request.Request(f'http://127.0.0.1:{port}/'), timeout=2, max_bytes=10)
        self.assertEqual(str(caught.exception.reason), 'URLError')

    def test_dead_idle_worker_is_replaced(self):
        pool = self.fresh_pool()
        self.fetch('/ok')
        pool.idle[0].process.kill()
        pool.idle[0].process.wait()
        self.assertIn(b'Complete body.', self.fetch('/ok'))
        self.assertEqual(pool.total, 1)


if __name__ == '__main__':
    unittest.main()
