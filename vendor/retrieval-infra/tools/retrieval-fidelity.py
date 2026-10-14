#!/usr/bin/env python3
"""Compare query-paired JSONL captures; missing queries count as misses, never disappear.

Rows: {query_id, query, as_of, results:[{url, content_sha256?, facts?:[id]}]}.
Leak labels are independent, separate rows: {unit_id, label: clean|leaked|unknown,
served: bool, question_id}. Units must identify actual visible text and exact anchor.
"""
import argparse
import json
import math
import pathlib
import random
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def canonical_url(url):
    """Remove tracking and fragment only; do not collapse different eventId/tab parameters."""
    p = urlsplit(url)
    if p.scheme not in ('https', 'http') or not p.netloc:
        raise ValueError('result URL must be absolute HTTP(S)')
    params = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
              if not k.lower().startswith('utm_') and k.lower() not in ('fbclid', 'gclid')]
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or '/', urlencode(sorted(params)), ''))


def divide(numerator, denominator):
    return numerator / denominator if denominator else None


def unique_results(row, k):
    result = {}
    for item in row.get('results', [])[:k]:
        result.setdefault(canonical_url(item['url']), item)
    return result


def query_metrics(reference, candidate, k):
    if candidate and any(candidate.get(x) != reference.get(x) for x in ('query', 'as_of')):
        raise ValueError('same query_id has different query text or exact anchor')
    baseline = unique_results(reference, k)
    frozen = unique_results(candidate or {}, k)
    overlap = baseline.keys() & frozen.keys()
    # nDCG uses binary membership in the recorded reference list, NOT human relevance labels.
    dcg = sum((url in baseline) / math.log2(rank + 2) for rank, url in enumerate(frozen))
    idcg = sum(1 / math.log2(i + 2) for i in range(min(k, len(baseline))))
    known_hashes = {u for u, d in baseline.items() if d.get('content_sha256')}
    same_bytes = sum(u in frozen and frozen[u].get('content_sha256') == baseline[u]['content_sha256'] for u in known_hashes)
    depth = max(len(baseline),len(frozen))
    discounts = [0.9 ** i for i in range(depth)]
    prefix_score = sum(w * len(set(list(baseline)[:i+1]) & set(list(frozen)[:i+1])) / (i+1) for i,w in enumerate(discounts))
    ref_facts = {f for d in baseline.values() for f in d.get('facts', [])}
    facts_complete = all("facts" in d for d in [*baseline.values(),*frozen.values()])
    got_facts = {f for d in frozen.values() for f in d.get('facts', [])}
    return dict(query_id=reference['query_id'], missing_query=candidate is None,
        reference_urls=len(baseline), candidate_urls=len(frozen), common_urls=len(overlap),
        url_recall=divide(len(overlap),len(baseline)), url_precision_against_reference=divide(len(overlap),len(frozen)),
        jaccard=divide(len(overlap),len(baseline.keys() | frozen.keys())),
        ndcg_reference_membership=divide(dcg,idcg),
        weighted_prefix_overlap=divide(prefix_score,sum(discounts)),
        reference_hashed_documents=len(known_hashes), exact_content_matches=same_bytes,
        content_recall=divide(same_bytes,len(known_hashes)),
        reference_facts=len(ref_facts), matched_facts=len(ref_facts & got_facts),
        fact_recall=divide(len(ref_facts & got_facts),len(ref_facts)) if facts_complete else None)


def wilson(success, n, z=1.959963984540054):
    if not n:
        return None
    p = success/n
    denominator = 1+z*z/n
    center = (p+z*z/(2*n))/denominator
    half = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/denominator
    return [max(0,center-half), min(1,center+half)]


def leakage_metrics(labels):
    units = {}
    for row in labels:
        key = row['unit_id']
        if row['label'] not in ('clean','leaked','unknown') or type(row['served']) is not bool:
            raise ValueError('independent labels require clean/leaked/unknown and a boolean served')
        if key in units and units[key] != row:
            raise ValueError('conflicting duplicate independent label')
        units[key] = row
    rows = list(units.values())
    served = [r for r in rows if r['served']]
    leaked = [r for r in rows if r['label']=='leaked']
    clean = [r for r in rows if r['label']=='clean']
    exposed = sum(r['label']=='leaked' for r in served)
    unknown = sum(r['label']=='unknown' for r in served)
    qids = {r['question_id'] for r in served}
    contaminated = {r['question_id'] for r in served if r['label']=='leaked'}
    return dict(independently_labeled_units=len(rows), served_units=len(served),
        served_known_leaks=exposed, served_unknown_units=unknown,
        observed_leakage_among_adjudicated=divide(exposed,len(served)-unknown),
        leakage_lower_bound=divide(exposed,len(served)), leakage_upper_bound=divide(exposed+unknown,len(served)),
        adjudicated_wilson95=wilson(exposed,len(served)-unknown),
        clean_retention=divide(sum(r['served'] for r in clean),len(clean)),
        leak_block_recall=divide(sum(not r['served'] for r in leaked),len(leaked)),
        question_contamination_lower_bound=divide(len(contaminated),len(qids)),
        note='Describes only supplied independent units. Population inference requires a random sample; correlated/repeated pages require question-cluster resampling. Unknown is not clean.')


def weighted_leakage_metrics(labels, bootstrap_replicates=2000, seed=20260911):
    """Design-weighted ratios for an explicitly stratified random audit.

    Candidate gate accuracy and model exposure must be passed in SEPARATE calls. An
    accepted candidate may lose a top-k slot, so accepted and served are not synonyms.
    Bootstrap intervals resample question clusters and are approximate, conditional on
    this sample and the supplied labels; they are not a finite-population design proof.
    """
    rows = list({r['unit_id']: r for r in labels}.values())
    leakage_metrics(labels)  # reject conflicting duplicates and invalid labels
    for r in rows:
        n, population = r.get('stratum_sample'), r.get('stratum_population')
        if not isinstance(n,int) or not isinstance(population,int) or not 0 < n <= population:
            raise ValueError('each unit needs a valid sampling population and sample size')
        if not r.get('sampling_stratum') or not r.get('question_id'):
            raise ValueError('sampling stratum and question cluster are required')
        if 'accepted' in r and type(r['accepted']) is not bool:
            raise ValueError('accepted must be a boolean when supplied')
    strata = {}
    for r in rows:
        design=(r['stratum_population'],r['stratum_sample'])
        if r['sampling_stratum'] in strata and strata[r['sampling_stratum']] != design:
            raise ValueError('inconsistent sampling design within a stratum')
        strata[r['sampling_stratum']] = design
    if len({r.get('unit_kind') for r in rows}) > 1:
        raise ValueError('candidate decisions and visible outputs need separate denominators')
    if rows and any('accepted' in r for r in rows) and not all('accepted' in r for r in rows):
        raise ValueError('gate acceptance must be supplied for every candidate or none')

    def estimates(multiplicity):
        def total(predicate):
            return sum(r['stratum_population']/r['stratum_sample'] * multiplicity.get(r['question_id'],0)
                       for r in rows if predicate(r))
        served=total(lambda r:r['served'])
        leaks=total(lambda r:r['served'] and r['label']=='leaked')
        unknown=total(lambda r:r['served'] and r['label']=='unknown')
        # An empty/error response is not useful clean information. Keep it out of
        # retention while retaining the original sample/exposure denominator.
        usable_clean=lambda r:r['label']=='clean' and r.get('usable',True)
        clean=total(usable_clean)
        out=dict(leakage_lower_bound=divide(leaks,served),
            leakage_upper_bound=divide(leaks+unknown,served),
            leakage_among_adjudicated=divide(leaks,served-unknown),
            clean_delivery_retention=divide(total(lambda r:usable_clean(r) and r['served']),clean))
        if rows and all('accepted' in r for r in rows):
            accepted_clean=total(lambda r:usable_clean(r) and r['accepted'])
            all_leaks=total(lambda r:r['label']=='leaked')
            unknown_accepted=total(lambda r:r['label']=='unknown' and r['accepted'] and r.get('usable',True))
            unknown_rejected=total(lambda r:r['label']=='unknown' and not r['accepted'] and r.get('usable',True))
            out.update(clean_filter_retention=divide(accepted_clean,clean),
                clean_filter_retention_lower_bound=divide(accepted_clean,clean+unknown_rejected),
                clean_filter_retention_upper_bound=divide(accepted_clean+unknown_accepted,clean+unknown_accepted),
                leak_filter_block_recall=divide(total(lambda r:r['label']=='leaked' and not r['accepted']),all_leaks))
        return out

    questions=sorted({r['question_id'] for r in rows})
    point=estimates(dict.fromkeys(questions,1))
    draws={key:[] for key in point};rng=random.Random(seed)
    if len(questions)>=2:
        for _ in range(bootstrap_replicates):
            counts=dict.fromkeys(questions,0)
            for q in rng.choices(questions,k=len(questions)):counts[q]+=1
            for key,value in estimates(counts).items():
                if value is not None:draws[key].append(value)
    intervals={}
    for key,values in draws.items():
        values.sort()
        intervals[key]=dict(valid_replicates=len(values),
            percentile95=[values[int(.025*(len(values)-1))],values[int(.975*(len(values)-1))]] if values else None)
    return dict(sample_units=len(rows),question_clusters=len(questions),strata=strata,
        point=point,approximate_question_cluster_bootstrap=intervals,seed=seed,
        note='Inverse inclusion weights N_h/n_h. Bounds express unresolved labels; bootstrap intervals express sampling variation conditional on labels. Not a population claim without a valid random design. Stratified finite-population corrections are not applied; small cluster counts or constant labels can yield misleadingly narrow bootstrap intervals. Question contamination needs a question-level audit, not this document sample.')


def compare(reference, candidate, k=10):
    if not isinstance(k,int) or k < 1:
        raise ValueError('k must be positive')
    baseline = {r['query_id']:r for r in reference}
    replay = {r['query_id']:r for r in candidate}
    if len(baseline) != len(reference) or len(replay) != len(candidate):
        raise ValueError('duplicate query_id; repeated calls need unique ids')
    if replay.keys()-baseline.keys():
        raise ValueError('candidate has unpaired queries; evaluate adaptive trajectories separately')
    pairs = [query_metrics(row,replay.get(qid),k) for qid,row in baseline.items()]
    metric_names = ['url_recall','url_precision_against_reference','jaccard','ndcg_reference_membership','weighted_prefix_overlap','content_recall','fact_recall']
    means = {}
    for key in metric_names:
        values = [p[key] for p in pairs if p[key] is not None]
        means[key] = dict(mean=divide(sum(values),len(values)),defined_queries=len(values))
    return dict(query_count=len(pairs),missing_queries=sum(p['missing_query'] for p in pairs),k=k,
        macro=means,micro_url_recall=divide(sum(p['common_urls'] for p in pairs),sum(p['reference_urls'] for p in pairs)),pairs=pairs,
        caveat='URL overlap measures replay fidelity to the saved search, not semantic relevance. Fact ids require independent annotation; without them fact recall is unavailable.')


def read_rows(path):
    return [json.loads(line) for line in pathlib.Path(path).read_text().splitlines() if line.strip()]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference');parser.add_argument('--candidate')
    parser.add_argument('--labels');parser.add_argument('--out',required=True);parser.add_argument('--k',type=int,default=10)
    args=parser.parse_args()
    if bool(args.reference)!=bool(args.candidate):parser.error('reference and candidate must be paired')
    if not args.reference and not args.labels:parser.error('provide a comparison or independent labels')
    out={}
    if args.reference:out['fidelity']=compare(read_rows(args.reference),read_rows(args.candidate),args.k)
    if args.labels:
        labels=read_rows(args.labels)
        out['leakage']=leakage_metrics(labels)
        if any('sampling_stratum' in r for r in labels):out['weighted_leakage']=weighted_leakage_metrics(labels)
    pathlib.Path(args.out).write_text(json.dumps(out,ensure_ascii=True,indent=2)+'\n')


if __name__=='__main__':main()
