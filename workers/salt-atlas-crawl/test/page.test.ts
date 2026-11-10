// End-to-end parser tests on realistic page markup (Squarespace, WordPress, Wix patterns),
// plus the brief renderer's size budget.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBrief } from '../src/brief.ts';
import { processPage } from '../src/process.ts';

const SQUARESPACE_HOME = `<!doctype html><html lang="en"><head>
<title>Tengirri Surf Charters | Mentawai</title>
<meta property="og:image" content="https://images.squarespace-cdn.com/content/v1/5893/hero.jpg?format=1500w">
<meta property="og:image:width" content="1500"><meta property="og:image:height" content="1000">
<script type="application/ld+json">{"@type":"LocalBusiness","name":"Tengirri Surf Charters","telephone":"+61 434 249 834","email":"anthony@tengirri.com"}</script>
<script>window.dataLayer=[];</script>
</head><body>
<header><a href="https://wa.me/6281387022077" class="whatsapp-btn" aria-label="WhatsApp us"><img src="/s/whatsapp-icon.png"></a></header>
<div class="sqs-gallery">
  <div class="slide" data-image="https://images.squarespace-cdn.com/content/v1/5893/telescopes.jpg" data-image-dimensions="2500x1667" alt="Surfer at Telescopes"></div>
  <img data-src="https://images.squarespace-cdn.com/content/v1/5893/cabin.jpg" data-image-dimensions="2000x1333" alt="Twin cabin" src="data:image/gif;base64,R0lGOD">
  <noscript><img src="https://images.squarespace-cdn.com/content/v1/5893/deck.jpg?format=750w" alt="Deck at sunset"></noscript>
</div>
<h1>The best surf charter boat for small groups</h1>
<p>Tengirri carries a maximum of 8 guests in 6 air-conditioned cabins. Trips are 11 nights.</p>
<p>Prices from AUD 6,950 per person. Full boat available.</p>
<footer><p>Tengirri Group Pty Ltd · <a href="mailto:anthony@tengirri.com">anthony@tengirri.com</a> · 0434249834 (+61 434249834)</p>
<a href="https://www.instagram.com/tengirrisurfcharters/">Instagram</a>
<a href="https://www.facebook.com/tengirrisurfcharters">Facebook</a>
<a href="https://www.facebook.com/sharer.php?u=x">Share</a></footer>
</body></html>`;

const WORDPRESS_ROOMS = `<!doctype html><html lang="en-US"><head><title>Accommodation — Kingfisher</title>
<link rel="canonical" href="http://www.kingfisher-mentawai.com/accomodation">
</head><body>
<h2>Accommodation</h2>
<p>The Resort is made up of three traditional style luxury beachfront bungalows as well as one modern luxury suite with a private plunge pool. At any one time, there will only ever be a maximum of twelve guests.</p>
<img src="http://www.kingfisher-mentawai.com/wp-content/uploads/2023/02/bungalow-1024x683.jpg"
     srcset="http://www.kingfisher-mentawai.com/wp-content/uploads/2023/02/bungalow-300x200.jpg 300w, http://www.kingfisher-mentawai.com/wp-content/uploads/2023/02/bungalow-1024x683.jpg 1024w, http://www.kingfisher-mentawai.com/wp-content/uploads/2023/02/bungalow-scaled.jpg 2560w"
     alt="Beachfront bungalow" width="1024" height="683">
<a href="http://www.kingfisher-mentawai.com/wp-content/uploads/2023/02/lances-left.jpg"><img src="http://www.kingfisher-mentawai.com/wp-content/uploads/2023/02/lances-left-150x150.jpg" width="150" height="150"></a>
<img src="http://www.kingfisher-mentawai.com/wp-content/uploads/2023/02/family-kids-pool.jpg" alt="Family with kids at the pool" width="1600" height="1066">
<img src="http://www.kingfisher-mentawai.com/wp-content/themes/k/img/logo.png" alt="Kingfisher logo">
<p>Contact: <a href="/cdn-cgi/l/email-protection#CFEMAIL">[email&#160;protected]</a> Tel: +62 853 652 523 78 Whatsapp: +27 727 9595 00</p>
<a href="https://www.tripadvisor.com/Hotel_Review-g1-d2-Reviews-Kingfisher.html">Read our reviews</a>
<a href="https://hotels.cloudbeds.com/reservation/abc">Book now</a>
</body></html>`;

function cf(email: string): string {
  const key = 0x5a;
  return key.toString(16) + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
}

test('Squarespace homepage: hero, gallery originals, WhatsApp link, contacts, prices, capacity', () => {
  const x = processPage({
    item: { url: 'https://tengirri.com/', markdown: '# The best surf charter boat for small groups\nTengirri carries a maximum of 8 guests in 6 air-conditioned cabins.\n\nPrices from AUD 6,950 per person. Full boat available.', crawl: { loadedUrl: 'https://tengirri.com/', httpStatusCode: 200 }, metadata: { title: 'Tengirri Surf Charters | Mentawai' } },
    html: SQUARESPACE_HOME,
    requestedUrl: 'https://tengirri.com/',
    feeds: 'hero, overview',
    prospectDomain: 'tengirri.com',
    country: 'Indonesia',
  });
  assert.equal(x.status, 'ok');
  assert.equal(x.section, 'hero');
  const urls = x.images.map((i) => i.url);
  assert.ok(urls.includes('https://images.squarespace-cdn.com/content/v1/5893/hero.jpg?format=2500w'));
  assert.ok(urls.includes('https://images.squarespace-cdn.com/content/v1/5893/telescopes.jpg?format=2500w'));
  assert.ok(urls.includes('https://images.squarespace-cdn.com/content/v1/5893/deck.jpg?format=2500w'), 'noscript fallback image is found');
  assert.ok(!urls.some((u) => /whatsapp-icon|data:/.test(u)), 'icons and data URIs are dropped');
  const tele = x.images.find((i) => i.url.includes('telescopes'))!;
  assert.equal(tele.width, 2500);
  assert.equal(tele.height, 1667);

  const wa = x.contacts.filter((c) => c.kind === 'whatsapp');
  assert.deepEqual(wa.map((c) => c.value), ['+6281387022077']);
  assert.equal(wa[0].evidence, 'wa.me');
  assert.ok(x.contacts.some((c) => c.kind === 'email' && c.value === 'anthony@tengirri.com' && c.evidence === 'mailto'));
  assert.ok(x.contacts.some((c) => c.kind === 'phone' && c.value === '+61434249834'));
  assert.ok(x.contacts.some((c) => c.kind === 'instagram' && c.value.endsWith('/tengirrisurfcharters')));
  assert.equal(x.socials.facebook, 'https://facebook.com/tengirrisurfcharters');

  assert.equal(x.prices[0].currency, 'AUD');
  assert.equal(x.prices[0].amount, 6950);
  assert.equal(x.prices[0].unit, 'per person');
  assert.ok(x.capacity.some((c) => c.startsWith('max 8 guests')), x.capacity.join(' | '));
  assert.equal(x.jsonLd.name, 'Tengirri Surf Charters');
});

test('WordPress rooms page: full-size originals, lightbox links, family photos ranked down, cfemail, booking and review links', () => {
  const html = WORDPRESS_ROOMS.replace('CFEMAIL', cf('info@kingfisher-mentawai.com'));
  const x = processPage({
    item: { url: 'http://www.kingfisher-mentawai.com/accomodation', crawl: { loadedUrl: 'https://kingfisher-mentawai.com/accomodation/' } },
    html,
    requestedUrl: 'http://www.kingfisher-mentawai.com/accomodation',
    feeds: 'rooms',
    prospectDomain: 'kingfisher-mentawai.com',
    country: 'Indonesia',
  });
  assert.equal(x.status, 'ok', 'trailing slash and https upgrade are not treated as a redirect');
  assert.equal(x.section, 'rooms');
  const bungalow = x.images.find((i) => i.canonicalKey.endsWith('/bungalow'))!;
  assert.ok(bungalow, 'all bungalow variants merge into one image');
  assert.equal(bungalow.width, 2560, 'largest srcset entry wins');
  assert.equal(x.images.filter((i) => i.canonicalKey.endsWith('/bungalow')).length, 1);
  const lances = x.images.find((i) => i.url.endsWith('/lances-left.jpg'));
  assert.ok(lances, 'lightbox link to the full-size file is captured');
  assert.ok(!x.images.some((i) => /logo/.test(i.url)));
  const family = x.images.find((i) => /family/.test(i.url))!;
  assert.ok(family.score < bungalow.score, 'family imagery ranks below surf and room shots');

  assert.ok(x.contacts.some((c) => c.kind === 'email' && c.value === 'info@kingfisher-mentawai.com' && c.evidence === 'cfemail'));
  assert.ok(x.contacts.some((c) => c.kind === 'whatsapp' && c.value === '+27727959500' && c.evidence === 'labelled_text'));
  assert.ok(x.contacts.some((c) => c.kind === 'phone' && c.value === '+6285365252378'));
  assert.ok(x.bookingLinks.some((l) => l.includes('cloudbeds')));
  assert.ok(x.reviewLinks.some((l) => l.includes('tripadvisor')));
  assert.ok(x.capacity.some((c) => c.startsWith('3 bungalows')), x.capacity.join(' | '));
  assert.ok(x.capacity.some((c) => c.startsWith('max 12 guests')), x.capacity.join(' | '));
});

test('dead and moved pages are recognised', () => {
  const gone = processPage({
    item: { url: 'https://x.com/old-rooms', crawl: { loadedUrl: 'https://x.com/', httpStatusCode: 200 }, markdown: 'Welcome to our resort. ' + 'Lots of text. '.repeat(100) },
    html: '<html><body><p>Welcome</p></body></html>',
    requestedUrl: 'https://x.com/old-rooms', feeds: 'rooms', prospectDomain: 'x.com', country: null,
  });
  assert.equal(gone.status, 'redirect_home');
  const blocked = processPage({
    item: { url: 'https://x.com/', crawl: { httpStatusCode: 403 } },
    html: '<html><head><title>Attention Required! | Cloudflare</title></head></html>',
    requestedUrl: 'https://x.com/', feeds: null, prospectDomain: 'x.com', country: null,
  });
  assert.equal(blocked.status, 'blocked');
});

test('brief stays inside its size budget and flags what was not read', () => {
  const page = processPage({
    item: { url: 'https://tengirri.com/', markdown: ('## Section\n' + 'Long paragraph about waves and cabins. '.repeat(80) + '\n').repeat(30), metadata: { title: 'Tengirri' } },
    html: SQUARESPACE_HOME,
    requestedUrl: 'https://tengirri.com/', feeds: 'hero', prospectDomain: 'tengirri.com', country: 'Indonesia',
  });
  const pages = Array.from({ length: 6 }, (_, i) => ({ url: `https://tengirri.com/p${i}`, status: 'crawled', reason: null, extract: page }));
  pages.push({ url: 'https://tengirri.com/old', status: 'failed', reason: 'gone: HTTP 404', extract: null as never });
  const images = page.images.map((i) => ({ section: i.section, image_url: i.url, width: i.width, height: i.height, alt: i.alt, rank_score: i.score, page_url: 'https://tengirri.com/' }));
  const { markdown, complete } = renderBrief({
    prospect: { id: 'tengirri.com', name: 'Tengirri Surf Charters', country: 'Indonesia', region: 'Mentawai', type: 'charter', website: 'https://tengirri.com' },
    pages, images, scoutContacts: [{ kind: 'email', value: 'anthony@tengirri.com' }], documents: [],
  });
  assert.ok(markdown.length <= 14500, `brief is ${markdown.length} chars`);
  assert.ok(complete, 'a permanently gone page does not keep the brief incomplete');
  assert.match(markdown, /anthony@tengirri\.com .* — matches scout/);
  assert.match(markdown, /\+6281387022077/);
  assert.match(markdown, /Pages not read\n- https:\/\/tengirri\.com\/old — failed: gone: HTTP 404/);
  assert.match(markdown, /### hero/);
});
