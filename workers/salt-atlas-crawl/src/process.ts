// Turns one crawled page (Apify item + saved HTML) into a PageExtract.
// Pure function: no network, no database. Easy to test and to re-run on stored HTML.

import { cleanEmail, dedupeContacts, extractFromLinks, extractFromText, normalisePhone } from './contacts.ts';
import { htmlToText, scanHtml } from './html.ts';
import { extractImages, sectionFor } from './images.ts';
import {
  extractAirports, extractCapacity, extractDurations, extractPrices, extractWaveNames, geoFromMeta, mdToPlain,
  pageHealth, parseJsonLd, splitSections,
} from './text.ts';
import type { ContactFound, PageExtract, WccItem } from './types.ts';
import { isHomePath, matchKey, rootDomain, safeUrl } from './urls.ts';

export interface PageInput {
  item: WccItem;
  html: string | null; // transformed HTML saved by Apify; null if it could not be fetched
  requestedUrl: string; // the URL we asked Apify for (from `sources`)
  feeds: string | null;
  prospectDomain: string;
  country: string | null;
}

export function processPage(input: PageInput): PageExtract {
  const { item, html, requestedUrl } = input;
  const finalUrl = item.crawl?.loadedUrl || item.url || requestedUrl;
  const doc = scanHtml(html || '');
  const markdown = item.markdown || '';
  const htmlText = html ? htmlToText(html) : '';
  const plain = markdown ? mdToPlain(markdown) : htmlText || item.text || '';
  // Contacts live in footers and headers, which readable-text markdown can drop, so search both.
  const contactText = `${plain}\n${htmlText}`.slice(0, 400_000);

  const isHome = isHomePath(requestedUrl);
  const section = sectionFor(input.feeds, requestedUrl, isHome);
  const ld = parseJsonLd(doc.jsonLd);
  const images = extractImages(doc, {
    pageUrl: finalUrl, baseUrl: doc.base, prospectDomain: input.prospectDomain, section, isHome, jsonLdImages: ld.images,
  });

  const links = extractFromLinks(doc, finalUrl, input.prospectDomain, input.country);
  const textContacts = extractFromText(contactText, input.prospectDomain, input.country);
  const ldContacts: ContactFound[] = [];
  const ldEmail = ld.data.email ? cleanEmail(ld.data.email) : null;
  if (ldEmail) ldContacts.push({ kind: 'email', value: ldEmail, evidence: 'json-ld', sameDomain: rootDomain(ldEmail.split('@')[1]) === rootDomain(input.prospectDomain) });
  const ldPhone = ld.data.telephone ? normalisePhone(ld.data.telephone, input.country) : null;
  if (ldPhone) ldContacts.push({ kind: 'phone', value: ldPhone.value, evidence: 'json-ld', localFormat: ldPhone.localFormat });
  const contacts = dedupeContacts([...links.contacts, ...textContacts, ...ldContacts]);

  const sections = splitSections(markdown || plain);
  const headings = doc.headings.length ? doc.headings : sections.filter((s) => s.level > 0).map((s) => ({ level: s.level, text: s.heading }));
  const title = (item.metadata?.title || doc.title || '').trim();

  const requestedKey = matchKey(requestedUrl);
  const finalKey = matchKey(finalUrl);
  const redirectedHome = Boolean(requestedKey && finalKey && requestedKey !== finalKey && isHomePath(finalUrl));
  const health = pageHealth({
    title, text: plain, httpStatus: item.crawl?.httpStatusCode ?? null, imageCount: images.length,
    requestedIsHome: isHome, redirectedHome,
  });

  const metaGeo = geoFromMeta(doc.meta);
  const geo = ld.data.geo ? { ...ld.data.geo, source: 'json-ld' } : metaGeo ? { ...metaGeo, source: 'meta' } : null;
  const description = (item.metadata?.description || doc.meta['og:description'] || doc.meta['description'] || '').slice(0, 400);

  return {
    url: requestedUrl,
    finalUrl,
    title: title.slice(0, 300),
    description,
    language: item.metadata?.languageCode || doc.lang,
    httpStatus: item.crawl?.httpStatusCode ?? null,
    chars: plain.length,
    section,
    status: health.status,
    statusDetail: health.detail,
    contacts,
    socials: links.socials,
    reviewLinks: links.reviewLinks.slice(0, 15),
    bookingLinks: links.bookingLinks.slice(0, 15),
    videos: [...new Set(links.videos)].slice(0, 10),
    documents: links.documents.slice(0, 15),
    images,
    prices: extractPrices(plain),
    capacity: extractCapacity(plain),
    durations: extractDurations(plain),
    airports: extractAirports(plain),
    waveNames: section === 'waves' ? extractWaveNames(sections, headings) : [],
    headings: headings.map((h) => `${'#'.repeat(Math.max(1, h.level))} ${h.text}`).slice(0, 80),
    sections,
    jsonLd: ld.data,
    geo,
  };
}

/** Is the stored page still on the operator's site (not bounced to an agency or a parked domain)? */
export function sameSiteAsProspect(finalUrl: string, prospectDomain: string): boolean {
  const u = safeUrl(finalUrl);
  if (!u) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const want = prospectDomain.toLowerCase().replace(/^www\./, '');
  return host === want || host.endsWith('.' + want) || want.endsWith('.' + host);
}
