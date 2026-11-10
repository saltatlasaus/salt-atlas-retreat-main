// Text extraction: page sections, prices, capacity, transfer times, airports, wave
// names, structured data, and detection of blocked, empty or dead pages.

import type { PageExtract, PriceFound, Section } from './types.ts';

/** Markdown to plain text: drop images, keep link text, remove emphasis markers. */
export function mdToPlain(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split markdown into heading-led sections (H1–H4). Text before the first heading becomes "Intro". */
const CONSENT_LINE = /we value your privacy|we use cookies|use of cookies|cookie (policy|settings|preferences|consent)|accept all|reject all|customi[sz]e (cookies|consent|preferences)|powered by (cookieyes|cookiebot|onetrust|complianz)|manage (cookies|consent)/i;

/** Drop cookie and consent banner text that survived the crawler's own cookie removal. */
export function stripConsent(md: string): string {
  return md
    .split(/\r?\n/)
    .map((line) => (CONSENT_LINE.test(line) && line.length < 600 ? line.split(/(?<=[.!?])\s+/).filter((x) => !CONSENT_LINE.test(x)).join(' ').replace(/\b(Customise|Customize|Reject All|Accept All|Powered by\s*\S*)\b/gi, '').trim() : line))
    .join('\n');
}

export function splitSections(md: string, maxText = 1200): Section[] {
  const lines = stripConsent(md).split(/\r?\n/);
  const out: Section[] = [];
  let cur: Section = { heading: 'Intro', level: 0, text: '' };
  const flush = () => {
    const t = mdToPlain(cur.text).replace(/\s+/g, ' ').trim();
    if (t || cur.level > 0) out.push({ heading: cur.heading, level: cur.level, text: t.slice(0, maxText) });
  };
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      cur = { heading: mdToPlain(h[2]).slice(0, 160), level: h[1].length, text: '' };
    } else {
      cur.text += line + '\n';
    }
  }
  flush();
  return out.filter((s) => s.text || s.level > 0);
}

// Currency tokens. Order matters: longer, unambiguous forms first.
const CURRENCY_TOKENS: [RegExp, string][] = [
  [/^(US\$|USD|U\$S)$/i, 'USD'], [/^(A\$|AU\$|AUD)$/i, 'AUD'], [/^(NZ\$|NZD)$/i, 'NZD'], [/^(R\$|BRL)$/i, 'BRL'],
  [/^(MX\$|MXN)$/i, 'MXN'], [/^(€|EUR)$/i, 'EUR'], [/^(£|GBP)$/i, 'GBP'], [/^(Rp\.?|IDR)$/i, 'IDR'],
  [/^(₡|CRC)$/i, 'CRC'], [/^(MAD|DH|Dhs)$/i, 'MAD'], [/^(LKR|Rs\.?)$/i, 'LKR'], [/^(CHF)$/i, 'CHF'],
  [/^(ZAR)$/i, 'ZAR'], [/^(FJD|FJ\$)$/i, 'FJD'], [/^(MVR|Rf)$/i, 'MVR'], [/^(PHP|₱)$/i, 'PHP'], [/^(PEN|S\/)$/i, 'PEN'],
  [/^(CAD|C\$|CA\$)$/i, 'CAD'], [/^\$$/, '$?'],
];
const CUR_ALT = 'US\\$|U\\$S|USD|A\\$|AU\\$|AUD|NZ\\$|NZD|R\\$|BRL|MX\\$|MXN|€|EUR|£|GBP|Rp\\.?|IDR|₡|CRC|MAD|Dhs|LKR|Rs\\.?|CHF|ZAR|FJD|FJ\\$|MVR|PHP|₱|PEN|S\\/|CAD|C\\$|CA\\$|\\$';
const NUMBER = '\\d{1,3}(?:[.,\\s]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
const PRICE_BEFORE = new RegExp(`(${CUR_ALT})\\s?(${NUMBER})(\\s?[kK]\\b)?`, 'g');
const PRICE_AFTER = new RegExp(`(?<![\\w.,])(${NUMBER})\\s?(USD|AUD|NZD|EUR|GBP|IDR|CRC|MXN|BRL|MAD|LKR|CHF|ZAR|FJD|MVR|PHP|PEN|CAD|€|£)\\b`, 'g');

function currencyCode(tok: string): string | null {
  for (const [re, code] of CURRENCY_TOKENS) if (re.test(tok.trim())) return code;
  return null;
}

/** "1.500.000" (thousands with dots), "3,932", "1 200,50", "2,950.00" -> number. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s/g, '');
  const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (lastSep >= 0) {
    const decimals = s.length - lastSep - 1;
    const seps = s.match(/[.,]/g) || [];
    const mixed = new Set(seps).size > 1;
    if (decimals === 3 && !mixed) s = s.replace(/[.,]/g, ''); // all separators are thousands
    else if (decimals <= 2) s = s.slice(0, lastSep).replace(/[.,]/g, '') + '.' + s.slice(lastSep + 1);
    else s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const UNIT_RULES: [RegExp, string][] = [
  [/full[\s-]?(boat|charter)|whole[\s-]?(boat|resort|villa)|private charter|exclusive use|buy-?out|per charter/i, 'full boat / buyout'],
  [/per\s?person\s?per\s?night|pppn|pp\s?\/\s?night|pp\s?pn/i, 'per person per night'],
  [/per\s?person|\bpp\b|\bp\.p\.|per\s?surfer|per\s?guest|\/\s?person|por persona/i, 'per person'],
  [/per\s?night|\/\s?night|nightly|a night|por noche|per malam/i, 'per night'],
  [/per\s?week|\/\s?week|weekly|7\s?nights/i, 'per week'],
  [/per\s?trip|per\s?package|package|\d{1,2}\s?nights?/i, 'per trip / package'],
  [/per\s?day|\/\s?day|daily/i, 'per day'],
];

function unitFor(context: string): string | null {
  for (const [re, label] of UNIT_RULES) if (re.test(context)) return label;
  return null;
}

/** Prices written on the page, with the words around them. Unverified: Claude and people judge them. */
export function extractPrices(text: string, max = 25): PriceFound[] {
  const found: PriceFound[] = [];
  const seen = new Set<string>();
  const taken: [number, number][] = [];
  const push = (raw: string, cur: string, amt: string, k: boolean, at: number) => {
    // "$8,000.00 USD" matches both "$8,000.00" and "8,000.00 USD": one price, not two.
    const end = at + raw.length;
    if (taken.some(([a, b]) => at < b && end > a)) return;
    taken.push([at, end]);
    const code = currencyCode(cur);
    let amount = parseAmount(amt);
    if (!code || amount == null) return;
    if (k) amount *= 1000;
    if (amount < 10) return; // "$5 beers" and similar noise
    const context = text.slice(Math.max(0, at - 90), at + raw.length + 90).replace(/\s+/g, ' ').trim();
    // The unit is read from the price's own sentence only, so "…per person. Full boat charter…" stays per person.
    const afterRaw = text.slice(at + raw.length, at + raw.length + 70);
    const after = afterRaw.split(/[!?\n]|\.\s/)[0];
    const beforeRaw = text.slice(Math.max(0, at - 60), at);
    const before = beforeRaw.split(/[!?\n]|\.\s/).pop() || '';
    const unit = unitFor(after) ?? unitFor(before);
    const key = `${code}|${amount}|${unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ amount, currency: code, raw: raw.trim(), unit, context });
  };
  // Explicit codes after the number ("8,000 USD") are clearer than a bare "$", so they go first.
  for (const m of text.matchAll(PRICE_AFTER)) push(m[0], m[2], m[1], false, m.index ?? 0);
  for (const m of text.matchAll(PRICE_BEFORE)) push(m[0], m[1], m[2], Boolean(m[3]), m.index ?? 0);
  return found.slice(0, max);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
};
const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})\\b`;
// Up to 4 describing words: "three traditional style luxury beachfront bungalows", "6 air-conditioned cabins".
// Words that signal a distance or time ("10 minutes from the rooms") stop the match.
const CAP_STOP = `from|to|away|walk|walking|min|mins|minutes?|hours?|hrs?|metres?|meters?|km|miles?|steps|days?|nights?|weeks?|years?|per|of|between|in|at|near|across|for|with|and|or|guests?|surfers?|people|persons|pax|adults|${Object.keys(NUMBER_WORDS).join('|')}`;
const CAP_ADJ = `(?:(?:(?!(?:${CAP_STOP})\\b)[a-z-]+\\s+){0,4})`;
const CAPACITY_RES: [RegExp, string][] = [
  [new RegExp(`\\b(?:max(?:imum)?|up to|sleeps|accommodates?|capacity(?: of)?|limited to|only|no more than)\\s*(?:of\\s*)?${NUM}\\s*(guests|surfers|people|pax|persons|adults|riders)\\b`, 'gi'), 'max'],
  [new RegExp(`\\b${NUM}\\s*(guests|surfers|pax)\\s*(?:max(?:imum)?|at any one time|maximum)`, 'gi'), 'max'],
  [new RegExp(`\\b${NUM}\\s*(?:x\\s*)?${CAP_ADJ}(bungalows|villas|rooms|cabins|umas|suites|chalets|bedrooms|bed\\s?rooms|tents|houses|guest\\s?rooms)\\b`, 'gi'), ''],
];

export function toNumber(token: string): number | null {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

const DURATION_RE =
  /\b(\d{1,3})(?:\s?(?:-|–|to)\s?(\d{1,3}))?\s?(min(?:ute)?s?|hrs?|hours?)\s*(?:by\s+|on\s+(?:the\s+)?|via\s+)?(speed\s?boat|boat(?:\s?ride)?|walk|drive|paddle|transfer|flight|ferry|car|tuk-?tuk|scooter)\b/gi;
const AIRPORT_RE = /\(([A-Z]{3})\)|\b([A-Z]{3})\s+airport\b|airport\s*\(?([A-Z]{3})\)?/g;
const NOT_AIRPORTS = new Set(['USD', 'AUD', 'EUR', 'GBP', 'IDR', 'NZD', 'MXN', 'CRC', 'PDF', 'FAQ', 'SUP', 'BBQ', 'ATM', 'GPS', 'VIP', 'TBC', 'TBA', 'AKA', 'DIY', 'ALL', 'THE', 'AND', 'NEW', 'MIN', 'MAX', 'KMS', 'WIFI', 'UTC', 'GMT', 'WST', 'AST']);

function uniqueSnippets(text: string, re: RegExp, max: number, pad = 50): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const key = m[0].toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const at = m.index ?? 0;
    out.push(text.slice(Math.max(0, at - pad), at + m[0].length + pad).replace(/\s+/g, ' ').trim());
    if (out.length >= max) break;
  }
  return out;
}

/** Capacity facts like "max 8 guests" or "4 bungalows", each with the sentence it came from. */
export function extractCapacity(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [re, tag] of CAPACITY_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const n = toNumber(m[1]);
      if (n === null || n === 0 || n > 400) continue;
      const unit = m[2].toLowerCase().replace(/\s+/g, ' ');
      const fact = `${tag ? tag + ' ' : ''}${n} ${unit}`;
      if (seen.has(fact)) continue;
      seen.add(fact);
      const at = m.index ?? 0;
      const snippet = text.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/\s+/g, ' ').trim();
      out.push(`${fact} — "${snippet}"`);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

export function extractDurations(text: string): string[] {
  return uniqueSnippets(text, DURATION_RE, 20, 35);
}

export function extractAirports(text: string): string[] {
  const out = new Set<string>();
  AIRPORT_RE.lastIndex = 0;
  for (const m of text.matchAll(AIRPORT_RE)) {
    const code = m[1] || m[2] || m[3];
    if (!code || NOT_AIRPORTS.has(code)) continue;
    const at = m.index ?? 0;
    const around = text.slice(Math.max(0, at - 80), at + 80).toLowerCase();
    if (/airport|fly|flight|land|arrive|aeropuerto|aeroporto|bandara/.test(around)) out.add(code);
  }
  return [...out].slice(0, 6);
}

const GENERIC_HEADINGS = /^(the\s+)?(waves?|surf(ing)?|breaks?|surf (breaks|spots|guide|report|season)|our waves|spots|the breaks|faq|faqs|contact( us)?|book( now)?|enquire|about( us)?|home|menu|gallery|photos|reviews?|testimonials|rates|prices|pricing|location|getting here|news|blog|follow us|subscribe|newsletter|instagram|map|intro)$/i;

// Words that mark page furniture or marketing, not a break name.
const NOT_WAVE_WORDS = /\b(schedule|terms|conditions|included|filters?|direction|type|skill|level|guide|options|famous|paradise|reality|dream|holiday|booking|book|rates?|prices?|faq|enquire|contact|menu|gallery|reviews?|testimonials?|news|blog|resort|accommodation|packages?|more|ultimate|welcome|explore|discover)\b/i;

/** Candidate break names: short headings on a waves page. Claude confirms them; we never assert. */
export function extractWaveNames(sections: Section[], headings: { level: number; text: string }[]): string[] {
  const names = new Set<string>();
  const seen = new Set<string>();
  const pool = [...headings.map((h) => h.text), ...sections.filter((s) => s.level >= 2).map((s) => s.heading)];
  for (const raw of pool) {
    const t = raw.replace(/^\d+\s*[.·)\-–:]\s*/, '').replace(/[“”"]/g, '').trim();
    if (t.length < 3 || t.length > 40) continue;
    if (GENERIC_HEADINGS.test(t)) continue;
    if (t.split(/\s+/).length > 5) continue;
    if (/[?!]$/.test(t)) continue;
    if (/·|\|/.test(t)) continue; // eyebrow labels like "SURF · MENTAWAI ISLANDS"
    if (/\b(19|20)\d\d\b/.test(t)) continue; // "2027 SCHEDULE"
    if (NOT_WAVE_WORDS.test(t)) continue;
    if (/\b(january|february|march|april|may|june|july|august|september|october|november|december|year-round|season)\b/i.test(t)) continue;
    if (/\.$/.test(t) && t.split(/\s+/).length > 2) continue; // a sentence, not a name
    const name = t.replace(/[.,:;]+$/, '').replace(/[’']s$/i, "'s").trim();
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.add(/^[A-Z0-9'’\s.-]+$/.test(name) && name.length > 3 ? name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : name);
  }
  return [...names].slice(0, 40);
}

// ---- structured data ----

type Json = unknown;
function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

export interface JsonLdResult {
  data: PageExtract['jsonLd'];
  images: { url: string; width?: number; height?: number }[];
}

export function parseJsonLd(blocks: string[]): JsonLdResult {
  const data: PageExtract['jsonLd'] = {};
  const images: JsonLdResult['images'] = [];
  const nodes: Record<string, Json>[] = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b.replace(/^\s*<!--|-->\s*$/g, ''));
      for (const n of asArray(parsed)) {
        if (n && typeof n === 'object') {
          const obj = n as Record<string, Json>;
          nodes.push(obj, ...asArray(obj['@graph'] as Record<string, Json>[]).filter((x) => x && typeof x === 'object'));
        }
      }
    } catch {
      /* broken JSON-LD is common; skip the block */
    }
  }
  const str = (v: Json) => (typeof v === 'string' ? v.trim() : undefined);
  for (const n of nodes) {
    const type = asArray(n['@type'] as string | string[]).join(' ');
    const relevant = /Hotel|Resort|Lodging|LocalBusiness|Organization|TouristAttraction|Place|Product|Trip|Accommodation|Campground|Hostel|BedAndBreakfast|Boat/i.test(type);
    if (!relevant) continue;
    data.name ??= str(n.name);
    data.telephone ??= str(n.telephone);
    data.email ??= str(n.email)?.replace(/^mailto:/i, '');
    data.priceRange ??= str(n.priceRange);
    if (!data.address && n.address) {
      const a = n.address as Record<string, Json> | string;
      data.address = typeof a === 'string' ? a : [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry && (typeof a.addressCountry === 'string' ? a.addressCountry : (a.addressCountry as Record<string, Json>).name)].filter((x) => typeof x === 'string' && x).join(', ');
    }
    const g = n.geo as Record<string, Json> | undefined;
    if (!data.geo && g && g.latitude != null && g.longitude != null) {
      const lat = Number(g.latitude), lng = Number(g.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) data.geo = { lat, lng };
    }
    if (n.sameAs) data.sameAs = asArray(n.sameAs as string | string[]).filter((x) => typeof x === 'string').slice(0, 10);
    for (const im of asArray(n.image as Json[])) {
      if (typeof im === 'string') images.push({ url: im });
      else if (im && typeof im === 'object') {
        const o = im as Record<string, Json>;
        const url = str(o.url) || str(o.contentUrl);
        if (url) images.push({ url, width: Number(o.width) || undefined, height: Number(o.height) || undefined });
      }
    }
  }
  return { data, images };
}

export function geoFromMeta(meta: Record<string, string>): { lat: number; lng: number } | null {
  const pos = meta['geo.position'] || meta['icbm'];
  const m = pos ? /(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)/.exec(pos) : null;
  const lat = m ? Number(m[1]) : Number(meta['place:location:latitude']);
  const lng = m ? Number(m[2]) : Number(meta['place:location:longitude']);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng } : null;
}

// ---- page health ----

const BLOCKED_RE =
  /just a moment\.\.\.|attention required!? \| cloudflare|verify you are (a )?human|checking your browser|access denied|request blocked|are you a robot|captcha|enable javascript and cookies|error 1020|ddos protection by|bot protection|unusual traffic|forbidden/i;
const GONE_RE = /\b(404|page not found|page cannot be found|no longer available|nothing (was )?found|página no encontrada|halaman tidak ditemukan)\b/i;
const PARKED_RE =
  /(this domain (is|may be) for sale|buy this domain|domain (is )?parked|hugedomains|sedo\.com|dan\.com|afternic|godaddy\.com\/domains|account (has been )?suspended|website (is )?(expired|suspended)|coming soon|under construction)/i;

export function pageHealth(input: {
  title: string; text: string; httpStatus: number | null; imageCount: number; requestedIsHome: boolean;
  redirectedHome: boolean;
}): { status: PageExtract['status']; detail: string | null } {
  const head = `${input.title}\n${input.text.slice(0, 3000)}`;
  const chars = input.text.length;
  if (input.httpStatus === 404 || input.httpStatus === 410) return { status: 'gone', detail: `HTTP ${input.httpStatus}` };
  if (input.httpStatus && input.httpStatus >= 400) {
    return input.httpStatus === 403 || input.httpStatus === 429 || input.httpStatus === 503
      ? { status: 'blocked', detail: `HTTP ${input.httpStatus}` }
      : { status: 'gone', detail: `HTTP ${input.httpStatus}` };
  }
  if (input.redirectedHome && !input.requestedIsHome) return { status: 'redirect_home', detail: 'page now redirects to the homepage' };
  if (chars < 1500 && BLOCKED_RE.test(head)) return { status: 'blocked', detail: (head.match(BLOCKED_RE) || [''])[0] };
  if (chars < 2500 && PARKED_RE.test(head)) return { status: 'parked', detail: (head.match(PARKED_RE) || [''])[0] };
  if (chars < 1200 && GONE_RE.test(input.title + ' ' + input.text.slice(0, 400))) return { status: 'gone', detail: 'not-found page' };
  if (chars < 250 && input.imageCount === 0) return { status: 'thin', detail: `${chars} characters, no images` };
  return { status: 'ok', detail: null };
}
