import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('fidelity',pathlib.Path(__file__).with_name('retrieval-fidelity.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class Metrics(unittest.TestCase):
    def test_tracking_duplicates_missing_queries_and_empty_denominator(self):
        r=[dict(query_id='1',query='test',as_of='2026-08-30',results=[dict(url='https://example.test/a'),dict(url='https://example.test/a?utm_source=x')]),
           dict(query_id='2',query='second',as_of='2026-08-30',results=[dict(url='https://example.test/b')])]
        c=[r[0]]
        result=f.compare(r,c)
        self.assertEqual(result['micro_url_recall'],0.5)
        self.assertEqual(result['missing_queries'],1)
        self.assertEqual(f.compare([],[])['micro_url_recall'],None)

    def test_meaningful_query_parameters_remain_distinct(self):
        self.assertNotEqual(f.canonical_url('https://example.test/?eventId=1'),f.canonical_url('https://example.test/?eventId=2'))

    def test_unknown_and_empty_are_not_zero_leakage(self):
        rows=[dict(unit_id='a',label='leaked',served=True,question_id='q'),dict(unit_id='b',label='unknown',served=True,question_id='q'),dict(unit_id='c',label='clean',served=False,question_id='q')]
        result=f.leakage_metrics(rows)
        self.assertEqual(result['leakage_lower_bound'],0.5)
        self.assertEqual(result['leakage_upper_bound'],1)
        self.assertEqual(result['clean_retention'],0)
        self.assertIsNone(f.leakage_metrics([])['observed_leakage_among_adjudicated'])

    def test_content_match_and_facts_are_separate(self):
        ref=dict(query_id='1',query='q',as_of='2026-08-30',results=[dict(url='https://example.test/a',content_sha256='a',facts=['f1','f2'])])
        candidate=dict(ref,results=[dict(url='https://example.test/a',content_sha256='b',facts=['f1'])])
        out=f.compare([ref],[candidate])['pairs'][0]
        self.assertEqual(out['url_recall'],1)
        self.assertEqual(out['content_recall'],0)
        self.assertEqual(out['fact_recall'],0.5)
        self.assertRaises(ValueError,f.compare,[ref],[dict(candidate,as_of='2026-08-31')])

    def test_stratified_weights_and_top_k_are_not_filter_errors(self):
        def row(uid,label,served,accepted,stratum,n):
            return dict(unit_id=uid,question_id=uid,label=label,served=served,accepted=accepted,
                sampling_stratum=stratum,stratum_population=n,stratum_sample=1,unit_kind='candidate')
        rows=[row('a','clean',True,True,'passed',90),
              row('b','clean',False,True,'limit',9),row('c','leaked',False,False,'rejected',1)]
        out=f.weighted_leakage_metrics(rows,50)['point']
        self.assertEqual(out['clean_filter_retention'],1)
        self.assertAlmostEqual(out['clean_delivery_retention'],90/99)
        self.assertEqual(out['leak_filter_block_recall'],1)

    def test_weighted_unknown_bounds_and_single_cluster(self):
        rows=[dict(unit_id=str(i),question_id='q',label=label,served=True,
            sampling_stratum='search',stratum_population=30,stratum_sample=3,unit_kind='visible')
            for i,label in enumerate(['clean','leaked','unknown'])]
        out=f.weighted_leakage_metrics(rows)
        self.assertEqual(out['point']['leakage_lower_bound'],1/3)
        self.assertEqual(out['point']['leakage_upper_bound'],2/3)
        self.assertIsNone(out['approximate_question_cluster_bootstrap']['leakage_lower_bound']['percentile95'])
        with self.assertRaises(ValueError):f.weighted_leakage_metrics([*rows,dict(rows[0],label='leaked')])
        with self.assertRaises(ValueError):f.weighted_leakage_metrics([dict(rows[0],unit_kind='candidate'),rows[1]])


if __name__=='__main__':unittest.main()
