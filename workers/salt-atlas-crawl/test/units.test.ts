import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEmail, decodeCfEmail, dedupeContacts, extractFromLinks, extractFromText, normalisePhone, whatsappFromHref } from '../src/contacts.ts';
import { decodeEntities, htmlToText, parseAttrs, scanHtml } from '../src/html.ts';
import { canonicalKey, isJunkImage, parseSrcset, sectionFor, upgradeImageUrl } from '../src/images.ts';
import { imageSize } from '../src/sniff.ts';
import { extractAirports, extractCapacity, extractDurations, extractPrices, extractWaveNames, pageHealth, parseAmount, parseJsonLd, splitSections } from '../src/text.ts';
import { interleaveByDomain, isHomePath, looseKey, matchKey, rootDomain } from '../src/urls.ts';

test('matchKey ignores scheme, www, trailing slash, fragment and tracking params', () => {
  const a = matchKey('https://www.Kingfisher-Mentawai.com/accomodation/?utm_source=x#top');
  const b = matchKey('http://kingfisher-mentawai.com/accomodation');
  assert.equal(a, b);
  assert.equal(matchKey('https://tengirri.com/'), 'tengirri.com/');
  assert.equal(matchKey('https://tengirri.com/index.html'), 'tengirri.com/');
  assert.notEqual(matchKey('https://x.com/a?id=1'), matchKey('https://x.com/a?id=2'));
  assert.equal(looseKey('https://x.com/Rooms'), looseKey('https://x.com/rooms'));
  assert.equal(matchKey('mailto:a@b.com'), null);
});

test('rootDomain handles two-part suffixes', () => {
  assert.equal(rootDomain('images.example.co.id'), 'example.co.id');
  assert.equal(rootDomain('https://www.aloitaresort.com/x'), 'aloitaresort.com');
  assert.equal(rootDomain('static.wixstatic.com'), 'wixstatic.com');
});

test('isHomePath', () => {
  assert.ok(isHomePath('https://tengirri.com/'));
  assert.ok(isHomePath('https://tengirri.com'));
  assert.ok(isHomePath('https://tengirri.com/en/'));
  assert.ok(!isHomePath('https://tengirri.com/the-boat/'));
});

test('interleaveByDomain spreads requests across sites', () => {
  const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://b.com/1', 'https://c.com/1'].map((url) => ({ url }));
  const out = interleaveByDomain(urls).map((x) => x.url);
  assert.deepEqual(out.slice(0, 3), ['https://a.com/1', 'https://b.com/1', 'https://c.com/1']);
  assert.equal(out.length, 5);
});

test('HTML scanner: attributes, entities, comments, raw text, anchors, headings, JSON-LD', () => {
  const html = `<!doctype html><html lang="en-AU"><head><title>Resort &amp; Spa</title>
    <meta property="og:image" content="https://x.com/a.jpg?x=1&amp;y=2">
    <script type="application/ld+json">{"@type":"Resort","name":"X"}</script>
    <script>var a = "<a href='/fake'>no</a>";</script></head>
    <body><!-- <a href="/commented">x</a> --><a href="/real" title='T "q"'>Real <b>link</b></a>
    <h2>Rifles</h2><img data-src="/a-1024x683.jpg" alt="Surf at Rifles" width="1024" height="683"><div style="background-image:url('/bg.jpg')"></div>
    <span data-cfemail="1d"></span></body></html>`;
  const doc = scanHtml(html);
  assert.equal(doc.lang, 'en-au');
  assert.equal(doc.title, 'Resort & Spa');
  assert.equal(doc.meta['og:image'], 'https://x.com/a.jpg?x=1&y=2');
  assert.equal(doc.jsonLd.length, 1);
  assert.deepEqual(doc.links.map((l) => l.href), ['/real']);
  assert.equal(doc.links[0].text, 'Real link');
  assert.equal(doc.links[0].attrs.title, 'T "q"');
  assert.deepEqual(doc.headings, [{ level: 2, text: 'Rifles' }]);
  assert.equal(doc.images[0].attrs['data-src'], '/a-1024x683.jpg');
  assert.deepEqual(doc.cssImages.map((c) => c.url), ['/bg.jpg']);
  assert.equal(parseAttrs('a="1" b=\'2\' c=3 d').d, '');
  assert.equal(decodeEntities('&#x27;&#39;&euro;'), "''€");
  assert.ok(!htmlToText(html).includes('var a'));
});

test('srcset parser copes with commas inside URLs', () => {
  const s = 'https://res.cloudinary.com/d/image/upload/w_400,h_300,c_fill/v1/x.jpg 400w, https://res.cloudinary.com/d/image/upload/w_1600,h_1200,c_fill/v1/x.jpg 1600w';
  const e = parseSrcset(s);
  assert.equal(e.length, 2);
  assert.equal(e[1].w, 1600);
  assert.ok(e[1].url.endsWith('/v1/x.jpg'));
  assert.deepEqual(parseSrcset('a.jpg 1x, b.jpg 2x').map((x) => x.x), [1, 2]);
});

test('image URL upgrades to the original', () => {
  const up = (s: string) => upgradeImageUrl(new URL(s), 'https://site.com');
  assert.equal(up('https://images.squarespace-cdn.com/content/v1/abc/photo.jpg?format=750w').url, 'https://images.squarespace-cdn.com/content/v1/abc/photo.jpg?format=2500w');
  assert.equal(up('https://static.wixstatic.com/media/a1_b2~mv2.jpg/v1/fill/w_640,h_480,al_c,q_80/a1.jpg').url, 'https://static.wixstatic.com/media/a1_b2~mv2.jpg');
  assert.equal(up('https://static.wixstatic.com/media/a1_b2~mv2.jpg/v1/fill/w_640,h_480,al_c,q_80/a1.jpg').widthHint, 640);
  const wp = up('https://site.com/wp-content/uploads/2024/05/rifles-1024x683.jpg');
  assert.equal(wp.url, 'https://site.com/wp-content/uploads/2024/05/rifles.jpg');
  assert.equal(wp.widthHint, 1024);
  assert.equal(up('https://res.cloudinary.com/d/image/upload/w_800,c_fill/q_auto/v123/x.jpg').url, 'https://res.cloudinary.com/d/image/upload/v123/x.jpg');
  assert.equal(up('https://cdn.shopify.com/s/files/1/a/b_800x600.jpg?v=1').url, 'https://cdn.shopify.com/s/files/1/a/b.jpg?v=1');
  assert.equal(up('https://site.com/_next/image?url=%2Fimg%2Fhero.jpg&w=3840&q=75').url, 'https://site.com/img/hero.jpg');
  assert.equal(up('https://site.com/cdn-cgi/image/width=800,quality=75/img/hero.jpg').url, 'https://site.com/img/hero.jpg');
  assert.equal(up('https://i0.wp.com/site.com/wp-content/uploads/a-300x200.jpg?w=300').url, 'https://site.com/wp-content/uploads/a.jpg');
  assert.equal(up('https://lh3.googleusercontent.com/p/AF1Qxyz=w800-h600-k-no').url, 'https://lh3.googleusercontent.com/p/AF1Qxyz=s0');
});

test('canonicalKey ties size variants together', () => {
  assert.equal(canonicalKey('https://site.com/wp-content/uploads/a-1024x683.jpg'), canonicalKey('https://site.com/wp-content/uploads/a.jpg'));
  assert.equal(canonicalKey('https://www.site.com/a.JPG'), canonicalKey('https://site.com/a.jpg'));
});

test('junk images are dropped', () => {
  assert.ok(isJunkImage('https://site.com/wp-content/uploads/logo.png'));
  assert.ok(isJunkImage('https://site.com/img/icons/arrow-left.png'));
  assert.ok(isJunkImage('https://site.com/x.svg'));
  assert.ok(isJunkImage('https://www.facebook.com/tr?id=1&ev=PageView'));
  assert.ok(isJunkImage('https://site.com/a.jpg', 'Logo of resort'));
  assert.ok(!isJunkImage('https://site.com/uploads/rifles-barrel.jpg', 'Barrel at Rifles'));
});

test('sectionFor uses the scout feeds first, then the URL', () => {
  assert.equal(sectionFor('rooms/cabins, amenities', 'https://x.com/a', false), 'rooms');
  assert.equal(sectionFor('hero, overview', 'https://x.com/', true), 'hero');
  assert.equal(sectionFor(null, 'https://x.com/the-waves/', false), 'waves');
  assert.equal(sectionFor(null, 'https://x.com/gallery', false), 'gallery');
  assert.equal(sectionFor('pricing, inclusions', 'https://x.com/rates', false), 'other');
});

test('Cloudflare email protection decodes', () => {
  // "info@ex.com" XOR 0x42
  const key = 0x42;
  const hex = key.toString(16) + [...'info@ex.com'].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  assert.equal(decodeCfEmail(hex), 'info@ex.com');
  assert.equal(decodeCfEmail('zz'), null);
});

test('email cleaning rejects junk', () => {
  assert.equal(cleanEmail('mailto:Info@Kingfisher-Mentawai.com?subject=Hi'), 'info@kingfisher-mentawai.com');
  assert.equal(cleanEmail('logo@2x.png'), null);
  assert.equal(cleanEmail('name@example.com'), null);
  assert.equal(cleanEmail('abc@sentry.wixpress.com'), null);
});

test('phone normalisation', () => {
  assert.deepEqual(normalisePhone('tel:+62 (0) 811-668-949', null), { value: '+62811668949', localFormat: false });
  assert.deepEqual(normalisePhone('0812 3456 7890', 'Indonesia'), { value: '+6281234567890', localFormat: true });
  assert.deepEqual(normalisePhone('0034 600 123 456', null), { value: '+34600123456', localFormat: false });
  assert.equal(normalisePhone('12345', null), null);
  assert.equal(normalisePhone('0000000000', null), null);
});

test('WhatsApp only from wa.me-style links or explicit labels', () => {
  assert.deepEqual(whatsappFromHref('https://wa.me/6281387022077?text=hi'), { phone: '+6281387022077', link: 'https://wa.me/6281387022077?text=hi' });
  assert.equal(whatsappFromHref('https://wa.me/message/ABC123')!.phone, null);
  assert.equal(whatsappFromHref('https://api.whatsapp.com/send?phone=27727959500')!.phone, '+27727959500');
  assert.equal(whatsappFromHref('https://chat.whatsapp.com/abc'), null);
  const text = 'Call us +62 853 6525 2378. Whatsapp: +27 727 9595 00. Email info@kingfisher-mentawai.com';
  const found = extractFromText(text, 'kingfisher-mentawai.com', null);
  assert.ok(found.some((c) => c.kind === 'whatsapp' && c.value === '+27727959500'));
  assert.ok(found.some((c) => c.kind === 'email' && c.sameDomain));
  // the plain phone sits within 60 characters of "Whatsapp", but is before the label: we accept that it may be tagged WhatsApp
  const deduped = dedupeContacts([
    { kind: 'phone', value: '+1', evidence: 'text' },
    { kind: 'whatsapp', value: '+1', evidence: 'wa.me' },
    { kind: 'email', value: 'a@b.com', evidence: 'text' },
    { kind: 'email', value: 'a@b.com', evidence: 'mailto' },
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped.find((c) => c.kind === 'email')!.evidence, 'mailto');
});

test('amount parsing handles regional formats', () => {
  assert.equal(parseAmount('1.500.000'), 1500000);
  assert.equal(parseAmount('3,932'), 3932);
  assert.equal(parseAmount('2,950.00'), 2950);
  assert.equal(parseAmount('1.200,50'), 1200.5);
  assert.equal(parseAmount('1 200'), 1200);
  assert.equal(parseAmount('220'), 220);
});

test('prices with units and context', () => {
  const p = extractPrices('Packages from US$3,932 per person for 11 nights. Full boat charter AUD 31,000. Rp 1.500.000 per night. Beers $5.');
  const usd = p.find((x) => x.currency === 'USD')!;
  assert.equal(usd.amount, 3932);
  assert.equal(usd.unit, 'per person');
  assert.equal(p.find((x) => x.currency === 'AUD')!.unit, 'full boat / buyout');
  assert.equal(p.find((x) => x.currency === 'IDR')!.amount, 1500000);
  assert.ok(!p.some((x) => x.amount === 5));
  const after = extractPrices('Price: 2,500 EUR per week');
  assert.equal(after[0].currency, 'EUR');
  assert.equal(after[0].unit, 'per week');
});

test('capacity, durations, airports', () => {
  const t = 'Max 12 guests across 4 bungalows. Lance\'s Left is 2 minutes by boat; HTs is 10 min by speedboat. Fly into Padang (PDG) airport. Prices in (USD).';
  assert.ok(extractCapacity(t).some((s) => s.includes('12 guests')));
  assert.ok(extractCapacity(t).some((s) => s.includes('4 bungalows')));
  assert.equal(extractDurations(t).length, 2);
  assert.deepEqual(extractAirports(t), ['PDG']);
});

test('markdown sections', () => {
  const md = '# Kingfisher\nIntro text\n## Lance\'s Left\nA long left.\n### Bintangs\nBarrels.\n## FAQ';
  const s = splitSections(md);
  assert.deepEqual(s.map((x) => x.heading), ['Kingfisher', "Lance's Left", 'Bintangs', 'FAQ']);
  assert.equal(s[1].text, 'A long left.');
});

test('JSON-LD: graph, address, geo, images', () => {
  const r = parseJsonLd([
    JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, { '@type': ['Hotel', 'Resort'], name: 'Latitude Zero', telephone: '+62811668949', address: { streetAddress: 'Sifauruasi', addressCountry: 'ID' }, geo: { latitude: '-0.23', longitude: '98.4' }, image: [{ url: 'https://x.com/a.jpg', width: 2000 }, 'https://x.com/b.jpg'] }] }),
    '{broken',
  ]);
  assert.equal(r.data.name, 'Latitude Zero');
  assert.equal(r.data.address, 'Sifauruasi, ID');
  assert.deepEqual(r.data.geo, { lat: -0.23, lng: 98.4 });
  assert.equal(r.images.length, 2);
});

test('page health', () => {
  const base = { title: '', text: 'x'.repeat(2000), httpStatus: 200, imageCount: 3, requestedIsHome: false, redirectedHome: false };
  assert.equal(pageHealth(base).status, 'ok');
  assert.equal(pageHealth({ ...base, httpStatus: 404 }).status, 'gone');
  assert.equal(pageHealth({ ...base, httpStatus: 403 }).status, 'blocked');
  assert.equal(pageHealth({ ...base, title: 'Just a moment...', text: 'Checking your browser' }).status, 'blocked');
  assert.equal(pageHealth({ ...base, text: 'This domain is for sale. Buy this domain.' }).status, 'parked');
  assert.equal(pageHealth({ ...base, text: 'hi', imageCount: 0 }).status, 'thin');
  assert.equal(pageHealth({ ...base, redirectedHome: true }).status, 'redirect_home');
});

test('image size sniffing: PNG, GIF, WebP, JPEG', () => {
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 2400);
  new DataView(png.buffer).setUint32(20, 1600);
  assert.deepEqual(imageSize(png), { width: 2400, height: 1600, type: 'png' });

  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
  assert.deepEqual(imageSize(gif), { width: 320, height: 240, type: 'gif' });

  const webp = new Uint8Array(32);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  // VP8X: width-1 and height-1 as 24-bit little endian at 24 and 27
  webp.set([0x7f, 0x07, 0x00, 0x2b, 0x04, 0x00], 24); // 1920 x 1068
  assert.deepEqual(imageSize(webp), { width: 1920, height: 1068, type: 'webp' });

  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x40, 0x09, 0x60, 0x03, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 2400, height: 1600, type: 'jpeg' });
  assert.equal(imageSize(new Uint8Array(40)), null);
});

test('capacity: number words, describing words, no distance false positives', () => {
  const c = extractCapacity('Three traditional style luxury beachfront bungalows. Only ever a maximum of twelve guests. We are 10 minutes from the rooms of the village. 6 air-conditioned cabins.');
  assert.ok(c.some((x) => x.startsWith('3 bungalows')), c.join(' | '));
  assert.ok(c.some((x) => x.startsWith('max 12 guests')), c.join(' | '));
  assert.ok(c.some((x) => x.startsWith('6 cabins')), c.join(' | '));
  assert.ok(!c.some((x) => x.startsWith('10 rooms')), c.join(' | '));
});

// Regressions from the first live crawl (Aloita, 10 Nov 2026).
test('plain English is never read as an email address', () => {
  const text = 'Surf when you want to surf at all. Most guests stay a week. Tricky at times. It is hard. Stay at Aloita. The best experience at Aloita. We get busy. Nothing at all. Experiences';
  const found = extractFromText(text, 'aloitaresort.com', 'Indonesia').filter((c) => c.kind === 'email');
  assert.deepEqual(found, []);
  const real = extractFromText('Write to bookings [at] aloitaresort.com or info at aloitaresort dot com', 'aloitaresort.com', 'Indonesia').filter((c) => c.kind === 'email').map((c) => c.value).sort();
  assert.deepEqual(real, ['bookings@aloitaresort.com', 'info@aloitaresort.com']);
});

test('capacity ignores words that merely start with a number word', () => {
  const c = extractCapacity('cherished memories for you and your loved ones surfing EXPERIENCES luxury villas. Ten absolute beachfront villas.');
  assert.ok(!c.some((x) => x.startsWith('1 villas')), c.join(' | '));
  assert.ok(c.some((x) => x.startsWith('10 villas')), c.join(' | '));
});

test('wave names: no eyebrows, months, sentences or case duplicates', () => {
  const names = extractWaveNames([], ['SURF · MENTAWAI ISLANDS', 'Tikus.', 'Scarecrows.', 'SCARECROWS', "G4's", 'G4’S', 'May to September', 'The Mentawais receive waves year-round.', 'Ombak Tidur.', 'OMBAK TIDUR', 'Suicides Left.'].map((text) => ({ level: 3, text })));
  assert.deepEqual(names, ['Tikus', 'Scarecrows', "G4's", 'Ombak Tidur', 'Suicides Left']);
});

test('cookie banner text is dropped from page sections', () => {
  const s = splitSections('Aloita Resort - Beachfront Mentawai Resort We value your privacy We use cookies to enhance your browsing experience. By clicking "Accept All", you consent to our use of cookies. Customise Reject All Accept All Powered by\n## Wake up steps from the ocean.\nEvery villa at Aloita is designed around island living.');
  assert.ok(!/cookie|Accept All|privacy/i.test(s.map((x) => x.text).join(' ')), JSON.stringify(s));
  assert.ok(s.some((x) => /Every villa/.test(x.text)));
});

test('regressions from the other live briefs', () => {
  // one price, not two
  const p = extractPrices('In order to confirm your spot, a $8,000.00 USD NON-REFUNDABLE deposit. Surfing Tax ($140 USD per person).');
  assert.deepEqual(p.map((x) => `${x.currency} ${x.amount} ${x.unit ?? ''}`.trim()), ['USD 8000', 'USD 140 per person']);
  // "eight surfers across six cabins" is 6 cabins, not 8
  const c = extractCapacity('With room for eight surfers across six cabins, everyone has their own bed.');
  assert.ok(!c.some((x) => x.startsWith('8 cabins')), c.join(' | '));
  // booking-terms headings are not breaks
  const w = extractWaveNames([], ['2027 SCHEDULE', 'Terms and Conditions', 'What’s Included', 'Skill Level', 'Hide Filters', 'Macaronis', "Lance's Right (Hollow tree's)"].map((text) => ({ level: 3, text })));
  assert.deepEqual(w, ['Macaronis', "Lance's Right (Hollow tree's)"]);
});

test('map embeds are not review links; place links are', () => {
  const doc = scanHtml('<a href="https://maps.google.com/maps?ll=-2.37,99.84&z=12">map</a><a href="https://www.google.com/maps/place/Kingfisher+Resort/@-2.37,99.84">reviews</a>', 'https://kingfisher-mentawai.com/');
  const f = extractFromLinks(doc, 'https://kingfisher-mentawai.com/', 'kingfisher-mentawai.com', 'Indonesia');
  assert.deepEqual(f.reviewLinks, ['https://www.google.com/maps/place/Kingfisher+Resort/@-2.37,99.84']);
});

test('the 9am review list shows this morning\'s staged pages with links and checks', async () => {
  const { FakeD1 } = await import('./fakes.ts');
  const { stagedForReview } = await import('../src/review.ts');
  const db = new FakeD1();
  db.db.exec(`INSERT INTO prospects (id, name, country) VALUES ('a.com', 'A', 'Indonesia'), ('b.com', 'B', 'Indonesia');
    INSERT INTO page_drafts (prospect_id, slug, kit_json, status, notes, updated_at) VALUES
      ('a.com', 'aloita-resort', '{"name":"Aloita Resort"}', 'built', 'Check every photo. · staged 2026-11-11', datetime('now')),
      ('b.com', 'old-page', '{"name":"Old"}', 'built', '', datetime('now', '-1 day'));`);
  const list = await stagedForReview(db);
  assert.deepEqual(list, [{ slug: 'aloita-resort', name: 'Aloita Resort', url: 'https://staging.saltatlas-website.pages.dev/destinations/aloita-resort/', check: 'Check every photo.' }]);
});

test('depth-1 crawl follows only photo, room and surf pages on the resorts own sites', async () => {
  const { buildCrawlInput, followGlobs, rootDomains } = await import('../src/apify.ts');
  assert.deepEqual(rootDomains(['https://www.nihi.com/', 'https://nihi.com/sumba/surf', 'https://tengirri.com/x']), ['nihi.com', 'tengirri.com']);
  const input = buildCrawlInput(['https://www.nihi.com/', 'https://tengirri.com/'], 'primary', {});
  assert.equal(input.maxCrawlDepth, 1);
  assert.equal((input.includeUrlGlobs as unknown[]).length, 4);
  assert.equal(input.maxCrawlPages, 2 + 24 + 10);
  const retry = buildCrawlInput(['https://www.nihi.com/'], 'retry', {});
  assert.equal(retry.maxCrawlDepth, 0);
  assert.equal(retry.includeUrlGlobs, undefined);
  assert.ok(followGlobs(['nihi.com'])[0].glob.includes('gallery'));
});

test('cron firings map to the right job by UTC time', async () => {
  const { jobFor } = await import('../src/schedule.ts');
  const at = (hhmm: string) => Date.parse(`2026-11-12T${hhmm}:00Z`);
  assert.equal(jobFor(at('01:00')), 'crawl');
  assert.equal(jobFor(at('20:45')), 'evening_crawl');
  for (const t of ['03:30', '04:30', '05:30', '06:30']) assert.equal(jobFor(at(t)), 'photos');
  assert.equal(jobFor(at('07:30')), 'watchdog');
});
