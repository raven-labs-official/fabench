import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import time
from lxml import html as lh
from article_content import ForwardText, element_paths, extract_article, archive_capture, digest, reader_document


class ArticleContentTest(unittest.TestCase):
    def test_actual_met_office_tables_preserve_pre_fix_output(self):
        directory = Path(__file__).resolve().parent / 'fixtures' / 'met-office-extraction'
        for record in json.loads((directory / 'manifest.json').read_text()):
            with self.subTest(url=record['url']):
                raw = gzip.decompress((directory / record['file']).read_bytes())
                self.assertEqual(digest(raw), record['raw_sha256'])
                body, document = extract_article(raw, record['url'])
                self.assertEqual(document['title'], record['title'])
                self.assertEqual(digest(body), record['body_sha256'])
                self.assertEqual(len(body), record['body_chars'])
                self.assertEqual(len(document['table_blocks']), record['table_blocks'])
                self.assertTrue(document['usable'])
                self.assertTrue(document['complete'])

    def test_reader_error_interstitial_is_not_an_article(self):
        page = '[Home](https://example.org/)\n\n[Products](https://example.org/products)\n\n## 404 Error\n\nThis page does not exist. Try the homepage.'
        meta = reader_document(page)
        self.assertFalse(meta['usable'])
        self.assertFalse(meta['complete'])
        self.assertEqual(meta['unusable_reason'], 'error-page')
        article = '## 404 Error\n\n' + 'This technical reference explains HTTP errors and their causes with examples. ' * 15
        self.assertTrue(reader_document(article)['usable'])

    def test_page_title_survives_a_table_as_the_last_block(self):
        raw = b'<html><head><meta property="og:title" content="Fictional annual results"></head><body><article><h1>Release details</h1><p>The fictional agency explains these annual observations in points and describes the reporting period.</p><table><tr><th>Period</th><th>Value</th></tr><tr><td>2025</td><td>12</td></tr></table></article></body></html>'
        _, meta = extract_article(raw, 'https://example.org/results')
        self.assertEqual(meta['title'], 'Fictional annual results')

    def test_advertising_changes_do_not_change_retained_article(self):
        template = '<html><body><nav>{advert}</nav><article><h1>Synthetic report</h1><p>The agency described an observation and explained its measurement methodology in detail for readers.</p><aside><p>Note: preliminary observations use a different instrument.</p></aside></article><footer>{advert}</footer></body></html>'
        old, a = extract_article(template.format(advert='Old promotion').encode(), 'https://example.org/a')
        new, b = extract_article(template.format(advert='New market widget 2026-09-10 95 percent').encode(), 'https://example.org/a')
        self.assertEqual(old, new)
        self.assertIn('preliminary observations', new)
        self.assertNotIn('95 percent', new)
        self.assertTrue(a['usable'])
        self.assertEqual(a['body_sha256'], b['body_sha256'])
        self.assertTrue(all(block['xpath'] for block in a['blocks']))

    def test_table_structure_units_and_notes_survive(self):
        raw = b'''<article><h1>Fictional financial statement</h1><p>Values are expressed in millions of dollars; this table reports the measurement periods.</p><table><caption>Annual observations</caption><tr><th rowspan="2">Measure</th><th colspan="2">Period</th></tr><tr><th>2024</th><th>2025</th></tr><tr><td>Revenue*</td><td>12.5</td><td>15.2</td></tr></table><p>* Includes provisional estimates.</p></article>'''
        text, meta = extract_article(raw, 'https://example.org/statement')
        table = next(b['table'] for b in meta['blocks'] if b['kind'] == 'table')
        self.assertEqual(table['cells'][0]['rowspan'], 2)
        self.assertEqual(table['cells'][1]['colspan'], 2)
        self.assertEqual(table['matrix'][2], ['Revenue*', '12.5', '15.2'])
        self.assertIn('millions of dollars', text)
        self.assertIn('Includes provisional estimates', text)
        for block in meta['blocks']:
            self.assertTrue(text[block['start']:block['end']])
        changed, _ = extract_article(raw.replace(b'15.2', b'19.4'), 'https://example.org/statement')
        self.assertNotEqual(digest(text), digest(changed))

    def test_financial_words_and_future_plans_are_not_cleaned_away(self):
        raw = b'<article><h1>Fictional company plan</h1><p>The company plans to invest $50 million in 2027. This plan was discussed alongside current stock prices and future risks.</p><div class="ad-slot">Buy now 999</div></article>'
        text, _ = extract_article(raw, 'https://example.org/plan')
        self.assertIn('$50 million in 2027', text)
        self.assertIn('stock prices', text)
        self.assertNotIn('Buy now', text)

    def test_challenge_pages_are_unusable_but_articles_about_captcha_are_kept(self):
        self.assertFalse(reader_document('Pardon Our Interruption ' * 30)['usable'])
        text, meta = extract_article(b'<article><h1>Research into CAPTCHA</h1><p>This research describes how CAPTCHA technology affects the collection of publicly available information across different websites.</p></article>', 'https://example.org/research')
        self.assertTrue(meta['usable'])

    def test_raw_storage_is_lossless_and_reader_is_not_labeled_origin_html(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = b'\x00\xff<html>original bytes</html>'
            record = archive_capture(raw, directory, 'origin-response')
            self.assertEqual(gzip.decompress(Path(record['path']).read_bytes()), raw)
            self.assertEqual(record['sha256'], digest(raw))
            self.assertEqual(archive_capture(raw, directory, 'origin-response')['path'], record['path'])
        self.assertEqual(reader_document('Some valid document text. ' * 20)['source_format'], 'reader-markdown')

    def test_inline_markup_does_not_drop_selected_paragraphs_or_tables(self):
        raw = b'''<html><body><div><p>The fictional agency announced a partnership with <a href="/partner">Example Labs</a>, covering its measurement programme and future reporting schedule.</p><table><tr><th>Annual <em>observations</em>, revised</th><th>Value</th></tr><tr><td>2025</td><td>15.2</td></tr></table><p>Subscribe to unrelated promotional updates.</p></div></body></html>'''
        selected = 'The fictional agency announced a partnership with Example Labs, covering its measurement programme and future reporting schedule. Annual observations, revised Value 2025 15.2'
        with patch('article_content.trafilatura.extract', return_value=selected):
            body, meta = extract_article(raw, 'https://example.org/report')
        self.assertEqual(meta['extractor'], 'trafilatura-aligned-dom')
        # Existing rendering, including its spaces, is retained after alignment.
        self.assertIn('Example Labs , covering', body)
        self.assertIn('Annual observations , revised', body)
        self.assertEqual(len(meta['table_blocks']), 1)
        self.assertNotIn('Subscribe', body)
        self.assertTrue(meta['usable'])

    def test_inline_alignment_preserves_authored_word_boundaries(self):
        raw = b'<html><body><div><p>The fictional agency describes why the labels now here and nowhere differ in meaning during analysis.</p><p>Send us further feedback.</p></div></body></html>'
        selected = 'The fictional agency describes why the labels nowhere and nowhere differ in meaning during analysis.'
        with patch('article_content.trafilatura.extract', return_value=selected):
            body, meta = extract_article(raw, 'https://example.org/report')
        self.assertNotIn('now here', body)
        self.assertTrue(any('now here' in block['text'] for block in meta['excluded']))


if __name__ == '__main__': unittest.main()


class ElementPathTest(unittest.TestCase):
    def test_paths_match_lxml_including_repeated_tags_and_comments(self):
        page = (b'<html><head><title>T</title></head><body><!-- note --><div><p>a</p><p>b<b>x</b></p>'
                b'<span>c</span><!-- c --><p>d</p></div><div><p>only</p><fb:like>e</fb:like></div>'
                b'<table><tr><td>1</td><td>2</td></tr></table></body></html>')
        tree = lh.fromstring(page)
        expected = {node: tree.getroottree().getpath(node) for node in tree.iter() if isinstance(node.tag, str)}
        self.assertEqual(element_paths(tree), expected)
        self.assertIn('/html/body/div[1]/p[2]/b', expected.values())
        self.assertIn('/html/body/div[2]/p', expected.values())
        doubled = lh.fromstring(b'<html><body><p>a</p></body></html><html><body><p>b</p></body></html>')
        reference = {node: doubled.getroottree().getpath(node) for node in doubled.iter() if isinstance(node.tag, str)}
        self.assertEqual(element_paths(doubled), reference)

    def test_a_page_with_many_sibling_paragraphs_extracts_quickly(self):
        page = b'<html><body>' + b''.join(b'<p>Paragraph %d of a long flat page.</p>' % i for i in range(60000)) + b'</body></html>'
        started = time.monotonic()
        article, document = extract_article(page, 'https://example.test/flat')
        self.assertLess(time.monotonic() - started, 60)
        self.assertTrue(article)

    def test_forward_text_gives_the_same_answers_as_plain_containment(self):
        text = 'alpha beta gamma delta alpha epsilon beta'
        forward = ForwardText(text)
        for value in ['alpha', 'gamma', 'beta', 'alpha', 'zeta', '', 'epsilon beta', 'alpha beta', 'delta']:
            self.assertEqual(value in forward, value in text, value)

