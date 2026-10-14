"""Bound the complete urllib exchange, including DNS, redirects and body reads.

Socket timeouts only limit individual waits. A small stdlib-only child keeps the existing
urllib transport while giving its caller an enforceable wall clock deadline. Headers
(including credentials) are sent through stdin, never argv.

Children are long-lived and serve one request at a time. Starting a Python interpreter per
request cost about 0.16 CPU seconds each; at 24 concurrent questions that was more than one
core of a four-core host. A child that misses its deadline is killed and discarded, so the
deadline stays a hard wall clock bound; the next request starts a replacement.
"""
import email.message
import io
import json
import os
from pathlib import Path
import queue
import select
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

WORKER_FLAG = '--bounded-http-worker'
# Idle children beyond this age are closed so a quiet helper does not keep memory.
IDLE_SECONDS = float(os.environ.get('BOUNDED_HTTP_IDLE_S', '60'))


def _default_cap():
    configured = os.environ.get('BOUNDED_HTTP_MAX_WORKERS')
    if configured:
        return max(1, int(configured))
    # Callers are the helper's fetch threads; never make them queue for a child by default.
    return max(128, int(os.environ.get('FETCH_CONCURRENCY', '0') or 0) + 16)


class HTTPDeadlineExceeded(TimeoutError):
    pass


class Response(io.BytesIO):
    def __init__(self, body, metadata):
        super().__init__(body)
        self.status = metadata['status']
        self.headers = email.message.Message()
        for key, value in metadata['headers']:
            self.headers[key] = value
        self.url = metadata['url']

    def geturl(self):
        return self.url


class _WorkerFailed(Exception):
    """The child died or broke the reply framing; it is discarded."""


class _Worker:
    def __init__(self, process):
        self.process = process
        self.fd = process.stdout.fileno()
        self.idle_since = time.monotonic()

    def alive(self):
        return self.process.poll() is None

    def kill(self):
        try:
            self.process.kill()
        except OSError:
            pass
        for stream in (self.process.stdin, self.process.stdout):
            try:
                stream.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

    def exchange(self, payload, deadline):
        """Send one request; return (metadata, body) or raise with the phase reached."""
        try:
            data = memoryview(json.dumps(payload).encode() + b'\n')
            while data:
                data = data[self.process.stdin.write(data):]
        except OSError as error:
            raise _WorkerFailed('request write failed') from error
        headers_received = False
        buffer = bytearray()
        while True:
            while buffer:
                if buffer.startswith(b'H\n'):
                    headers_received = True
                    del buffer[:2]
                    continue
                if not buffer.startswith(b'R '):
                    raise _WorkerFailed('malformed reply')
                newline = buffer.find(b'\n')
                if newline < 0:
                    break
                try:
                    meta_len, body_len = (int(x) for x in buffer[2:newline].split())
                except ValueError as error:
                    raise _WorkerFailed('malformed reply header') from error
                end = newline + 1 + meta_len + body_len
                if len(buffer) < end:
                    break
                if len(buffer) > end:
                    raise _WorkerFailed('unexpected bytes after reply')
                metadata = json.loads(bytes(buffer[newline + 1:newline + 1 + meta_len]))
                return metadata, bytes(buffer[newline + 1 + meta_len:end])
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _Deadline(headers_received)
            ready, _, _ = select.select([self.fd], [], [], remaining)
            if not ready:
                raise _Deadline(headers_received)
            chunk = os.read(self.fd, 1 << 16)
            if not chunk:
                raise _WorkerFailed('worker closed its output')
            buffer += chunk


class _Deadline(Exception):
    def __init__(self, headers_received):
        super().__init__()
        self.headers_received = headers_received


class _Pool:
    """Thread-safe set of children. Every child is started by one long-lived thread, because
    PR_SET_PDEATHSIG fires when the creating thread exits, not only when the process does."""

    def __init__(self):
        self.pid = os.getpid()
        self.cap = _default_cap()
        self.lock = threading.Condition()
        self.idle = []
        self.total = 0
        self.spawn_requests = queue.SimpleQueue()
        self.spawner = threading.Thread(target=self._spawn_loop, name='bounded-http-spawner', daemon=True)
        self.spawner.start()

    def _spawn_loop(self):
        while True:
            done, holder = self.spawn_requests.get()
            try:
                holder['process'] = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), WORKER_FLAG, str(os.getpid())],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
            except BaseException as error:  # handed back to the waiting caller
                holder['error'] = error
            done.set()

    def _spawn(self):
        done, holder = threading.Event(), {}
        self.spawn_requests.put((done, holder))
        done.wait()
        if 'error' in holder:
            raise holder['error']
        return _Worker(holder['process'])

    def acquire(self, deadline):
        stale = []
        try:
            with self.lock:
                while True:
                    now = time.monotonic()
                    keep = []
                    for worker in self.idle:
                        if worker.alive() and now - worker.idle_since <= IDLE_SECONDS:
                            keep.append(worker)
                        else:
                            stale.append(worker)
                            self.total -= 1
                    self.idle = keep
                    if self.idle:
                        return self.idle.pop()
                    if self.total < self.cap:
                        self.total += 1
                        break
                    remaining = deadline - now
                    if remaining <= 0:
                        raise _Deadline(False)
                    self.lock.wait(remaining)
        finally:
            if stale:
                with self.lock:
                    self.lock.notify_all()
            for worker in stale:
                worker.kill()
        try:
            return self._spawn()
        except BaseException:
            with self.lock:
                self.total -= 1
                self.lock.notify()
            raise

    def release(self, worker, healthy):
        if healthy and worker.alive():
            worker.idle_since = time.monotonic()
            with self.lock:
                self.idle.append(worker)
                self.lock.notify()
            return
        worker.kill()
        with self.lock:
            self.total -= 1
            self.lock.notify()


_POOL = None
_POOL_LOCK = threading.Lock()


def _pool():
    global _POOL
    with _POOL_LOCK:
        if _POOL is None or _POOL.pid != os.getpid():
            _POOL = _Pool()
        return _POOL


def open_response(request, *, timeout, max_bytes, context=None):
    deadline = time.monotonic() + timeout
    payload = dict(url=request.full_url, headers=dict(request.header_items()),
                   timeout=timeout, max_bytes=max_bytes,
                   parent_pid=os.getpid(),
                   verify_tls=context is None or context.verify_mode != ssl.CERT_NONE)
    pool = _pool()
    try:
        worker = pool.acquire(deadline)
    except _Deadline:
        raise HTTPDeadlineExceeded(f'HTTP transfer timed out after {timeout}s (before-response-headers)') from None
    healthy = False
    try:
        metadata, body = worker.exchange(payload, deadline)
        healthy = True
    except _Deadline as error:
        phase = 'response-body' if error.headers_received else 'before-response-headers'
        raise HTTPDeadlineExceeded(f'HTTP transfer timed out after {timeout}s ({phase})') from None
    except _WorkerFailed:
        code = worker.process.poll()
        if code is None:
            try:
                code = worker.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                code = None
        if code:
            raise subprocess.CalledProcessError(code, worker.process.args) from None
        raise
    finally:
        pool.release(worker, healthy)
    if metadata.get('error'):
        raise urllib.error.URLError(metadata['error'])
    response = Response(body, metadata)
    if response.status >= 400:
        raise urllib.error.HTTPError(response.url, response.status, 'HTTP error', response.headers, response)
    return response


_CONTEXTS = {}


def _context(verify_tls):
    if verify_tls not in _CONTEXTS:
        context = ssl.create_default_context()
        if not verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        _CONTEXTS[verify_tls] = context
    return _CONTEXTS[verify_tls]


def _serve_one(request, output):
    try:
        req = urllib.request.Request(request['url'], headers=request['headers'])
        try:
            response = urllib.request.urlopen(req, timeout=request['timeout'], context=_context(request['verify_tls']))
        except urllib.error.HTTPError as error:
            response = error
        with response:
            output.write(b'H\n')
            output.flush()
            body = response.read(request['max_bytes'])
            metadata = dict(status=response.status, url=response.geturl(), headers=list(response.headers.items()))
    except Exception as error:
        # Do not copy the request, credential or arbitrary exception body into logs.
        metadata, body = dict(error=type(error).__name__), b''
    encoded = json.dumps(metadata).encode()
    output.write(b'R %d %d\n' % (len(encoded), len(body)) + encoded + body)
    output.flush()


def worker_main(parent_pid):
    if sys.platform == 'linux':
        import ctypes
        import signal
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise OSError('Cannot attach HTTP worker lifetime to helper')
    if os.getppid() != parent_pid:
        return
    source, output = sys.stdin.buffer, sys.stdout.buffer
    while True:
        line = source.readline()
        if not line:
            return
        request = json.loads(line)
        if os.getppid() != request['parent_pid']:
            return
        _serve_one(request, output)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == WORKER_FLAG:
        worker_main(int(sys.argv[2]))
    else:
        raise SystemExit(f'usage: {Path(__file__).name} {WORKER_FLAG} PARENT_PID')
