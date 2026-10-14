#!/usr/bin/env python3
"""Fetch URLs, establish a publication date, return the article text.

Reads {"urls": [...]} on stdin, writes {"results": [{url, date, title, text, why}]} on stdout.
`date` is null when no page date could be established. The caller either applies its strict
date gate or performs an explicit content-availability review; extraction alone is not admission.

WHY htmldate AND NOT A HANDFUL OF REGEXES. Four patterns over the obvious metadata fields
reach 82.8% of fetched pages (measured, 495 URLs stratified across the corpus's eleven
months); htmldate's cascade reaches 92.3% with extensive search off. It also knows the ~65
names publishers actually use, which four patterns cannot.

WHY extensive_search=False. The last stages of the cascade scan free text and will accept a
copyright year, returning a confident-looking January 1st. Off, htmldate abstains instead of
guessing — and for this filter an abstention is cheap (one document dropped) while a wrong
date is not (a post-anchor document admitted, silently, invalidating the question it appears
in).

WHY original_date=False. This asks for the LAST MODIFIED date rather than first publication.
The test the caller needs is "could every word on this page have been written before the
anchor", and an edit made after publication is exactly what breaks that. Taking the earlier
of the two dates would pass a page published in January and rewritten in August.
"""
import sys, json, ssl, urllib.request, urllib.error, re, os, time, threading, random
import concurrent.futures as cf
import contextlib, uuid, datetime, queue, atexit
from htmldate import find_date
from lxml import html as lxml_html, etree
from shared_api_admission import acquire as acquire_shared_api, AdmissionError
from bounded_http import open_response, HTTPDeadlineExceeded
from env_names import project_env
_REQUEST_CONTEXT = threading.local()
_MONOTONIC_EPOCH_MS = time.time() * 1000 - time.monotonic() * 1000


class _StdoutWriter:
    """All stdout lines leave through one thread, in the order they were queued.

    The request loop must keep reading while Node is slow to drain the pipe, so a queued
    line normally returns at once. A caller that needs its line in the pipe before it
    continues, such as a timing event naming the capture a native parser is about to read,
    passes wait=True and blocks until the line is written and flushed.
    """

    def __init__(self, stream):
        self.stream = stream
        self.queue = queue.SimpleQueue()
        self.lock = threading.Lock()
        self.error = None
        self.closed = False
        self.thread = threading.Thread(target=self._run, name='helper-stdout', daemon=True)
        self.thread.start()

    def put(self, line, wait=False):
        item = [line, threading.Event() if wait else None, False]
        with self.lock:
            if self.error is not None:
                raise BrokenPipeError(f'helper stdout closed: {type(self.error).__name__}')
            if self.closed:  # after shutdown nothing drains the queue; write in place
                self.stream.write(line)
                self.stream.flush()
                return
            self.queue.put(item)
        if wait:
            item[1].wait()
            if not item[2]:
                raise BrokenPipeError('helper stdout closed before the line was written')

    def _run(self):
        while True:
            item = self.queue.get()
            line, done = item[0], item[1]
            try:
                if line is not None:
                    self.stream.write(line)
                if line is None or done is not None or self.queue.empty():
                    self.stream.flush()
                item[2] = True
            except (BrokenPipeError, OSError) as error:
                with self.lock:
                    self.error = error
                    pending = [item]
                    while True:
                        try:
                            pending.append(self.queue.get_nowait())
                        except queue.Empty:
                            break
                for waiting in pending:
                    if waiting[1] is not None:
                        waiting[1].set()
                return
            if done is not None:
                done.set()
            if line is None:
                return

    def close(self, timeout=30):
        with self.lock:
            if self.closed or self.error is not None:
                return
            self.closed = True
            done = threading.Event()
            self.queue.put([None, done, False])
        done.wait(timeout)


_STDOUT = _StdoutWriter(sys.stdout)
atexit.register(_STDOUT.close)

def timing_emit(context, stage, phase, error=None):
    if not context or not context.get('traceId'): return
    event = dict(context, stage=stage, phase=phase,
                 atUtc=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
                 monotonicMs=_MONOTONIC_EPOCH_MS + time.monotonic() * 1000)
    # faulthandler prints the Python thread identifier in hexadecimal. Match it
    # to the last completed capture without copying page text into diagnostics.
    native = dict(processId=os.getpid(), threadId=hex(threading.get_ident()))
    captured = getattr(_REQUEST_CONTEXT, 'capture', None)
    if captured:
        native.update(captureSha256=captured['sha256'], captureKind=captured['kind'])
    event['python'] = native
    if phase == 'finished': event.update(status='failed' if error else 'success')
    if error: event['errorName'] = type(error).__name__
    # A native crash is matched to the last capture named on stdout, so that line must be in
    # the pipe before the parser runs.
    _STDOUT.put(json.dumps({'id': getattr(_REQUEST_CONTEXT, 'request_id', None), 'timing': event}) + '\n',
                wait=bool(captured))

# Parsing a very large page can hold a worker for a minute without any network activity.
# While such a local step runs, the request keeps reporting progress, up to this limit; a
# step that exceeds it stops reporting, so a real hang still trips the caller's deadline.
CPU_STAGES = frozenset({'document.extract', 'document.date.modified', 'document.date.published'})
CPU_STAGE_LIMIT_S = float(os.environ.get('PAGE_DATER_CPU_STAGE_LIMIT_S', '600'))
_CPU_STAGES = {}
_CPU_STAGES_LOCK = threading.Lock()


def request_in_bounded_cpu_stage(request_id):
    now = time.monotonic()
    with _CPU_STAGES_LOCK:
        return any(owner == request_id and now - started < CPU_STAGE_LIMIT_S
                   for owner, started in _CPU_STAGES.values())


@contextlib.contextmanager
def stage(name, context=None):
    prior = getattr(_REQUEST_CONTEXT, 'timing', None)
    cpu_key = None
    if name in CPU_STAGES:
        cpu_key = object()
        with _CPU_STAGES_LOCK:
            _CPU_STAGES[cpu_key] = (getattr(_REQUEST_CONTEXT, 'request_id', None), time.monotonic())
    current = context or dict(prior or {}, parentId=(prior or {}).get('spanId'), spanId=str(uuid.uuid4()))
    _REQUEST_CONTEXT.timing = current
    if context: timing_emit(current, name, 'admitted')
    timing_emit(current, name, 'started')
    try:
        yield
    except BaseException as error:
        timing_emit(current, name, 'finished', error)
        raise
    else:
        timing_emit(current, name, 'finished')
    finally:
        _REQUEST_CONTEXT.timing = prior
        if cpu_key is not None:
            with _CPU_STAGES_LOCK:
                _CPU_STAGES.pop(cpu_key, None)


def admission_progress(request_id=None):
    if request_id is None:
        request_id = getattr(_REQUEST_CONTEXT, 'request_id', None)
    if request_id is not None:
        _STDOUT.put(json.dumps({'id': request_id, 'admission_wait': True}) + '\n')

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/120.0.0.0 Safari/537.36")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# Explicit new treatment; legacy callers keep their recorded extraction behavior.
ARTICLE_MODE = project_env('FABENCH_CONTENT_POLICY', None) == 'article-blocks-tables-v1'
RAW_DIRECTORY = project_env('FABENCH_RAW_PAGES_DIR', '')
BROWSER_ON = ARTICLE_MODE and project_env('FABENCH_BROWSER_FALLBACK', None) == '1'


def capture(out, raw, kind, truncated=False):
    if not ARTICLE_MODE: return True
    from article_content import archive_capture
    # A Reader fallback archives a different input from the direct response.
    # Never attribute an in-progress or failed write to the previous capture.
    _REQUEST_CONTEXT.capture = None
    try:
        with stage('capture.archive'):
            captured = archive_capture(raw, RAW_DIRECTORY, kind, truncated)
            out.setdefault('captures', []).append(captured)
            _REQUEST_CONTEXT.capture = captured
        return True
    except (OSError, ValueError):
        out['quality_error'] = 'raw capture could not be persisted'
        out['text'] = ''
        return False

TAGS = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.S | re.I)
INLINE_BINARY = re.compile(r"data:(?:image|audio|video)/[\w.+-]+(?:;[\w=.+-]+)*?;base64,[A-Za-z0-9+/=\r\n]+", re.I)


def set_text(out: dict, text: str, limit: int = 40000) -> None:
    """Remove unreadable inline media before the text budget; retain Markdown alt text.

    This text-only tool never decodes images. Do not delete ordinary URLs, scoreboards,
    tables, future dates or prose under the guise of cleanup.
    """
    cleaned, count = INLINE_BINARY.subn("[inline media omitted]", text)
    cleaned = cleaned.strip()
    if ARTICLE_MODE and limit == 40000: limit = 0
    out["text"] = cleaned[:limit] if limit else cleaned
    out["text_extraction"] = dict(raw_text_chars=len(text), cleaned_text_chars=len(cleaned),
        inline_media_removed=count, delivered_chars=len(out["text"]), truncated=bool(limit and len(cleaned)>limit))


def text_of(html: str) -> str:
    """Parse markup before discarding executable/style nodes, including unclosed tails.

    Keep all ordinary visible text, including ancillary headlines and scores: cleanup
    must not silently become a semantic leakage filter. A truncated style element must
    not consume the delivered text budget as CSS.
    """
    try:
        root = lxml_html.fromstring(html)
        for node in root.xpath('//script|//style|//noscript|//template'):
            node.drop_tree()
        return re.sub(r"\s+", " ", " ".join(root.itertext())).strip()
    except (ValueError, TypeError, etree.ParserError):
        return ""


def title_of(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return re.sub(r"\s+", " ", m.group(1)).strip()[:200] if m else ""


# Reader endpoint used only when a direct fetch is refused. Off unless JINA_READER=1.
#
# WHY A FALLBACK AND NOT THE MAIN PATH. About a third of news URLs answer 403 to any ordinary
# client: the refusals come from CDN bot rules (CloudFront WAF, Cloudflare's JS challenge)
# aimed at AI crawlers, and they are not random — measured on 20 such URLs, the blocked set
# was dominated by public-radio stations (kbia, cpr, kyuk, wrkf, publicradiotulsa, wxxinews,
# kenw, kanw), which are exactly the outlets through which AP and NPR copy reaches this
# corpus. Losing them is a systematic hole, not a sampling loss.
#
# Measured on those same 20: the reader returned article text for 18, and a publication date
# for 18 as well, in a `Published Time:` header. Dates cross-checked against the crawl month
# the URLs were sampled from and they line up. It marks its own failures — a page it could
# not get through returns a body carrying "requiring CAPTCHA" or "has been denied" rather
# than pretending to be an article, which is what makes it safe to use: a silent CAPTCHA page
# admitted as article text would be worse than no document at all.
#
# Direct fetch stays primary. The reader is slower, is a third party in the path, and returns
# markdown rather than the original HTML, so htmldate cannot run on it — its date comes from
# the reader's own header instead, which is a different and less inspectable provenance.
READER = "https://r.jina.ai/"
# The reader refuses a spoofed browser UA — the full Chrome string reproducibly returns 403
# while an honest client name returns 200. It does not want callers pretending to be
# browsers, which is a hint about what it is: an identified service, not a stealth proxy.
READER_UA = "raven-bench/1.0"
# Anonymous reader access is blocked PER TARGET DOMAIN, not rate-limited: r.jina.ai answers
# "AbuseAlleviationError: Anonymous access to domain www.reuters.com blocked until ..." for
# exactly the tier-1 outlets that also block Common Crawl, while bbc.com and cnbc.com return
# 200 from the same burst. A key lifts that, so it is worth setting.
READER_KEY = os.environ.get("JINA_API_KEY", "").strip()
# Both were far longer than anything a live page takes: measured reader latency is 4-11s and
# a site that blocks us answers 403 in under a second. The old 20s + 70s pair meant one dead
# host could hold a worker for a minute and a half.
DIRECT_TIMEOUT = float(os.environ.get("DIRECT_TIMEOUT_S", "8"))
# This is the single source consumed by both this helper and PageDater. The Node caller adds
# a small serialization grace period rather than racing this socket timeout at the same instant.
READER_TIMEOUT = float(os.environ.get("READER_TIMEOUT_S", "30"))

# One reader call at a time, with a gap between them.
#
# The reader is rate-limited, and the limit is low enough that a benchmark run walks straight
# into it. Measured across an 8-question run over two columns: of 140 URLs that the direct
# fetch could not get, 204 reader attempts came back 429 and only 29 returned an article. The
# same reader, called from a single column at lower concurrency, refused nothing and recovered
# 16 of 30. So the pages are reachable; we were simply asking too fast.
#
# Pacing, and what three measurements say about it.
#
# Unpaced, an 8-question run over two columns drew 204 refusals and recovered 29 pages.
# Spacing request STARTS 1.2s apart improved that to 135 refusals and 40 recovered. Holding a
# permit for the whole call at concurrency 2 — on the theory that ~6s per call left several in
# flight and the concurrency was the trigger — made it WORSE: 158 refusals, 34 recovered, and
# 40% more wall clock.
#
# That last result rules out the concurrency explanation. What remains fits a per-minute
# quota: six requests sent one at a time drew zero refusals, while ~200 requests over ~700
# seconds is about 17 per minute regardless of how they are spaced, and retries push it
# higher. No arrangement of the same volume gets under a volume limit; that needs either an
# API key with a larger allowance or fewer requests.
#
# So concurrency is left generous and the interval does the pacing. Both are environment
# variables so this is tunable without an edit once the actual allowance is known.
# Stated as a request rate, not a magic interval: the reader's published limit with a key is
# 500 RPM, and the number here should be readable against that. The old 1.2s gap was set for
# ANONYMOUS access (20 RPM) and left in place after the key arrived — it serialised starts at
# 50/min, a tenth of the allowance, and with forty-eight workers the last page in a batch
# waited 58 seconds behind the gate. Probed directly, the reader served 150 concurrent
# requests without a refusal.
_READER_SEMAPHORE = threading.BoundedSemaphore(int(os.environ.get("JINA_CONCURRENCY", "16")))
_READER_LOCK = threading.Lock()
_READER_GAP = 60.0 / float(os.environ.get("JINA_RPM", "400"))
_READER_LAST = [0.0]


class reader_slot:
    """Hold one reader permit, and space starts apart, for the duration of a `with` block."""

    def __enter__(self):
        with stage('reader.admission'):
            while not _READER_SEMAPHORE.acquire(timeout=1):
                admission_progress()
            try:
                self.shared = acquire_shared_api(READER, READER_KEY, admission_progress)
            except Exception:
                _READER_SEMAPHORE.release()
                raise
            with _READER_LOCK:
                wait = _READER_GAP - (time.monotonic() - _READER_LAST[0])
                if wait > 0:
                    time.sleep(wait)
                _READER_LAST[0] = time.monotonic()
            return self

    def __exit__(self, *exc):
        try:
            if self.shared:
                self.shared.release(exc[1])
        finally:
            _READER_SEMAPHORE.release()
        return False
READER_ON = os.environ.get("JINA_READER") == "1"
READER_BLOCKED = re.compile(r"requiring CAPTCHA|has been denied|Just a moment", re.I)
READER_DATE = re.compile(r"^Published Time:\s*(.+)$", re.M)
READER_TITLE = re.compile(r"^Title:\s*(.+)$", re.M)


def reader_preflight() -> dict:
    """Exercise the configured Jina account without exposing its credential or target data."""
    if not READER_ON:
        return {"enabled": False, "ok": True, "http_status": None, "error": None}
    try:
        with reader_slot():
            headers = {"User-Agent": READER_UA, "Accept": "text/plain"}
            if READER_KEY:
                headers["Authorization"] = f"Bearer {READER_KEY}"
            req = urllib.request.Request(READER + "https://example.com", headers=headers)
            with open_response(req, timeout=READER_TIMEOUT, max_bytes=4096, context=CTX) as res:
                body = res.read(4096)
                status = int(getattr(res, "status", 200))
        if status < 200 or status >= 300 or not body.strip():
            return {"enabled": True, "ok": False, "http_status": status,
                    "error": "reader returned no usable body"}
        return {"enabled": True, "ok": True, "http_status": status, "error": None}
    except urllib.error.HTTPError as e:
        try:
            detail = e.read(300).decode("utf-8", "ignore").replace("\n", " ").strip()
        except Exception:
            detail = ""
        return {"enabled": True, "ok": False, "http_status": e.code,
                "error": (detail[:180] or f"HTTP {e.code}")}
    except Exception as e:
        return {"enabled": True, "ok": False, "http_status": None,
                "error": type(e).__name__}


def normalise_date(raw: str) -> str | None:
    """The reader's Published Time is not one format: ISO, RFC 2822, and oddities such as
    `2026-01-02CET07:49` all appear. Only a plain calendar date is needed downstream."""
    raw = raw.strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.search(r"(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})", raw, re.I)
    if m:
        mo = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].index(m.group(2).lower()[:3]) + 1
        return f"{m.group(3)}-{mo:02d}-{int(m.group(1)):02d}"
    return None


def via_reader(url: str, out: dict, attempts: int = 3) -> dict:
    """Second attempt through the reader. Leaves `out` untouched on any doubt."""
    body = None
    for i in range(attempts):
        try:
            with reader_slot():
                _h = {"User-Agent": READER_UA, "Accept": "text/plain"}
                if READER_KEY:
                    _h["Authorization"] = f"Bearer {READER_KEY}"
                req = urllib.request.Request(READER + url, headers=_h)
                with stage('http.reader'):
                    reader_limit = 8 * 1024 * 1024 if ARTICLE_MODE else 900000
                    with open_response(req, timeout=READER_TIMEOUT, max_bytes=reader_limit + (1 if ARTICLE_MODE else 0), context=CTX) as res:
                        reader_raw = res.read(reader_limit + (1 if ARTICLE_MODE else 0))
                        reader_truncated = len(reader_raw) > reader_limit
                        if not capture(out, reader_raw, 'reader-response', reader_truncated): return out
                        body = reader_raw[:reader_limit].decode("utf-8", "ignore")
            break
        except urllib.error.HTTPError as e:
            # Back off on a refusal for going too fast; anything else is this URL, not our
            # pace, so retrying it would only spend the rate limit on a certain failure.
            #
            # The wait happens outside the permit so a backing-off request does not hold a
            # slot the other threads could use.
            if e.code == 429 and i < attempts - 1:
                time.sleep((2 ** i) * _READER_GAP + random.random())
                continue
            # Keep the body on a refusal. A counter can say "1,894 blocked" but not whether
            # the service is rate-limiting, refusing the target, or out of quota — and those
            # need opposite fixes. Truncated because some of these are whole HTML pages.
            try:
                detail = e.read(400).decode("utf-8", "ignore").replace("\n", " ").strip()
            except Exception:
                detail = ""
            out["why"] += f" · reader HTTP {e.code}" + (f" [{detail[:180]}]" if detail else "")
            return out
        except AdmissionError:
            out['why'] += ' · reader API admission unavailable'
            return out
        except Exception as e:
            out["why"] += f" · reader {type(e).__name__}"
            if isinstance(e, HTTPDeadlineExceeded): out["why"] += f" ({e})"
            return out
    if body is None:
        out["why"] += " · reader HTTP 429"
        return out
    if READER_BLOCKED.search(body[:600]):
        out["why"] += " · reader hit CAPTCHA"
        return out
    marker = body.find("Markdown Content:")
    article = body[marker + len("Markdown Content:"):] if marker >= 0 else body
    if not article.strip():
        out["why"] += " · reader empty body"
        return out
    d = READER_DATE.search(body)
    date = normalise_date(d.group(1)) if d else None
    t = READER_TITLE.search(body)
    out["date"] = date
    out["title"] = (t.group(1).strip()[:200] if t else "")
    # Strip the reader's own header block; everything after `Markdown Content:` is the article.
    set_text(out, article)
    if ARTICLE_MODE:
        from article_content import reader_document
        with stage('document.reader-extract'):
            out['content_document'] = reader_document(out['text'])
        out['content_document']['complete'] = bool(out['content_document'].get('usable')) and not reader_truncated
        out.pop('quality_error', None)
        source = re.search(r'^URL Source:\s*(https?://\S+)\s*$', body, re.M)
        if source: out['final_url'] = source.group(1)
    # Dating and extraction are separate. Strict mode still rejects date=None; content
    # mode and independent audits must see the successfully fetched text to assess it.
    out["why"] = "via reader" if date else "via reader · no date"
    out["source"] = "reader"
    return out


def _timed(out: dict, t0: float) -> dict:
    out["ms"] = int((time.monotonic() - t0) * 1000)
    return out


def fallback(url, out, browser=True):
    if BROWSER_ON and browser:
        from browser_fallback import run_browser, apply_browser
        try:
            if apply_browser(out, run_browser(url, RAW_DIRECTORY, admission_progress)):
                return out
        except Exception as error:
            # Broken browser installation/capture storage changes the treatment, so do
            # not silently replace a configured path with another implementation.
            out['quality_error'] = 'browser processing failed: ' + str(error)[:400]
            return out
    return via_reader(url, out) if READER_ON else out


def one(url: str) -> dict:
    # ms is reported per page because "the fetch layer is slow" is not actionable — the run
    # summary needs to say WHICH step is slow. Worst case here used to be 90s (20s direct
    # timeout then a 70s reader timeout), and forty-eight workers each holding one of those
    # is how a queue that drains at 1.3 pages/second happens.
    t0 = time.monotonic()
    out = {"url": url, "date": None, "title": "", "text": "", "why": "", "source": "direct", "ms": 0}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/pdf;q=0.9"})
        with stage('http.direct'):
            max_bytes = (8 if ARTICLE_MODE else 3) * 1024 * 1024
            with open_response(req, timeout=DIRECT_TIMEOUT, max_bytes=max_bytes + 1, context=CTX) as res:
                raw = res.read(max_bytes + 1)
                out['response_bytes_read'] = len(raw)
                out['response_truncated'] = len(raw) > max_bytes
                out['final_url'] = res.geturl() if hasattr(res, 'geturl') else url
                if not capture(out, raw, 'origin-response', out['response_truncated']): return _timed(out, t0)
                content_type = res.headers.get('Content-Type', '').split(';')[0].strip().lower()
                out['content_type'] = content_type
                is_pdf = content_type == 'application/pdf' or raw[:1024].lstrip().startswith(b'%PDF-')
                html = raw[:max_bytes].decode("utf-8", "ignore") if not is_pdf else ''
                # Zero-error in measurement (132 pages, none postdating their own crawl) but
                # present on only 39%, so it is a cross-check rather than the primary signal.
                out["lastmod"] = res.headers.get("Last-Modified")
    except urllib.error.HTTPError as e:
        out["why"] = f"HTTP {e.code}"
        if ARTICLE_MODE:
            error_raw = e.read(8 * 1024 * 1024 + 1)
            out['http_status'] = e.code
            if not capture(out, error_raw, 'origin-error-response', len(error_raw) > 8 * 1024 * 1024): return _timed(out, t0)
        return _timed(fallback(url, out), t0)
    except Exception as e:
        out["why"] = "timeout" if "timed out" in str(e) else "fetch failed"
        if isinstance(e, HTTPDeadlineExceeded): out["why"] += f" ({e})"
        return _timed(fallback(url, out), t0)

    # A PDF is not HTML. Decoding compressed PDF bytes can expose metadata dates and
    # then falsely pass binary fragments as article text. The configured Reader already
    # supports PDF text; on failure retain an explicit extraction failure, never bytes.
    if is_pdf:
        out['why'] = 'PDF requires text extraction'
        return _timed(fallback(url, out, browser=False), t0)

    try:
        with stage('document.date.modified'):
            out["date"] = find_date(html, original_date=False, outputformat="%Y-%m-%d",
                                    extensive_search=False)
    except Exception:
        out["date"] = None
    # Preserve a successful direct fetch even if the reader fallback cannot supply a date.
    # Strict date mode withholds it; content mode may review the recovered candidate body.
    out["title"] = title_of(html)
    if ARTICLE_MODE:
        from article_content import extract_article
        try:
            with stage('document.extract'):
                article, document = extract_article(raw[:max_bytes], url)
            document['complete'] = document['complete'] and not out['response_truncated']
            out['content_document'] = document
            if document['title']: out['title'] = document['title']
            set_text(out, article)
        except Exception:
            out['text'] = ''
            out['why'] = 'article extraction failed'
        try:
            with stage('document.date.published'):
                out['published_date'] = find_date(html, original_date=True, outputformat='%Y-%m-%d', extensive_search=False)
        except Exception:
            out['published_date'] = None
    else:
        set_text(out, text_of(html))
    content_bad = ARTICLE_MODE and (not out.get('content_document', {}).get('usable') or not out.get('content_document', {}).get('complete'))
    if (not ARTICLE_MODE and not out['date']) or out.get('response_truncated') or len(out['text']) < 200 or content_bad:
        reasons = []
        if not out['date']: reasons.append('no date in page')
        if out.get('response_truncated'): reasons.append('direct response truncated')
        if len(out['text']) < 200: reasons.append('sparse direct text')
        if content_bad: reasons.append('unusable direct article')
        out["why"] = ' · '.join(reasons)
        # Recover missing article content; only the legacy date-gate additionally
        # refetches complete pages merely because htmldate abstained.
        return _timed(fallback(url, out), t0)

    if not out['date']: out['why'] = 'no date in page'

    return _timed(out, t0)


# ── request loop ─────────────────────────────────────────────────────────────
#
# One long-lived process, one request per line: {"id": N, "urls": [...]} in,
# {"id": N, "results": [...]} out. The caller used to start a fresh process per batch, which
# cost 0.4s importing htmldate every time AND gave each process its own copy of the reader
# semaphore below — so "8 concurrent" became 8 x fifty processes, and the throttling that
# followed was ours, not the service's.
#
# FETCH_CONCURRENCY is therefore the whole run's budget, not one batch's, which also makes it
# the run's throughput ceiling: every page a web arm needs queues here. Sized against the
# reader's published 500 RPM — at ~8s a page, 48 in flight is ~360 RPM, leaving headroom for
# the direct fetches that never touch the reader. 24 was measurably too tight: one question
# took nine minutes because 1,280 fetches were queued three-per-second behind it.
_POOL = cf.ThreadPoolExecutor(int(os.environ.get("FETCH_CONCURRENCY", "48")))


def _serve(req: dict) -> str:
    _REQUEST_CONTEXT.request_id = req.get('id')
    _REQUEST_CONTEXT.timing = req.get('timing')
    if req.get("ping") is True:
        if ARTICLE_MODE:
            try:
                import article_content
                if not RAW_DIRECTORY: raise ValueError('raw capture directory missing')
            except (ImportError, ValueError):
                reader = {"enabled": READER_ON, "ok": False, "http_status": None, "error": "article extraction dependencies or capture directory unavailable"}
            else:
                reader = reader_preflight()
        else:
            reader = reader_preflight()
        browser = {'enabled':BROWSER_ON, 'ok':True}
        if BROWSER_ON:
            try:
                from browser_fallback import run_browser
                browser.update(run_browser('', RAW_DIRECTORY, admission_progress, probe=True))
            except Exception as error:
                browser.update(ok=False, error=str(error)[:400])
        line = json.dumps({"id": req.get("id"), "ok": reader["ok"] and browser['ok'],
                           "reader": reader, "browser":browser, "results": []})
        return line
    def one_with_context(url, context):
        _REQUEST_CONTEXT.request_id = req.get('id')
        _REQUEST_CONTEXT.timing = req.get('timing')
        _REQUEST_CONTEXT.capture = None
        admission_progress()  # Begin active work with a fresh inactivity deadline.
        try:
            with stage('python.page', context):
                return one(url)
        finally:
            _REQUEST_CONTEXT.capture = None
    futures = []
    for url in req.get('urls', []):
        context = dict(req.get('timing') or {}, parentId=(req.get('timing') or {}).get('spanId'), spanId=str(uuid.uuid4()))
        timing_emit(context, 'python.page', 'queued')
        futures.append(_POOL.submit(one_with_context, url, context))
    pending = set(futures)
    while pending:
        _, pending = cf.wait(pending, timeout=1, return_when=cf.FIRST_COMPLETED)
        # Batches queued behind workers waiting on shared quota have not started a
        # network request yet. Running network requests retain their own socket
        # timeouts; local parsing reports progress only within CPU_STAGE_LIMIT_S.
        if any(not future.running() for future in pending) or request_in_bounded_cpu_stage(req.get('id')):
            admission_progress()
    results = [future.result() for future in futures]
    line = json.dumps({"id": req.get("id"), "results": results})
    return line


def main() -> None:
    # Requests are handled off the read loop so batches overlap; a separate executor because
    # handing them to _POOL would let a handler wait on a pool it is itself occupying.
    dispatch = cf.ThreadPoolExecutor(int(os.environ.get("PAGE_DATER_DISPATCH_CONCURRENCY", "64")))
    queued_requests = {}
    queue_lock = threading.Lock()
    stop_progress = threading.Event()

    def keep_queued_requests_live():
        while not stop_progress.wait(1):
            with queue_lock:
                waiting = [request_id for future, request_id in queued_requests.items()
                           if not future.running() and not future.done()]
            # Only unstarted requests receive these heartbeats. Active operations
            # retain their socket/inactivity deadlines and cannot hide a stall.
            for request_id in waiting:
                try:
                    admission_progress(request_id)
                except (BrokenPipeError, OSError):
                    return

    def forget_request(future):
        with queue_lock:
            queued_requests.pop(future, None)

    progress_thread = threading.Thread(target=keep_queued_requests_live, daemon=True)
    progress_thread.start()
    def serve_with_timing(req, context):
        _REQUEST_CONTEXT.request_id = req.get('id')
        _REQUEST_CONTEXT.timing = context
        admission_progress()
        with stage('python.dispatch', context):
            result = _serve(dict(req, timing=context))
        # Finish timing before the reply removes Node's pending request sink; the queue keeps
        # this order.
        _STDOUT.put(result + "\n")
    try:
        for line in sys.stdin:
            line = line.strip()
            if line:
                req = json.loads(line)
                context = dict(req.get('timing') or {}, parentId=(req.get('timing') or {}).get('spanId'), spanId=str(uuid.uuid4()))
                _REQUEST_CONTEXT.request_id = req.get('id')
                timing_emit(context, 'python.dispatch', 'queued')
                future = dispatch.submit(serve_with_timing, req, context)
                with queue_lock:
                    queued_requests[future] = req.get('id')
                future.add_done_callback(forget_request)
    finally:
        dispatch.shutdown(wait=True)
        stop_progress.set()
        progress_thread.join(timeout=2)
        _STDOUT.close()


if __name__ == "__main__":
    main()
