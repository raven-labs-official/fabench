from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import json

from reporting import sept17 as m


class RemoteQueryTest(unittest.TestCase):
    def test_remote_query_uses_the_published_entry_and_preserves_its_fingerprint(self):
        report = {'query_sha256': 'published-query', 'rows': []}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(m, 'ROOT', Path(directory)), \
                patch.object(m.sys, 'argv', ['sept17-leaderboard.py', '--host', 'fixture', '--json']), \
                patch.object(m.subprocess, 'run', return_value=Mock(returncode=0, stdout=json.dumps(report))) as run, \
                patch.object(m, 'markdown', return_value=''), patch('builtins.print') as output:
            m.main()
        self.assertEqual(run.call_args.args[0][-2:], [
            'fixture', f'python3 {m.CURRENT_RELEASE}/tools/sept17-leaderboard.py --on-server --json'])
        self.assertNotIn('input', run.call_args.kwargs)
        self.assertEqual(json.loads(output.call_args.args[0])['query_sha256'], 'published-query')


def run(id, model='deepseek:deepseek-flash', time='2026-09-17T00:00:00Z', mode=None, pool=m.POOL):
    return {'run_id': id, 'started_at_utc': time, 'config': {
        'llm': model, 'question_set_id': pool, 'execution_mode': mode,
        'conditions': [{'arm': 'none'}]}}


def cell(id, qid='q1', p=0.5, status='success', arm='none', condition='c1'):
    return {'run_id': id, 'question_id': qid, 'probability': p, 'status': status,
            'arm': arm, 'condition_id': condition, 'updated_at_utc': '2026-09-17T01:00:00Z'}


class Sept17Tests(unittest.TestCase):
    def test_strict_priority_earliest_valid_and_reviewed_only_fills(self):
        runs = [run('bad'), run('early', time='2026-09-18'), run('later', time='2026-09-19'),
                run('repair', mode='postprocess', time='2026-09-16')]
        cells = [cell('bad', p=None, status='failed'), cell('early', p=.8),
                 cell('later', p=.99), cell('repair', p=1), cell('repair', 'q2', .3)]
        r = m.merge(list(reversed(runs)), cells, {'q1': 1, 'q2': 0})[0]
        self.assertEqual([a['probability'] for a in r['answers']], [.8, .3])
        self.assertEqual(r['reviewed_extra'], 1)
        self.assertAlmostEqual(r['brier'], (.2 ** 2 + .3 ** 2) / 2)

    def test_pool_and_question_scope(self):
        runs = [run('old', pool='march-300'), run('right')]
        r = m.merge(runs, [cell('old', p=1), cell('right'), cell('right', 'foreign')], {'q1': 1})[0]
        self.assertEqual(r['n'], 1)
        self.assertEqual(r['brier_index'], 50)
        self.assertEqual(r['run_ids'], ['right'])

    def test_aliases_and_arms_remain_separate(self):
        runs = [run('a', 'claude:claude-opus-5'), run('b', 'openrouter:anthropic/claude-opus-5')]
        rows = m.merge(runs, [cell('a'), cell('b', 'q2'), cell('b', arm='frozen')], {'q1': 0, 'q2': 1})
        self.assertEqual([(r['model'], r['arm'], r['n']) for r in rows],
                         [('Claude Opus 5', 'none', 2), ('Claude Opus 5', 'frozen', 1)])

    def test_threshold_is_strictly_above_200(self):
        labels = {str(i): 1 for i in range(254)}
        for n in (200, 201, 254):
            with self.subTest(n=n):
                r = m.merge([run('a')], [cell('a', str(i), 1) for i in range(n)], labels)[0]
                self.assertEqual(r['eligible'], n > 200)
                self.assertEqual(r['complete'], n == 254)
                self.assertEqual(r['brier_index'], 100)

    def test_invalid_predictions_never_imputed(self):
        bad = [float('nan'), float('inf'), -0.1, 1.1, None, True, '0.5']
        cells = [cell('a', str(i), p) for i, p in enumerate(bad)]
        cells += [cell('a', 'failed', 1, 'failed'), cell('a', 'reused', .5, 'reused')]
        labels = {c['question_id']: 1 for c in cells}
        r = m.merge([run('a')], cells, labels)[0]
        self.assertEqual(r['n'], 1)
        self.assertEqual(r['brier_index'], 50)
        self.assertEqual(len(r['missing_ids']), 8)

    def test_resumed_run_not_averaged_and_live_success_included(self):
        runs = [run('a'), run('b', time='2026-09-18')]
        runs[1]['status'] = 'running'
        r = m.merge(runs, [cell('a', 'q1', 1), cell('b', 'q1', .1),
                          cell('b', 'q2', 0), cell('b', 'q3', 0)],
                    {'q1': 1, 'q2': 1, 'q3': 1})[0]
        self.assertEqual(r['n'], 3)
        self.assertAlmostEqual(r['brier'], 2 / 3)

    def test_hash_mismatch_fails_closed(self):
        r = run('a')
        r['config']['question_set'] = {'file_sha256': 'wrong'}
        with self.assertRaisesRegex(ValueError, 'inconsistent'):
            m.merge([r], [cell('a')], {'q1': 1})
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'questions.jsonl'
            p.write_text('{"id":"q1"}\n')
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                m.verified_jsonl(p, m.QUESTION_HASH)

    def test_no_valid_answers_has_no_score(self):
        r = m.merge([run('a')], [cell('a', p=None, status='failed')], {'q1': 1})[0]
        self.assertIsNone(r['brier_index'])
        self.assertFalse(r['eligible'])
        self.assertTrue(r['execution_complete'])
        self.assertFalse(r['evaluation_complete'])


    def test_completed_batches_with_abstentions_are_not_unrun(self):
        with tempfile.TemporaryDirectory() as d:
            trace = Path(d) / 'failed.jsonl'
            trace.write_text('{"type":"agent_failed","data":{"partial_final_answer":"{\\"probability_yes\\":null}","error":{"message":"Invalid forecast"}}}\n')
            failed = cell('b', 'q2', None, 'failed')
            failed['trace_path'] = str(trace)
            r = m.merge([run('a'), run('b')], [cell('a', 'q1'), failed], {'q1': 1, 'q2': 0})[0]
            self.assertEqual((r['terminal_n'], r['n'], r['no_probability_n']), (2, 1, 1))
            self.assertTrue(r['execution_complete'])
            self.assertTrue(r['evaluation_complete'])
            self.assertFalse(r['complete'])
            self.assertEqual(r['not_started_n'], 0)
            self.assertEqual(r['merged_batches'], 2)

    def test_progress_partition_excludes_duplicates_and_distinguishes_pending(self):
        cells = [cell('a', 'q1'), cell('a', 'q2', None, 'failed'),
                 cell('b', 'q1'), cell('b', 'q3', None, 'claimed')]
        r = m.merge([run('a'), run('b')], cells, dict.fromkeys(['q1', 'q2', 'q3', 'q4'], 1))[0]
        self.assertEqual((r['n'], r['unscored_terminal_n'], r['pending_n'], r['not_started_n']), (1, 1, 1, 1))
        self.assertFalse(r['execution_complete'])
        self.assertEqual(r['terminal_n'], 2)


if __name__ == '__main__':
    unittest.main()

class BothIdentityTests(unittest.TestCase):
    def test_both_merges_only_versioned_mixed_and_preserves_legacy_records(self):
        import copy
        runs = [run('legacy'), run('mixed'), run('both'), run('unknown')]
        for r, arm in zip(runs, ['both', 'mixed', 'both', 'mixed']):
            cond = {'arm': arm, 'condition_id': 'c1'}
            if r['run_id'] in ('mixed', 'both'):
                cond['retrieval_mixed_policy'] = dict(m._arm_identity.BOTH_POLICY)
            r['config']['conditions'] = [cond]
        cells = [cell('legacy', 'q0', 1, arm='both'), cell('mixed', 'q1', .8, arm='mixed'),
                 cell('both', 'q2', .4, arm='both'), cell('unknown', 'q3', 1, arm='mixed')]
        original = copy.deepcopy((runs, cells))
        rows = m.merge(runs, cells, {f'q{i}': 1 for i in range(4)})
        self.assertEqual([(r['arm'], r['n']) for r in rows], [('both', 2)])
        self.assertEqual([a['question_id'] for a in rows[0]['answers']], ['q1', 'q2'])
        self.assertEqual((runs, cells), original)


class ProcessMatchTests(unittest.TestCase):
    def test_exited_or_mismatched_process_does_not_match(self):
        live = {'pid': 7, 'start_ticks': '42', 'state': 'S', 'boot_id': 'boot'}
        with patch.object(m.runtime, 'identity', return_value=live):
            self.assertTrue(m.process_matches(7, 42, 'boot'))
            self.assertTrue(m.process_matches('7'))
            self.assertFalse(m.process_matches(7, 43))
            self.assertFalse(m.process_matches(7, boot='other'))
        for state in ('Z', 'X'):
            with self.subTest(state=state), patch.object(m.runtime, 'identity', return_value={**live, 'state': state}):
                self.assertFalse(m.process_matches(7, 42, 'boot'))
        self.assertFalse(m.process_matches(None))
