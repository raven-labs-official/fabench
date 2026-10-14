import importlib.util
import pathlib
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('dater_writer', pathlib.Path(__file__).with_name('date-and-text.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class BlockingStream:
    """A pipe whose reader is stalled until `release` is set."""

    def __init__(self):
        self.release = threading.Event()
        self.lines = []
        self.flushes = 0

    def write(self, line):
        self.release.wait()
        self.lines.append(line)

    def flush(self):
        self.flushes += 1


class BrokenStream:
    def write(self, line):
        raise BrokenPipeError()

    def flush(self):
        pass


class StdoutWriter(unittest.TestCase):
    def test_a_stalled_reader_does_not_block_queued_lines(self):
        stream = BlockingStream()
        writer = d._StdoutWriter(stream)
        start = time.monotonic()
        for index in range(100):
            writer.put(f'{index}\n')
        self.assertLess(time.monotonic() - start, .5)
        waited = threading.Event()
        def wait_for_write():
            writer.put('capture\n', wait=True)
            waited.set()
        thread = threading.Thread(target=wait_for_write)
        thread.start()
        self.assertFalse(waited.wait(.2), 'wait=True must block until the line is written')
        stream.release.set()
        self.assertTrue(waited.wait(5))
        thread.join()
        writer.put('result\n')
        writer.close()
        self.assertEqual(stream.lines, [f'{i}\n' for i in range(100)] + ['capture\n', 'result\n'])
        self.assertGreaterEqual(stream.flushes, 2)

    def test_broken_pipe_releases_waiters_and_later_writes_fail(self):
        writer = d._StdoutWriter(BrokenStream())
        with self.assertRaises(BrokenPipeError):
            writer.put('x\n', wait=True)
        with self.assertRaises(BrokenPipeError):
            writer.put('y\n')
        writer.close()

    def test_request_loop_reads_while_stdout_is_not_drained(self):
        # A real helper: nobody reads its stdout until every request line has been sent.
        import json, os, subprocess, sys
        env = {k: v for k, v in os.environ.items() if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy')}
        env.update(JINA_READER='0', FABENCH_CONTENT_POLICY='', FETCH_CONCURRENCY='2', FABENCH_BROWSER_FALLBACK='0',
                   no_proxy='*', NO_PROXY='*')
        process = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).with_name('date-and-text.py'))],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
        try:
            # Unroutable URLs fail fast without network; each request emits timing lines.
            lines = ''.join(json.dumps({'id': i, 'urls': ['http://127.0.0.1:9/x'],
                                        'timing': {'traceId': 't', 'spanId': str(i), 'pad': 'p' * 4000}}) + '\n'
                            for i in range(300)).encode()
            done = threading.Event()
            def send():
                process.stdin.write(lines)
                process.stdin.close()
                done.set()
            sender = threading.Thread(target=send, daemon=True)
            sender.start()
            # About 1.2 MB of requests and more of replies; a blocked read loop would stall here.
            self.assertTrue(done.wait(20), 'the helper stopped reading while stdout was full')
            out = process.stdout.read()
            replies = [json.loads(line) for line in out.splitlines() if b'"results"' in line]
            self.assertEqual(len(replies), 300)
        finally:
            process.kill()
            process.wait()
            process.stdout.close()


if __name__ == '__main__':
    unittest.main()
