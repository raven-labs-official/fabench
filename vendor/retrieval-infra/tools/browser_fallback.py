"""Thread-safe adapter from the page helper to bounded, isolated browser workers."""
import gzip
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from article_content import digest, extract_article

POLICY = 'crawl4ai-rendered-dom-v1'
_SLOTS = threading.BoundedSemaphore(2)


def run_browser(url, directory, progress=lambda: None, probe=False):
    queued = time.monotonic()
    while not _SLOTS.acquire(timeout=1): progress()
    queue_ms = int((time.monotonic()-queued)*1000)
    try:
        env = dict(os.environ)
        env['PLAYWRIGHT_BROWSERS_PATH'] = env.get('PLAYWRIGHT_BROWSERS_PATH') or str(Path(sys.prefix).parent / '.playwright')
        proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name('browser_capture.py'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=env, start_new_session=True)
        try:
            stdout, stderr = proc.communicate(json.dumps(dict(url=url, directory=directory, probe=probe)), timeout=45)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            stdout, stderr = proc.communicate()
            return dict(ok=False, error='browser-deadline', queue_ms=queue_ms)
        result = json.loads(stdout)
        result['queue_ms'] = queue_ms
        if proc.returncode or result.get('infrastructure_error'):
            raise RuntimeError('browser dependency/startup failed: ' + str(result.get('error',''))[:400])
        return result
    finally:
        _SLOTS.release()


def apply_browser(out, result):
    """Keep an existing direct body unless a complete, usable rendered article is recovered."""
    out.setdefault('attempts', []).append({'path':'browser', **{k:v for k,v in result.items() if k not in ('captures','dom_capture')}})
    out.setdefault('captures', []).extend(result.get('captures', []))
    if not result.get('ok') or not result.get('dom_capture'): return False
    record = result['dom_capture']
    raw = gzip.decompress(Path(record['path']).read_bytes())
    if digest(raw) != record['sha256'] or record['truncated']: raise ValueError('browser DOM capture integrity failed')
    final_url = result.get('final_url') or out['url']
    # Browser DOM is Unicode serialized as UTF-8, independently of origin charset metadata.
    body, document = extract_article(raw.decode('utf-8'), final_url)
    if not document['usable'] or not document['complete'] or len(body) < 200:
        out['attempts'][-1]['unusable_reason'] = document['unusable_reason'] or 'sparse-or-incomplete-body'
        return False
    from htmldate import find_date
    def date(original):
        try: return find_date(raw.decode('utf-8'), original_date=original, outputformat='%Y-%m-%d', extensive_search=False)
        except Exception: return None
    out.update(source='browser', final_url=final_url, text=body, title=document['title'] or out.get('title',''),
               content_document={**document, 'source_format':'browser-rendered-html'},
               date=date(False), published_date=date(True), why='via browser', browser_policy=POLICY)
    out.pop('quality_error', None)
    return True
