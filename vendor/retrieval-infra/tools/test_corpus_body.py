import hashlib
import sqlite3
import sys
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from corpus_body import decode_body, install_body_view, load_dictionaries  # noqa: E402

DICTIONARY = b'Subscribe to our newsletter for the latest updates. All rights reserved. ' * 20


def encode(text, dict_id=1):
    deflater = zlib.compressobj(9, zlib.DEFLATED, -15, 9, zlib.Z_DEFAULT_STRATEGY, DICTIONARY)
    return b'RB\x01' + dict_id.to_bytes(4, 'big') + deflater.compress(text.encode()) + deflater.flush()


class CorpusBodyTest(unittest.TestCase):
    def corpus(self):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE docs (id INTEGER PRIMARY KEY, url TEXT, title TEXT, body TEXT, crawl_date TEXT, crawl_ms INTEGER, wire TEXT, source TEXT)')
        conn.execute('CREATE TABLE corpus_body_dictionaries (id INTEGER PRIMARY KEY, codec INTEGER, sha256 TEXT, dictionary BLOB, created_at TEXT)')
        conn.execute('INSERT INTO corpus_body_dictionaries VALUES (1, 1, ?, ?, ?)', (hashlib.sha256(DICTIONARY).hexdigest(), DICTIONARY, 'now'))
        return conn

    def test_plain_text_and_blobs_decode_to_the_original(self):
        conn = self.corpus()
        dictionaries = load_dictionaries(conn)
        text = 'Report: café 中文 — Subscribe to our newsletter for the latest updates.'
        self.assertEqual(decode_body(encode(text), dictionaries), text)
        self.assertEqual(decode_body('plain', {}), 'plain')
        with self.assertRaises(ValueError):
            decode_body(encode(text, 2), dictionaries)

    def test_view_returns_decoded_bodies_for_unqualified_docs(self):
        conn = self.corpus()
        conn.execute('INSERT INTO docs VALUES (1, "u", "t", ?, "d", 1, NULL, "ccnews")', (encode('hello world'),))
        self.assertTrue(install_body_view(conn))
        self.assertEqual(conn.execute('SELECT body FROM docs WHERE id=1').fetchone()[0], 'hello world')

    def test_dictionary_hash_is_checked(self):
        conn = self.corpus()
        conn.execute("UPDATE corpus_body_dictionaries SET sha256='bad'")
        with self.assertRaises(ValueError):
            load_dictionaries(conn)


if __name__ == '__main__':
    unittest.main()
