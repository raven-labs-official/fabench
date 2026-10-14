import unittest

from env_names import former_env_name, project_env, project_env_name


class EnvNames(unittest.TestCase):
    def test_new_name_first_then_former_name(self):
        self.assertEqual(former_env_name('FABENCH_CORPUS_DB'), 'RAVEN_CORPUS_DB')
        self.assertIsNone(former_env_name('JINA_READER'))
        self.assertEqual(project_env('FABENCH_CORPUS_DB', None, {'RAVEN_CORPUS_DB': '/old'}), '/old')
        self.assertEqual(project_env_name('FABENCH_CORPUS_DB', {'RAVEN_CORPUS_DB': '/old'}), 'RAVEN_CORPUS_DB')
        self.assertEqual(project_env('FABENCH_CORPUS_DB', None, {'FABENCH_CORPUS_DB': '/new', 'RAVEN_CORPUS_DB': '/old'}), '/new')
        self.assertEqual(project_env('FABENCH_CORPUS_DB', None, {'FABENCH_CORPUS_DB': '', 'RAVEN_CORPUS_DB': '/old'}), '')
        self.assertEqual(project_env('FABENCH_CORPUS_DB', 'default', {}), 'default')
        with self.assertRaises(KeyError) as raised:
            project_env('FABENCH_CORPUS_DB', environ={})
        self.assertEqual(raised.exception.args, ('FABENCH_CORPUS_DB',))


if __name__ == '__main__':
    unittest.main()
