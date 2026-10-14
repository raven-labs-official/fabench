#!/usr/bin/env python3
"""Validate and describe a complete pinned historical-query replay (not live-search fidelity)."""
import argparse
import hashlib
import importlib.util
import json
import math
from datetime import datetime
from pathlib import Path
from statistics import mean, median


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def instant(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('replay requires an exact timezone-bearing anchor')
    return parsed


def summarize(input_path, replay_path, prior_path=None):
    inputs = json.loads(Path(input_path).read_text())
    rows = json.loads(Path(replay_path).read_text())
    if not inputs or len(inputs) != len(rows):
        raise ValueError('incomplete replay or empty input')
    prior = json.loads(Path(prior_path).read_text()) if prior_path else None
    if prior is not None and len(prior) != len(rows):
        raise ValueError('prior baseline replay is incomplete')
    module_path = Path(__file__).with_name('retrieval-fidelity.py')
    spec = importlib.util.spec_from_file_location('fidelity', module_path)
    fidelity = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fidelity)
    reference, candidate, comparisons = [], [], []
    for i, (expected, row) in enumerate(zip(inputs, rows)):
        for key in ('question_id', 'query', 'as_of'):
            if expected[key] != row[key]:
                raise ValueError(f'replay identity mismatch at row {i}: {key}')
        if prior is not None:
            if any(prior[i][k] != row[k] for k in ('question_id', 'query', 'as_of', 'original_urls')):
                raise ValueError(f'pinned baseline changed at row {i}')
            if 'original_scores' in prior[i] and prior[i]['original_scores'] != row.get('original_scores'):
                raise ValueError(f'pinned baseline scores changed at row {i}')
        old = row['original_urls']
        new = [hit['url'] for hit in row['candidate']]
        if len(old) != len(set(old)) or len(new) != len(set(new)):
            raise ValueError('duplicate result URL')
        if len(old) > 10 or len(new) > 10:
            raise ValueError('replay exceeded the fixed top-10 budget')
        if 'original_scores' in row or 'candidate_scores' in row:
            if len(old) != len(row.get('original_scores', [])) or len(new) != len(row.get('candidate_scores', [])):
                raise ValueError('score/result length mismatch')
        for hit in row['candidate']:
            if instant(hit['crawlDate']) >= instant(row['as_of']):
                raise ValueError(f'candidate capture is not strictly pre-anchor at row {i}')
            if len(hit['snippet']) > 260 or len(hit['head']) > 260:
                raise ValueError('snippet budget exceeded')
        base = dict(query_id=str(i), query=row['query'], as_of=row['as_of'])
        reference.append(dict(**base, results=[dict(url=u) for u in old]))
        candidate.append(dict(**base, results=[dict(url=u) for u in new]))
        comparisons.append(dict(index=i, question_id=row['question_id'], query=row['query'],
            same_url_set=set(old) == set(new), same_url_order=old == new,
            baseline_count=len(old), candidate_count=len(new),
            baseline_only=[u for u in old if u not in new], candidate_only=[u for u in new if u not in old]))
    metric = fidelity.compare(reference, candidate, 10)
    coverage = {}
    for key in ('head_term_coverage', 'snippet_term_coverage'):
        values = [hit[key] for row in rows for hit in row['candidate'] if hit[key] is not None]
        coverage[key] = dict(mean=mean(values) if values else None, result_positions=len(values))
    latency = {}
    for key in ('old_ms', 'new_ms'):
        values = sorted(row[key] for row in rows)
        if any(not isinstance(v, (float, int)) or not math.isfinite(v) or v < 0 for v in values):
            raise ValueError('invalid measured query latency')
        latency[key] = dict(total_ms=sum(values), median_ms=median(values),
            p95_nearest_rank_ms=values[math.ceil(.95*len(values))-1], max_ms=max(values))
    return dict(schema='raven.frozen-replay-summary.v1',
        scope='Fixed historical queries: whole-corpus ranking statistics versus strict historical statistics. The baseline is NOT the contemporaneous real web search, and selected queries are not a probability sample.',
        hashes=dict(input=digest(input_path), replay=digest(replay_path),
            prior_replay=digest(prior_path) if prior_path else None,
            summary_tool=digest(__file__), metric_tool=digest(module_path)),
        query_count=len(rows), question_count=len({r['question_id'] for r in rows}),
        baseline_empty=sum(not r['original_urls'] for r in rows),
        candidate_empty=sum(not r['candidate'] for r in rows),
        recovered_empty=sum(not r['original_urls'] and bool(r['candidate']) for r in rows),
        newly_empty=sum(bool(r['original_urls']) and not r['candidate'] for r in rows),
        unchanged_sets=sum(r['same_url_set'] for r in comparisons),
        unchanged_order=sum(r['same_url_order'] for r in comparisons),
        baseline_result_positions=sum(len(r['original_urls']) for r in rows),
        candidate_result_positions=sum(len(r['candidate']) for r in rows),
        strictly_pre_anchor_positions=sum(len(r['candidate']) for r in rows),
        membership_comparison=metric, candidate_head_vs_snippet_coverage=coverage,
        latency=latency, latency_note='Sequential diagnostic timing; cache and execution order are uncontrolled, so no causal speedup claim.',
        changes=[r for r in comparisons if not r['same_url_order']])


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('input'); ap.add_argument('replay'); ap.add_argument('output')
    ap.add_argument('--prior-baseline-replay')
    args = ap.parse_args()
    report = summarize(args.input, args.replay, args.prior_baseline_replay)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ('membership_comparison','changes')}, ensure_ascii=False))
