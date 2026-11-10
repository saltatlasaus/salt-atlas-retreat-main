// A small, forgiving HTML scanner. It does not build a DOM; it walks the tags once and
// collects what the extractors need. It is dependency-free so it runs the same in the
// Worker and in Node tests, and it is linear in the size of the page.

export type Attrs = Record<string, string>;

export interface RawImage {
  tag: string; // img | source | a | meta | link | video | css | div ...
  attrs: Attrs;
  order: number;
}

export interface RawLink {
  href: string;
  text: string;
  attrs: Attrs;
}

export interface RawDoc {
  base: string | null;
  lang: string | null;
  title: string;
  meta: Record<string, string>; // lower-cased name/property -> content (first wins)
  canonical: string | null;
  links: RawLink[];
  images: RawImage[];
  cssImages: { url: string; order: number }[];
  jsonLd: string[];
  headings: { level: number; text: string }[];
  iframes: string[];
  cfEmails: string[];
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'template']);
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  euro: '€', pound: '£', yen: '¥', copy: '©', reg: '®', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  middot: '·', bull: '•', times: '×', deg: '°', frac12: '½', eacute: 'é', aacute: 'á', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', atilde: 'ã', otilde: 'õ', agrave: 'à', egrave: 'è',
};

export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

export function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    out[name] = decodeEntities(val);
  }
  return out;
}

/** Find the '>' that closes a tag, ignoring any '>' inside quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

export function cssUrls(style: string): string[] {
  const out: string[] = [];
  CSS_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSS_URL_RE.exec(style))) out.push(decodeEntities(m[2].trim()));
  return out;
}

export function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Plain text of a whole page, keeping rough line breaks. Scripts and styles are dropped. */
export function htmlToText(html: string): string {
  const noRaw = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const withBreaks = noRaw.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|dt|dd)\b[^>]*>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function scanHtml(html: string): RawDoc {
  const doc: RawDoc = {
    base: null, lang: null, title: '', meta: {}, canonical: null, links: [], images: [], cssImages: [],
    jsonLd: [], headings: [], iframes: [], cfEmails: [],
  };
  const openA: { attrs: Attrs; start: number }[] = [];
  const openH: { level: number; start: number }[] = [];
  let order = 0;
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt + 2);
      const name = html.slice(lt + 2, end < 0 ? n : end).trim().toLowerCase();
      if (name === 'a' && openA.length) {
        const a = openA.pop()!;
        pushLink(doc, a.attrs, stripTags(html.slice(a.start, lt)));
      } else if (/^h[1-6]$/.test(name) && openH.length) {
        const h = openH.pop()!;
        const text = stripTags(html.slice(h.start, lt));
        if (text) doc.headings.push({ level: h.level, text: text.slice(0, 200) });
      }
      i = end < 0 ? n : end + 1;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64));
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const end = tagEnd(html, lt + nameMatch[0].length);
    if (end < 0) break;
    const attrs = parseAttrs(html.slice(lt + nameMatch[0].length, end).replace(/\/\s*$/, ''));
    i = end + 1;

    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf('</' + name, i);
      const inner = html.slice(i, close < 0 ? n : close);
      if (name === 'title' && !doc.title) doc.title = stripTags(inner).slice(0, 300);
      if (name === 'script' && /ld\+json/i.test(attrs.type || '')) doc.jsonLd.push(inner.trim());
      const closeEnd = close < 0 ? n : html.indexOf('>', close);
      i = closeEnd < 0 ? n : closeEnd + 1;
      continue;
    }

    if (attrs.style && /url\(/i.test(attrs.style)) {
      for (const u of cssUrls(attrs.style)) doc.cssImages.push({ url: u, order: order++ });
    }
    if (attrs['data-cfemail']) doc.cfEmails.push(attrs['data-cfemail']);
    for (const k of ['data-bg', 'data-background', 'data-background-image', 'data-bg-src', 'data-bgset']) {
      if (attrs[k] && name !== 'img') doc.images.push({ tag: 'css', attrs: { src: attrs[k] }, order: order++ });
    }

    switch (name) {
      case 'html':
        if (attrs.lang) doc.lang = attrs.lang.toLowerCase().slice(0, 10);
        break;
      case 'base':
        if (attrs.href && !doc.base) doc.base = attrs.href;
        break;
      case 'meta': {
        const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
        if (key && attrs.content !== undefined && !(key in doc.meta)) doc.meta[key] = attrs.content;
        break;
      }
      case 'link': {
        const rel = (attrs.rel || '').toLowerCase();
        if (rel.split(/\s+/).includes('canonical') && attrs.href && !doc.canonical) doc.canonical = attrs.href;
        if (rel.includes('preload') && (attrs.as || '').toLowerCase() === 'image') {
          doc.images.push({ tag: 'preload', attrs, order: order++ });
        }
        break;
      }
      case 'img':
      case 'source':
        doc.images.push({ tag: name, attrs, order: order++ });
        break;
      case 'video':
        if (attrs.poster) doc.images.push({ tag: 'poster', attrs: { src: attrs.poster }, order: order++ });
        break;
      case 'iframe':
        if (attrs.src || attrs['data-src']) doc.iframes.push(attrs.src || attrs['data-src']);
        break;
      case 'a':
        openA.push({ attrs, start: i });
        if (openA.length > 3) openA.shift(); // malformed markup guard
        break;
      default:
        if (/^h[1-6]$/.test(name)) {
          openH.push({ level: Number(name[1]), start: i });
          if (openH.length > 3) openH.shift();
        } else if (attrs['data-image'] && /squarespace/i.test(attrs['data-image'])) {
          // Squarespace gallery slides keep the image on a wrapper element
          doc.images.push({ tag: 'sqs', attrs: { src: attrs['data-image'], 'data-image-dimensions': attrs['data-image-dimensions'] || '', alt: attrs.alt || '' }, order: order++ });
        }
    }
  }
  // Anchors that were never closed still carry useful hrefs.
  for (const a of openA) pushLink(doc, a.attrs, '');
  return doc;
}

function pushLink(doc: RawDoc, attrs: Attrs, text: string) {
  const href = attrs.href || attrs['data-href'] || '';
  if (!href) return;
  doc.links.push({ href, text: text.slice(0, 200), attrs });
}
