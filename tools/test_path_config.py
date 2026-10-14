import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import path_config
from path_config import PROJECT_ROOT, SHARED_ROOT, configured_path, required_path
from reporting import combined, sept17
from reporting.paths import add_input_arguments, report_paths


class PathConfigTests(unittest.TestCase):
    def setUp(self):
        temporary_root = Path(os.environ.get('TMPDIR', PROJECT_ROOT / 'results/test-tmp'))
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.environment = patch.dict(os.environ, {'TMPDIR': str(temporary_root)}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_shared_paths_sit_below_one_root(self):
        root = path_config.SHARED_ROOT
        expected = {
            'SHARED_RUNS_ROOT': f'{root}/runs',
            'SHARED_BENCH_DIR': f'{root}/runs/raven-bench',
            'SHARED_RESULTS_DIR': f'{root}/runs/raven-bench/results',
            'SHARED_REGISTRY_PATH': f'{root}/runs/raven-bench/registry.sqlite',
            'TEAM_CONFIG_DIR': f'{root}/config/raven-bench',
            'CURRENT_RELEASE': f'{root}/current/raven-bench',
            'FROZEN_SHARED_CACHE': f'{root}/cache/frozen-query/cache.sqlite',
        }
        self.assertEqual({name: getattr(path_config, name) for name in expected}, expected)
        for unconfigured in (path_config.UNCONFIGURED_SHARED_ROOT, path_config.UNCONFIGURED_DATA_ROOT):
            self.assertFalse(Path(unconfigured, 'runs').exists())
            with self.assertRaises(NotADirectoryError):
                Path(unconfigured, 'runs').mkdir(parents=True)

    def test_settings_come_from_environment_then_paths_file_then_site_file(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / 'site.json'
            paths = Path(directory) / 'paths.json'
            site.write_text(json.dumps({'sharedRoot': 'site-root', 'teamGroup': 'site-group'}))
            paths.write_text(json.dumps({'sharedRoot': 'paths-root'}))
            with patch.object(path_config, 'SITE_CONFIG_FILE', site):
                self.assertEqual(configured_path('sharedRoot', 'FABENCH_SHARED_ROOT'), Path(directory) / 'site-root')
                self.assertEqual(path_config.setting('teamGroup'), 'site-group')
                self.assertIsNone(path_config.setting('reportHost'))
                os.environ['FABENCH_PATHS_CONFIG'] = str(paths)
                self.assertEqual(path_config.setting('sharedRoot'), str(Path(directory) / 'paths-root'))
                self.assertEqual(path_config.setting('teamGroup'), 'site-group')
                os.environ['FABENCH_SHARED_ROOT'] = '/env-root'
                os.environ['FABENCH_TEAM_GROUP'] = 'env-group'
                self.assertEqual(path_config.setting('sharedRoot'), '/env-root')
                self.assertEqual(path_config.setting('teamGroup'), 'env-group')
                # A former RAVEN_* name is read only while the FABENCH_* name is unset.
                os.environ['RAVEN_TEAM_GROUP'] = 'former-group'
                self.assertEqual(path_config.setting('teamGroup'), 'env-group')
                del os.environ['FABENCH_TEAM_GROUP']
                self.assertEqual(path_config.setting('teamGroup'), 'former-group')
            with patch.object(path_config, 'SITE_CONFIG_FILE', Path(directory) / 'absent.json'):
                del os.environ['FABENCH_PATHS_CONFIG'], os.environ['FABENCH_SHARED_ROOT']
                self.assertEqual(path_config.setting('sharedRoot'), path_config.UNCONFIGURED_SHARED_ROOT)
                self.assertEqual(path_config.setting('dataRoot'), path_config.UNCONFIGURED_DATA_ROOT)

    def test_shell_settings_command(self):
        command = [sys.executable, '-I', str(PROJECT_ROOT / 'tools/path_config.py'), 'get']
        child = subprocess.run([*command, 'teamGroup'], env={'FABENCH_TEAM_GROUP': 'env-group'},
                               capture_output=True, text=True)
        self.assertEqual((child.returncode, child.stdout), (0, 'env-group\n'))
        child = subprocess.run([*command, 'teamGroup'], env={'RAVEN_TEAM_GROUP': 'former-group'},
                               capture_output=True, text=True)
        self.assertEqual((child.returncode, child.stdout), (0, 'former-group\n'))
        child = subprocess.run([*command, 'unknownKey'], env={}, capture_output=True, text=True)
        self.assertEqual(child.returncode, 2)

    def test_shell_scripts_read_the_shared_root_from_configuration(self):
        definition = 'shared_root="$(python3 -I "$(dirname "${BASH_SOURCE[0]}")/path_config.py" get sharedRoot)"'
        for script in sorted((PROJECT_ROOT / 'tools').glob('*.sh')):
            if script.is_symlink():
                continue
            text = script.read_text()
            with self.subTest(script=script.name):
                self.assertNotIn('shared_root=/', text)
                if SHARED_ROOT != path_config.UNCONFIGURED_SHARED_ROOT:
                    self.assertNotIn(SHARED_ROOT + '/', text)
                if '$shared_root' in text or '$shared_bench_dir' in text:
                    self.assertTrue(definition in text
                                    or 'source "$repo_root/tools/shared-environment.sh"' in text)

    def test_config_relative_paths_and_environment_override(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'paths.json'
            path.write_text(json.dumps({'resultsDir': 'output with spaces'}))
            os.environ['FABENCH_PATHS_CONFIG'] = str(path)
            self.assertEqual(configured_path('resultsDir', 'FABENCH_RESULTS_DIR'), path.parent / 'output with spaces')
            path.write_text('broken JSON')
            os.environ['FABENCH_RESULTS_DIR'] = directory
            self.assertEqual(configured_path('resultsDir', 'FABENCH_RESULTS_DIR'), Path(directory))
            del os.environ['FABENCH_RESULTS_DIR']
            with self.assertRaisesRegex(ValueError, 'Cannot read path configuration'):
                configured_path('resultsDir', 'FABENCH_RESULTS_DIR')

    def test_required_paths_explain_missing_configuration(self):
        self.assertIsNone(configured_path('paper287Dir', 'FABENCH_SEPT0921_FINAL_DIR'))
        with self.assertRaisesRegex(ValueError, 'FABENCH_SEPT0921_FINAL_DIR.*paper287Dir'):
            required_path('paper287Dir', 'FABENCH_SEPT0921_FINAL_DIR')

    def test_config_file_and_field_errors_are_not_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'paths.json'
            os.environ['FABENCH_PATHS_CONFIG'] = str(path)
            for content in ('[]', '{"resultsDir": null}', '{"resultsDir": ""}'):
                path.write_text(content)
                with self.subTest(content=content), self.assertRaises(ValueError):
                    configured_path('resultsDir', 'FABENCH_RESULTS_DIR')

    def test_report_cli_paths_override_optional_config(self):
        parser = argparse.ArgumentParser()
        add_input_arguments(parser)
        os.environ['FABENCH_PATHS_CONFIG'] = '/missing/config.json'
        paths = report_paths(parser.parse_args(['--results-dir', 'local-results', '--registry', 'snapshot.sqlite']),
                             Path('/shared'))
        self.assertTrue(paths.local)
        self.assertEqual(paths.results, Path.cwd() / 'local-results')
        self.assertEqual(paths.registry, Path.cwd() / 'snapshot.sqlite')

    def test_report_defaults_preserve_shared_query_and_explicit_local_root(self):
        parser = argparse.ArgumentParser()
        add_input_arguments(parser)
        shared = report_paths(parser.parse_args([]), Path('/shared'))
        local = report_paths(parser.parse_args(['--local']), Path('/shared'))
        self.assertFalse(shared.local)
        self.assertEqual(shared.registry, Path('/shared/registry.sqlite'))
        self.assertTrue(local.local)
        self.assertEqual(local.results, PROJECT_ROOT / 'results')

    def test_missing_explicit_report_input_never_queries_ssh(self):
        with tempfile.TemporaryDirectory() as directory:
            for module in (sept17, combined):
                with self.subTest(module=module.__name__), \
                        patch.object(sys, 'argv', ['report', '--results-dir', directory, '--registry',
                                                  str(Path(directory) / 'missing.sqlite'), '--output-dir',
                                                  str(Path(directory) / 'report')]), \
                        patch('subprocess.run') as remote:
                    with self.assertRaises(FileNotFoundError):
                        module.main()
                    remote.assert_not_called()
            self.assertFalse((Path(directory) / 'missing.sqlite').exists())

    def test_default_combined_query_uses_published_entry_and_selected_host(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(sept17, 'ROOT', Path(directory) / 'missing shared root'), \
                patch.object(sys, 'argv', ['report', '--host', 'fixture']), \
                patch('subprocess.run') as remote:
            combined.main()
        command = remote.call_args.args[0]
        self.assertEqual(command[:2], ['ssh', 'fixture'])
        self.assertIn(f'{path_config.CURRENT_RELEASE}/tools/sept0921-leaderboard.py --output-dir', command[2])
        self.assertIn("'", command[2])
        self.assertNotIn('--local', command[2])
        self.assertTrue(remote.call_args.kwargs['check'])

    def test_local_collect_reads_selected_root_and_readonly_registry(self):
        with tempfile.TemporaryDirectory(prefix='report # ') as directory:
            root = Path(directory)
            data = root / sept17.DATA_SUBDIRECTORY
            data.mkdir(parents=True)
            questions = data / 'raven-july-2026-model-test.jsonl'
            grading = data / 'raven-july-2026-grading-key.jsonl'
            questions.write_text(''.join(json.dumps({'id': f'q{i}'}) + '\n' for i in range(254)))
            grading.write_text(''.join(json.dumps({'id': f'q{i}', 'resolution_result': 1}) + '\n' for i in range(254)))
            registry = root / 'selected registry.sqlite'
            with sqlite3.connect(registry) as db:
                db.execute('CREATE TABLE runs (run_id TEXT, status TEXT, started_at_utc TEXT, config_json TEXT)')
                db.execute('CREATE TABLE run_cells (run_id TEXT, question_id TEXT, probability REAL, status TEXT, arm TEXT, condition_id TEXT)')
                config = {'question_set_id': sept17.POOL, 'llm': 'deepseek:deepseek-flash', 'conditions': [{'arm': 'none'}]}
                db.execute('INSERT INTO runs VALUES (?, ?, ?, ?)', ('example', 'completed', '2026-09-17', json.dumps(config)))
                db.execute('INSERT INTO run_cells VALUES (?, ?, ?, ?, ?, ?)', ('example', 'q0', .8, 'success', 'none', 'c1'))
            before = registry.read_bytes()
            # This tests file relocation on synthetic inputs, not the historical paper export.
            with patch.object(sept17, 'QUESTION_HASH', hashlib.sha256(questions.read_bytes()).hexdigest()), \
                    patch.object(sept17, 'GRADING_HASH', hashlib.sha256(grading.read_bytes()).hexdigest()):
                report = sept17.collect(root, registry)
            self.assertEqual(report['questions'], 254)
            self.assertEqual(report['rows'][0]['n'], 1)
            self.assertAlmostEqual(report['rows'][0]['brier_index'], 80)
            self.assertEqual(registry.read_bytes(), before)
            self.assertTrue(all(c['pointer'].startswith(str(root)) for c in report['controllers']))

    def test_paper_loaders_require_config_and_keep_pinned_hash_check(self):
        loaders = {'load287': PROJECT_ROOT / 'paper', 'load265': PROJECT_ROOT / 'docs/research/iclr-experiments/analysis'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'paths.json'
            config.write_text(json.dumps({'paper287Dir': 'bundle', 'paper265Dir': 'bundle'}))
            bundle = root / 'bundle'
            (bundle / 'source').mkdir(parents=True)
            (bundle / 'leaderboard.json').write_text('{}')
            (bundle / 'source/leaderboard-sept0921.json').write_text('{}')
            for name, analysis in loaders.items():
                if not (analysis / f'{name}.py').exists():
                    continue  # the public tree carries only the 287-question loader
                with self.subTest(loader=name):
                    child = subprocess.run([sys.executable, '-c', f'import {name}'], cwd=directory,
                                           env={'PYTHONPATH': str(analysis)}, capture_output=True, text=True)
                    self.assertNotEqual(child.returncode, 0)
                    # The archived iclr loader (load265) keeps its former RAVEN_* name.
                    self.assertRegex(child.stderr, '(FABENCH|RAVEN)_SEPT')
                    child = subprocess.run([sys.executable, '-c', f'import {name}'], cwd=directory,
                                           env={'PYTHONPATH': str(analysis), 'FABENCH_PATHS_CONFIG': str(config)},
                                           capture_output=True, text=True)
                    self.assertNotEqual(child.returncode, 0)
                    # load287 first asks for the receipt of paper/build_inputs.py; load265 checks pinned hashes
                    self.assertIn('paper/build_inputs.py' if name == 'load287' else 'Pinned', child.stderr)
                    self.assertIn(str(bundle), child.stderr)


if __name__ == '__main__':
    unittest.main()
