"""Main-content extraction with inspectable DOM blocks. No network or time filtering."""
import collections
import gzip
import hashlib
import logging
import os
from pathlib import Path
import re
import tempfile
from lxml import html as lh, etree
import trafilatura
from trafilatura.metadata import examine_meta, extract_meta_json, extract_title

POLICY = 'article-blocks-tables-v1'


def article_title(tree):
    """Use the pinned Trafilatura title cascade, without unrelated metadata work.

    extract_metadata also guesses dates from free text and tables. Its date was
    never used here: the page helper separately extracts publication/modification
    dates with extensive_search=False. Keep the same meta/JSON-LD/DOM precedence
    and final normalization, without invoking that unused extensive date search.
    """
    metadata = examine_meta(tree)
    try:
        metadata = extract_meta_json(tree, metadata)
    except Exception as error:
        logging.getLogger(__name__).warning('error in JSON metadata extraction: %s', error)
    if not metadata.title:
        metadata.title = extract_title(tree)
    metadata.clean_and_trim()
    return metadata.title


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def archive_capture(raw: bytes, directory: str, kind: str, truncated=False):
    if not directory:
        raise ValueError('article extraction requires a raw capture directory')
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True, mode=0o2750)
    sha = digest(raw)
    target = root / (sha + '.bin.gz')
    if not target.exists():
        fd, tmp = tempfile.mkstemp(prefix='.raw-', dir=root)
        try:
            os.fchmod(fd, 0o640)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(gzip.compress(raw, mtime=0))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
    return dict(sha256=sha, bytes=len(raw), path=str(target.resolve()), kind=kind, truncated=truncated)


def text_of(node):
    return re.sub(r'\s+', ' ', ' '.join(node.itertext())).strip()


class ForwardText:
    """Substring tests against the selected text, starting where the previous match was found.

    Blocks are visited in document order and usually appear in that order in the selected
    text, so a forward search is short. A value not found ahead is looked up in the whole
    text, so the answer is always the same as `value in text`; only the work changes. A plain
    `in` rescanned megabytes for each of 100,000 paragraphs on one flat page.
    """
    def __init__(self, text):
        self.text = text
        self.cursor = 0

    def __contains__(self, value):
        found = self.text.find(value, self.cursor)
        if found < 0:
            found = self.text.find(value)
        if found < 0:
            return False
        self.cursor = found
        return True


def selected_text_contains(node, selected):
    # DOM block rendering inserts spaces between text nodes. Trafilatura can keep
    # inline links/superscripts attached to punctuation, so also compare the source
    # text-node concatenation. Preserve authored whitespace and the rendered body.
    return text_of(node) in selected or re.sub(r'\s+', ' ', ''.join(node.itertext())).strip() in selected


def unusable_reason(text):
    # Only characteristic interstitial headings, not any article discussing these words.
    start = text.strip()[:500]
    if re.match(r'(?is)^(?:title:\s*)?(?:pardon our interruption|just a moment|access denied|verify (?:you are|that you are) human|checking your browser|enable javascript and cookies)', start):
        return 'challenge-page'
    # A short standalone error message preceded only by linked site navigation.
    # Keep articles that discuss errors: prose before/after the heading prevents
    # this interstitial classification. No domain-specific whitelist is used.
    error = re.search(r'(?im)^\s*(?:#{1,6}\s*)?(?:404(?: error)?|page not found|(?:please be advised that )?this page is unavailable)\.?\s*$', text)
    if error:
        prefix = re.sub(r'!?\[[^\]\n]*\]\([^\)\n]*\)', '', text[:error.start()])
        prefix = re.sub(r'[\s*#_\[\]()>-]+', ' ', prefix).strip()
        suffix = text[error.end():]
        if len(prefix) < 100 and len(suffix) < 700:
            return 'error-page'
    if len(text.strip()) < 80:
        return 'insufficient-content'
    if len(text) < 700 and re.match(r'(?is)^(?:log in|sign in|login)(?:\s|$)', start):
        return 'login-page'
    return None


def table_content(table):
    cells, grid = [], {}
    all_rows = table.xpath('.//tr[not(ancestor::table[2])]')
    rows = all_rows[:256]
    truncated = len(all_rows) > 256
    for r, row in enumerate(rows):
        col = 0
        all_cells = row.xpath('./th|./td')
        truncated |= len(all_cells) > 128
        for cell in all_cells[:128]:
            while (r, col) in grid: col += 1
            def span(name):
                try: return max(1, min(128, int(cell.get(name, '1'))))
                except ValueError: return 1
            rs, cs = span('rowspan'), span('colspan')
            truncated |= r + rs > 256 or col + cs > 128
            value = text_of(cell)
            cells.append(dict(row=r, column=col, rowspan=rs, colspan=cs,
                              header=cell.tag == 'th', text=value))
            for rr in range(r, min(256, r + rs)):
                for cc in range(col, min(128, col + cs)): grid[rr, cc] = value
            col += cs
    width = max((c for _, c in grid), default=-1) + 1
    height = max((r for r, _ in grid), default=-1) + 1
    matrix = [[grid.get((r, c), '') for c in range(width)] for r in range(height)]
    # Render a spanning cell once. Keep the expanded grid and spans separately for audit.
    origins = {(cell['row'], cell['column']): cell['text'] for cell in cells}
    rendered_rows = [[origins.get((r, c), '') for c in range(width)] for r in range(height)]
    lines = ['| ' + ' | '.join(v.replace('|', '\\|') for v in row) + ' |' for row in rendered_rows]
    if lines: lines.insert(1, '| ' + ' | '.join(['---'] * width) + ' |')
    caption = ' '.join(text_of(n) for n in table.xpath('./caption'))
    return dict(cells=cells, caption=caption, truncated=truncated, html=etree.tostring(table, encoding='unicode', method='html'),
                matrix=matrix), '\n'.join(([caption] if caption else []) + lines)


def element_paths(tree):
    """XPath of every element in lxml's getpath format, computed in one pass.

    getpath counts same-name siblings on every call, so a page with 100,000 sibling
    paragraphs took minutes and stalled the page helper. Here each parent counts its
    element children once: a child gets `tag[k]` when the parent has several children
    with that tag, otherwise just `tag`. Comments and processing instructions do not
    count, as in libxml2. Namespaced trees keep the library implementation.
    """
    document = tree.getroottree()
    top = document.getroot()
    if any(isinstance(node.tag, str) and node.tag.startswith('{') for node in top.iter()):
        return {node: document.getpath(node) for node in tree.iter() if isinstance(node.tag, str)}
    # A malformed page can leave several top-level elements; the root is then indexed too.
    roots = [node for node in (*top.itersiblings(preceding=True), *top.itersiblings()) if node.tag == top.tag]
    before = sum(1 for node in top.itersiblings(preceding=True) if node.tag == top.tag)
    paths = {top: f'/{top.tag}[{before + 1}]' if roots else '/' + top.tag}
    stack = [top]
    while stack:
        parent = stack.pop()
        children = [child for child in parent if isinstance(child.tag, str)]
        totals = collections.Counter(child.tag for child in children)
        seen = collections.Counter()
        for child in children:
            seen[child.tag] += 1
            step = f'{child.tag}[{seen[child.tag]}]' if totals[child.tag] > 1 else child.tag
            paths[child] = f'{paths[parent]}/{step}'
            stack.append(child)
    return paths


def extract_article(raw: bytes, url: str):
    tree = lh.fromstring(raw)
    title_metadata = article_title(tree)
    paths = element_paths(tree)
    excluded = []
    # Source-independent structural rules. Notes/sidebars inside the article stay by default.
    candidates = tree.xpath('//article|//*[@itemprop="articleBody"]') or tree.xpath('//main')
    root = max(candidates, key=lambda n: len(text_of(n))) if candidates else tree
    for node in list(tree.iter()):
        if not isinstance(node.tag, str) or node.getparent() is None: continue
        label = ' '.join([node.get('class', ''), node.get('id', ''), node.get('role', '')]).lower()
        explicit = node.tag in ('script', 'style', 'noscript', 'template', 'nav') or node.get('role') in ('navigation', 'banner')
        furniture = bool(re.search(r'(?:^|[\s_-])(?:advertisement|advert|ad|ads|cookie-banner|cookie-consent|related-articles|recommended-stories|social-share)(?:$|[\s_-])', label))
        outside_footer = node.tag in ('aside', 'footer') and root not in node.iterancestors() and node is not root
        if (explicit or furniture or outside_footer) and node is not root:
            value = text_of(node)
            excluded.append(dict(xpath=paths.get(node), text=value, sha256=digest(value), reason='structural-furniture'))
            node.drop_tree()
    selected = None
    method = 'explicit-main'
    if not candidates:
        # Trafilatura selects likely main text when semantic HTML containers are absent.
        selected = trafilatura.extract(tree, url=url, output_format='txt', include_tables=True,
                                        include_comments=False, favor_precision=True) or ''
        selected = re.sub(r'\s+', ' ', selected)
        method = 'trafilatura-aligned-dom'
    forward = ForwardText(selected) if selected is not None else None
    blocks, tables = [], []
    block_tags = {'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'blockquote', 'figcaption', 'table'}
    # Publication/byline timestamps are often inline spans rather than paragraphs.
    # Keep their visible text inside the selected main container, with the original
    # DOM position. Do not manufacture text from datetime attributes or metadata.
    def time_annotation(node):
        label = ' '.join([node.get('class', ''), node.get('itemprop', '')]).lower()
        marked = node.tag == 'time' or node.get('itemprop') in ('datePublished','dateModified') or re.search(r'(?:^|[\s_-])(?:date|published|updated)(?:$|[\s_-])', label)
        if not marked: return False
        value = text_of(node)
        return bool(marked and 0 < len(value) <= 160 and re.search(r'(?:\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b)', value, re.I))
    annotations = {node for node in root.iter() if isinstance(node.tag,str) and time_annotation(node)} if candidates else set()
    annotations = {node for node in annotations if not any(child in annotations for child in node.iterdescendants())}
    for node in root.iter():
        if node.tag not in block_tags and node not in annotations: continue
        if any(a.tag in block_tags for a in node.iterancestors() if a is not root): continue
        value = text_of(node)
        if not value: continue
        if selected is not None and node.tag != 'table' and not selected_text_contains(node, forward):
            excluded.append(dict(xpath=paths.get(node), text=value, sha256=digest(value), reason='outside-extracted-main'))
            continue
        kind = 'table' if node.tag == 'table' else ('heading' if re.fullmatch('h[1-6]', node.tag) else ('article-time' if node in annotations else 'paragraph'))
        metadata = None
        if kind == 'table':
            # Do not append every page table to Trafilatura's main text.
            if selected is not None and not any(selected_text_contains(c, selected) for c in node.xpath('.//td|.//th') if len(text_of(c)) >= 12): continue
            metadata, rendered = table_content(node)
            if not metadata['cells']: continue
        else:
            rendered = ('#' * int(node.tag[1]) + ' ' if kind == 'heading' else '') + value
        block = dict(id=f'b{len(blocks)}', kind=kind, xpath=paths.get(node), text=value,
                     sha256=digest(value), rendered=rendered)
        if metadata is not None:
            block['table'] = metadata
            tables.append(block['id'])
        blocks.append(block)
    if not blocks and selected and selected.strip():
        blocks = [dict(id='b0', kind='paragraph', xpath=None, text=selected.strip(),
                       sha256=digest(selected.strip()), rendered=selected.strip())]
        method = 'trafilatura-text-unmapped'
    body = ''
    for block in blocks:
        if body: body += '\n\n'
        block['start'] = len(body)
        body += block.pop('rendered')
        block['end'] = len(body)
    reason = unusable_reason(text_of(root)) or unusable_reason(body)
    title_nodes = root.xpath('.//h1')
    title = title_metadata or (text_of(title_nodes[0]) if title_nodes else '')
    return body, dict(policy=POLICY, extraction_revision='article-time-blocks-v2', extractor=method, trafilatura_version=trafilatura.__version__,
                     title=title, body_sha256=digest(body), blocks=blocks, table_blocks=tables,
                     excluded=excluded, usable=reason is None, unusable_reason=reason,
                     complete=not any(b.get('table', {}).get('truncated') for b in blocks), source_format='html', offset_unit='unicode-codepoints')


def reader_document(text: str):
    reason = unusable_reason(text)
    return dict(policy=POLICY, extractor='reader-output', body_sha256=digest(text), blocks=[],
                table_blocks=[], excluded=[], usable=reason is None, unusable_reason=reason,
                complete=reason is None, content_scope='unavailable' if reason else 'captured-text', extraction_revision='reader-error-pages-v2', source_format='reader-markdown', offset_unit='unicode-codepoints')
