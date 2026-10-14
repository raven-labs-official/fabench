#!/usr/bin/env python3
"""Verify and extract one indexed Common Crawl response without backdating live bytes.
Usage: extract-cc-capture.py cdx-record.json capture.warc.gz exact-anchor output.jsonl
The CDX object may be a raw record or {records:[one record]}. Fetch byte ranges separately.
Requires lxml, already provided by the pinned htmldate Python environment.
"""
import base64
import datetime as dt
import gzip
import hashlib
import json
import pathlib
import sys
from lxml import html


def headers(raw):
    lines=raw.split(b'\r\n')
    return lines[0].decode('ascii'),dict(line.decode('latin1').split(':',1) for line in lines[1:] if b':' in line)


def normalized_headers(raw):
    first,values=headers(raw)
    return first,{k.lower():v.strip() for k,v in values.items()}


def sha1(data):return base64.b32encode(hashlib.sha1(data).digest()).decode().rstrip('=')
def instant(s):
    if 'T' not in s or not (s.endswith('Z') or '+' in s[10:] or '-' in s[10:]):
        raise ValueError('exact timezone-qualified timestamp required')
    return dt.datetime.fromisoformat(s.replace('Z','+00:00'))


def extract(record,compressed,anchor):
    if len(compressed)!=int(record['length']):raise ValueError('compressed range length differs from CDX')
    raw=gzip.decompress(compressed)
    head,remaining=raw.split(b'\r\n\r\n',1);version,wh=normalized_headers(head)
    if not version.startswith('WARC/') or wh.get('warc-type')!='response':raise ValueError('expected response WARC record')
    length=int(wh['content-length']);block=remaining[:length]
    if len(block)!=length or remaining[length:].strip():raise ValueError('incomplete or unexpected WARC records')
    if wh.get('warc-block-digest')!='sha1:'+sha1(block):raise ValueError('WARC block digest mismatch')
    http_head,payload=block.split(b'\r\n\r\n',1);status,hh=normalized_headers(http_head)
    if status.split()[1]!='200' or record.get('status')!='200':raise ValueError('expected HTTP 200 capture')
    if hh.get('transfer-encoding') or hh.get('content-encoding') not in (None,'identity'):
        raise ValueError('unsupported stored HTTP transfer/content encoding; do not guess decoding')
    if int(hh.get('content-length',len(payload)))!=len(payload):raise ValueError('HTTP body length mismatch')
    if wh.get('warc-payload-digest')!='sha1:'+sha1(payload) or sha1(payload)!=record['digest']:
        raise ValueError('payload differs from WARC or public CDX digest')
    captured=instant(wh['warc-date'])
    if captured>=instant(anchor):raise ValueError('capture is not strictly before anchor')
    if captured.strftime('%Y%m%d%H%M%S')!=record['timestamp']:raise ValueError('capture time differs from public CDX')
    if wh['warc-target-uri']!=record['url']:raise ValueError('capture URL differs from public CDX')
    if 'text/html' not in hh.get('content-type',''):raise ValueError('only HTML captures supported')
    root=html.fromstring(payload)
    title=' '.join(root.xpath('string(//title)').split())
    for el in root.xpath('//script|//style|//noscript'):el.drop_tree()
    body=' '.join(root.text_content().split())
    if not title or not body:raise ValueError('no readable title/body')
    return dict(url=record['url'],title=title,body=body,crawlDate=wh['warc-date'],source='cc-main',
        capture_proof=dict(warc_record_id=wh['warc-record-id'],filename=record['filename'],offset=record['offset'],length=record['length'],
            cdx_digest=record['digest'],compressed_sha256=hashlib.sha256(compressed).hexdigest(),
            html_sha256=hashlib.sha256(payload).hexdigest(),text_sha256=hashlib.sha256(body.encode()).hexdigest(),
            document_sha256=hashlib.sha256(json.dumps([record['url'],title,body,wh['warc-date']],ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),
            extraction='lxml HTML text excluding script/style/noscript; no generated facts',verified_at=dt.datetime.now(dt.timezone.utc).isoformat()))


def main():
    record_path,warc_path,anchor,out=sys.argv[1:]
    records=json.loads(pathlib.Path(record_path).read_text())
    if 'records' in records:
        if len(records['records'])!=1:raise ValueError('exactly one indexed capture required')
        records=records['records'][0]
    doc=extract(records,pathlib.Path(warc_path).read_bytes(),anchor)
    pathlib.Path(out).write_text(json.dumps(doc,ensure_ascii=True)+'\n')
    print(json.dumps({k:v for k,v in doc.items() if k!='body'},ensure_ascii=False))

if __name__=='__main__':main()
