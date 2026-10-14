#!/usr/bin/env python3
"""Offline diagnostics; never equate the production judge's drop rate with true leakage.

python3 tools/retrieval-trace-audit.py --out DIR TRACE_DIR [TRACE_DIR ...]
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import pathlib
import random
import statistics


def timestamp(value):
    if not value:
        return None
    if len(value) == 10:
        value += 'T23:59:59.999Z'
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_run(root):
    manifest = json.loads((root / 'manifest.json').read_text())
    rows, samples, queries, exposures = [], {}, [], []
    for path in sorted((root / 'cells').glob('*.jsonl')):
        events = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        start = next(e['data'] for e in events if e['type'] == 'cell_started')
        counts = collections.Counter()
        urls, fetched, pools = set(), set(), set()
        ages = []
        for event in events:
            data = event.get('data') or {}
            if event['type'] == 'tool_call_finished':
                name = data.get('name', '')
                if data.get('results') or data.get('fetched'):
                    visible=data.get('model_visible_content') or {}
                    blob=visible.get('text_blob')
                    exposures.append(dict(unit_id=f"{manifest['run_id']}:{start['question_id']}:{event['sequence']}",
                        run_id=manifest['run_id'],question_id=start['question_id'],question=start.get('question'),
                        as_of=start.get('as_of'),trace=str(path),sequence=event['sequence'],operation=name,
                        content=data.get('content'),content_sha256=data.get('content_sha256'),
                        model_visible_content=visible,body_path=str(root/blob['path']) if blob else None,
                        results=data.get('results'),fetched=data.get('fetched'),
                        label=None,served=True))
                if 'search' in name:
                    results = data.get('results') or []
                    counts['searches'] += 1
                    counts['empty_searches'] += not bool(results)
                    counts['result_slots'] += len(results)
                    pool = tuple(sorted(r['url'] for r in results))
                    counts['repeated_result_pools'] += bool(results) and pool in pools
                    pools.add(pool)
                    queries.append(dict(run_id=manifest['run_id'], question_id=start['question_id'],
                        as_of=start.get('as_of'), query=(data.get('args') or {}).get('query'),
                        results=results, trace=str(path), sequence=event['sequence']))
                    for result in results:
                        urls.add(result['url'])
                        crawl = result.get('crawlDate')
                        if crawl:
                            age = (timestamp(start['as_of']) - timestamp(crawl)) / 86400
                            ages.append(age)
                            counts['timestamped_slots'] += 1
                            counts['post_anchor_slots'] += age < 0
                elif 'fetch' in name:
                    counts['fetch_calls'] += 1
                    if data.get('fetched'):
                        fetched.add(data['fetched']['url'])
                        counts['fetch_successes'] += 1
            if event['type'] == 'retrieval_audit':
                audit = data['audit']
                for c in audit.get('candidates', []):
                    counts['candidate_views'] += 1
                    counts['disposition:' + c['final_disposition']] += 1
                    judge = c.get('leak_filter') or {}
                    counts['review_truncated_views'] += bool(judge.get('reviewTruncated'))
                    counts['served_truncated_views'] += bool(judge.get('reviewTruncated') and c['served_to_forecaster'])
                    if c.get('fetch', {}).get('body_blob'):
                        blob = c['fetch']['body_blob']
                        key = (start['question_id'], audit['anchor_utc'], audit.get('operation'), c['url'], blob['sha256'], c['final_disposition'])
                        samples.setdefault(key, dict(run_id=manifest['run_id'], question_id=start['question_id'],
                            question=start.get('question'), as_of=audit['anchor_utc'], trace=str(path),
                            sequence=event['sequence'], operation=audit['operation'], candidate=c,
                            body_path=str(root / blob['path'])))
        rows.append(dict(run_id=manifest['run_id'], question_id=start['question_id'],
            arm=start['arm'], model=start.get('condition', {}).get('model'), as_of=start.get('as_of'),
            question=start.get('question'), trace=str(path), trace_sha256=digest(path), counts=dict(counts),
            unique_search_urls=len(urls), unique_fetched_urls=len(fetched),
            freshest_crawl_age_days=min(ages) if ages else None,
            median_crawl_age_days=statistics.median(ages) if ages else None))
    totals = collections.Counter()
    for row in rows:
        totals.update(row['counts'])
    summary = dict(run_id=manifest['run_id'], trace_dir=str(root), manifest_sha256=digest(root/'manifest.json'),
        run_status=manifest['status'], cells=len(rows), models=sorted({r['model'] or '' for r in rows}),
        arms=sorted({r['arm'] for r in rows}), counts=dict(totals),
        zero_fetch_cells=sum(r['counts'].get('fetch_successes', 0) == 0 for r in rows),
        zero_result_cells=sum(r['counts'].get('result_slots', 0) == 0 for r in rows),
        sum_cell_unique_urls=sum(r['unique_search_urls'] for r in rows),
        true_leakage_rate=None, true_leakage_note='Requires independent labels of model-visible bytes, not production verdicts.')
    return summary, rows, list(samples.values()), queries, exposures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=pathlib.Path)
    parser.add_argument('traces', nargs='+', type=pathlib.Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    summaries, rows, candidates, queries, exposures = [], [], [], [], []
    for root in args.traces:
        summary, cells, docs, searches, visible = audit_run(root)
        summaries.append(summary); rows.extend(cells); candidates.extend(docs); queries.extend(searches)
        exposures.extend(visible)
        print(json.dumps(summary), flush=True)
    for name, records in [('cells', rows), ('candidates', candidates), ('queries', queries), ('visible-tool-outputs',exposures)]:
        with (args.out / (name + '.jsonl')).open('w') as f:
            for row in records:
                f.write(json.dumps(row, ensure_ascii=True) + '\n')
    (args.out / 'summary.json').write_text(json.dumps(summaries, indent=2)+'\n')
    # Separate strata: both accepted and rejected examples are required for a confusion matrix.
    strata = collections.defaultdict(list)
    for c in candidates:
        strata[c['candidate']['final_disposition']].append(c)
    rng = random.Random(20260911)
    packet, sampling_key = [], []
    for name, group in sorted(strata.items()):
        rng.shuffle(group)
        for c in group[:12]:
            unit_id=f"candidate:{len(packet)+1}"
            packet.append(dict(unit_id=unit_id,question_id=c['question_id'],question=c['question'],as_of=c['as_of'],
                               url=c['candidate']['url'],title=c['candidate']['title'],body_path=c['body_path'],
                               purpose='candidate filtering accuracy; full reviewed text, not necessarily all served text',
                               independent_label=None,independent_evidence=None))
            sampling_key.append(dict(unit_id=unit_id,stratum=name,stratum_population=len(group),stratum_sample=min(12,len(group)),record=c))
    (args.out / 'review-packet.json').write_text(json.dumps(packet, ensure_ascii=True, indent=2)+'\n')
    (args.out / 'review-sampling-key.json').write_text(json.dumps(sampling_key,ensure_ascii=True,indent=2)+'\n')
    # Actual tool output packets are a separate denominator for residual exposure.
    # Keep sampling probability for each operation; repeated calls are correlated by question.
    by_operation=collections.defaultdict(list)
    for e in exposures:by_operation[e['operation']].append(e)
    visible_packet=[]
    for operation,group in sorted(by_operation.items()):
        rng.shuffle(group)
        visible_packet.extend(dict(e,stratum_population=len(group),stratum_sample=min(12,len(group))) for e in group[:12])
    (args.out/'visible-review-packet.json').write_text(json.dumps(visible_packet,ensure_ascii=True,indent=2)+'\n')


if __name__ == '__main__':
    main()
