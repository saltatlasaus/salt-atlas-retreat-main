// Photo mirror: copies every photo a ready page draft uses from the resort's own website into R2,
// and serves it from this Worker at /photo/<key>. Some resort sites refuse Cloudflare's servers (HTTP 520/403):
// those are retried on later mornings (MAX_ATTEMPTS), flagged by the 07:30 watchdog, and can be fetched from a
// computer with internet with tools/fetch_failed_photos.py. The daily staging task points staged pages at these
// copies, so they never depend on hotlinking; at go-live tools/pull_pages.py converts them to WebP
// in the website repo. Runs on the 06:30 UTC cron (after the 01:53 to 05:53 gap-fill sessions, before 07:03 staging).

import type { D1Database, Env } from './types.ts';

const MAX_PER_RUN = 150;          // photos fetched per cron run (well inside the subrequest limit)
export const MAX_ATTEMPTS = 3;    // refused photos are retried on later mornings, then left to tools/fetch_failed_photos.py
const MAX_BYTES = 15 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; SaltAtlasPhotoMirror/1.0; +https://www.saltatlas.com)';

/** Deterministic key for a photo URL: 32 hex chars of SHA-256, plus a guessed extension. */
export async function photoKey(url: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  const ext = (/\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.exec(url)?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
  return `${hex}.${ext}`;
}

/** Every external photo URL in a kit JSON (src / poster fields), skipping our own hosts. */
export function photoUrls(kit: unknown, own: string[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((k === 'src' || k === 'poster') && typeof x === 'string' && /^https?:\/\//.test(x) && !own.some((o) => x.includes(o))) out.add(x);
        else walk(x);
      }
    }
  };
  walk(kit);
  return [...out];
}

export async function mirrorPhotos(env: Env): Promise<{ fetched: number; failed: number; skipped: number }> {
  const db: D1Database = env.DB;
  const own = ['saltatlas.com', new URL(env.PUBLIC_URL).host];
  // Ready drafts, plus staged ones still under review, so a photo refused yesterday gets another try.
  const drafts = await db.prepare(`SELECT prospect_id, kit_json FROM page_drafts WHERE status IN ('ready', 'built') AND kit_json <> '{}' ORDER BY status DESC`).all<{ prospect_id: string; kit_json: string }>();
  // Skip copies we have, photos that failed MAX_ATTEMPTS times, and anything already tried in the last 20 hours.
  const done = new Set(
    (await db
      .prepare(`SELECT url FROM photo_mirror WHERE status = 'ok' OR attempts >= ?1 OR fetched_at > datetime('now', '-20 hours')`)
      .bind(MAX_ATTEMPTS)
      .all<{ url: string }>()).results.map((r) => r.url),
  );
  let fetched = 0, failed = 0, skipped = 0;
  for (const d of drafts.results) {
    let kit: unknown;
    try { kit = JSON.parse(d.kit_json); } catch { continue; }
    for (const url of photoUrls(kit, own)) {
      if (done.has(url)) { skipped++; continue; }
      if (fetched + failed >= MAX_PER_RUN) return { fetched, failed, skipped };
      const key = await photoKey(url);
      let status = 'failed', bytes = 0, type = '', error: string | null = null;
      try {
        const origin = new URL(url).origin + '/';
        const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: origin, Accept: 'image/*' }, redirect: 'follow' });
        type = res.headers.get('content-type') || '';
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
        const buf = await res.arrayBuffer();
        bytes = buf.byteLength;
        if (bytes > MAX_BYTES) throw new Error(`too large (${bytes} bytes)`);
        if (bytes < 2000) throw new Error('too small');
        await env.SCRAPE_BUCKET.put(`photos/${key}`, buf, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
        status = 'ok';
        fetched++;
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        failed++;
      }
      done.add(url);
      await db
        .prepare(`INSERT INTO photo_mirror (url, key, prospect_id, status, bytes, content_type, error, fetched_at, attempts)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), 1)
                  ON CONFLICT(url) DO UPDATE SET key = excluded.key, status = excluded.status, bytes = excluded.bytes,
                    content_type = excluded.content_type, error = excluded.error, fetched_at = excluded.fetched_at,
                    attempts = photo_mirror.attempts + 1`)
        .bind(url, key, d.prospect_id, status, bytes, type, error)
        .run();
    }
  }
  return { fetched, failed, skipped };
}

/** GET /photo/<key>: public, long-cached copy of a mirrored photo. */
export async function servePhoto(env: Env, key: string): Promise<Response> {
  if (!/^[0-9a-f]{32}\.(jpg|png|webp|gif|avif)$/.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.SCRAPE_BUCKET.get(`photos/${key}`);
  if (!obj || !obj.body) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** Photos still missing for drafts under review, per resort (for the 07:30 watchdog's Teams message). */
export async function refusedPhotos(db: D1Database): Promise<{ prospect_id: string; n: number }[]> {
  return (await db
    .prepare(`SELECT m.prospect_id, count(*) AS n FROM photo_mirror m
              WHERE m.status = 'failed' AND m.fetched_at > datetime('now', '-20 hours')
                AND EXISTS (SELECT 1 FROM page_drafts d WHERE d.prospect_id = m.prospect_id AND d.status IN ('ready', 'built'))
              GROUP BY m.prospect_id ORDER BY n DESC`)
    .all<{ prospect_id: string; n: number }>()).results;
}

/** GET /img/<images.id>: any crawled photo candidate, so the gap-fill session can look at a photo before
 *  choosing it for a slot. Only ids in the images table are served (not an open proxy). The copy is kept in
 *  R2 under the same key the 06:30 run uses, so a chosen photo is never fetched twice. */
export async function serveCandidate(env: Env, idText: string): Promise<Response> {
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare(`SELECT image_url, prospect_id FROM images WHERE id = ?1`).bind(id).first<{ image_url: string; prospect_id: string }>();
  if (!row) return new Response('Not found', { status: 404 });
  const key = await photoKey(row.image_url);
  const cached = await env.SCRAPE_BUCKET.get(`photos/${key}`);
  if (cached && cached.body) {
    return new Response(cached.body, { headers: { 'Content-Type': cached.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
  }
  let status = 'failed', bytes = 0, type = '', error: string | null = null, buf: ArrayBuffer | null = null;
  try {
    const res = await fetch(row.image_url, { headers: { 'User-Agent': UA, Referer: new URL(row.image_url).origin + '/', Accept: 'image/*' }, redirect: 'follow' });
    type = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
    buf = await res.arrayBuffer();
    bytes = buf.byteLength;
    if (bytes > MAX_BYTES) throw new Error(`too large (${bytes} bytes)`);
    if (bytes < 2000) throw new Error('too small');
    await env.SCRAPE_BUCKET.put(`photos/${key}`, buf, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
    status = 'ok';
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  await env.DB
    .prepare(`INSERT INTO photo_mirror (url, key, prospect_id, status, bytes, content_type, error, fetched_at, attempts)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), 1)
              ON CONFLICT(url) DO UPDATE SET key = excluded.key, status = excluded.status, bytes = excluded.bytes,
                content_type = excluded.content_type, error = excluded.error, fetched_at = excluded.fetched_at,
                attempts = photo_mirror.attempts + 1`)
    .bind(row.image_url, key, row.prospect_id, status, bytes, type, error)
    .run();
  if (status !== 'ok' || !buf) return new Response(`The resort's site refused this photo (${error})`, { status: 502 });
  return new Response(buf, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
}
