#!/usr/bin/env python3
"""Join immutable review evidence without promoting model votes to ground truth.

The candidate body gate and bytes actually exposed to a forecaster are different
denominators. This tool reports them separately, including unresolved-label bounds.
"""
import argparse
import collections
import hashlib
import importlib.util
import json
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text())


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def unique(rows, key='id'):
    out = {}
    for row in rows:
        if row[key] in out:
            raise ValueError(f'duplicate {key}: {row[key]}')
        out[row[key]] = row
    return out


def confusion(rows, label, decision):
    counts = collections.Counter()
    for row in rows:
        truth = label(row)
        prediction = decision(row)
        counts[f'{truth}/{prediction}'] += 1
    return dict(sorted(counts.items()))


def rate(rows, predicate):
    return sum(r['weight'] for r in rows if predicate(r))


def gate_metrics(rows, field):
    # The parameter names deliberately say candidate, never model exposure.
    known_clean = [r for r in rows if r['adjudication']['label'] == 'clean'
                   and r['adjudication'].get('usable', True)]
    known_leaks = [r for r in rows if r['adjudication']['label'] == 'leaked']
    unknown = [r for r in rows if r['adjudication']['label'] == 'unknown'
               and r['adjudication'].get('usable', True)]
    accepted = rate(rows, lambda r:r[field] is True)
    leaked = rate(known_leaks, lambda r:r[field] is True)
    # Relevance/usability affects retention, never whether an unknown datum might
    # leak. An irrelevant live scoreboard can still contaminate a trajectory.
    unresolved = rate(rows, lambda r:r['adjudication']['label']=='unknown' and r[field] is True)
    divide = lambda x,y:x/y if y else None
    clean_accept = rate(known_clean, lambda r:r[field] is True)
    clean_total = rate(known_clean, lambda r:True)
    unknown_accept = rate(unknown, lambda r:r[field] is True)
    # A failed review did not deliver its candidate either. If that unresolved
    # candidate was clean, it belongs in the pessimistic retention denominator.
    unknown_not_delivered = rate(unknown, lambda r:r[field] is not True)
    return {
        'sample_accepted_candidates': sum(r[field] is True for r in rows),
        'sample_decision_errors': sum(r[field] is None for r in rows),
        'estimated_accepted_candidate_total': accepted,
        'candidate_body_leakage_lower_bound': divide(leaked, accepted),
        'candidate_body_leakage_upper_bound': divide(leaked+unresolved, accepted),
        'clean_gate_retention_among_adjudicated': divide(clean_accept, clean_total),
        'clean_gate_retention_lower_bound': divide(clean_accept, clean_total+unknown_not_delivered),
        'clean_gate_retention_upper_bound': divide(clean_accept+unknown_accept, clean_total+unknown_accept),
        'leak_gate_block_recall_among_adjudicated': divide(
            rate(known_leaks, lambda r:r[field] is False), rate(known_leaks, lambda r:True)),
        'note': 'N_h/n_h weighted candidate bodies. These are NOT actual model-visible leakage rates. '
                'Unknown labels remain unresolved; decision errors are not clean/leaked verdicts. '
                'No top-k reranking, live refetch, or new forecasting trajectory was performed.'}


def visible_only_metrics(module, rows):
    result = module.weighted_leakage_metrics(rows)
    # Sampling only delivered outputs cannot measure clean documents discarded
    # upstream. A value of 1 here would be a denominator tautology.
    result['point'].pop('clean_delivery_retention', None)
    result['approximate_question_cluster_bootstrap'].pop('clean_delivery_retention', None)
    result['clean_retention'] = {
        'identifiable': False,
        'reason': 'Delivered-output sample has no rejected clean-document denominator; use the separately sampled candidate gates.'}
    return result


def summarize(audit, sample, allow_incomplete=False, component_reviews=None, component_version='v4'):
    if component_version not in ('v4','v5'): raise ValueError('component version must be v4 or v5')
    audit, sample = Path(audit), Path(sample)
    inputs = unique(read(audit/'blind-input.json'))
    adjudications = unique(read(audit/'assistant-adjudications.json')['rows'])
    machine = unique(read(p) for p in sorted((audit/'qwen-review').glob('*.json'))
                     if p.name not in ('protocol.json','summary.json'))
    conditions = {}
    for name in ['production-replay','production-v3']:
        conditions[name] = unique(r for p in sorted((audit/name).glob('results-*.json'))
                                  for r in read(p)['results'])
    candidate_ids = {k for k,v in inputs.items() if v['unit']=='candidate'}
    component = None
    if component_reviews:
        component = unique(read(component_reviews)['rows'])
        expected = {k for k in candidate_ids if inputs[k]['body'].strip()}
        if set(component) != expected:
            raise ValueError('component review must cover every nonempty candidate exactly once')
        for id,row in component.items():
            if row.get('body_sha256') != sha(inputs[id]['body']):
                raise ValueError(f'component body identity changed: {id}')
            if row.get('label') not in ('clean','leaked','unknown') and not (row.get('parser_error') or row.get('reviewer_error')):
                raise ValueError(f'invalid component verdict: {id}')
    if set(adjudications)-set(inputs) or set(machine)-set(inputs):
        raise ValueError('review contains an unknown input id')
    if not allow_incomplete and set(machine)!=set(inputs):
        raise ValueError('independent triage is incomplete')
    for name, reviews in conditions.items():
        if set(reviews)!=candidate_ids:
            raise ValueError(f'{name} is not the complete paired candidate sample')
    for reviews in [adjudications,machine,*conditions.values()]:
        for id,row in reviews.items():
            if row.get('body_sha256') != sha(inputs[id]['body']):
                raise ValueError(f'body identity changed: {id}')

    def adjudication(id):
        return adjudications.get(id, {'label':'unknown','reason':'Not source-adjudicated; model vote is provisional.'})

    def decision(name,id):
        row=conditions[name][id]
        if row.get('error'):return None
        value=row.get('decision',{}).get('leaked')
        if type(value) is not bool:raise ValueError(f'bad filter verdict: {id}')
        return value

    candidates=[]
    keys=unique(read(sample/'review-sampling-key.json'),'unit_id')
    for id in sorted(candidate_ids,key=lambda k:int(k.split('-')[1])):
        source=inputs[id];key=keys[source['original_unit_id']];old=key['record']['candidate']
        eligible=(old['engine_date_decision']=='fetch'
                  and old['final_disposition'] not in ('market_host_rejected','dater_missing_result')
                  and bool(source['body'].strip()))
        v2,v3=decision('production-replay',id),decision('production-v3',id)
        row={'id':id,'question_id':source['question_id'],'body_sha256':sha(source['body']),
             'stratum':key['stratum'],'weight':key['stratum_population']/key['stratum_sample'],
             'adjudication':adjudication(id),'independent_model_label':machine.get(id,{}).get('label'),
             'old_disposition':old['final_disposition'],
             'historically_returned_url':old['served_to_forecaster'],
             'old_gate_accepted':bool(old['served_to_forecaster'] or old['final_disposition']=='passed_but_not_served_limit'),
             'v2_body_leaked':v2,'v3_body_leaked':v3}
        for version,verdict in [('v2',v2),('v3',v3)]:
            row[f'{version}_strict_gate_accepted']=False if not eligible or old['page_date_decision']!='accepted' else None if verdict is None else not verdict
            row[f'{version}_content_gate_accepted']=False if not eligible else None if verdict is None else not verdict
        if component is not None:
            review = component.get(id, {})
            verdict = review.get('label')
            row[f'{component_version}_body_label'] = verdict
            row[f'{component_version}_review_error'] = review.get('parser_error') or review.get('reviewer_error')
            row[f'{component_version}_strict_gate_accepted'] = False if not eligible or old['page_date_decision']!='accepted' else None if verdict is None else verdict=='clean'
            row[f'{component_version}_content_gate_accepted'] = False if not eligible else None if verdict is None else verdict=='clean'
        candidates.append(row)

    packets=unique(read(sample/'visible-review-packet.json'),'unit_id')
    visible=[]
    for id,source in inputs.items():
        if source['unit']!='visible':continue
        key=packets[source['original_unit_id']];label=adjudication(id)
        visible.append({'unit_id':id,'unit_kind':'actual_visible_tool_output',
            'question_id':source['question_id'],'label':label['label'],'served':True,
            'body_sha256':sha(source['body']),'sampling_stratum':key['operation'],
            'stratum_population':key['stratum_population'],'stratum_sample':key['stratum_sample'],
            'backend':'frozen' if '--frozen--' in key['trace'] else 'web-filter',
            'usable':label.get('usable',True)})
    spec=importlib.util.spec_from_file_location('fidelity',Path(__file__).with_name('retrieval-fidelity.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    exposure={name:visible_only_metrics(module,
        [r for r in visible if name=='all' or r['backend']==name]) for name in ['all','frozen','web-filter']}
    return {
        'schema':'raven.retrieval-review-comparison.v3' if component is not None else 'raven.retrieval-review-comparison.v2',
        **({'component_review': {
            'version':component_version,
            'mode':'Saved component-policy replies parsed offline by the production parser; not a new production trajectory.',
            'nonempty_candidates':len(component),
            'counts':dict(collections.Counter(r.get('label','error') for r in component.values())),
            'confusion':confusion([r for r in candidates if r['id'] in component],lambda r:r['adjudication']['label'],lambda r:r[f'{component_version}_body_label']),
            'metrics':{name:gate_metrics(candidates,name) for name in [f'{component_version}_strict_gate_accepted',f'{component_version}_content_gate_accepted']},
            'file_sha256':hashlib.sha256(Path(component_reviews).read_bytes()).hexdigest(),
        }} if component is not None else {}),
        'input_units':len(inputs),'independent_triage_completed':len(machine),
        'independent_triage_complete':set(machine)==set(inputs),
        'label_policy':'Source-backed assistant adjudications are separate from provisional model votes; neither is independent human gold.',
        'paired_body_review_counts':{
            name:dict(collections.Counter('error' if r.get('error') else str(r['decision']['leaked']) for r in reviews.values()))
            for name,reviews in conditions.items()},
        'paired_body_review_flips':[{'id':r['id'],'v2':r['v2_body_leaked'],'v3':r['v3_body_leaked']}
                                   for r in candidates if r['v2_body_leaked']!=r['v3_body_leaked']],
        'source_adjudication_confusions':{
            name:confusion(candidates,lambda r:r['adjudication']['label'],lambda r:r[name])
            for name in ['v2_body_leaked','v3_body_leaked']},
        'model_agreement_not_accuracy':{
            name:confusion(candidates,lambda r:(r['independent_model_label'] or {}).get('label','pending'),lambda r:r[name])
            for name in ['v2_body_leaked','v3_body_leaked']},
        'candidate_gate_metrics':{name:gate_metrics(candidates,name) for name in
            ['old_gate_accepted','v2_strict_gate_accepted','v2_content_gate_accepted',
             'v3_strict_gate_accepted','v3_content_gate_accepted']},
        'actual_visible_output_metrics':exposure,
        'exposure_notes':'One unit is the complete tool output (a search may have multiple results). '
            'Backend reports are domains of the original operation-stratified sample, retaining original inclusion weights. '
            'Known leaks found outside this probability sample must not be inserted as random draws. '
            'Question contamination requires complete question-trajectory audits.',
        'candidate_rows':candidates,'visible_rows':visible,
        'input_file_sha256':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in
            [audit/'blind-input.json',audit/'assistant-adjudications.json',sample/'review-sampling-key.json',sample/'visible-review-packet.json']}}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('audit_dir');parser.add_argument('sampling_dir');parser.add_argument('output')
    parser.add_argument('--allow-incomplete',action='store_true')
    parser.add_argument('--component-reviews',help='Complete offline production-parser conformance result for nonempty candidates')
    parser.add_argument('--component-version',choices=['v4','v5'],default='v4')
    args=parser.parse_args()
    out=summarize(args.audit_dir,args.sampling_dir,args.allow_incomplete,args.component_reviews,args.component_version)
    Path(args.output).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in out.items() if k in
        ('input_units','independent_triage_completed','independent_triage_complete','paired_body_review_counts','paired_body_review_flips')},indent=2))


if __name__=='__main__':main()
