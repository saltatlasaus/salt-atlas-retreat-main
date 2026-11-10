// Contact extraction: emails (including Cloudflare-obfuscated ones), phone numbers,
// WhatsApp (only from wa.me-style links or explicit WhatsApp labels), social profiles,
// review-site links and booking-engine links.

import type { RawDoc } from './html.ts';
import type { ContactFound } from './types.ts';
import { rootDomain, safeUrl } from './urls.ts';

/** Cloudflare "email protection": hex string, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out) ? out : null;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}/gi;
// Obfuscated emails need an explicit marker. Plain English ("surf at all. Most") must never become an
// address, so a bare " at " only counts together with a spelled-out " dot " ("info at resort dot com").
const OBFUSCATED_RE = /([a-z0-9._%+-]{2,64})\s*(?:\[at\]|\(at\)|\{at\}|\[@\]|\(@\))\s*([a-z0-9-]{2,63}(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\sdot\s|\.)\s*[a-z0-9-]{2,63}){1,3})/gi;
const SPOKEN_EMAIL_RE = /\b([a-z0-9._%+-]{2,64})\s+at\s+([a-z0-9-]{2,63}(?:\s+dot\s+[a-z0-9-]{2,24}){1,3})\b/gi;
const JUNK_EMAIL = /(\.(png|jpe?g|gif|webp|svg|avif|css|js)$|example\.|@sentry|sentry\.|wixpress\.com|@domain\.|@email\.|@yourdomain|@yoursite|yourname@|name@|user@|test@|@test\.|no-?reply@|donotreply@|@2x|@3x|godaddy\.com|@mysite\.|cloudflare\.com|schema\.org|@u\.)/i;

export function cleanEmail(e: string): string | null {
  const v = e.trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:)]+$/, '').toLowerCase();
  try {
    const dec = decodeURIComponent(v);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(dec)) return null;
    if (JUNK_EMAIL.test(dec)) return null;
    return dec;
  } catch {
    return null;
  }
}

// Countries in the rotation where local numbers start with a trunk "0" that is dropped
// after the country code. Only used to convert numbers written without +country code.
const TRUNK_ZERO: Record<string, string> = {
  indonesia: '62', 'sri lanka': '94', morocco: '212', philippines: '63', australia: '61',
  'united kingdom': '44', uk: '44', 'new zealand': '64', france: '33', 'south africa': '27', peru: '51',
  japan: '81', taiwan: '886', thailand: '66', malaysia: '60', vietnam: '84',
};

export interface PhoneNorm {
  value: string; // +E.164 when we are confident, otherwise the digits as written
  localFormat: boolean;
}

/** Normalise a phone number. Returns null for things that are not plausibly phone numbers. */
export function normalisePhone(raw: string, country: string | null): PhoneNorm | null {
  const s = raw
    .trim()
    .replace(/^tel:/i, '')
    .replace(/\(0\)/g, '') // "+62 (0) 812..." style: the bracketed trunk zero is not dialled
    .replace(/^(\+|00)?\s*/, (m) => (m.trim() ? '+' : ''));
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (/^(\d)\1+$/.test(digits)) return null; // 0000000 placeholders
  if (plus) return { value: '+' + digits, localFormat: false };
  const cc = country ? TRUNK_ZERO[country.toLowerCase()] : undefined;
  if (cc && digits.startsWith('0') && !digits.startsWith('00')) {
    return { value: '+' + cc + digits.slice(1), localFormat: true };
  }
  return { value: digits, localFormat: true };
}

/** Phone number from a WhatsApp link, or a link-only marker for wa.me/message/... short links. */
export function whatsappFromHref(href: string): { phone: string | null; link: string } | null {
  const u = safeUrl(href.replace(/^whatsapp:\/\//i, 'https://api.whatsapp.com/'));
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'wa.me' || host === 'wa.link') {
    const seg = u.pathname.replace(/^\/+/, '').split('/')[0];
    if (seg === 'message' || host === 'wa.link') return { phone: null, link: u.toString() };
    const d = seg.replace(/\D/g, '');
    return d.length >= 7 ? { phone: '+' + d, link: u.toString() } : null;
  }
  if (/(^|\.)whatsapp\.com$/.test(host)) {
    if (host.startsWith('chat.')) return null; // group invites are not a business number
    const d = (u.searchParams.get('phone') || '').replace(/\D/g, '');
    return d.length >= 7 ? { phone: '+' + d, link: u.toString() } : null;
  }
  return null;
}

const SOCIAL_RULES: [string, RegExp, RegExp][] = [
  ['instagram', /(^|\.)instagram\.com$/, /^\/(p|reel|reels|explore|stories|accounts|share|tv)\b/i],
  ['facebook', /(^|\.)facebook\.com$|(^|\.)fb\.com$/, /^\/(sharer|share|dialog|plugins|tr|login|events)\b|sharer\.php/i],
  ['youtube', /(^|\.)youtube\.com$/, /^\/(watch|embed|results|shorts)\b/i],
  ['tiktok', /(^|\.)tiktok\.com$/, /^\/(embed|share)\b/i],
  ['linkedin', /(^|\.)linkedin\.com$/, /^\/(share|sharing|shareArticle)\b/i],
  ['x', /(^|\.)(twitter|x)\.com$/, /^\/(intent|share|home)\b/i],
];

const REVIEW_HOSTS = /(tripadvisor\.[a-z.]+|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|g\.page|maps\.google\.|booking\.com|airbnb\.[a-z.]+|agoda\.com|expedia\.[a-z.]+|hotels\.com|trip\.com|trustpilot\.com|hostelworld\.com)/i;
const BOOKING_ENGINES = /(cloudbeds\.com|littlehotelier\.com|direct-book\.com|siteminder\.com|sirvoy\.com|beds24\.com|checkfront\.com|fareharbor\.com|rezdy\.com|bookingsync\.com|lodgify\.com|guesty\.com|mews\.(li|com)|synxis\.com|wetravel\.com|trekksoft\.com|peek\.com|xola\.com|bokun\.io|booking\.com|airbnb\.[a-z.]+|agoda\.com|expedia\.[a-z.]+|hostelworld\.com|simplybook\.me|book\.(?:[a-z0-9-]+)\.[a-z.]+|reservations?\.|ibe\.)/i;

export interface LinkFindings {
  contacts: ContactFound[];
  socials: Record<string, string>;
  reviewLinks: string[];
  bookingLinks: string[];
  videos: string[];
  documents: string[];
}

export function extractFromLinks(doc: RawDoc, pageUrl: string, prospectDomain: string, country: string | null): LinkFindings {
  const out: LinkFindings = { contacts: [], socials: {}, reviewLinks: [], bookingLinks: [], videos: [], documents: [] };
  const site = rootDomain(prospectDomain);
  for (const l of doc.links) {
    const href = l.href.trim();
    const label = `${l.text} ${l.attrs['aria-label'] || ''} ${l.attrs.title || ''} ${l.attrs.class || ''}`.toLowerCase();
    if (/^mailto:/i.test(href)) {
      const e = cleanEmail(href);
      if (e) out.contacts.push({ kind: 'email', value: e, evidence: 'mailto', sameDomain: rootDomain(e.split('@')[1]) === site });
      continue;
    }
    if (/\/cdn-cgi\/l\/email-protection#/i.test(href)) {
      const e = decodeCfEmail(href.split('#')[1] || '');
      const c = e && cleanEmail(e);
      if (c) out.contacts.push({ kind: 'email', value: c, evidence: 'cfemail', sameDomain: rootDomain(c.split('@')[1]) === site });
      continue;
    }
    if (/^tel:/i.test(href)) {
      const p = normalisePhone(decodeURIComponent(href), country);
      if (p) {
        const isWa = /whats\s?app|\bwa\b/.test(label);
        out.contacts.push({ kind: isWa ? 'whatsapp' : 'phone', value: p.value, evidence: isWa ? 'labelled_link' : 'tel', localFormat: p.localFormat });
      }
      continue;
    }
    const wa = whatsappFromHref(href);
    if (wa) {
      out.contacts.push({ kind: 'whatsapp', value: wa.phone ?? wa.link, evidence: 'wa.me' });
      continue;
    }
    const u = safeUrl(href, pageUrl);
    if (!u) continue;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let social = false;
    for (const [name, hostRe, skipRe] of SOCIAL_RULES) {
      if (hostRe.test(host)) {
        social = true;
        if (!skipRe.test(u.pathname) && u.pathname.length > 1 && !out.socials[name]) {
          out.socials[name] = `https://${host}${u.pathname.replace(/\/+$/, '')}`;
        }
      }
    }
    if (social) {
      if (/youtube\.com$/.test(host) && /^\/(watch|shorts)/.test(u.pathname)) out.videos.push(u.toString());
      continue;
    }
    const full = host + u.pathname;
    // A map embed (just coordinates) is not a review listing; a Google place link is.
    const mapOnly = /google\.[a-z.]+\/maps|maps\.google\./i.test(full) && !/\/place\/|[?&]cid=|[?&]q=place_id|ftid=/i.test(full);
    if (REVIEW_HOSTS.test(full) && !mapOnly && !out.reviewLinks.includes(u.toString())) out.reviewLinks.push(u.toString());
    const vendorHome = (u.pathname === '/' || u.pathname === '') && !u.search;
    if (rootDomain(host) !== site && !vendorHome && BOOKING_ENGINES.test(full) && !out.bookingLinks.includes(u.toString())) out.bookingLinks.push(u.toString());
    if (/vimeo\.com\/\d+/.test(full)) out.videos.push(u.toString());
    if (/\.pdf$/i.test(u.pathname) && !out.documents.includes(u.toString())) out.documents.push(u.toString());
  }
  for (const src of doc.iframes) {
    const u = safeUrl(src, pageUrl);
    if (u && /(youtube(-nocookie)?\.com\/embed|player\.vimeo\.com)/.test(u.hostname + u.pathname)) out.videos.push(u.toString());
  }
  for (const hex of doc.cfEmails) {
    const e = decodeCfEmail(hex);
    const c = e && cleanEmail(e);
    if (c) out.contacts.push({ kind: 'email', value: c, evidence: 'cfemail', sameDomain: rootDomain(c.split('@')[1]) === site });
  }
  // Facebook/Instagram profiles also go to the contacts table, which accepts those kinds.
  if (out.socials.instagram) out.contacts.push({ kind: 'instagram', value: out.socials.instagram, evidence: 'link' });
  if (out.socials.facebook) out.contacts.push({ kind: 'facebook', value: out.socials.facebook, evidence: 'link' });
  return out;
}

const PHONE_IN_TEXT = /\+\s?\d[\d\s().\-]{6,18}\d/g;

/** Emails and phones written in the page text (footer, contact blocks). */
export function extractFromText(text: string, prospectDomain: string, country: string | null): ContactFound[] {
  const out: ContactFound[] = [];
  const site = rootDomain(prospectDomain);
  EMAIL_RE.lastIndex = 0;
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = cleanEmail(m[0]);
    if (e) out.push({ kind: 'email', value: e, evidence: 'text', sameDomain: rootDomain(e.split('@')[1]) === site });
  }
  for (const m of [...text.matchAll(OBFUSCATED_RE), ...text.matchAll(SPOKEN_EMAIL_RE)]) {
    const domain = m[2].replace(/\s*(\[dot\]|\(dot\)|\{dot\}|\sdot\s|\.)\s*/gi, '.');
    const e = cleanEmail(`${m[1]}@${domain}`);
    if (e && /\.[a-z]{2,24}$/.test(e)) out.push({ kind: 'email', value: e, evidence: 'obfuscated', sameDomain: rootDomain(domain) === site });
  }
  for (const m of text.matchAll(PHONE_IN_TEXT)) {
    const p = normalisePhone(m[0], country);
    if (!p) continue;
    // WhatsApp only when the label sits right next to this number ("WhatsApp: +62…" or "+62… (WhatsApp)").
    // A label that belongs to the next number on the line must not leak onto this one.
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 40), at);
    const after = text.slice(at + m[0].length, at + m[0].length + 20);
    const labelledPhone = /(tel|phone|call|ph|fax|mobile|landline)\b[^0-9+]{0,10}$/i.test(before);
    const isWa = !labelledPhone && (/whats\s?app[^0-9+]{0,12}$/i.test(before) || /^\s*[(\[]?\s*(whats\s?app|wa)\b/i.test(after));
    out.push({ kind: isWa ? 'whatsapp' : 'phone', value: p.value, evidence: isWa ? 'labelled_text' : 'text', localFormat: p.localFormat });
  }
  return out;
}

/** Merge duplicates, keeping the strongest evidence for each value. */
export function dedupeContacts(list: ContactFound[]): ContactFound[] {
  const rank: Record<string, number> = { 'wa.me': 6, labelled_link: 5, mailto: 5, cfemail: 5, tel: 4, labelled_text: 3, link: 3, text: 2, obfuscated: 1 };
  const map = new Map<string, ContactFound>();
  for (const c of list) {
    const key = `${c.kind}|${c.value}`;
    const prev = map.get(key);
    if (!prev || (rank[c.evidence] ?? 0) > (rank[prev.evidence] ?? 0)) map.set(key, c);
  }
  // A number that is a confirmed WhatsApp does not also need a separate phone row.
  const wa = new Set([...map.values()].filter((c) => c.kind === 'whatsapp').map((c) => c.value));
  return [...map.values()].filter((c) => !(c.kind === 'phone' && wa.has(c.value)));
}
