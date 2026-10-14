#!/usr/bin/env python3
"""Read-only 287-question view: pinned Sept-17 plus poly-new-0921, no new predictions."""
import argparse
import csv
import fcntl
import hashlib
import html
import io
import json
import math
from pathlib import Path
import sqlite3
import subprocess

from path_config import CURRENT_RELEASE
from . import sept17
from .selection import select_answers_by_priority
from .paths import add_input_arguments, report_paths
from .scoring import brier_index, brier_score

POLY_SUBDIRECTORY = Path('question-sets/poly-new-0921/benchmark-v1')
QHASH = 'a5d0ba85342743b73c517ec7bc4cd4624501b048f8fe5c7c6c96f640506d72e4'
GHASH = 'd2029dd54fb787f15cb3886634be590b095ecfbcd85a0e1146bb50dc8975d544'
ASTRA_XHIGH = 'GPT-6 Astra (xhigh)'
ALTERNATE_POOLS = (
    # The neutral V1 prompt adds one fixed prefix. Everything else, including
    # the cutoff and grading, must match the pinned question pools exactly.
    ('neutral', Path('sol56-neutral-v1-20260923/neutral-v1-sept17-model-test.jsonl'),
     Path('sol56-neutral-v1-20260923/neutral-v1-sept17-grading-key.jsonl'),
     'f64ef2831a8fbb871aa78e75f295281d5623e36372448fe4d810496784972b7a', sept17.GRADING_HASH),
    ('neutral', Path('sol56-neutral-v1-20260923/fill-poly-20260923/neutral-v1-poly-model-test.jsonl'),
     Path('sol56-neutral-v1-20260923/fill-poly-20260923/neutral-v1-poly-grading-key.jsonl'),
     'cb5e0d67365361bb54467bfbdb0db2d874b81475acd8384f06a41fe0b52d2d78', GHASH),
    ('neutral', Path('analysis/neutral-prompt-poly3-20260922/neutral-poly3-model-test.jsonl'),
     Path('analysis/neutral-prompt-poly3-20260922/neutral-poly3-grading-key.jsonl'),
     '98fb32c94a685cd19ca2a20814d6fd47ec02c6b7f83b3bc9274c79375367346b',
     '83521245174321b748595e7b63f73f76793a307cb90383f3eb8fe482a7b456a0'),
    ('xhigh', Path('analysis/astra-xhigh-sept0921-20260922/questions.jsonl'),
     Path('analysis/astra-xhigh-sept0921-20260922/grading.jsonl'),
     '767b3e70fa20a91ec240d1d135777df860b049805296e5b2fec9b1160a21862b',
     'c4bed0267fc210aa9a6a936fe9043da7df6fed935e780ac8ab15dce60ee3c01d'),
    ('xhigh', Path('analysis/astra-effort-sept20-20260922/questions.jsonl'),
     Path('analysis/astra-effort-sept20-20260922/grading.jsonl'),
     '05e1fac11dc0d8a6a0cf46006fdc8f417f155854e7470d09787e840653b9ef3b',
     '0be7c81d4f8987850a0631e49d21113a69a8e5bec0baa744d3ecfe04d955706a'),
    ('xhigh', Path('analysis/astra-effort-poly10-20260922/questions.jsonl'),
     Path('analysis/astra-effort-poly10-20260922/grading.jsonl'),
     '07b209117c7c171aae1456fd15bd5ef6dd752d41431703db8a8087109e7856a8',
     '0f268e3f8d80e8a6d1a7ef6fd5f0571f302a64908a7030700b9c0982861d8e78'),
)


def verify_alternate_questions(canonical, candidates, kind, prefix=None):
    if not candidates or not set(candidates) <= set(canonical):
        raise ValueError('Alternate question IDs differ from the pinned 287')
    if kind == 'neutral' and prefix is None:
        first = next(iter(candidates))
        original = canonical[first]['prompt']
        changed = candidates[first]['prompt']
        if not changed.endswith(original):
            raise ValueError('Neutral prompt does not preserve the reviewed prompt')
        prefix = changed[:-len(original)]
        if not prefix:
            raise ValueError('Neutral prompt prefix is empty')
    for qid, candidate in candidates.items():
        original = canonical[qid]
        expected = dict(original)
        if kind == 'neutral':
            expected['prompt'] = prefix + original['prompt']
        if candidate != expected:
            raise ValueError(f'Alternate question changed outside the approved condition: {qid}')
    return prefix


def alternate_sources(canonical_questions, canonical_grades, runs, cells, root=None):
    """Validate alternate inputs and return earliest valid, traceable answers."""
    root = Path(root) if root is not None else sept17.ROOT
    specs = {}
    neutral_prefix = None
    for kind, qpath, gpath, qhash, ghash in ALTERNATE_POOLS:
        qpath = root / qpath
        gpath = root / gpath
        questions = sept17.verified_jsonl(qpath, qhash)
        grading = sept17.verified_jsonl(gpath, ghash)
        if set(questions) != set(grading) or any(grading[q] != canonical_grades[q] for q in questions):
            raise ValueError(f'Alternate grading differs from the pinned 287: {qpath}')
        neutral_prefix = verify_alternate_questions(canonical_questions, questions, kind, neutral_prefix)
        raw = qpath.read_bytes() + b'\nGRADING\n' + gpath.read_bytes()
        pool_id = f'question-pool:{qpath.stem}@{hashlib.sha256(raw).hexdigest()[:12]}'
        specs[qhash] = dict(kind=kind, ids=set(questions), pool_id=pool_id, grading_hash=ghash)
    by_run = {}
    for cell in cells:
        by_run.setdefault(cell['run_id'], []).append(cell)
    selected, failed = {}, {}
    for run in sorted(runs, key=lambda r: (r.get('started_at_utc') or '', r['run_id'])):
        config = run['config']
        question_set = config.get('question_set') or {}
        spec = specs.get(question_set.get('file_sha256'))
        if spec is None:
            continue
        if (config.get('question_set_id') != spec['pool_id'] or
                question_set.get('grading_file_sha256') != spec['grading_hash']):
            raise ValueError(f'Alternate run has inconsistent question/grading identity: {run["run_id"]}')
        kind = spec['kind']
        expected_model = 'codex:gpt-5.6-sol' if kind == 'neutral' else 'codex:gpt-6-astra'
        expected_effort = 'high' if kind == 'neutral' else 'xhigh'
        allowed_arms = ('none', 'frozen', 'web-filter') if kind == 'neutral' else ('web-filter',)
        # The same ten-question diagnostic files also contain Astra high runs.
        # They are valid experiments, but only xhigh belongs in this row.
        if (config.get('llm') != expected_model or config.get('effort') != expected_effort or
                config.get('compare') not in allowed_arms):
            continue
        if config.get('execution_mode') not in (None, 'strict'):
            raise ValueError(f'Alternate run changes execution mode: {run["run_id"]}')
        for cell in by_run.get(run['run_id'], []):
            qid, arm = cell['question_id'], cell['arm']
            if qid not in spec['ids'] or arm != config['compare']:
                raise ValueError(f'Alternate run contains a cell outside its pinned scope: {run["run_id"]}')
            key = (kind, arm, qid)
            if sept17.valid(cell) and key not in selected:
                selected[key] = dict(question_id=qid, probability=cell['probability'],
                    outcome=canonical_grades[qid]['resolution_result'],
                    mode='prompt_fallback' if kind == 'neutral' else 'xhigh',
                    result_run_id=run['run_id'], source_run_id=cell.get('source_run_id') or run['run_id'],
                    condition_id=cell['condition_id'], raw_model=config['llm'])
            elif cell['status'] == 'failed':
                previous = failed.get(key)
                if previous is None or (cell.get('updated_at_utc') or '') > (previous.get('updated_at_utc') or ''):
                    failed[key] = cell
    return selected, failed, specs


def with_prompt_fallback(row, selected, labels, failure_categories=None):
    if row['model'] != 'GPT-5.6 Sol' or row['arm'] not in ('none', 'frozen', 'web-filter'):
        return row
    existing = {answer['question_id'] for answer in row['answers']}
    additions = [dict(answer) for (kind, arm, qid), answer in selected.items()
                 if kind == 'neutral' and arm == row['arm'] and qid in labels and qid not in existing]
    if not additions:
        return dict(row, prompt_fallback_n=0)
    answers = sorted(select_answers_by_priority([row['answers'], additions], labels).values(),
                     key=lambda a: a['question_id'])
    measure = metric(answers)
    recovered = {a['question_id'] for a in additions}
    categories = failure_categories if failure_categories is not None else row.get('failure_categories', {})
    remaining_categories = {qid: category for qid, category in categories.items() if qid not in recovered}
    updated = dict(row, answers=answers, **measure, complete=measure['n'] == row['expected'],
        eligible=measure['n'] > sept17.MIN_EXCLUSIVE,
        missing_ids=sorted(set(labels) - {a['question_id'] for a in answers}),
        no_probability_n=sum(category == 'no_probability' for category in remaining_categories.values()),
        condition_ids=sorted(set(row.get('condition_ids', [])) |
                             {a['raw_model'] + '|' + a['condition_id'] for a in additions}),
        prompt_fallback_n=len(additions))
    if 'valid_answers' in row:
        updated['valid_answers'] = len(answers)
        updated['run_ids'] = sorted(set(row['run_ids']) | {a['result_run_id'] for a in additions})
        updated['merged_batches'] = len(updated['run_ids'])
        updated['condition_count'] = len(updated['condition_ids'])
        updated['failure_categories'] = remaining_categories
        updated['failure_counts'] = {name: sum(v == name for v in remaining_categories.values())
                                     for name in sorted(set(remaining_categories.values()))}
        updated['unscored_terminal_n'] = max(0, row['unscored_terminal_n'] -
                                             sum(qid in categories for qid in recovered))
        updated['terminal_n'] = len(answers) + updated['unscored_terminal_n']
        updated['execution_complete'] = updated['terminal_n'] == row['expected']
        updated['evaluation_complete'] = len(answers) + updated['no_probability_n'] == row['expected']
        for key in ('pending_ids', 'not_started_ids', 'unresolved_failed_ids'):
            updated[key] = sorted(set(row[key]) - recovered)
        updated['pending_n'] = len(updated['pending_ids'])
        updated['not_started_n'] = len(updated['not_started_ids'])
    return updated


def xhigh_row(selected, failed, labels):
    answers = sorted((dict(a) for (kind, arm, qid), a in selected.items()
                      if kind == 'xhigh' and arm == 'web-filter' and qid in labels),
                     key=lambda a: a['question_id'])
    measure = metric(answers)
    used = {a['question_id'] for a in answers}
    return dict(model=ASTRA_XHIGH, arm='web-filter', answers=answers,
        expected=len(labels), **measure, complete=measure['n'] == len(labels),
        eligible=measure['n'] > sept17.MIN_EXCLUSIVE,
        missing_ids=sorted(set(labels) - used),
        no_probability_n=sum(sept17.failure_category(cell) == 'no_probability'
                             for (kind, arm, qid), cell in failed.items()
                             if kind == 'xhigh' and arm == 'web-filter' and qid in labels and qid not in used),
        condition_ids=sorted({a['raw_model'] + '|' + a['condition_id'] for a in answers}),
        prompt_fallback_n=0, effort='xhigh')


def metric(answers):
    if not answers:
        return {'n': 0, 'brier': None, 'brier_index': None}
    if len({a['question_id'] for a in answers}) != len(answers):
        raise ValueError('Duplicate question in combined score')
    if any(type(a['probability']) not in (int, float) or not math.isfinite(a['probability'])
           or not 0 <= a['probability'] <= 1 or a['outcome'] not in (0, 1) for a in answers):
        raise ValueError('Invalid prediction/outcome in combined score')
    score = brier_score((a['probability'], a['outcome']) for a in answers)
    return {'n': len(answers), 'brier': score, 'brier_index': brier_index(score)}


def combine(regular, poly, regular_ids, new_ids):
    if set(regular_ids) & set(new_ids):
        raise ValueError('Sept-17 and poly-new IDs overlap')
    all_ids = set(regular_ids) | set(new_ids)
    prior = {(r['model'], r['arm']): r for r in regular}
    added = {(r['model'], r['arm']): r for r in poly}
    rows = []
    models = set(sept17.MODEL_ALIASES.values()) | {r['model'] for r in regular + poly}
    for model in sorted(models):
        arms = ('none',) if model == 'JEV 1.13.0' else ('web-filter',) if model == ASTRA_XHIGH else sept17.BASE_ARMS + (('both',) if (model, 'both') in prior or (model, 'both') in added else ())
        for arm in arms:
            a, b = prior.get((model, arm), {}), added.get((model, arm), {})
            answers = [dict(x, source_dataset='sept-17') for x in a.get('answers', [])]
            answers += [dict(x, source_dataset='poly-new-0921') for x in b.get('answers', [])]
            if any(x['question_id'] not in all_ids for x in answers):
                raise ValueError('Prediction outside the combined question set')
            m = metric(answers)
            rows.append(dict(model=model, arm=arm, expected=len(all_ids), **m,
                sept17_n=len(a.get('answers', [])), poly_new_n=len(b.get('answers', [])),
                complete=m['n'] == len(all_ids), eligible=m['n'] > sept17.MIN_EXCLUSIVE,
                no_probability_n=a.get('no_probability_n', 0) + b.get('no_probability_n', 0),
                prompt_fallback_n=a.get('prompt_fallback_n', 0) + b.get('prompt_fallback_n', 0),
                effort='xhigh' if model == ASTRA_XHIGH else None,
                missing_ids=sorted(all_ids - {x['question_id'] for x in answers}), answers=answers,
                condition_ids=sorted(set(a.get('condition_ids', []) + b.get('condition_ids', [])))))
    common = set.intersection(*[{a['question_id'] for a in row['answers']} for row in rows])
    for row in rows:
        row['common_questions'] = metric([a for a in row['answers'] if a['question_id'] in common])
    return sorted(rows, key=lambda r: (not r['eligible'], -(r['brier_index'] if r['brier_index'] is not None else -1), r['model'], r['arm']))


def collect(root=None, registry_path=None):
    root = Path(root) if root is not None else sept17.ROOT
    registry_path = Path(registry_path) if registry_path is not None else root / 'registry.sqlite'
    regular = sept17.collect(root, registry_path)
    poly_directory = root / POLY_SUBDIRECTORY
    data = root / sept17.DATA_SUBDIRECTORY
    q = sept17.verified_jsonl(poly_directory / 'poly-new-0921-model-test.jsonl', QHASH)
    g = sept17.verified_jsonl(poly_directory / 'poly-new-0921-grading-key.jsonl', GHASH)
    baseq = sept17.verified_jsonl(data / 'raven-july-2026-model-test.jsonl', sept17.QUESTION_HASH)
    if len(q) != 33 or set(q) != set(g) or len(baseq) != 254 or set(q) & set(baseq):
        raise ValueError('Expected disjoint pinned 254 + 33 question sets')
    with sqlite3.connect(registry_path.absolute().as_uri() + '?mode=ro', uri=True, timeout=30) as db:
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only = ON')
        db.execute('BEGIN')
        runs, alternate_runs = [], []
        alternate_hashes = {s[3] for s in ALTERNATE_POOLS}
        for value in db.execute('SELECT * FROM runs'):
            r = dict(value); c = json.loads(r.pop('config_json') or '{}')
            question_hash = c.get('question_set', {}).get('file_sha256')
            if question_hash == QHASH:
                if c.get('question_set', {}).get('grading_file_sha256') != GHASH:
                    raise ValueError('Poly grading hash mismatch')
                runs.append(dict(r, config=c))
            elif question_hash in alternate_hashes:
                alternate_runs.append(dict(r, config=c))
        cells = [dict(x) for x in db.execute('SELECT * FROM run_cells')]
        db.rollback()
    pools = {r['config']['question_set_id'] for r in runs}
    if len(pools) != 1:
        raise ValueError('Expected one canonical Poly pool; diagnostic subsets must be excluded')
    labels = {qid: v['resolution_result'] for qid, v in g.items()}
    if any(v not in (0, 1) for v in labels.values()):
        raise ValueError('Nonbinary Poly grading')
    poly = sept17.merge(runs, cells, labels, pool=next(iter(pools)), question_hash=QHASH, grading_hash=GHASH)
    strict_baseline = {(r['model'], r['arm']): r for r in combine(regular['rows'], poly, baseq, q)}
    canonical_questions = {**baseq, **q}
    canonical_grades = {**sept17.verified_jsonl(data / 'raven-july-2026-grading-key.jsonl', sept17.GRADING_HASH), **g}
    selected, failed, specs = alternate_sources(canonical_questions, canonical_grades, alternate_runs, cells, root)
    regular_rows = [with_prompt_fallback(r, selected, baseq) for r in regular['rows']]
    poly_rows = [with_prompt_fallback(r, selected, q) for r in poly]
    regular_rows.append(xhigh_row(selected, failed, baseq))
    poly_rows.append(xhigh_row(selected, failed, q))
    combined = combine(regular_rows, poly_rows, baseq, q)
    for row in combined:
        baseline = strict_baseline.get((row['model'], row['arm']))
        row['strict_baseline'] = ({key: baseline[key] for key in
                                  ('n', 'brier', 'brier_index', 'sept17_n', 'poly_new_n', 'no_probability_n')}
                                  if baseline else None)
        row['strict_n'] = baseline['n'] if baseline else 0
        row['strict_brier_index'] = baseline['brier_index'] if baseline else None
    return dict(schema='raven.sept0921-leaderboard.v1', dataset='sept-0921', questions=287,
        generated_at_utc=regular['generated_at_utc'], generated_at_singapore=regular['generated_at_singapore'],
        poly_sampled_after_utc=regular['generated_at_utc'],
        cutoff_utc=regular['cutoff_utc'], rows=combined, poly_rows=poly_rows,
        inputs={'sept17_questions_sha256': sept17.QUESTION_HASH, 'sept17_grading_sha256': sept17.GRADING_HASH,
                'poly_questions_sha256': QHASH, 'poly_grading_sha256': GHASH,
                'alternate_question_sha256': sorted(specs)},
        question_ids=sorted(set(baseq) | set(q)),
        method='Pinned strict valid answer first; neutral V1 prompt may fill only missing GPT-5.6 Sol none/frozen/web-filter cells. '
               'Astra xhigh is a separate web-filter row. All alternate question fields, except the fixed neutral prompt prefix, '
               'and all grading fields are verified against the pinned 287 questions. Earliest valid alternate answer wins. '
               'Recompute Brier from per-question squared errors; never average indices or impute refusals. '
               'Mixed prompt conditions and historical delivery versions remain visible per answer; descriptive comparison.',
        summary={'valid_cells': sum(r['n'] for r in combined), 'target_cells': 287 * len(combined),
                 'complete_groups': sum(r['complete'] for r in combined), 'required_groups': len(combined)},
        regular_active=[r for r in regular['runs'] if r.get('live')], controllers=regular['controllers'],
        poly_runs=[{k: r.get(k) for k in ['run_id', 'status', 'tag', 'started_at_utc', 'last_heartbeat_utc', 'trace_directory']} for r in runs])


def publish(report, dest):
    dest.mkdir(parents=True, exist_ok=True)
    def save(name, value):
        p = dest / name; temporary = p.with_suffix(p.suffix + '.tmp')
        temporary.write_text(value); temporary.replace(p)
    save('leaderboard.json', json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    save('predictions.jsonl', ''.join(json.dumps(dict(model=r['model'], arm=r['arm'], **a), ensure_ascii=False)+'\n'
                                     for r in report['rows'] for a in r['answers']))
    headers = ['model', 'arm', 'sept17_n', 'poly_new_n', 'n', 'expected', 'brier', 'brier_index',
               'complete', 'no_probability_n', 'prompt_fallback_n', 'strict_n', 'strict_brier_index', 'effort']
    f = io.StringIO()
    writer = csv.DictWriter(f, fieldnames=headers, extrasaction='ignore'); writer.writeheader(); writer.writerows(report['rows'])
    save('leaderboard.csv', f.getvalue())
    def fmt(v): return '—' if v is None else f'{v:.2f}'
    lines = ['# sept-0921: 254 + 33 = 287 questions', '', 'Sampled: ' + report['generated_at_singapore'], '',
             'A green check only means all 287 questions have a valid probability; empty probabilities, failures and runs not yet made stay missing. Rows with different coverage, or earlier delivered versions, are not a strict same-condition ranking.',
             'GPT-5.6 Sol takes the valid answers to the original question text first and fills missing answers from the separate neutral-prompt condition; Astra xhigh is listed separately for web-filter. Per-question sources are in the JSON.', '',
             '| Model | Setting | Sept-17 /254 | Poly-new /33 | Combined /287 | Neutral-prompt fills | Brier Index ↑ |', '|---|---|---:|---:|---:|---:|---:|']
    for r in report['rows']:
        lines.append(f'| {r["model"]} | {r["arm"]} | {r["sept17_n"]} | {r["poly_new_n"]} | {r["n"]} | {r["prompt_fallback_n"]} | {fmt(r["brier_index"])} |')
    save('report.md', '\n'.join(lines)+'\n')
    body = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sept-0921 · FABench</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f5f7f5;color:#172a31;margin:24px}main{max-width:1150px;margin:auto}table{border-collapse:collapse;width:100%;background:white}th,td{padding:10px;border-bottom:1px solid #d6dfdf;text-align:left}.scroll{overflow:auto}.done{color:#137047}a{color:#12624d}</style><main><h1>sept-0921 · 287 questions</h1>'
    body += '<p>Sept-17 254 questions + poly-new-0921 33 questions; updated: '+html.escape(report['generated_at_singapore'])+'</p>'
    body += '<p>Valid probabilities '+str(report['summary']['valid_cells'])+'/'+str(report['summary']['target_cells'])+'. Missing answers are not filled with 0.5; scores are recomputed after per-question deduplication. GPT-5.6 Sol uses the original question text first and fills gaps from the neutral prompt; Astra xhigh is listed separately for web-filter. Per-question sources and original conditions are kept; this is a descriptive progress board.</p><p><a href="leaderboard.csv">CSV</a> · <a href="leaderboard.json">Full JSON</a> · <a href="predictions.jsonl">Per-question results</a></p><div class="scroll"><table><thead><tr>'
    body += ''.join('<th>'+h+'</th>' for h in ['Model','Setting','Sept-17 /254','Poly-new /33','Combined /287','Neutral-prompt fills','Brier Index ↑','Status'])+'</tr></thead><tbody>'
    for r in report['rows']:
        values=[r['model'],r['arm'],r['sept17_n'],r['poly_new_n'],r['n'],r['prompt_fallback_n'],fmt(r['brier_index']),'✓ Complete' if r['complete'] else 'Incomplete' if r['eligible'] else 'Small sample · not ranked']
        body += '<tr'+(' class="done"' if r['complete'] else '')+'>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in values)+'</tr>'
    body += '</tbody></table></div><p>Scores on the questions every row shares are in common_questions in the JSON; Astra xhigh uses the full and diagnostic-subset results checked question by question against the question text and answers, shown apart from the default effort.</p></main></html>'
    save('index.html',body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_input_arguments(parser)
    parser.add_argument('--host', help='SSH host for the default shared query (default: reportHost setting)')
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    paths = report_paths(args, sept17.ROOT)
    output_dir = args.output_dir or paths.results / 'reporting/sept0921-latest'
    if not paths.local and not paths.registry.exists():
        # Run the published query on the shared server; do not copy credentials or raw traces.
        import shlex
        command = f'python3 {CURRENT_RELEASE}/tools/sept0921-leaderboard.py --output-dir ' + shlex.quote(str(output_dir))
        subprocess.run(['ssh', sept17.report_host(args.host), command], check=True)
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / '.publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        report = collect(paths.results, paths.registry)
        publish(report, output_dir)
    print(json.dumps(dict(timestamp=report['generated_at_singapore'],**report['summary']),ensure_ascii=False))
