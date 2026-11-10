// Image link extraction: find every photo on a page, upgrade resized copies to the
// largest original the site serves, drop logos and junk, and rank what is left.
// Nothing is downloaded here; we only record links (plus sizes when the page tells us).

import type { RawDoc, RawImage } from './html.ts';
import type { ImageCandidate, ImageSection } from './types.ts';
import { bareHost, rootDomain, safeUrl } from './urls.ts';

export interface SrcsetEntry {
  url: string;
  w: number | null;
  x: number | null;
}

/** Srcset parser that copes with commas inside URLs (Cloudinary "w_800,h_600" etc.). */
export function parseSrcset(s: string): SrcsetEntry[] {
  const out: SrcsetEntry[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && (s[i] === ',' || /\s/.test(s[i]))) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let k = j;
      while (k < n && s[k] !== ',') k++;
      descriptor = s.slice(j, k).trim();
      j = k;
    }
    i = j + 1;
    if (!url) continue;
    const wm = /(\d+)w\b/.exec(descriptor);
    const xm = /([\d.]+)x\b/.exec(descriptor);
    out.push({ url, w: wm ? Number(wm[1]) : null, x: xm ? Number(xm[1]) : null });
  }
  return out;
}

export interface Upgraded {
  url: string;
  widthHint: number | null; // the size we saw, which the original is at least as big as
  exactWidth: number | null; // set when the URL itself pins an exact delivered width
}

const NUM = (v: string | null | undefined) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.round(x) : null;
};

/** Rewrite a resized image URL into the largest version the platform serves. */
export function upgradeImageUrl(u: URL, pageOrigin: string): Upgraded {
  const host = u.hostname.toLowerCase();
  let widthHint: number | null = null;
  let exactWidth: number | null = null;

  // Next.js image optimiser: /_next/image?url=<original>&w=3840
  if (u.pathname.endsWith('/_next/image') && u.searchParams.get('url')) {
    widthHint = NUM(u.searchParams.get('w'));
    const inner = safeUrl(u.searchParams.get('url')!, pageOrigin);
    if (inner) return { ...upgradeImageUrl(inner, pageOrigin), widthHint };
  }
  // Cloudflare Image Resizing: /cdn-cgi/image/width=800,quality=75/<path>
  const cf = /^\/cdn-cgi\/image\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (cf) {
    widthHint = NUM(/(?:^|,)(?:width|w)=(\d+)/.exec(cf[1])?.[1]);
    const inner = safeUrl(cf[2].startsWith('http') ? cf[2] : '/' + cf[2], u.origin);
    if (inner) return { url: inner.toString(), widthHint, exactWidth: null };
  }
  // Squarespace: ?format=750w -> serve 2500w (the largest Squarespace delivers)
  if (/squarespace(-cdn)?\.com$/.test(host)) {
    widthHint = NUM(/(\d+)w/.exec(u.searchParams.get('format') || '')?.[1]);
    u.search = '?format=2500w';
    return { url: u.toString(), widthHint, exactWidth: null };
  }
  // Wix: /media/<id>~mv2.jpg/v1/fill/w_640,h_480,.../file.jpg -> /media/<id>~mv2.jpg (original)
  if (host === 'static.wixstatic.com') {
    const m = /^(\/media\/[^/]+)\/v1\/[^/]+\/([^/]+)/.exec(u.pathname);
    if (m) {
      widthHint = NUM(/w_(\d+)/.exec(m[2])?.[1]);
      return { url: `https://static.wixstatic.com${m[1]}`, widthHint, exactWidth: null };
    }
  }
  // Cloudinary: /image/upload/<transform segments>/v123/id.jpg -> drop transforms
  if (host.endsWith('cloudinary.com') && u.pathname.includes('/upload/')) {
    const [before, after] = u.pathname.split('/upload/');
    const segs = after.split('/');
    const keep: string[] = [];
    let dropping = true;
    for (const seg of segs) {
      if (dropping && /^[a-z]{1,3}_[^/]+$/.test(seg) && !/^v\d+$/.test(seg)) {
        widthHint = widthHint ?? NUM(/(?:^|,)w_(\d+)/.exec(seg)?.[1]);
        continue;
      }
      dropping = false;
      keep.push(seg);
    }
    u.pathname = `${before}/upload/${keep.join('/')}`;
    return { url: u.toString(), widthHint, exactWidth: null };
  }
  // Shopify: file_800x600.jpg / file_800x.jpg -> file.jpg
  if (host === 'cdn.shopify.com' || host.endsWith('.myshopify.com')) {
    const m = /_(\d*)x(\d*)(@\dx)?(\.[a-z]+)$/i.exec(u.pathname);
    if (m) {
      widthHint = NUM(m[1]);
      u.pathname = u.pathname.replace(/_(\d*)x(\d*)(@\dx)?(\.[a-z]+)$/i, '$4');
    }
    u.searchParams.delete('width');
    return { url: u.toString(), widthHint, exactWidth: null };
  }
  // WordPress Jetpack CDN: i0.wp.com/<host>/<path>?w=800 -> original host
  if (/^i[0-3]\.wp\.com$/.test(host)) {
    widthHint = NUM(u.searchParams.get('w')) ?? NUM(u.searchParams.get('resize')?.split(',')[0]);
    const inner = safeUrl('https:/' + u.pathname);
    if (inner) return { ...upgradeImageUrl(inner, pageOrigin), widthHint };
  }
  // Google-hosted images: ...=w800-h600-no -> =s0 (original size)
  if (/googleusercontent\.com$|ggpht\.com$/.test(host)) {
    const m = /=([wsh]\d+[^/]*)$/.exec(u.pathname);
    if (m) {
      widthHint = NUM(/[ws](\d+)/.exec(m[1])?.[1]);
      u.pathname = u.pathname.replace(/=[wsh]\d+[^/]*$/, '=s0');
    }
    return { url: u.toString(), widthHint, exactWidth: null };
  }
  // Storyblok: /f/.../m/800x0/filters:... -> drop the /m/ part
  if (host === 'a.storyblok.com') {
    const m = /\/m\/(\d+)x\d+.*$/.exec(u.pathname);
    if (m) {
      widthHint = NUM(m[1]);
      u.pathname = u.pathname.replace(/\/m\/.*$/, '');
    }
    return { url: u.toString(), widthHint, exactWidth: null };
  }
  // Query-string resizers (imgix, Contentful, Sanity, Prismic, generic ?w=)
  const QUERY_CDNS = /(imgix\.net|ctfassets\.net|cdn\.sanity\.io|images\.prismic\.io|imagekit\.io|twic\.pics)$/;
  if (QUERY_CDNS.test(host)) {
    widthHint = NUM(u.searchParams.get('w') ?? u.searchParams.get('width') ?? u.searchParams.get('tr')?.match(/w-(\d+)/)?.[1]);
    for (const k of ['w', 'h', 'width', 'height', 'fit', 'crop', 'q', 'auto', 'dpr', 'ar', 'rect', 'fm', 'tr', 'max-w', 'max-h']) u.searchParams.delete(k);
    return { url: u.toString(), widthHint, exactWidth: null };
  }
  // WordPress uploads: image-1024x683.jpg -> image.jpg (the full-size original)
  const wp = /-(\d{2,5})x(\d{2,5})(\.(?:jpe?g|png|webp|avif|gif))$/i.exec(u.pathname);
  if (wp && /\/wp-content\/|\/uploads\//.test(u.pathname)) {
    widthHint = NUM(wp[1]);
    u.pathname = u.pathname.replace(/-(\d{2,5})x(\d{2,5})(\.(?:jpe?g|png|webp|avif|gif))$/i, '$3');
    return { url: u.toString(), widthHint, exactWidth: null };
  }
  // WordPress "-scaled" originals are already the full image; generic ?w= hints are recorded but kept.
  const qw = NUM(u.searchParams.get('w') ?? u.searchParams.get('width'));
  if (qw) exactWidth = qw;
  return { url: u.toString(), widthHint, exactWidth };
}

/** Identity of an image regardless of size variant: host + path with size tokens removed. */
export function canonicalKey(url: string): string {
  const u = safeUrl(url);
  if (!u) return url;
  const path = u.pathname
    .toLowerCase()
    .replace(/-\d{2,5}x\d{2,5}(?=\.\w+$)/, '')
    .replace(/_\d*x\d*(@\dx)?(?=\.\w+$)/, '')
    .replace(/-scaled(?=\.\w+$)/, '')
    .replace(/\.(jpe?g|png|webp|avif)$/, '');
  return bareHost(u) + path;
}

const JUNK_RE =
  /(^|[\/_\-.])(logo|logos|logotype|icon|icons|favicon|sprite|avatar|gravatar|badge|flag|flags|payment|visa|mastercard|paypal|amex|trustpilot|tripadvisor|certificate|award-badge|placeholder|spinner|loader|loading|blank|spacer|pixel|tracking|1x1|transparent|arrow|chevron|button|btn|cursor|emoji|cookie|qr-?code|map-?pin|marker|signature|stars?-rating|rating-stars|social|whatsapp|facebook|instagram|youtube|tiktok)([\/_\-.]|$)/i;
const JUNK_HOSTS =
  /(facebook\.com|facebook\.net|google-analytics\.com|googletagmanager\.com|doubleclick\.net|bing\.com|hotjar\.com|tacdn\.com|tripadvisor\.|gstatic\.com|gravatar\.com|maps\.googleapis\.com|ggpht\.com\/.*=s(16|32|48)|wp\.com\/latex|shields\.io|paypalobjects\.com|trustpilot\.com|cookiebot\.com|onetrust\.com)/i;
const KNOWN_CDNS =
  /(squarespace-cdn\.com|squarespace\.com|wixstatic\.com|cloudinary\.com|imgix\.net|cdn\.shopify\.com|wp\.com|ctfassets\.net|cdn\.sanity\.io|images\.prismic\.io|webflow\.com|website-files\.com|cloudfront\.net|amazonaws\.com|googleusercontent\.com|storyblok\.com|imagekit\.io|b-cdn\.net|bunnycdn|akamaized\.net|fastly|r2\.dev|cdninstagram\.com|framerusercontent\.com|cdn\.prod\.website-files\.com|hubspotusercontent|lodgify|cloudbeds\.com|wetravel\.com|ucarecdn\.com|weebly\.com|editmysite\.com|godaddysites|img1\.wsimg\.com|jimdo|strikingly|zenfolio|smugmug)/i;

export function isJunkImage(url: string, alt = ''): boolean {
  const u = safeUrl(url);
  if (!u) return true;
  const p = u.pathname.toLowerCase();
  if (/\.(svg|ico|cur)(\?|$)/.test(p)) return true;
  if (JUNK_HOSTS.test(u.hostname + p)) return true;
  if (JUNK_RE.test(p)) return true;
  if (/^(logo|icon)\b/i.test(alt.trim())) return true;
  return false;
}

const SECTION_RULES: [ImageSection, RegExp][] = [
  ['gallery', /gallery|photos?\b|media|portfolio/i],
  ['rooms', /room|villa|accom|bungalow|cabin|suite|lodg|stay|the-boat|\bboat\b|vessel|cabins?|uma\b|house|sleep/i],
  ['waves', /wave|surf|break|spot|reef|swell/i],
  ['amenities', /activit|experience|adventure|amenit|facilit|dining|food|spa|yoga|fishing|dive|explore|island-life|resort\b/i],
  ['getting_there', /getting|travel|how-to-get|transfer|location|direction|arrival/i],
];

/** Which page-template section a page's photos belong to, from the scout's `feeds` note and the URL. */
export function sectionFor(feeds: string | null, pageUrl: string, isHome: boolean): ImageSection {
  const f = (feeds || '').toLowerCase();
  for (const [section, re] of SECTION_RULES) if (re.test(f)) return section;
  if (/hero|overview/.test(f) || isHome) return 'hero';
  const path = safeUrl(pageUrl)?.pathname || '';
  for (const [section, re] of SECTION_RULES) if (re.test(path)) return section;
  return 'other';
}

const POSITIVE = /surf|wave|barrel|tube|line-?up|reef|break|swell|boat|charter|deck|room|suite|villa|bungalow|cabin|bedroom|pool|beach|aerial|drone|sunset|ocean|island|bay|point|lagoon|palm|jungle/i;
const NEGATIVE = /staff|team|chef|menu|plate|map|chart|diagram|wedding|logo|screenshot|banner-text|flyer|poster|voucher|certificate|award/i;
const FAMILY = /\bkids?\b|child|children|family|families|baby|toddler|grom/i;

const SECTION_WEIGHT: Record<ImageSection, number> = {
  hero: 15, gallery: 12, waves: 12, rooms: 10, amenities: 8, getting_there: 2, other: 4,
};
const DISCOVERY_WEIGHT: Record<string, number> = {
  og: 8, link: 6, preload: 6, jsonld: 6, srcset: 4, sqs: 4, img: 2, css: 2, poster: 3, source: 4,
};

export function scoreImage(c: Omit<ImageCandidate, 'score'>): number {
  const w = c.width ?? c.widthHint;
  let s = 0;
  if (w == null) s += 12;
  else if (w >= 2000) s += 30;
  else if (w >= 1600) s += 26;
  else if (w >= 1200) s += 22;
  else if (w >= 1000) s += 14;
  else if (w >= 800) s += 8;
  if (c.width && c.height) {
    const r = c.width / c.height;
    if (r >= 1.3 && r <= 2.2) s += 10;
    else if (r >= 1.0) s += 4;
    else if (r < 0.9) s -= 4;
  }
  s += SECTION_WEIGHT[c.section] ?? 0;
  s += DISCOVERY_WEIGHT[c.discovery] ?? 0;
  const words = `${c.alt} ${c.url}`;
  if (POSITIVE.test(words)) s += 6;
  if (NEGATIVE.test(words)) s -= 6;
  if (FAMILY.test(words)) s -= 15; // Salt Atlas pages never lead with family imagery
  if (c.order < 3) s += 3;
  if (c.thirdParty) s -= 15;
  return Math.max(0, Math.min(100, s));
}

interface Collected {
  url: string;
  width: number | null;
  height: number | null;
  widthHint: number | null;
  alt: string;
  discovery: string;
  order: number;
}

function dims(attrs: Record<string, string>): { w: number | null; h: number | null } {
  const sq = /^(\d{2,5})x(\d{2,5})$/.exec(attrs['data-image-dimensions'] || '');
  if (sq) return { w: Number(sq[1]), h: Number(sq[2]) };
  const w = /^\d+$/.test(attrs.width || '') ? Number(attrs.width) : null;
  const h = /^\d+$/.test(attrs.height || '') ? Number(attrs.height) : null;
  // width="1" or tiny declared sizes are layout hints, not the image size
  return { w: w && w >= 50 ? w : null, h: h && h >= 50 ? h : null };
}

function fromRaw(img: RawImage): Collected[] {
  const a = img.attrs;
  const alt = (a.alt || a.title || '').slice(0, 160);
  const { w, h } = dims(a);
  const out: Collected[] = [];
  const srcset = a.srcset || a['data-srcset'] || a['data-lazy-srcset'] || a.imagesrcset || '';
  if (srcset) {
    const entries = parseSrcset(srcset);
    const best = entries.reduce<SrcsetEntry | null>((b, e) => {
      const ew = e.w ?? (e.x ? e.x * 1000 : 0);
      const bw = b ? b.w ?? (b.x ? b.x * 1000 : 0) : -1;
      return ew > bw ? e : b;
    }, null);
    if (best) out.push({ url: best.url, width: best.w, height: null, widthHint: null, alt, discovery: img.tag === 'source' ? 'source' : 'srcset', order: img.order });
  }
  const discovery = img.tag === 'img' ? 'img' : img.tag === 'preload' ? 'preload' : img.tag === 'poster' ? 'poster' : img.tag === 'sqs' ? 'sqs' : 'css';
  for (const k of ['data-orig-file', 'data-large-file', 'data-full-url', 'data-hi-res-src', 'data-zoom-image', 'data-original', 'data-lazy-src', 'data-src', 'data-image', 'src', 'href']) {
    if (a[k] && !(img.tag === 'source' && k === 'src')) {
      out.push({ url: a[k], width: w, height: h, widthHint: null, alt, discovery, order: img.order });
      break; // first non-empty attribute in priority order is the best single source
    }
  }
  return out;
}

const IMAGE_FILE = /\.(jpe?g|png|webp|avif)(\?|$)/i;

export interface ImageContext {
  pageUrl: string;
  baseUrl: string | null;
  prospectDomain: string;
  section: ImageSection;
  isHome: boolean;
  jsonLdImages: { url: string; width?: number; height?: number }[];
  maxPerPage?: number;
}

export function extractImages(doc: RawDoc, ctx: ImageContext): ImageCandidate[] {
  const base = (doc.base && safeUrl(doc.base, ctx.pageUrl)?.toString()) || ctx.pageUrl;
  const pageOrigin = safeUrl(ctx.pageUrl)?.origin || ctx.pageUrl;
  const collected: Collected[] = [];

  for (const img of doc.images) collected.push(...fromRaw(img));
  for (const c of doc.cssImages) collected.push({ url: c.url, width: null, height: null, widthHint: null, alt: '', discovery: 'css', order: c.order });
  // Lightbox galleries usually link the thumbnail to the full-size file.
  for (const l of doc.links) {
    if (IMAGE_FILE.test(l.href)) collected.push({ url: l.href, width: null, height: null, widthHint: null, alt: l.text || l.attrs.title || '', discovery: 'link', order: 0 });
  }
  const og = doc.meta['og:image'] || doc.meta['og:image:url'] || doc.meta['twitter:image'] || doc.meta['twitter:image:src'];
  if (og) {
    collected.push({
      url: og, width: Number(doc.meta['og:image:width']) || null, height: Number(doc.meta['og:image:height']) || null,
      widthHint: null, alt: doc.meta['og:image:alt'] || '', discovery: 'og', order: 0,
    });
  }
  for (const j of ctx.jsonLdImages) collected.push({ url: j.url, width: j.width ?? null, height: j.height ?? null, widthHint: null, alt: '', discovery: 'jsonld', order: 0 });

  const byKey = new Map<string, ImageCandidate>();
  const site = rootDomain(ctx.prospectDomain);
  for (const c of collected) {
    const u = safeUrl(c.url, base);
    if (!u) continue;
    const up = upgradeImageUrl(u, pageOrigin);
    if (isJunkImage(up.url, c.alt)) continue;
    const width = c.width ?? up.exactWidth;
    const widthHint = c.width ? null : up.widthHint;
    const known = width ?? widthHint;
    if (known != null && known < 400) continue; // thumbnails and icons
    const host = safeUrl(up.url)!.hostname;
    const thirdParty = rootDomain(host) !== site && !KNOWN_CDNS.test(host);
    // A page's og:image on the homepage is the operator's chosen hero shot.
    const section: ImageSection = c.discovery === 'og' && ctx.isHome ? 'hero' : ctx.section;
    const key = canonicalKey(up.url);
    const cand: Omit<ImageCandidate, 'score'> = {
      url: up.url, canonicalKey: key, width, height: c.height, widthHint, alt: c.alt.trim(),
      discovery: c.discovery, order: c.order, thirdParty, section,
    };
    const prev = byKey.get(key);
    if (prev) {
      // Keep the best facts from every sighting of the same image.
      prev.width = Math.max(prev.width ?? 0, cand.width ?? 0) || null;
      prev.height = prev.height ?? cand.height;
      prev.widthHint = Math.max(prev.widthHint ?? 0, cand.widthHint ?? 0) || null;
      if (!prev.alt && cand.alt) prev.alt = cand.alt;
      if ((DISCOVERY_WEIGHT[cand.discovery] ?? 0) > (DISCOVERY_WEIGHT[prev.discovery] ?? 0)) prev.discovery = cand.discovery;
      if (cand.section === 'hero') prev.section = 'hero';
      prev.order = Math.min(prev.order, cand.order);
      prev.score = scoreImage(prev);
    } else {
      byKey.set(key, { ...cand, score: scoreImage(cand) });
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, ctx.maxPerPage ?? 60);
}
