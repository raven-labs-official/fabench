/** Readable plain text from historical wikitext, converted locally and deterministically.
 *
 * Rendering through the Wikipedia API would expand today's templates into an old revision,
 * so it is never used. Templates are dropped except a short list whose visible text is plain
 * (dates, conversions, flags with names); infobox fields become "field: value" lines placed
 * after the lead; tables become one line per row. The output starts with the article's own
 * short description and lead, which is what a reader needs from a preview.
 */
export const WIKI_PLAIN_TEXT_POLICY = 'wikitext-plain-v1';

const TAIL_SECTIONS = /^(references|external links|see also|further reading|notes|citations|sources|bibliography|footnotes|notes and references)$/i;
const SKIP_INFOBOX_FIELDS = /^(image|image_?size|image_?upright|alt|caption|logo|logo_?size|logo_?alt|logo_?caption|map|map_?image|map_?caption|map_?size|pushpin_.*|signature|signature_?alt|module\d*|embed|child|footnotes|website|url|coordinates|coords|onlysourced)$/i;
const ENTITIES: Record<string, string> = { nbsp: ' ', ndash: '–', mdash: '—', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", minus: '−', times: '×', thinsp: ' ', hairsp: ' ', zwj: '', zwnj: '' };

/** Splits a template or link body on top-level `|`, ignoring pipes inside nested markup. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; i++; } else if ((two === '}}' || two === ']]') && depth > 0) { depth--; i++; }
    else if (s[i] === '|' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Index just past the `}}` (or `]]`) closing the construct opened at `at`, or -1. */
function closing(s: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < s.length - 1; i++) {
    if (s[i] === open[0] && s[i + 1] === open[1]) { depth++; i++; }
    else if (s[i] === close[0] && s[i + 1] === close[1]) { depth--; i++; if (depth === 0) return i + 1; }
  }
  return -1;
}

const positional = (args: string[]) => args.filter(a => !/^\s*[\w -]+\s*=/.test(a)).map(a => a.trim());

function inlineTemplate(name: string, args: string[]): string | null {
  const p = positional(args);
  switch (name) {
    case 'nowrap': case 'nobr': case 'small': case 'big': case 'smaller': case 'larger': case 'nbsp': case 'lang-en':
      return p[0] ?? '';
    case 'lang': return p[1] ?? '';
    case 'abbr': case 'nihongo': case 'ill': case 'interlanguage link': case 'interlanguage link multi': case 'not a typo': case 'sic':
      return p[0] ?? '';
    case 'sortname': return [p[0], p[1]].filter(Boolean).join(' ');
    case 'convert': case 'cvt': return [p[0], p[1]].filter(Boolean).join(' ');
    case 'flag': case 'flagcountry': case 'flag country': case 'flagu': return p[0] ?? '';
    case 'circa': case 'c.': return p[0] ? `c. ${p[0]}` : 'c.';
    case 'as of': return `As of ${p.join(' ')}`.trim();
    case 'start date': case 'end date': case 'birth date': case 'death date': case 'start date and age': case 'birth date and age':
    case 'death date and age': case 'film date': case 'dts':
      return p.filter(x => /^\d{1,4}$/.test(x)).slice(0, 3).join('-');
    case 'percentage': return p[0] && p[1] ? `${p[0]}/${p[1]}` : '';
    case 'ubl': case 'unbulleted list': case 'plainlist': case 'flatlist': case 'hlist': case 'plain list':
      return p.join('; ');
    case 'efn': case 'sfn': case 'refn': case 'efn-ua': case 'efn-lr': case 'citation needed': case 'cn': case 'clarify': case 'when':
    case 'update needed': case 'dead link': case 'main': case 'see also': case 'further': case 'for': case 'about': case 'redirect':
    case 'distinguish': case 'use dmy dates': case 'use mdy dates': case 'use british english': case 'use american english':
    case 'good article': case 'featured article': case 'pp-vandalism': case 'pp-semi-indef': case 'pp': case 'toc limit': case 'reflist':
    case 'flagicon': case 'flag icon': case 'dagger': case 'ref label': case 'note label':
      return '';
    default: return null;
  }
}

/** Medal tables keep their numbers in template fields (gold_AUS = 67); one line per team,
 * ordered by gold, silver, bronze as the rendered table is. */
function medalsTable(args: string[]): string {
  const teams = new Map<string, { gold: number; silver: number; bronze: number }>();
  for (const arg of args) {
    const m = /^\s*(gold|silver|bronze)_([A-Za-z0-9]+)\s*=\s*(\d+)\s*$/.exec(arg);
    if (!m) continue;
    const t = teams.get(m[2]!) ?? { gold: 0, silver: 0, bronze: 0 };
    t[m[1] as 'gold' | 'silver' | 'bronze'] = Number(m[3]); teams.set(m[2]!, t);
  }
  return [...teams].sort(([a, x], [b, y]) => y.gold - x.gold || y.silver - x.silver || y.bronze - x.bronze || (a < b ? -1 : 1))
    .map(([team, t]) => `${team} | gold ${t.gold} | silver ${t.silver} | bronze ${t.bronze} | total ${t.gold + t.silver + t.bronze}`).join('\n');
}

/** Replaces templates with their plain text; collects infobox fields and the short description. */
function expandTemplates(s: string, collected: { infobox: string[]; short: string[] }, depth = 0): string {
  let out = '', i = 0;
  while (i < s.length) {
    const at = s.indexOf('{{', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    const end = closing(s, at, '{{', '}}');
    if (end < 0) { break; } // An unterminated template hides the rest, as MediaWiki would render it unreadably.
    const inner = s.slice(at + 2, end - 2);
    const [rawName = '', ...args] = splitTopLevel(inner);
    const name = rawName.replace(/^\s*(template:)?/i, '').replace(/_/g, ' ').trim().toLowerCase();
    if (name === 'short description') { const text = args[0]?.trim(); if (depth === 0 && text && text.toLowerCase() !== 'none') collected.short.push(text); }
    else if (name.startsWith('infobox') && depth === 0) {
      for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq < 0) continue;
        const key = arg.slice(0, eq).trim(), value = plainInline(arg.slice(eq + 1), collected, depth + 1);
        if (key && value && !SKIP_INFOBOX_FIELDS.test(key)) collected.infobox.push(`${key.replace(/_/g, ' ')}: ${value}`);
      }
    } else if (name === 'medals table' || name === 'medal table') {
      out += `\n${medalsTable(args)}\n`;
    } else if (!name.startsWith('cite') && !name.startsWith('infobox') && !name.startsWith('navbox') && !name.startsWith('sidebar')) {
      const text = inlineTemplate(name, args);
      if (text) out += expandTemplates(text, collected, depth + 1);
    }
    i = end;
  }
  return out;
}

function stripLinks(s: string): string {
  let out = '', i = 0;
  while (i < s.length) {
    const at = s.indexOf('[[', i);
    if (at < 0) { out += s.slice(i); break; }
    out += s.slice(i, at);
    const end = closing(s, at, '[[', ']]');
    if (end < 0) { out += s.slice(at); break; }
    const parts = splitTopLevel(s.slice(at + 2, end - 2));
    const target = (parts[0] ?? '').trim();
    if (!/^:?(file|image|category|media|[a-z]{2,3}(-[a-z]+)?):/i.test(target) || /^:category:/i.test(target))
      out += stripLinks(parts.length > 1 ? parts[parts.length - 1]! : target.replace(/^:/, '').split('#')[0]!);
    i = end;
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function plainInline(s: string, collected: { infobox: string[]; short: string[] }, depth = 0): string {
  let t = expandTemplates(s, collected, depth);
  t = stripLinks(t);
  t = t.replace(/\[(?:https?:)?\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1').replace(/\[(?:https?:)?\/\/[^\]]+\]/g, '');
  t = t.replace(/'''''|'''|''/g, '');
  t = t.replace(/<br\s*\/?>/gi, '; ').replace(/<[^>]+>/g, '');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

/** One line per table row; cells joined with " | ". */
function tableLines(lines: string[]): string[] {
  const out: string[] = []; let row: string[] = [];
  const flush = () => { const cells = row.filter(Boolean); if (cells.length) out.push(cells.join(' | ')); row = []; };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('{|')) continue;
    if (t.startsWith('|}')) { flush(); continue; }
    if (t.startsWith('|-')) { flush(); continue; }
    if (t.startsWith('|+')) { const caption = t.slice(2).trim(); if (caption) out.push(caption); continue; }
    if (t.startsWith('!') || t.startsWith('|')) {
      for (const cell of t.slice(1).split(/!!|\|\|/)) {
        const parts = splitTopLevel(cell);
        // "attributes | content": keep the content; a cell may also carry no attributes.
        const content = parts.length > 1 && /=/.test(parts[0]!) && !/\[\[|\{\{/.test(parts[0]!) ? parts.slice(1).join('|') : cell;
        row.push(content.trim());
      }
    } else if (t) row.push(t);
  }
  flush();
  return out;
}

export function wikitextToPlain(source: string): string {
  const collected = { infobox: [] as string[], short: [] as string[] };
  let s = source.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<ref\b[^>/]*\/>/gi, '').replace(/<ref\b[^>]*>[\s\S]*?(?:<\/ref\s*>|$)/gi, '')
    .replace(/<(gallery|timeline|mapframe|graph|score|templatedata)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/__[A-Z]+__/g, '');
  s = expandTemplates(s, collected);
  const blocks: string[] = []; let lead = true, cut = false;
  const lines = s.split('\n');
  for (let i = 0; i < lines.length && !cut; i++) {
    const line = lines[i]!;
    const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line.trim());
    if (heading) {
      const title = plainInline(heading[2]!, collected);
      if (TAIL_SECTIONS.test(title)) { cut = true; break; }
      if (lead) { blocks.push('\u0000INFOBOX'); lead = false; }
      blocks.push(`\n${title}`); continue;
    }
    if (line.trim().startsWith('{|')) {
      const table: string[] = [];
      let depth = 0;
      for (; i < lines.length; i++) {
        const t = lines[i]!.trim();
        if (t.startsWith('{|')) depth++;
        table.push(lines[i]!);
        if (t.startsWith('|}') && --depth === 0) break;
      }
      for (const row of tableLines(table)) { const text = plainInline(row, collected); if (text) blocks.push(text); }
      continue;
    }
    const listed = /^[*#:;]+\s*/.exec(line);
    const text = plainInline(listed ? line.slice(listed[0].length) : line, collected);
    if (text) blocks.push(listed ? `- ${text}` : text);
    else if (blocks.length && blocks[blocks.length - 1] !== '') blocks.push('');
  }
  if (lead) blocks.push('\u0000INFOBOX');
  const infobox = collected.infobox.length ? collected.infobox.join('\n') : '';
  const body = blocks.map(b => b === '\u0000INFOBOX' ? (infobox ? `\n${infobox}\n` : '') : b).join('\n');
  const short = collected.short.length ? `${collected.short[0]}\n\n` : '';
  return (short + body).replace(/\n{3,}/g, '\n\n').trim();
}
