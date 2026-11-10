import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTEMPTS, mirrorPhotos, photoKey, photoUrls, refusedPhotos, servePhoto } from '../src/photos.ts';
import type { Env } from '../src/types.ts';
import { FakeD1, FakeR2 } from './fakes.ts';

test('photo keys are stable and photo URLs skip our own hosts', async () => {
  const k = await photoKey('https://tengirri.com/wp-content/uploads/a.webp?x=1');
  assert.match(k, /^[0-9a-f]{32}\.webp$/);
  assert.equal(k, await photoKey('https://tengirri.com/wp-content/uploads/a.webp?x=1'));
  const urls = photoUrls({ hero: { image: { src: 'https://a.com/1.jpg' } }, stay: { gallery: [{ src: 'https://a.com/1.jpg' }, { src: 'https://www.saltatlas.com/img/x.webp' }, { src: 'https://w.dev/photo/abc.jpg' }] } }, ['saltatlas.com', 'w.dev']);
  assert.deepEqual(urls, ['https://a.com/1.jpg']);
});

test('mirror copies each photo once, records failures, and serves the copy', async () => {
  const db = new FakeD1();
  const r2 = new FakeR2();
  const env = { DB: db, SCRAPE_BUCKET: r2, PUBLIC_URL: 'https://w.dev' } as unknown as Env;
  db.db.exec(`INSERT INTO prospects (id, name, country) VALUES ('t.com', 'T', 'Indonesia');
    INSERT INTO page_drafts (prospect_id, slug, kit_json, status) VALUES ('t.com', 't', '{"hero":{"image":{"src":"https://t.com/ok.jpg"}},"stay":{"gallery":[{"src":"https://t.com/gone.jpg"},{"src":"https://t.com/ok.jpg"}]}}', 'ready');`);
  let calls = 0;
  globalThis.fetch = (async (u: string) => {
    calls++;
    return String(u).includes('gone') ? new Response('nope', { status: 404 }) : new Response(new Uint8Array(5000), { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  assert.deepEqual(await mirrorPhotos(env), { fetched: 1, failed: 1, skipped: 0 });
  assert.equal(calls, 2);
  assert.deepEqual(await mirrorPhotos(env), { fetched: 0, failed: 0, skipped: 2 }, 'nothing fetched twice the same day');
  assert.deepEqual(await refusedPhotos(db), [{ prospect_id: 't.com', n: 1 }], 'the refused photo is flagged');
  // Next morning: the refused photo is tried again (also once the draft is staged), until MAX_ATTEMPTS.
  db.db.exec(`UPDATE page_drafts SET status = 'built'`);
  for (let day = 2; day <= MAX_ATTEMPTS + 1; day++) {
    db.db.exec(`UPDATE photo_mirror SET fetched_at = datetime('now', '-1 day')`);
    const r = await mirrorPhotos(env);
    assert.equal(r.failed, day <= MAX_ATTEMPTS ? 1 : 0, `day ${day}`);
  }
  assert.equal(db.rows(`SELECT attempts FROM photo_mirror WHERE status = 'failed'`)[0]?.attempts, MAX_ATTEMPTS);
  assert.equal(calls, 2 + MAX_ATTEMPTS - 1, 'the good photo is never fetched again');
  const rows = db.rows(`SELECT status, error FROM photo_mirror ORDER BY status`);
  assert.deepEqual(rows.map((r) => r.status), ['failed', 'ok']);
  const key = await photoKey('https://t.com/ok.jpg');
  const res = await servePhoto(env, key);
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, 5000);
  assert.equal((await servePhoto(env, '../secret')).status, 404);
});
