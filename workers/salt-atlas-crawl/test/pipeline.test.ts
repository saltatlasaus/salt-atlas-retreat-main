// A full simulated day: claim -> process Apify results -> reconcile -> image sizes -> briefs,
// against a local SQLite copy of the real schema + migration, with Apify mocked.
// Also checks idempotency (steps re-run after a crash) and the next day's retry pick-up.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { buildBrief } from '../src/brief.ts';
import { claimBatch } from '../src/db.ts';
import { processChunk, reconcile, sniffRound } from '../src/pipeline.ts';
import type { Env, WccItem } from '../src/types.ts';
import { FakeD1, FakeR2 } from './fakes.ts';

const BATCH = '2026-11-11';
const RUN_ROW = `crawl-${BATCH}:primary`;

const PNG_2400 = (() => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, 2400);
  new DataView(b.buffer).setUint32(20, 1600);
  return b;
})();

const HOME_HTML = `<html><head><title>Tengirri</title><meta property="og:image" content="https://tengirri.com/wp-content/uploads/hero-1024x683.jpg"></head>
<body><a href="https://wa.me/6281387022077">WhatsApp</a><a href="mailto:anthony@tengirri.com">email</a>
<img src="https://tengirri.com/wp-content/uploads/telescopes.jpg" alt="Telescopes barrel">
<h1>Tengirri</h1><p>Max 8 guests. From AUD 6,950 per person.</p></body></html>`;
const ROOMS_HTML = `<html><head><title>Accommodation</title></head><body><h2>Accommodation</h2>
<p>Four bungalows, maximum of 12 guests. Whatsapp: +27 727 9595 00</p>
<img src="https://kingfisher-mentawai.com/wp-content/uploads/bungalow.jpg" width="2000" height="1333" alt="Bungalow"></body></html>`;

function items(): WccItem[] {
  const rec = (k: string) => `https://api.apify.com/v2/key-value-stores/kv1/records/${k}`;
  return [
    { url: 'https://tengirri.com/', markdown: '# Tengirri\nMax 8 guests. From AUD 6,950 per person.\n' + 'Text about the boat. '.repeat(40), htmlUrl: rec('home'), crawl: { loadedUrl: 'https://tengirri.com/', httpStatusCode: 200 }, metadata: { title: 'Tengirri' } },
    { url: 'https://tengirri.com/old-page', markdown: 'Welcome. ' + 'Home page text. '.repeat(60), htmlUrl: rec('old'), crawl: { loadedUrl: 'https://tengirri.com/', httpStatusCode: 200 } },
    { url: 'http://www.kingfisher-mentawai.com/accomodation', markdown: '## Accommodation\nFour bungalows, maximum of 12 guests.\n' + 'Lovely place. '.repeat(40), htmlUrl: rec('rooms'), crawl: { loadedUrl: 'https://kingfisher-mentawai.com/accomodation/', httpStatusCode: 200 } },
    { url: 'http://www.kingfisher-mentawai.com/contact-us/', markdown: 'Forbidden', htmlUrl: rec('blocked'), crawl: { httpStatusCode: 403 }, metadata: { title: 'Attention Required! | Cloudflare' } },
    { url: 'https://kingfisher-mentawai.com/rates.pdf', text: 'Rates 2027: US$220 per person per night', crawl: { contentType: 'application/pdf' }, metadata: { title: 'Rates' } },
  ];
}

const sniffed: string[] = [];
function installFetch(datasetItems: WccItem[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.apify.com/v2/datasets/ds1/items')) {
      const u = new URL(url);
      const off = Number(u.searchParams.get('offset'));
      const lim = Number(u.searchParams.get('limit'));
      return Response.json(datasetItems.slice(off, off + lim));
    }
    if (url.includes('/records/SKIPPED_URLS')) return Response.json({ robotsTxt: ['https://tengirri.com/schedule-rates/'] });
    if (url.endsWith('/records/home')) return new Response(HOME_HTML);
    if (url.endsWith('/records/old')) return new Response('<html><body><p>Welcome</p></body></html>');
    if (url.endsWith('/records/rooms')) return new Response(ROOMS_HTML);
    if (url.endsWith('/records/blocked')) return new Response('<html><head><title>Attention Required! | Cloudflare</title></head></html>');
    if (/\.(jpe?g|png|webp)(\?|$)/.test(url)) {
      sniffed.push(url);
      return new Response(PNG_2400, { headers: { 'content-type': 'image/png' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let db: FakeD1;
let r2: FakeR2;
let env: Env;

beforeEach(() => {
  db = new FakeD1();
  r2 = new FakeR2();
  env = { DB: db, SCRAPE_BUCKET: r2, APIFY_TOKEN: 't', WEBHOOK_SECRET: 's', ADMIN_TOKEN: 'a', PUBLIC_URL: 'https://w.dev' } as unknown as Env;
  db.db.exec(`
    INSERT INTO prospects (id, name, country, region, type) VALUES
      ('tengirri.com', 'Tengirri Surf Charters', 'Indonesia', 'Mentawai', 'charter'),
      ('kingfisher-mentawai.com', 'Kingfisher Resort', 'Indonesia', 'South Sipora', 'resort');
    INSERT INTO sources (prospect_id, url, tag, feeds) VALUES
      ('tengirri.com', 'https://tengirri.com/', 'operator', 'hero, overview'),
      ('tengirri.com', 'https://tengirri.com/the-boat/', 'operator', 'rooms/cabins'),
      ('tengirri.com', 'https://tengirri.com/schedule-rates/', 'operator', 'pricing'),
      ('tengirri.com', 'https://tengirri.com/old-page', 'operator', 'gallery'),
      ('tengirri.com', 'https://www.instagram.com/tengirrisurfcharters/', 'social', 'gallery'),
      ('kingfisher-mentawai.com', 'http://www.kingfisher-mentawai.com/accomodation', 'operator', 'rooms'),
      ('kingfisher-mentawai.com', 'http://www.kingfisher-mentawai.com/contact-us/', 'operator', 'contacts');
    UPDATE sources SET crawl_status = 'skip' WHERE tag = 'social';
    INSERT INTO contacts (prospect_id, kind, value, source_url) VALUES ('tengirri.com', 'email', 'anthony@tengirri.com', 'https://tengirri.com/schedule-rates/');
  `);
  installFetch(items());
});

const status = () =>
  Object.fromEntries(db.rows(`SELECT url, crawl_status, fail_reason, retry_count, batch FROM sources WHERE tag = 'operator'`).map((r) => [r.url, r]));

async function runDay(final = { status: 'SUCCEEDED', usage: 0.42 }) {
  const rows = await claimBatch(db, BATCH, 300);
  const urls = rows.map((r) => r.url);
  db.db.prepare(`INSERT INTO crawl_runs (id, instance_id, batch, kind, status) VALUES (?, ?, ?, 'primary', 'RUNNING')`).run(RUN_ROW, `crawl-${BATCH}`, BATCH);
  const n = await processChunk(env, { batch: BATCH, kind: 'primary', runRowId: RUN_ROW, datasetId: 'ds1', offset: 0 });
  const summary = await reconcile(env, { batch: BATCH, kind: 'primary', runRowId: RUN_ROW, runId: 'run1', kvId: 'kv1', urls, processed: n, final });
  return { rows, n, summary };
}

test('a full day: every URL ends in a clear state', async () => {
  const { rows, n } = await runDay();
  assert.equal(rows.length, 6, 'only operator pages are claimed; social links never go to Apify');
  assert.equal(n, 5);
  const s = status();
  assert.equal(s['https://tengirri.com/'].crawl_status, 'crawled');
  assert.equal(s['https://tengirri.com/'].batch, BATCH);
  assert.equal(s['http://www.kingfisher-mentawai.com/accomodation'].crawl_status, 'crawled');

  assert.equal(s['https://tengirri.com/old-page'].crawl_status, 'failed');
  assert.match(String(s['https://tengirri.com/old-page'].fail_reason), /^redirect_home/);
  assert.equal(s['https://tengirri.com/old-page'].retry_count, 99, 'a page that now redirects home is never retried');

  assert.match(String(s['http://www.kingfisher-mentawai.com/contact-us/'].fail_reason), /^blocked/);
  assert.equal(s['http://www.kingfisher-mentawai.com/contact-us/'].retry_count, 1, 'blocked pages get one retry');
  assert.equal(s['http://www.kingfisher-mentawai.com/contact-us/'].batch, null);

  assert.equal(s['https://tengirri.com/schedule-rates/'].crawl_status, 'skip');
  assert.equal(s['https://tengirri.com/schedule-rates/'].fail_reason, 'robots');

  assert.equal(s['https://tengirri.com/the-boat/'].crawl_status, 'failed');
  assert.equal(s['https://tengirri.com/the-boat/'].fail_reason, 'not_returned');
  assert.equal(s['https://tengirri.com/the-boat/'].retry_count, 1);

  const run = db.rows(`SELECT status, pages_ok, pages_failed, usage_usd FROM crawl_runs WHERE id = ?`, RUN_ROW)[0];
  assert.deepEqual(run, { status: 'SUCCEEDED', pages_ok: 2, pages_failed: 4, usage_usd: 0.42 });
});

test('images, contacts and documents are stored, linked and de-duplicated', async () => {
  await runDay();
  const imgs = db.rows(`SELECT prospect_id, image_url, width, width_hint, section FROM images ORDER BY image_url`);
  assert.ok(imgs.some((i) => i.image_url === 'https://tengirri.com/wp-content/uploads/hero.jpg' && i.section === 'hero' && i.width_hint === 1024));
  assert.ok(imgs.some((i) => i.image_url === 'https://kingfisher-mentawai.com/wp-content/uploads/bungalow.jpg' && i.width === 2000 && i.section === 'rooms'));

  const contacts = db.rows(`SELECT prospect_id, kind, value, found_by FROM contacts ORDER BY prospect_id, kind`);
  assert.ok(contacts.some((c) => c.kind === 'whatsapp' && c.value === '+6281387022077' && c.found_by === 'parser'));
  assert.ok(contacts.some((c) => c.kind === 'whatsapp' && c.value === '+27727959500' && c.prospect_id === 'kingfisher-mentawai.com'));
  assert.equal(contacts.filter((c) => c.value === 'anthony@tengirri.com').length, 1, 'scout email is not duplicated by the parser');
  assert.equal(contacts.find((c) => c.value === 'anthony@tengirri.com')!.found_by, 'scout');

  const docs = db.rows(`SELECT prospect_id, url, chars FROM documents`);
  assert.deepEqual(docs, [{ prospect_id: 'kingfisher-mentawai.com', url: 'https://kingfisher-mentawai.com/rates.pdf', chars: 39 }]);
  assert.ok([...r2.store.keys()].some((k) => k.startsWith(`crawl/${BATCH}/tengirri.com/`) && k.endsWith('.html')), 'raw HTML kept for re-parsing');
});

test('steps are safe to re-run after a crash (idempotent)', async () => {
  await runDay();
  const before = {
    images: db.rows(`SELECT count(*) AS n FROM images`)[0].n,
    contacts: db.rows(`SELECT count(*) AS n FROM contacts`)[0].n,
    retries: status()['http://www.kingfisher-mentawai.com/contact-us/'].retry_count,
  };
  // Replay the same chunk and reconcile, as the Workflow would after a crash mid-step.
  await processChunk(env, { batch: BATCH, kind: 'primary', runRowId: RUN_ROW, datasetId: 'ds1', offset: 0 });
  await reconcile(env, { batch: BATCH, kind: 'primary', runRowId: RUN_ROW, runId: 'run1', kvId: 'kv1', urls: Object.keys(status()), processed: 5, final: { status: 'SUCCEEDED', usage: 0.42 } });
  assert.equal(db.rows(`SELECT count(*) AS n FROM images`)[0].n, before.images);
  assert.equal(db.rows(`SELECT count(*) AS n FROM contacts`)[0].n, before.contacts);
  assert.equal(status()['http://www.kingfisher-mentawai.com/contact-us/'].retry_count, before.retries, 'no double penalty');
  assert.equal(status()['https://tengirri.com/the-boat/'].retry_count, 1, 'no double penalty for not-returned pages');
});

test('a failed Apify run puts URLs back in the queue without penalty', async () => {
  installFetch([]); // run produced nothing
  const { summary } = await runDay({ status: 'FAILED', usage: 0.05 });
  const s = status();
  for (const row of Object.values(s)) {
    if (row.fail_reason === 'robots') continue;
    assert.equal(row.retry_count, 0, `${row.fail_reason}`);
    assert.equal(row.batch, null);
    assert.equal(row.crawl_status, 'pending');
  }
  assert.equal(summary.status, 'FAILED');
});

test('next day: one retry for temporary failures, nothing for permanent ones', async () => {
  await runDay();
  const next = await claimBatch(db, '2026-11-12', 300);
  const urls = next.map((r) => r.url).sort();
  assert.deepEqual(urls, ['http://www.kingfisher-mentawai.com/contact-us/', 'https://tengirri.com/the-boat/']);
  assert.ok(next.every((r) => r.retry_count === 1), 'these go to the retry run (full browser)');
  // Second failure: retry_count 2, never claimed again.
  db.db.exec(`UPDATE sources SET crawl_status = 'failed', retry_count = 2, batch = NULL WHERE url IN ('http://www.kingfisher-mentawai.com/contact-us/', 'https://tengirri.com/the-boat/')`);
  assert.equal((await claimBatch(db, '2026-11-13', 300)).length, 0);
});

test('image sizes are read from file headers and ranks updated', async () => {
  await runDay();
  sniffed.length = 0;
  const n = await sniffRound(env, BATCH);
  assert.ok(n > 0);
  assert.ok(sniffed.length > 0 && sniffed.every((u) => !u.includes('bungalow')), 'images with a known size are not fetched');
  const hero = db.rows(`SELECT width, height, sniffed FROM images WHERE image_url LIKE '%hero.jpg'`)[0];
  assert.deepEqual(hero, { width: 2400, height: 1600, sniffed: 1 });
  assert.equal(await sniffRound(env, BATCH), 0, 'nothing is fetched twice');
});

test('briefs are built for Claude and stored in D1 and R2', async () => {
  await runDay();
  await sniffRound(env, BATCH);
  const r = await buildBrief(db, r2, 'tengirri.com');
  assert.ok(r && r.chars > 300);
  assert.equal(r!.complete, false, 'the-boat page is still due a retry');
  const md = String(db.rows(`SELECT brief_md FROM prospects WHERE id = 'tengirri.com'`)[0].brief_md);
  assert.match(md, /whatsapp: \+6281387022077 \(wa\.me; \/ \(home\)\) — new/);
  assert.match(md, /email: anthony@tengirri\.com .* — matches scout/);
  assert.match(md, /AUD 6,950 — per person/);
  assert.match(md, /hero\.jpg · 2400×1600/);
  assert.match(md, /Pages not read/);
  assert.ok(r2.store.has('briefs/tengirri.com.md') && r2.store.has('briefs/tengirri.com.json'));
  if (process.env.SHOW_BRIEF) console.log(md);
});

test('pages the scout already stamped with an older date are adopted, unless that crawl is still running', async () => {
  db.db.exec(`UPDATE sources SET batch = '2026-11-10' WHERE tag = 'operator'`);
  db.db.prepare(`INSERT INTO crawl_runs (id, instance_id, batch, kind, status, claimed_at) VALUES ('crawl-2026-11-10:primary', 'crawl-2026-11-10', '2026-11-10', 'primary', 'RUNNING', ?)`).run(new Date().toISOString());
  assert.equal((await claimBatch(db, BATCH, 300)).length, 0, 'a live crawl keeps its pages');
  db.db.exec(`UPDATE crawl_runs SET finished_at = '2026-11-10T18:00:00Z'`);
  assert.equal((await claimBatch(db, BATCH, 300)).length, 6, 'once it has finished, leftovers are adopted');
});
