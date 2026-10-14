"""Bounded Crawl4AI browser capture. JSON protocol; captured material stays outside Git."""
import asyncio
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
from urllib.parse import urlsplit

POLICY = 'crawl4ai-rendered-dom-v1'
MAX_BYTES = 8 * 1024 * 1024


def browser_directory():
    return os.environ.get('PLAYWRIGHT_BROWSERS_PATH') or str(Path(sys.prefix).parent / '.playwright')


async def capture_browser(url, directory, probe=False):
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
    from article_content import archive_capture
    started = time.monotonic()
    out = dict(policy=POLICY, ok=False, captures=[], url=url, acquired_at_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               crawl4ai_version=importlib.metadata.version('crawl4ai'), playwright_version=importlib.metadata.version('playwright'))
    responses, dom = [], {}
    async def created(page, **kwargs):
        def remember(response):
            if response.request.resource_type == 'document' and response.frame == page.main_frame:
                responses.append(response)
        page.on('response', remember)
        return page

    async def preserve(page, **kwargs):
        # Wait for delayed article text, then require a short stable-text interval. This
        # is a bounded readiness heuristic, not proof that every site finished loading.
        wait_started = time.monotonic()
        deadline, previous, stable = wait_started + 6, None, 0
        while time.monotonic() < deadline:
            current = await page.evaluate('() => { const e = document.querySelector("article, [itemprop=articleBody], main") || document.body; return e ? e.innerText : ""; }')
            stable = stable + 1 if current == previous and len(current.strip()) >= 200 else 0
            if stable >= 2 and time.monotonic()-wait_started >= 2: break
            previous = current
            await asyncio.sleep(0.5)
        dom['html'] = await page.content()
        dom['url'] = page.url
        dom['text_stable'] = stable >= 2
        return page

    # Each capture owns an ephemeral profile/cache; no cookies/history cross pages.
    with tempfile.TemporaryDirectory(prefix='raven-crawl4ai-') as scratch:
        browser = BrowserConfig(headless=True, browser_type='chromium', verbose=False,
                                use_persistent_context=False, enable_stealth=False)
        async with AsyncWebCrawler(config=browser, base_directory=scratch) as crawler:
            out['browser_version'] = crawler.crawler_strategy.browser_manager.browser.version
            if probe:
                out.update(ok=True, ms=int((time.monotonic()-started)*1000))
                return out
            crawler.crawler_strategy.set_hook('on_page_context_created', created)
            crawler.crawler_strategy.set_hook('before_retrieve_html', preserve)
            config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS, verbose=False,
                page_timeout=20_000, wait_until='domcontentloaded', delay_before_return_html=0,
                process_iframes=False, remove_overlay_elements=False, remove_consent_popups=False,
                flatten_shadow_dom=False, simulate_user=False, magic=False, screenshot=False,
                word_count_threshold=0, check_robots_txt=True)
            try:
                result = await asyncio.wait_for(crawler.arun(url, config=config), timeout=30)
                out.update(status_code=result.status_code, final_url=dom.get('url') or result.redirected_url or url,
                           crawl_success=result.success, text_stable=dom.get('text_stable', False))
                if not result.success: out['error'] = 'crawl-failed: ' + str(result.error_message)[:500]
            except Exception as error:
                out['error'] = type(error).__name__ + ': ' + str(error)[:300]
            if responses:
                response = responses[-1]
                out['response_url'], out['status_code'] = response.url, response.status
                out['response_content_type'] = response.headers.get('content-type', '')
                try:
                    raw = await asyncio.wait_for(response.body(), timeout=3)
                    out['captures'].append(archive_capture(raw[:MAX_BYTES], directory,
                        'browser-document-response-decoded', len(raw)>MAX_BYTES))
                except Exception as error:
                    out['response_capture_error'] = type(error).__name__
            if 'html' in dom:
                raw = dom['html'].encode('utf-8')
                record = archive_capture(raw[:MAX_BYTES], directory, 'browser-rendered-dom', len(raw)>MAX_BYTES)
                out['captures'].append(record)
                out['dom_capture'] = record
                out['ok'] = bool(out.get('crawl_success') and 200 <= (out.get('status_code') or 0) < 300 and not record['truncated'])
    out['ms'] = int((time.monotonic()-started)*1000)
    return out


def terminate_group(signum, frame):
    # Parent launches this helper in its own process group. Close browser descendants
    # too when the parent exits or cancels, not only this Python process.
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    if os.getpgrp() == os.getpid(): os.killpg(os.getpgrp(), signal.SIGTERM)
    else: os.kill(os.getpid(), signal.SIGTERM)


def main():
    request = json.loads(sys.stdin.readline())
    if request.get('probe') is not True:
        target = urlsplit(request['url'])
        if target.scheme not in ('http', 'https') or target.username or target.password:
            raise ValueError('browser URL must be HTTP(S) without credentials')
    os.environ['PLAYWRIGHT_BROWSERS_PATH'] = browser_directory()
    libraries = Path(browser_directory()) / 'system-libs/usr/lib/x86_64-linux-gnu'
    if libraries.is_dir():
        os.environ['LD_LIBRARY_PATH'] = str(libraries)
    os.environ.setdefault('LITELLM_LOCAL_MODEL_COST_MAP', 'True')
    if sys.platform == 'linux':
        import ctypes
        parent = os.getppid()
        signal.signal(signal.SIGTERM, terminate_group)
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)
        if os.getppid() != parent: terminate_group(signal.SIGTERM, None)
    with tempfile.TemporaryDirectory(prefix='raven-crawl4ai-state-') as scratch:
        os.environ['CRAWL4_AI_BASE_DIRECTORY'] = scratch
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(capture_browser(request.get('url', ''), request.get('directory', ''), request.get('probe', False)))
    print(json.dumps(result))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'ok':False, 'infrastructure_error':type(error).__name__, 'error':str(error)[:500]}))
        sys.exit(1)
