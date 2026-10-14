#!/usr/bin/env python3
"""Compare independently annotated evidence from adaptive traces by question.

JSONL rows: {question_id, as_of, prompt_facts: [id], retrieved_facts?: [id]}.
Each id denotes a source-backed, independently matched proposition. Omit
retrieved_facts when annotation is unfinished; [] means a completed empty audit.
This tool neither extracts facts nor infers temporal legality from overlap.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def fact_set(value, name):
    if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
        raise ValueError(f'{name} must be a list of nonempty fact ids')
    return set(value)


def anchor(value):
    if not isinstance(value, str) or 'T' not in value:
        raise ValueError('an exact timezone-bearing anchor is required')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('an exact timezone-bearing anchor is required')
    return parsed.astimezone(timezone.utc)


def indexed(rows):
    result = {}
    for row in rows:
        key = row.get('question_id')
        if not isinstance(key, str) or not key or key in result:
            raise ValueError('question ids must be unique and nonempty')
        anchor(row.get('as_of'))
        fact_set(row.get('prompt_facts'), 'prompt_facts')
        if 'retrieved_facts' in row:
            fact_set(row['retrieved_facts'], 'retrieved_facts')
        result[key] = row
    return result


def compare(reference_rows, candidate_rows):
    reference, candidate = indexed(reference_rows), indexed(candidate_rows)
    if candidate.keys() - reference.keys():
        raise ValueError('candidate contains questions absent from reference')
    pairs = []
    for key, ref in reference.items():
        got = candidate.get(key)
        prompt = fact_set(ref['prompt_facts'], 'prompt_facts')
        if got is not None:
            if anchor(got['as_of']) != anchor(ref['as_of']):
                raise ValueError('paired question anchors differ')
            if fact_set(got['prompt_facts'], 'prompt_facts') != prompt:
                raise ValueError('paired question prompt facts differ')
        complete = 'retrieved_facts' in ref and (got is None or 'retrieved_facts' in got)
        row = dict(question_id=key, as_of=ref['as_of'], missing_candidate=got is None,
                   annotation_complete=complete, prompt_fact_count=len(prompt))
        if not complete:
            row['reason'] = 'retrieved facts are unannotated on at least one present trace'
            pairs.append(row)
            continue
        real = fact_set(ref['retrieved_facts'], 'retrieved_facts')
        frozen = fact_set(got['retrieved_facts'], 'retrieved_facts') if got is not None else set()
        real_extra, frozen_extra = real - prompt, frozen - prompt
        real_total, frozen_total = prompt | real, prompt | frozen
        row.update(
            reference_retrieved=len(real), candidate_retrieved=len(frozen),
            matched_retrieved=len(real & frozen),
            retrieval_fact_recall=ratio(len(real & frozen), len(real)),
            retrieval_membership_precision=ratio(len(real & frozen), len(frozen)),
            reference_increment=len(real_extra), candidate_increment=len(frozen_extra),
            matched_increment=len(real_extra & frozen_extra),
            incremental_fact_recall=ratio(len(real_extra & frozen_extra), len(real_extra)),
            reference_total_available=len(real_total), candidate_total_available=len(frozen_total),
            matched_total_available=len(real_total & frozen_total),
            total_available_fact_recall=ratio(len(real_total & frozen_total), len(real_total)),
            prompt_only_total_coverage=ratio(len(prompt), len(real_total)),
            missing_reference_retrieved_ids=sorted(real - frozen),
            additional_candidate_retrieved_ids=sorted(frozen - real),
        )
        pairs.append(row)
    names = ['retrieval_fact_recall', 'retrieval_membership_precision', 'incremental_fact_recall',
             'total_available_fact_recall', 'prompt_only_total_coverage']
    macro = {}
    for name in names:
        values = [r[name] for r in pairs if r.get(name) is not None]
        macro[name] = dict(mean=ratio(sum(values), len(values)), defined_questions=len(values))
    complete = [r for r in pairs if r['annotation_complete']]
    micro = {}
    for name, numerator, denominator in [
        ('retrieval_fact_recall', 'matched_retrieved', 'reference_retrieved'),
        ('incremental_fact_recall', 'matched_increment', 'reference_increment'),
        ('total_available_fact_recall', 'matched_total_available', 'reference_total_available'),
    ]:
        micro[name] = ratio(sum(r[numerator] for r in complete), sum(r[denominator] for r in complete))
    return dict(schema='raven.trajectory-fidelity.v1', question_count=len(pairs),
                missing_candidates=sum(r['missing_candidate'] for r in pairs),
                completely_annotated_questions=len(complete), unannotated_questions=len(pairs)-len(complete),
                macro=macro, micro=micro, pairs=pairs,
                caveat='Equal-weight source-backed fact ids, cumulative per question. Query sequences need not match. Unannotated questions remain explicitly unavailable. Extra facts are not automatically irrelevant or leaked. Overlap is not truth, adequacy, actual use, or an estimate of future-information leakage. A missing trace receives no retrieved facts; total availability assumes the same initial prompt.')


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = compare(read_rows(args.reference), read_rows(args.candidate))
    out['input_sha256'] = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                          for name, path in [('reference', args.reference), ('candidate', args.candidate)]}
    out['tool_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
