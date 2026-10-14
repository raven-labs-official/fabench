#!/usr/bin/env python3
"""Turn files of the released FABench dataset into inputs for model runs.

    python tools/from-dataset.py questions --dataset DIR [--subset sept-17-254] --out-dir DIR [--prefix NAME]
    python tools/from-dataset.py wiki-plan --dataset DIR --manifest july-2026-07-01-684 --out plan.json
    python tools/from-dataset.py wiki-check --dataset DIR --manifest july-2026-07-01-684 --built wiki-....json

`questions` writes the model-facing question file and the separate grading key that
`pnpm exp:forecast-value --questions-file ... --grading-file ...` reads. Numeric results that the
dataset withholds (third-party market data) are written as `null` with
`"numeric_result_withheld": true`; scoring uses only the Yes/No outcome.

`wiki-plan` writes a plan for vendor/retrieval-infra/tools/cache-wikipedia.ts that selects the
manifest's pages by title at its anchor, as the original snapshot was prepared. `wiki-check`
compares the manifest that tool writes with the released one (revision ids and content hashes).
See docs/reproduction.md.
"""
import argparse
import json
import sys
import urllib.parse
from pathlib import Path

import pyarrow.parquet as pq

QUESTIONS = 'questions/july-2026-07-01/questions.parquet'
WIKI = 'corpus/wiki/{}.parquet'


def rows(path):
    return pq.read_table(path).to_pylist()


def write_jsonl(path, records):
    path.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records))


def questions(args):
    selected = [q for q in rows(args.dataset / QUESTIONS) if not args.subset or q['subset'] == args.subset]
    if not selected:
        raise SystemExit(f'no questions in subset {args.subset!r}')
    model, grading = [], []
    for q in selected:
        model.append(dict(
            id=q['question_id'], question_en=q['question_en'], question_zh=q['question_zh'],
            as_of_date=q['as_of_utc'], prediction_cutoff_utc=q['prediction_cutoff_utc'],
            prediction_cutoff_role=q['prediction_cutoff_role'], target_period_en=q['target_period_en'],
            resolution_criteria=q['resolution_criteria_en'], source_feed=q['category'],
            response_format=q['response_format'], numeric_target_unit=q['numeric_target_unit'],
            prompt=q['model_prompt'], data_contract='raven.question.v3', cut_off_time=q['information_cutoff_utc']))
        grade = dict(id=q['question_id'], resolution_date=q['resolution_date'],
                     resolution_result=q['resolution_result'],
                     numeric_result=json.loads(q['numeric_result_json']) if q['numeric_result_json'] else None)
        if q['numeric_result_withheld']:
            grade['numeric_result_withheld'] = True
        grading.append(grade)
    name = args.prefix or f'raven-july-{args.subset or "all"}'
    args.out_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl(args.out_dir / f'{name}-model-test.jsonl', model)
    write_jsonl(args.out_dir / f'{name}-grading-key.jsonl', grading)
    withheld = sum('numeric_result_withheld' in g for g in grading)
    print(f'{len(model)} questions ({withheld} with a withheld numeric result) -> '
          f'{args.out_dir / name}-{{model-test,grading-key}}.jsonl')


def wiki_plan(args):
    pages = rows(args.dataset / WIKI.format(args.manifest))
    anchors = sorted({p['anchor'] for p in pages})
    urls = [p['host'] + '/wiki/' + urllib.parse.quote(p['requested_title'].replace(' ', '_'), safe='')
            for p in pages]
    plan = dict(selection=f'Pages of the released Wikipedia manifest {args.manifest}, selected by title.',
                urls=urls, anchors=anchors)
    args.out.write_text(json.dumps(plan, ensure_ascii=False, indent=1) + '\n')
    print(f'{len(urls)} pages at {", ".join(anchors)} -> {args.out}')


def wiki_check(args):
    released = {(p['host'], p['page_id']): p for p in rows(args.dataset / WIKI.format(args.manifest))}
    built = {(r['host'], r['pageId']): r for r in json.loads(args.built.read_text())['revisions']}
    missing = sorted(set(released) - set(built))
    extra = sorted(set(built) - set(released))
    differ = [k for k in set(released) & set(built)
              if str(released[k]['rev_id']) != str(built[k]['version'])
              or released[k]['content_sha256'] != built[k]['bodySha256']]
    print(f'{len(released)} released pages; built {len(built)}; missing {len(missing)}; extra {len(extra)}; '
          f'different revision or text {len(differ)}')
    for label, keys in (('missing', missing), ('extra', extra), ('different', differ)):
        for host, page in keys[:20]:
            print(f'  {label}: {host} page {page}')
    if missing or extra or differ:
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='command', required=True)
    q = sub.add_parser('questions', help='question file and grading key for a model run')
    q.add_argument('--subset', help='keep one subset, e.g. sept-17-254 (the July preset) or poly-new-33')
    q.add_argument('--out-dir', type=Path, required=True)
    q.add_argument('--prefix', help='file name prefix (default raven-july-<subset or all>)')
    p = sub.add_parser('wiki-plan', help='cache-wikipedia.ts plan for a released manifest')
    p.add_argument('--manifest', required=True, help='july-2026-07-01-684 or july-2026-07-01-884')
    p.add_argument('--out', type=Path, required=True)
    c = sub.add_parser('wiki-check', help='compare a built Wikipedia manifest with the released one')
    c.add_argument('--manifest', required=True)
    c.add_argument('--built', type=Path, required=True, help='manifest JSON written by cache-wikipedia.ts')
    for parser in (q, p, c):
        parser.add_argument('--dataset', type=Path, required=True, help='directory of the downloaded dataset')
    args = ap.parse_args()
    {'questions': questions, 'wiki-plan': wiki_plan, 'wiki-check': wiki_check}[args.command](args)


if __name__ == '__main__':
    main()
