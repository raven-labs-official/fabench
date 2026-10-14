"""Persistent IPC client. Credentials never cross this pipe: only an opaque quota identifier."""
import atexit, hashlib, json, subprocess, threading, uuid
from urllib.parse import urlsplit

from env_names import project_env

class AdmissionError(RuntimeError):
    pass

class Bridge:
    def __init__(self):
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.waiters = {}
        self.failure = None
        self.child = subprocess.Popen([
            project_env('FABENCH_NODE_EXECUTABLE'), '--import', project_env('FABENCH_TSX_LOADER'),
            project_env('FABENCH_API_BRIDGE'),
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        threading.Thread(target=self._read, daemon=True).start()
        atexit.register(self.close)

    def _read(self):
        try:
            for line in self.child.stdout:
                message = json.loads(line)
                with self.lock:
                    waiter = self.waiters.get(str(message.get('id')))
                    if waiter:
                        waiter['message'] = message
                        waiter['event'].set()
        finally:
            with self.lock:
                self.failure = AdmissionError('reader API admission unavailable')
                for waiter in self.waiters.values():
                    waiter['event'].set()

    def rpc(self, payload, progress=None):
        request_id = str(uuid.uuid4())
        waiter = {'event': threading.Event(), 'message': None}
        with self.lock:
            if self.failure:
                raise self.failure
            self.waiters[request_id] = waiter
        try:
            with self.write_lock:
                self.child.stdin.write(json.dumps(dict(payload, id=request_id)) + '\n')
                self.child.stdin.flush()
            while not waiter['event'].wait(1):
                if progress:
                    progress()
            message = waiter['message']
            if not message or not message.get('ok'):
                raise AdmissionError('reader API admission unavailable')
            return message
        except (OSError, BrokenPipeError) as error:
            raise AdmissionError('reader API admission unavailable') from error
        finally:
            with self.lock:
                self.waiters.pop(request_id, None)

    def close(self):
        try:
            self.child.stdin.close()
            self.child.wait(timeout=3)
        except Exception:
            self.child.kill()

_bridge = None
_lock = threading.Lock()

def acquire(endpoint, credential, progress=None):
    global _bridge
    if not project_env('FABENCH_API_ADMISSION_DB', None):
        if project_env('FABENCH_SHARED_LIFECYCLE', None) == '1':
            raise AdmissionError('reader API admission unavailable')
        return None
    with _lock:
        if _bridge is None:
            _bridge = Bridge()
    parts = urlsplit(endpoint)
    origin = parts.scheme + '://' + parts.netloc
    digest = hashlib.sha256((origin + '\0' + credential).encode()).hexdigest()[:24]
    resource = 'api:' + parts.netloc + ':' + digest
    token = _bridge.rpc({'op': 'acquire', 'resource': resource}, progress)['token']
    return Permit(_bridge, token, progress)

class Permit:
    def __init__(self, bridge, token, progress):
        self.bridge, self.token, self.progress = bridge, token, progress

    def release(self, error=None):
        if getattr(error, 'code', None) == 429:
            headers = getattr(error, 'headers', {})
            self.bridge.rpc({'op': 'limited', 'token': self.token,
                             'retry_after': headers.get('Retry-After')}, self.progress)
        self.bridge.rpc({'op': 'release', 'token': self.token, 'success': error is None}, self.progress)
