#!/usr/bin/env python3
"""Prepare source worklists and immutable publication packages from archived inputs.

This utility does not decide historical availability. Only a reviewed registration
record can produce an accepted manifest; discovered directory links remain candidates.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urljoin, urlparse


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # An existing input or result is never overwritten.
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def worklist(questions, topics, catalog):
    mapping = {row['question_id']: row['titles'] for row in topics}
    rows = []
    for question in questions:
        qid = question.get('question_id') or question['id']
        text = question.get('question_text') or question.get('question_en') or question.get('question') or question.get('title')
        if not text:
            raise ValueError('Missing question text: ' + qid)
        anchor = question.get('as_of_date') or question.get('forecast_as_of_utc')
        if not anchor:
            raise ValueError('Missing question anchor: ' + qid)
        names = mapping.get(qid, [])
        matched = [p for p in catalog if any(n.casefold() in [a.casefold() for a in p['aliases']] for n in names)]
        urls = re.findall(r'https?://[^\s<>"\)]+', text)
        periods = sorted(set(re.findall(r'\b(?:FY\s*)?20\d{2}(?:\s*(?:Q[1-4]|fiscal year))?\b|\bQ[1-4]\s*(?:FY\s*)?20\d{2}\b', text, re.I)))
        rows.append(dict(question_id=qid, anchor=anchor, question_sha256=digest(text.encode()),
                         topics=names, period_mentions=periods, question_urls=urls,
                         publishers=matched, status='directory-discovery' if matched else 'publisher-needed'))
    return {'policy': 'source-worklist-v1', 'questions': len(rows), 'rows': rows}


class Links(HTMLParser):
    def __init__(self, base):
        super().__init__(); self.base = base; self.current = None; self.rows = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            href = dict(attrs).get('href')
            self.current = {'url': urljoin(self.base, href), 'label': ''} if href else None

    def handle_data(self, data):
        if self.current is not None:
            self.current['label'] += data

    def handle_endtag(self, tag):
        if tag == 'a' and self.current:
            self.rows.append(self.current); self.current = None


def directory(raw, url, kind):
    if kind == 'html':
        parser = Links(url); parser.feed(raw.decode('utf-8')); rows = parser.rows
    else:
        data = json.loads(raw)
        if kind == 'sec-index':
            rows = [{'url': urljoin(url, item['name']), 'label': item['name'], 'directory_modified': item.get('last-modified')}
                    for item in data['directory']['item']]
        else:
            recent = data['filings']['recent']; rows = []
            for i, form in enumerate(recent['form']):
                if form not in ['10-K', '10-Q', '8-K', '20-F', '6-K']: continue
                accession = recent['accessionNumber'][i]
                rows.append({'url': f"https://www.sec.gov/Archives/edgar/data/{int(data['cik'])}/{accession.replace('-', '')}/{recent['primaryDocument'][i]}",
                             'label': form, 'accession': accession, 'filing_date': recent['filingDate'][i],
                             'report_period': recent['reportDate'][i]})
    seen = set(); candidates = []
    for row in rows:
        if urlparse(row['url']).scheme != 'https' or row['url'] in seen: continue
        if kind == 'html' and not re.search(r'\.pdf(?:[?\s#]|$)|annual|quarter|earning|financial|results|report', row['url'] + ' ' + row['label'], re.I): continue
        seen.add(row['url']); candidates.append(dict(row, availability='unreviewed'))
    return {'policy': 'publisher-directory-candidates-v1', 'directory_url': url,
            'directory_sha256': digest(raw), 'adapter': kind, 'candidates': candidates}


def package(record, original, body, evidence, output):
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    required = ['url', 'title', 'availableAt', 'version', 'sourceType', 'referenceUrl', 'timeEvidence',
                'publisher', 'reportingPeriod', 'acquiredAt', 'cachedAt', 'checkedAt', 'checkedBy']
    if any(not record.get(key) for key in required): raise ValueError('Incomplete audited registration record')
    for name, path in [('originalFile', original), ('bodyFile', body), ('publicationEvidence', evidence)]:
        data = Path(path).read_bytes(); sha = digest(data)
        destination = output / 'objects' / sha
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if destination.read_bytes() != data: raise ValueError('Source object hash conflict')
        else:
            with destination.open('xb') as stream: stream.write(data)
        record[name] = {'path': str(destination.relative_to(output)), 'sha256': sha}
    body_hash = digest(Path(body).read_bytes())
    if record.get('bodySha256') and record['bodySha256'] != body_hash: raise ValueError('Audited body changed')
    record['bodySha256'] = body_hash
    save(output / 'manifest.json', {'policy': 'registered-source-publication-v2', 'entries': [record]})


def main():
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan'); plan.add_argument('--questions', required=True); plan.add_argument('--topics', required=True)
    plan.add_argument('--catalog', required=True); plan.add_argument('--out', required=True)
    discover = commands.add_parser('directory'); discover.add_argument('--input', required=True); discover.add_argument('--url', required=True)
    discover.add_argument('--adapter', choices=['html', 'sec-index', 'sec-submissions'], required=True); discover.add_argument('--out', required=True)
    register = commands.add_parser('package')
    for key in ['record', 'original', 'body', 'evidence', 'out']: register.add_argument('--' + key, required=True)
    args = parser.parse_args()
    if args.command == 'plan':
        questions = [json.loads(line) for line in Path(args.questions).read_text().splitlines() if line.strip()]
        save(args.out, worklist(questions, json.loads(Path(args.topics).read_text()), json.loads(Path(args.catalog).read_text())))
    elif args.command == 'directory': save(args.out, directory(Path(args.input).read_bytes(), args.url, args.adapter))
    else: package(json.loads(Path(args.record).read_text()), args.original, args.body, args.evidence, args.out)


if __name__ == '__main__': main()
