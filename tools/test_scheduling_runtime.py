import datetime as dt
import os
import unittest
from unittest.mock import patch

from scheduling import runtime


SAVED = {'pid': 7, 'start_ticks': '42', 'boot_id': 'boot'}


def process(state, start_ticks='42', boot_id='boot'):
    return {'pid': 7, 'start_ticks': start_ticks, 'state': state, 'boot_id': boot_id}


class LivenessTests(unittest.TestCase):
    def test_current_process_is_alive_by_its_own_identity(self):
        self.assertTrue(runtime.alive(runtime.identity(os.getpid())))

    def test_zombie_and_dead_processes_are_not_alive(self):
        with patch.object(runtime, 'identity', return_value=process('S')):
            self.assertTrue(runtime.alive(SAVED))
        for state in ('Z', 'X'):
            with self.subTest(state=state), patch.object(runtime, 'identity', return_value=process(state)):
                self.assertFalse(runtime.alive(SAVED))

    def test_reused_pid_or_new_boot_is_not_the_saved_process(self):
        for live in (process('S', start_ticks='43'), process('S', boot_id='other'), None):
            with self.subTest(live=live), patch.object(runtime, 'identity', return_value=live):
                self.assertFalse(runtime.alive(SAVED))
        with patch.object(runtime, 'identity', return_value=process('S')):
            self.assertFalse(runtime.alive({'pid': 7}))


class PublicationGraceTests(unittest.TestCase):
    def test_publication_has_bounded_time_to_finish_after_registry(self):
        epoch = dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc).timestamp()
        run = {'finished_at_utc': '2030-01-01T00:00:00Z'}
        self.assertTrue(runtime.publication_grace(run, epoch + 25))
        self.assertFalse(runtime.publication_grace(run, epoch + 301))


if __name__ == '__main__':
    unittest.main()
