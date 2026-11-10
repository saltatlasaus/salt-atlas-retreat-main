// URL helpers: normalising for matching, domain checks, and polite ordering.

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|mc_cid|mc_eid|_ga|_gl|ref|igshid|srsltid)$/i;

/** Parse safely; returns null for anything that is not http(s). */
export function safeUrl(raw: string | null | undefined, base?: string): URL | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('javascript:')) return null;
  if (s.includes('{{') || s.includes('${')) return null; // unrendered templates
  try {
    const u = base ? new URL(s, base) : new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

/** Host without "www." and in lower case. */
export function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Key used to match a crawled result back to a `sources` row.
 * Ignores scheme, www, trailing slash, fragment, tracking params and default ports.
 * Keeps the path case, because some servers treat paths as case-sensitive.
 */
export function matchKey(raw: string | null | undefined): string | null {
  const u = safeUrl(raw);
  if (!u) return null;
  let path = u.pathname.replace(/\/{2,}/g, '/');
  try {
    path = decodeURI(path);
  } catch {
    /* keep encoded path */
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '') path = '/';
  path = path.replace(/\/index\.(html?|php)$/i, '/') || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  return bareHost(u) + path + query;
}

/** Looser key: same as matchKey but path lower-cased. Used as a second matching pass. */
export function looseKey(raw: string | null | undefined): string | null {
  const k = matchKey(raw);
  if (!k) return null;
  const slash = k.indexOf('/');
  return slash < 0 ? k : k.slice(0, slash) + k.slice(slash).toLowerCase();
}

export function isHomePath(raw: string | null | undefined): boolean {
  const u = safeUrl(raw);
  if (!u) return false;
  const p = u.pathname.replace(/\/+$/, '');
  return p === '' || /^\/(index\.(html?|php)|home|en|es|pt|fr|de|id)$/i.test(p);
}

// Common two-part public suffixes seen in our markets. Not exhaustive, but enough to
// tell that "shop.example.co.id" and "example.co.id" are the same site.
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'com.au', 'net.au', 'co.nz', 'co.id', 'or.id', 'web.id', 'my.id', 'com.br', 'com.mx',
  'co.cr', 'com.pe', 'com.ph', 'co.za', 'com.sg', 'co.jp', 'com.fj', 'com.mv', 'com.lk', 'co.ma', 'com.pa',
  'com.ni', 'com.ec', 'com.co', 'com.ar', 'com.uy', 'co.in', 'com.my', 'com.tw', 'com.hk',
]);

/** Registrable domain, e.g. "images.example.co.id" -> "example.co.id". */
export function rootDomain(hostOrUrl: string): string {
  let host = hostOrUrl;
  const u = safeUrl(hostOrUrl.includes('://') ? hostOrUrl : 'https://' + hostOrUrl);
  if (u) host = u.hostname;
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function sameSite(a: string, b: string): boolean {
  return rootDomain(a) === rootDomain(b);
}

/**
 * Round-robin the URLs by domain so that concurrent crawler workers hit different sites,
 * rather than five requests at once to one small resort server.
 */
export function interleaveByDomain<T extends { url: string }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const u = safeUrl(it.url);
    const d = u ? rootDomain(u.hostname) : '?';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d)!.push(it);
  }
  const queues = [...groups.values()];
  const out: T[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

/** Short stable hash for R2 keys (FNV-1a, 32-bit, base36). */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
