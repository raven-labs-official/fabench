#!/usr/bin/env python3
"""Read-only Sept-17 model × arm rollup; Python standard library only."""
import argparse
import csv
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sqlite3
import subprocess
import sys  # noqa: F401 -- tests patch reporting.sept17.sys.argv
from datetime import datetime, timezone, timedelta

from path_config import CURRENT_RELEASE, SHARED_BENCH_DIR, configured_setting
from scheduling import runtime
from .selection import MODEL_ALIASES, ordered_runs, select_answers_by_priority
from .paths import add_input_arguments, report_paths
from .scoring import brier_index, brier_score

ROOT = Path(SHARED_BENCH_DIR)
POOL = 'question-pool:raven-july-2026-model-test@7f06337c7598'
DATA_SUBDIRECTORY = Path('question-sets/july-2026-finance-balanced-draft3-20260917')
QUESTION_HASH = '2f6c84eff24c6e672564eff2db91b206b7adb75409d1f6717ef50c101075d290'
GRADING_HASH = '62056df5d62da3d19741cf670290c2e8cce31fae20db35772be7e8a24f66ab70'
BASE_ARMS = ('none', 'frozen', 'web-filter')
ARMS = BASE_ARMS + ('both',)
_arm_spec = importlib.util.spec_from_file_location('retrieval_arms', Path(__file__).resolve().parents[1] / 'retrieval-arm-identity.py')
_arm_identity = importlib.util.module_from_spec(_arm_spec)
_arm_spec.loader.exec_module(_arm_identity)
MIN_EXCLUSIVE = 200

CONTROLLER_FILES = (
    'sol-july-20260921/current-plan.json',
    'missing-fill-20260921/current-controller.json',
)


def valid(cell):
    p = cell.get('probability')
    return (cell.get('status') in ('success', 'reused') and
            isinstance(p, (float, int)) and not isinstance(p, bool) and
            math.isfinite(p) and 0 <= p <= 1)


def verified_jsonl(path, expected_hash):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError(f'Pinned Sept-17 file hash mismatch: {path}')
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if len({r['id'] for r in rows}) != len(rows):
        raise ValueError(f'Duplicate question IDs: {path}')
    return {r['id']: r for r in rows}


def failure_category(cell):
    """Read terminal metadata only; never export thinking or final text."""
    path = cell.get('trace_path')
    if not path:
        return 'unknown'
    try:
        with Path(path).open('rb') as source:
            source.seek(0, 2)
            offset = max(0, source.tell() - 2 * 1024 * 1024)
            source.seek(offset)
            if offset:
                source.readline()
            lines = source.read().splitlines()
        for line in reversed(lines):
            if b'agent_failed' not in line:
                continue
            try:
                event = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if event.get('type') != 'agent_failed':
                continue
            data = event.get('data') or {}
            final = data.get('partial_final_answer') or ''
            error = data.get('error') or {}
            message = (error.get('message', '') if isinstance(error, dict) else str(error)).lower()
            if re.search(r'"probability_yes"\s*:\s*null\b', final):
                return 'no_probability'
            if final.strip():
                return 'answer_review'
            if any(x in message for x in ('usage_limit', 'usage limit', 'window_exhausted', 'insufficient_balance')):
                return 'quota_or_balance'
            if any(x in message for x in ('unanswered tool requests', 'helper exited', 'timeout', 'timed out', 'interrupted')):
                return 'technical'
            return 'unknown'
    except (OSError, ValueError, TypeError):
        pass
    return 'unknown'


def merge(runs, cells, labels, *, pool=POOL, question_hash=QUESTION_HASH, grading_hash=GRADING_HASH):
    """Match dashboard presentationPoints: strict first, then earliest run."""
    selected_runs = {}
    for run in runs:
        c = run['config']
        if c.get('question_set_id') != pool:
            continue
        if c.get('execution_mode') not in (None, 'strict', 'postprocess'):
            continue
        for key, wanted in [('file_sha256', question_hash),
                            ('grading_file_sha256', grading_hash)]:
            actual = (c.get('question_set') or {}).get(key)
            if actual is not None and actual != wanted:
                raise ValueError(f'{run["run_id"]}: inconsistent {key}')
        selected_runs[run['run_id']] = run
    ordered = ordered_runs(selected_runs.values())
    by_run = {}
    for cell in cells:
        by_run.setdefault(cell['run_id'], []).append(cell)
    groups = {}
    for run in ordered:
        c = run['config']
        raw_model = c.get('llm') or 'unknown'
        model = MODEL_ALIASES.get(raw_model, raw_model)
        reviewed = c.get('execution_mode') == 'postprocess'
        conditions = c.get('conditions', [])
        run_cells = [{**cell, 'arm': _arm_identity.recorded_arm(cell['arm'], conditions, cell.get('condition_id'))}
                     for cell in by_run.get(run['run_id'], [])]
        arms = {_arm_identity.recorded_arm(x.get('arm'), conditions, x.get('condition_id')) for x in conditions}
        arms.update(x['arm'] for x in run_cells)
        for arm in sorted(arms & set(ARMS), key=ARMS.index):
            g = groups.setdefault((model, arm), {
                'model': model, 'arm': arm, 'candidates': [], 'runs': set(),
                'conditions': set(), 'attempted': set(), 'latest': {},
            })
            g['runs'].add(run['run_id'])
            for cell in sorted(run_cells, key=lambda x: (
                    x['question_id'], x.get('condition_id', ''))):
                qid = cell['question_id']
                if cell['arm'] != arm or qid not in labels:
                    continue
                g['attempted'].add(qid)
                previous = g['latest'].get(qid)
                if previous is None or (cell.get('updated_at_utc') or '') > (previous.get('updated_at_utc') or ''):
                    g['latest'][qid] = cell
                if not reviewed:
                    g['conditions'].add(raw_model + '|' + cell['condition_id'])
                if valid(cell):
                    g['candidates'].append([{
                        'question_id': qid, 'probability': cell['probability'],
                        'outcome': labels[qid], 'mode': 'reviewed' if reviewed else 'strict',
                        'result_run_id': run['run_id'],
                        'source_run_id': cell.get('source_run_id') or run['run_id'],
                        'condition_id': cell['condition_id'], 'raw_model': raw_model,
                    }])
    rows = []
    for (model, arm), g in groups.items():
        g['selected'] = select_answers_by_priority(g['candidates'])
        answers = sorted(g['selected'].values(), key=lambda c: c['question_id'])
        scored = [c for c in answers if c['outcome'] in (0, 1)]
        n = len(scored)
        brier = brier_score((c['probability'], c['outcome']) for c in scored) if n else None
        terminal = {q: c for q, c in g['latest'].items() if q not in g['selected']
                    and c['status'] in ('success', 'reused', 'failed', 'interrupted')}
        pending = sorted(q for q in g['latest'] if q not in g['selected'] and q not in terminal)
        unseen = sorted(set(labels) - set(g['latest']))
        categories = {q: failure_category(c) for q, c in terminal.items()}
        category_counts = {name: sum(v == name for v in categories.values()) for name in sorted(set(categories.values()))}
        rows.append({
            'model': model, 'arm': arm, 'n': n, 'valid_answers': len(answers),
            'expected': len(labels), 'complete': n == len(labels),
            'eligible': n > MIN_EXCLUSIVE, 'brier': brier,
            'brier_index': brier_index(brier) if n else None,
            'reviewed_extra': sum(c['mode'] == 'reviewed' for c in answers),
            'strict_n': sum(c['mode'] == 'strict' for c in scored),
            'condition_count': len(g['conditions']),
            'condition_ids': sorted(g['conditions']), 'run_ids': sorted(g['runs']),
            'merged_batches': len(g['runs']),
            'terminal_n': len(answers) + len(terminal),
            'execution_complete': len(answers) + len(terminal) == len(labels),
            'evaluation_complete': len(answers) + category_counts.get('no_probability', 0) == len(labels),
            'unscored_terminal_n': len(terminal), 'no_probability_n': category_counts.get('no_probability', 0),
            'pending_n': len(pending), 'not_started_n': len(unseen),
            'pending_ids': pending, 'not_started_ids': unseen,
            'failure_categories': categories, 'failure_counts': category_counts,
            'missing_ids': sorted(set(labels) - set(g['selected'])),
            'unresolved_failed_ids': sorted(q for q, c in g['latest'].items()
                                           if q not in g['selected'] and c['status'] in ('failed', 'interrupted')),
            'answers': answers,
        })
    return sorted(rows, key=lambda r: (r['model'], ARMS.index(r['arm'])))


def process_matches(pid, ticks=None, boot=None):
    """Like runtime.alive, but a missing start time or boot ID is not compared."""
    try:
        live = runtime.identity(int(pid))
    except (TypeError, ValueError):
        return False
    return bool(live and live['state'] not in runtime.EXITED_STATES
                and (ticks is None or str(ticks) == live['start_ticks'])
                and (boot is None or boot == live['boot_id']))


def heartbeat_age(value, now):
    try:
        return round((now - datetime.fromisoformat(value.replace('Z', '+00:00'))).total_seconds(), 1)
    except (ValueError, TypeError, AttributeError):
        return None


def controller_summaries(root):
    out = []
    for name in CONTROLLER_FILES:
        path = root / name
        try:
            pointer = json.loads(path.read_text())
            if any(c.get('state_path') == pointer['state'] for c in out):
                continue
            state = json.loads(Path(pointer['state']).read_text())
            supervisor = pointer.get('supervisor') or {}
            pid = supervisor.get('pid') or pointer.get('controller_pid')
            item = {'pointer': str(path), 'state_path': pointer['state'],
                    'pid': pid, 'process_matches': process_matches(
                        pid, supervisor.get('start_ticks'), supervisor.get('boot_id'))}
            for key in ('status', 'updated_at_utc', 'last_updated_at_utc',
                        'job_holds', 'model_waits', 'scheduling', 'reserved_concurrency'):
                if key in state:
                    item[key] = state[key]
            out.append(item)
        except (OSError, KeyError, ValueError) as e:
            out.append({'pointer': str(path), 'read_error': str(e)})
    return out


def collect(root=None, registry_path=None):
    root = Path(root) if root is not None else ROOT
    data = root / DATA_SUBDIRECTORY
    registry_path = Path(registry_path) if registry_path is not None else root / 'registry.sqlite'
    questions = verified_jsonl(data / 'raven-july-2026-model-test.jsonl', QUESTION_HASH)
    grading = verified_jsonl(data / 'raven-july-2026-grading-key.jsonl', GRADING_HASH)
    if len(questions) != 254 or set(questions) != set(grading):
        raise ValueError('Sept-17 must contain exactly the pinned 254 question IDs')
    labels = {qid: row['resolution_result'] for qid, row in grading.items()}
    if any(y not in (0, 1) for y in labels.values()):
        raise ValueError('Missing/nonbinary grading result in pinned grading file')
    db = sqlite3.connect(registry_path.absolute().as_uri() + '?mode=ro', uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only = ON')
    db.execute('BEGIN')
    now = datetime.now(timezone.utc)
    runs = []
    for row in db.execute('SELECT * FROM runs'):
        r = dict(row)
        c = json.loads(r.pop('config_json') or '{}')
        if c.get('question_set_id') == POOL:
            r['config'] = c
            runs.append(r)
    if not runs:
        raise ValueError('No runs for pinned Sept-17 pool; refusing an empty leaderboard')
    placeholders = ','.join('?' for _ in runs)
    cells = [dict(r) for r in db.execute(
        f'SELECT * FROM run_cells WHERE run_id IN ({placeholders})',
        [r['run_id'] for r in runs])]
    db.rollback()
    db.close()
    rows = merge(runs, cells, labels)
    ranked = sorted((r for r in rows if r['eligible']), key=lambda r: (
        -r['brier_index'], r['model'], ARMS.index(r['arm'])))
    for rank, r in enumerate(ranked, 1):
        r['rank'] = rank
    summaries = []
    for r in runs:
        c = r['config']
        entry = {k: r.get(k) for k in (
            'run_id', 'tag', 'status', 'expected_cells', 'succeeded_cells',
            'reused_cells', 'failed_cells', 'interrupted_cells', 'started_at_utc',
            'last_heartbeat_utc', 'finished_at_utc')}
        entry.update(model=MODEL_ALIASES.get(c.get('llm'), c.get('llm')),
                     raw_model=c.get('llm'), mode=c.get('execution_mode') or 'strict',
                     arms=sorted({x['arm'] for x in c.get('conditions', [])}),
                     concurrency=c.get('conc'))
        if r['status'] == 'running':
            age = heartbeat_age(r.get('last_heartbeat_utc'), now)
            match = process_matches(r.get('pid'), r.get('process_started_ticks'), r.get('boot_id'))
            entry.update(heartbeat_age_seconds=age, process_matches=match,
                         live=match and age is not None and 0 <= age <= 120)
        summaries.append(entry)
    models = sorted({r['model'] for r in rows})
    required = [(m, a) for m in models for a in (('none',) if m == 'JEV 1.13.0' else BASE_ARMS + (('both',) if any(r['model'] == m and r['arm'] == 'both' for r in rows) else ()))]
    lookup = {(r['model'], r['arm']): r for r in rows}
    return {
        'schema': 'raven.sept17-leaderboard.v1', 'generated_at_utc': now.isoformat(),
        'generated_at_singapore': now.astimezone(timezone(timedelta(hours=8))).isoformat(),
        'question_set_id': POOL, 'questions_sha256': QUESTION_HASH, 'grading_sha256': GRADING_HASH,
        'cutoff_utc': '2026-07-01T00:00:00Z', 'questions': 254,
        'method': {'minimum_n_exclusive': MIN_EXCLUSIVE,
                   'metric': '100 * (1 - sqrt(mean((probability - outcome)^2)))',
                   'merge': 'model × arm × question; strict before postprocess; earliest run start, then run ID',
                   'missing': 'exclude; never impute 0.5',
                   'interpretation': 'Descriptive rollup across recorded conditions; arms may cover different questions.'},
        'summary': {'models': len(models), 'required_groups': len(required),
                    'complete_groups': sum(lookup.get(k, {}).get('complete', False) for k in required),
                    'execution_complete_groups': sum(lookup.get(k, {}).get('execution_complete', False) for k in required),
                    'evaluation_complete_groups': sum(lookup.get(k, {}).get('evaluation_complete', False) for k in required),
                    'eligible_groups': len(ranked),
                    'scored_cells': sum(lookup.get(k, {}).get('n', 0) for k in required),
                    'target_cells': len(required) * 254, 'pool_runs': len(runs)},
        'rows': rows, 'runs': summaries, 'controllers': controller_summaries(root),
    }


def markdown(report):
    s = report['summary']
    lines = ['# Sept-17 leaderboard', '',
             f"Updated: {report['generated_at_singapore']} (UTC+8). 254 questions, forecast cutoff 2026-07-01.", '',
             f"{s['models']} models; {s['evaluation_complete_groups']}/{s['required_groups']} groups fully evaluated (scorable or an explicit empty probability), "
             f"{s['complete_groups']} of them fully scorable; "
             f"{s['eligible_groups']} groups have more than 200 valid questions; {s['scored_cells']}/{s['target_cells']} valid model × setting × question answers.", '',
             'Brier Index = 100 × (1 − √Brier), higher is better; a constant forecast of 0.5 scores 50.', '',
             '## Main board (more than 200 valid questions)', '',
             '| Rank | Model | Setting | Brier Index | Valid questions | Added by review |',
             '| ---: | --- | --- | ---: | ---: | ---: |']
    for r in sorted((r for r in report['rows'] if r['eligible']), key=lambda r: r['rank']):
        lines.append(f"| {r['rank']} | {r['model']} | {r['arm']} | {r['brier_index']:.2f} | {r['n']}/254 | {r['reviewed_extra']} |")
    lines += ['', '## Small-sample progress (not on the main board)', '',
              '| Model | Setting | Brier Index | Valid questions |', '| --- | --- | ---: | ---: |']
    for r in report['rows']:
        if not r['eligible']:
            index = f"{r['brier_index']:.2f}" if r['brier_index'] is not None else '—'
            lines.append(f"| {r['model']} | {r['arm']} | {index} | {r['n']}/254 |")
    lines += ['', '## Execution coverage across batches (separate from scorable counts)', '',
              'Each question counts once. Finished includes failed and interrupted cells; a green check only means every question has a valid probability or an explicit empty probability, and technical failures still await a rerun or review. An explicit empty probability is not filled with 0.5 and is not rerun automatically.', '',
              '| Model | Setting | Finished/254 | Scorable | No probability | Other invalid/failed | Pending/claimed | Not claimed | Merged batches |',
              '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for r in report['rows']:
        mark = '✅ ' if r['evaluation_complete'] else ''
        lines.append(f"| {r['model']} | {r['arm']} | {mark}{r['terminal_n']}/254 | {r['n']} | "
                     f"{r['no_probability_n']} | {r['unscored_terminal_n'] - r['no_probability_n']} | "
                     f"{r['pending_n']} | {r['not_started_n']} | {r['merged_batches']} |")
    lines += ['', '## Run status', '']
    running = [r for r in report['runs'] if r['status'] == 'running']
    if not running:
        lines.append('No run of this question pool is marked running in the registry.')
    for r in running:
        lines.append(f"- {r['model']} / {','.join(r['arms'])}: "
                     f"{'alive' if r.get('live') else 'liveness needs checking'}; "
                     f"this batch succeeded {r['succeeded_cells']}, reused {r['reused_cells']}, "
                     f"failed {r['failed_cells']}, target {r['expected_cells']}; run `{r['run_id']}`.")
    for c in report['controllers']:
        lines.append(f"- Controller `{c['pointer']}`: status {c.get('status', 'unknown')}, process matches {c.get('process_matches', False)}.")
        for key in ('job_holds', 'model_waits', 'read_error'):
            if c.get(key):
                lines.append(f"  - {key}: `{json.dumps(c[key], ensure_ascii=False)}`")
    lines += ['', '## How the summary is computed', '',
              'The question set ID and the question and answer SHA256 are fixed; only a consistent snapshot of the central registry is read.',
              'Answers are merged per question for the same model and setting: original strict valid answers come first, and the earliest answer by run start time and run ID is taken; postprocess runs only fill missing questions.',
              'API and native Opus, and personal and team Sol, count as one model; each question keeps its source run, condition and review marks.',
              'Failures and missing answers are not scored and not filled with 0.5; scores of different continuation runs are not averaged. Summaries across versions or retrieval conditions are descriptive only: rows may cover different questions, so a difference cannot be attributed to retrieval from them.',
              'Per-question probabilities, sources, raw Brier, missing questions and controller state are in leaderboard.json in the same directory.', '']
    return '\n'.join(lines)


def report_host(selected):
    """The SSH host for the shared query: --host, else the reportHost setting."""
    host = selected or configured_setting('reportHost', 'FABENCH_REPORT_HOST')
    if not host:
        raise SystemExit('No local registry was found. Pass --local, --results-dir or --registry, '
                         'or name the SSH host with --host, FABENCH_REPORT_HOST or reportHost.')
    return host


def main():
    p = argparse.ArgumentParser(description=__doc__)
    add_input_arguments(p)
    p.add_argument('--host', help='SSH host when not running on the shared server (default: reportHost setting)')
    p.add_argument('--on-server', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--output-dir', type=Path, help='Save leaderboard.json, leaderboard.csv and report.md')
    p.add_argument('--json', action='store_true', help='Print JSON instead of Markdown')
    args = p.parse_args()
    paths = report_paths(args, ROOT)
    if args.on_server or paths.local or paths.registry.exists():
        report = collect(paths.results, paths.registry)
        report['query_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    else:
        command = f'python3 {CURRENT_RELEASE}/tools/sept17-leaderboard.py --on-server --json'
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                                 report_host(args.host), command], text=True, capture_output=True, timeout=180)
        if result.returncode:
            raise RuntimeError(f'Remote query failed ({result.returncode}): {result.stderr.strip()}')
        report = json.loads(result.stdout)
    md = markdown(report)
    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / 'leaderboard.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        (args.output_dir / 'report.md').write_text(md)
        fields = ['model', 'arm', 'n', 'expected', 'eligible', 'complete', 'brier_index',
                  'brier', 'strict_n', 'reviewed_extra', 'condition_count', 'rank', 'terminal_n',
                  'execution_complete', 'evaluation_complete', 'unscored_terminal_n', 'no_probability_n', 'pending_n',
                  'not_started_n', 'merged_batches']
        with (args.output_dir / 'leaderboard.csv').open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
            writer.writeheader()
            writer.writerows(report['rows'])
    print(json.dumps(report, ensure_ascii=False) if args.json else md)

