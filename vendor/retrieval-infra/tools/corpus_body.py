"""Decode CC-News article bodies stored as plain text or as compact blobs.

The blob format is defined in src/corpus/body-codec.ts: the bytes "RB", codec 1, a
big-endian uint32 dictionary id, then a raw-deflate stream compressed against that preset
dictionary, which is stored in the corpus table corpus_body_dictionaries.
"""
import hashlib
import zlib

TABLE = 'corpus_body_dictionaries'


def load_dictionaries(conn, schema='main'):
    """Return {id: dictionary bytes}; empty for a corpus that stores only plain text."""
    if not conn.execute(f"SELECT 1 FROM {schema}.sqlite_master WHERE type='table' AND name=?", (TABLE,)).fetchone():
        return {}
    dictionaries = {}
    for dict_id, codec, sha256, dictionary in conn.execute(f'SELECT id, codec, sha256, dictionary FROM {schema}.{TABLE}'):
        if codec != 1:
            raise ValueError(f'unsupported body codec {codec}')
        if hashlib.sha256(dictionary).hexdigest() != sha256:
            raise ValueError(f'body dictionary {dict_id} differs from its recorded hash')
        dictionaries[dict_id] = bytes(dictionary)
    return dictionaries


def decode_body(value, dictionaries):
    if isinstance(value, str):
        return value
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise ValueError('corpus body is neither text nor an encoded blob')
    data = bytes(value)
    if len(data) < 7 or data[:3] != b'RB\x01':
        raise ValueError('corpus body blob has an unknown encoding')
    dictionary = dictionaries.get(int.from_bytes(data[3:7], 'big'))
    if dictionary is None:
        raise ValueError('corpus body needs a missing dictionary')
    inflater = zlib.decompressobj(-15, zdict=dictionary)
    return (inflater.decompress(data[7:]) + inflater.flush()).decode('utf-8')


def install_body_view(conn, schema='main'):
    """Make unqualified `docs` return decoded bodies on this connection, like the Node store.

    Call before `PRAGMA query_only` or an explicit transaction. Returns False for a
    plain-text corpus, which needs no view.
    """
    dictionaries = load_dictionaries(conn, schema)
    if not dictionaries:
        return False
    conn.create_function('raven_corpus_body', 1, lambda value: decode_body(value, dictionaries), deterministic=True)
    conn.execute('CREATE TEMP VIEW docs AS SELECT id, url, title, raven_corpus_body(body) AS body, '
                 f'crawl_date, crawl_ms, wire, source FROM {schema}.docs')
    return True
