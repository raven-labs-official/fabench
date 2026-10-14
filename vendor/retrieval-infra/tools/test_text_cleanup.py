import importlib.util
import pathlib
import unittest
from unittest.mock import patch,MagicMock
from contextlib import nullcontext

spec=importlib.util.spec_from_file_location('dater',pathlib.Path(__file__).with_name('date-and-text.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)

class Cleanup(unittest.TestCase):
    def test_binary_payload_cannot_push_a_readable_future_fact_outside_review(self):
        body='Earlier context ![Chart description](data:image/png;base64,'+'A'*50000+') Later completed result on September 4, 2026.'
        out={};d.set_text(out,body)
        self.assertIn('Chart description',out['text'])
        self.assertIn('Later completed result',out['text'])
        self.assertEqual(out['text_extraction']['inline_media_removed'],1)
        self.assertFalse(out['text_extraction']['truncated'])

    def test_ordinary_text_urls_and_limits_are_preserved(self):
        body='Scheduled September 4. https://example.test/chart?q=QUJDRA== Score 3-1. '
        out={};d.set_text(out,body,20)
        self.assertEqual(out['text'],body[:20])
        self.assertTrue(out['text_extraction']['truncated'])
        self.assertEqual(out['text_extraction']['inline_media_removed'],0)

    def test_undated_reader_body_is_available_to_the_callers_date_policy(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=b'Title: Schedule\nMarkdown Content:\nThe event is scheduled for September 4.'
        with patch.object(d,'reader_slot',lambda:nullcontext()),patch.object(d,'open_response',return_value=response):
            out=d.via_reader('https://example.test/schedule',{'why':'HTTP 403','date':None,'text':''})
        self.assertIsNone(out['date'])
        self.assertEqual(out['text'],'The event is scheduled for September 4.')
        self.assertEqual(out['source'],'reader')

    def test_empty_reader_does_not_erase_a_successful_direct_fetch(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=b'Title: Empty\nMarkdown Content:\n '
        before={'why':'no date in page','date':None,'text':'Useful direct article.','title':'Original','source':'direct'}
        with patch.object(d,'reader_slot',lambda:nullcontext()),patch.object(d,'open_response',return_value=response):
            out=d.via_reader('https://example.test/schedule',before)
        self.assertEqual(out['text'],'Useful direct article.')
        self.assertEqual(out['source'],'direct')
        self.assertEqual(out['title'],'Original')

    def test_html_cleanup_preserves_tables_and_ancillary_facts(self):
        html = '<html><head><style>' + 'a{font-family:x}' * 5000 + '</style></head><body><p>Old article.</p><table><tr><td>Future score</td><td>3-1</td></tr></table><aside>New report on September 4, 2026.</aside></body></html>'
        text = d.text_of(html)
        self.assertIn('Future score 3-1', text)
        self.assertIn('New report on September 4, 2026.', text)
        self.assertNotIn('font-family', text)

    def test_unclosed_style_tail_and_empty_response_are_not_article_text(self):
        self.assertEqual(d.text_of('<html><body><p>Readable article</p><style>a{color:red}'), 'Readable article')
        self.assertEqual(d.text_of(''), '')

    def test_pdf_binary_is_not_dated_or_served_when_reader_is_disabled(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'%PDF-1.6 /CreationDate (D:20260101) stream compressed bytes'
        response.__enter__.return_value.headers = {'Content-Type': 'application/octet-stream'}
        with patch.object(d, 'READER_ON', False), patch.object(d, 'open_response', return_value=response), patch.object(d, 'find_date') as find:
            out = d.one('https://example.test/file')
        find.assert_not_called()
        self.assertEqual(out['text'], '')
        self.assertIsNone(out['date'])
        self.assertIn('PDF requires text extraction', out['why'])

    def test_pdf_uses_configured_reader_even_with_embedded_date_metadata(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'%PDF-1.6 /CreationDate (D:20260101) stream compressed bytes'
        response.__enter__.return_value.headers = {'Content-Type': 'application/pdf'}
        def reader(url, out):
            out.update(text='June report. Household consumption increased 0.2 percent.', source='reader')
            return out
        with patch.object(d, 'READER_ON', True), patch.object(d, 'open_response', return_value=response), patch.object(d, 'via_reader', side_effect=reader) as fallback:
            out = d.one('https://example.test/file.pdf')
        fallback.assert_called_once()
        self.assertIn('Household consumption', out['text'])
        self.assertIsNone(out['date'])
        self.assertNotIn('%PDF', out['text'])

    def test_truncated_dated_html_tries_reader_and_keeps_direct_text_on_failure(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'<p>Known clean article.</p><style>' + b'a' * (3 * 1024 * 1024)
        response.__enter__.return_value.headers = {'Content-Type': 'text/html'}
        with patch.object(d, 'READER_ON', True), patch.object(d, 'open_response', return_value=response), patch.object(d, 'find_date', return_value='2026-01-01'), patch.object(d, 'via_reader', side_effect=lambda url, out: out) as fallback:
            out = d.one('https://example.test/article')
        fallback.assert_called_once()
        self.assertTrue(out['response_truncated'])
        self.assertEqual(out['text'], 'Known clean article.')
        self.assertEqual(out['date'], '2026-01-01')

if __name__=='__main__':unittest.main()
