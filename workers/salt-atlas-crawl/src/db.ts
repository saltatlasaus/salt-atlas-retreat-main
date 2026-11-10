// All database access for the crawl pipeline. Every write is idempotent, so a workflow
// step that is retried after a crash can safely run again.

import type { BatchSource, D1Database, D1PreparedStatement, ImageCandidate, PageExtract } from './types.ts';
import { isHomePath, matchKey } from './urls.ts';

/** Reasons that mean "do not try this URL again"; the scout should log a replacement page. */
export const PERMANENT_REASONS = new Set(['gone', 'parked', 'redirect_home', 'robots', 'off_site']);

const now = () => new Date().toISOString();

/**
 * Tag today's work with the batch date and return it. Re-running this is safe: it returns the
 * same rows (plus anything newly added) and never claims a URL that is already finished.
 */
export async function claimBatch(db: D1Database, batch: string, maxUrls: number): Promise<BatchSource[]> {
  await db
    .prepare(
      `UPDATE sources SET batch = ?1
       WHERE id IN (
         SELECT s.id FROM sources s JOIN prospects p ON p.id = s.prospect_id
         WHERE s.tag = 'operator' AND COALESCE(p.status, 'new') <> 'rejected'
           -- Unclaimed, or left in an older batch (logged with a date by the scout, or a crawl
           -- that died) as long as no crawl for that older batch is still running.
           AND (s.batch IS NULL
                OR (s.batch < ?1 AND NOT EXISTS (
                      SELECT 1 FROM crawl_runs r
                      WHERE r.batch = s.batch AND r.finished_at IS NULL
                        AND r.claimed_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-12 hours'))))
           AND (s.crawl_status = 'pending'
                OR (s.crawl_status = 'failed' AND COALESCE(s.retry_count, 0) < 2))
         ORDER BY s.retry_count ASC, s.created_at ASC
         LIMIT ?2)`,
    )
    .bind(batch, maxUrls)
    .run();
  const rows = await db
    .prepare(
      `SELECT s.id, s.prospect_id, s.url, s.feeds, COALESCE(s.retry_count, 0) AS retry_count, p.country
       FROM sources s JOIN prospects p ON p.id = s.prospect_id
       WHERE s.batch = ?1 AND s.tag = 'operator' AND s.crawl_status IN ('pending', 'failed')
       ORDER BY s.id`,
    )
    .bind(batch)
    .all<BatchSource>();
  return rows.results;
}

/** Group batch rows by match key so one crawled page can update several identical rows. */
export function indexByKey(rows: BatchSource[]): Map<string, BatchSource[]> {
  const m = new Map<string, BatchSource[]>();
  for (const r of rows) {
    const k = matchKey(r.url);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

/**
 * Insert or update one crawl_runs row. Callers often pass only the fields that changed, so the
 * required columns are filled from the id ("<instance>:<kind>", instance = "crawl-YYYY-MM-DD[...]")
 * — SQLite checks NOT NULL before ON CONFLICT, so a partial insert would otherwise fail.
 */
export async function upsertCrawlRun(db: D1Database, fields: Record<string, unknown> & { id: string }): Promise<void> {
  const cut = fields.id.lastIndexOf(':');
  const instance = cut > 0 ? fields.id.slice(0, cut) : fields.id;
  const kind = cut > 0 ? fields.id.slice(cut + 1) : null;
  const defaults: Record<string, unknown> = {
    instance_id: instance,
    batch: instance.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? 'unknown',
    kind: kind === 'primary' || kind === 'retry' ? kind : null,
  };
  const row: Record<string, unknown> = { ...fields };
  const fillOnly = new Set<string>();
  for (const [k, v] of Object.entries(defaults)) {
    if (row[k] === undefined || row[k] === null) {
      row[k] = v;
      fillOnly.add(k); // used for a fresh insert, never overwrites an existing value
    }
  }
  const cols = Object.keys(row);
  const placeholders = cols.map((_, i) => `?${i + 1}`).join(', ');
  const updates = cols.filter((c) => c !== 'id' && !fillOnly.has(c)).map((c) => `${c} = excluded.${c}`).join(', ');
  await db
    .prepare(`INSERT INTO crawl_runs (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(id) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`)
    .bind(...cols.map((c) => row[c] ?? null))
    .run();
}

export async function getCrawlRun(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  return db.prepare(`SELECT * FROM crawl_runs WHERE id = ?1`).bind(id).first();
}

export async function logEvent(db: D1Database, runId: string, event: string, detail: unknown): Promise<void> {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  await db.prepare(`INSERT INTO run_log (run_id, event, detail) VALUES (?1, ?2, ?3)`).bind(runId, event, text.slice(0, 4000)).run();
}

/** Statements that record one parsed page: source rows, images, contacts, documents. One batch = one transaction. */
export function pageStatements(
  db: D1Database,
  args: {
    sources: BatchSource[];
    extract: PageExtract;
    crawlRunId: string;
    crawler: string;
    batch: string;
    extractKey: string;
    htmlKey: string | null;
    pageOk: boolean;
  },
): D1PreparedStatement[] {
  const { sources, extract: x, crawlRunId, crawler, batch, extractKey, htmlKey, pageOk } = args;
  const out: D1PreparedStatement[] = [];
  const t = now();
  const permanent = PERMANENT_REASONS.has(x.status);
  for (const s of sources) {
    if (pageOk) {
      out.push(
        db.prepare(
          `UPDATE sources SET crawl_status = 'crawled', fail_reason = NULL, crawl_run_id = ?2, crawler = ?3,
             final_url = ?4, http_status = ?5, content_chars = ?6, language = ?7, page_title = ?8,
             r2_key = ?9, html_r2_key = ?10, parsed_at = ?11
           WHERE id = ?1`,
        ).bind(s.id, crawlRunId, crawler, x.finalUrl, x.httpStatus, x.chars, x.language, x.title, extractKey, htmlKey, t),
      );
    } else {
      out.push(
        db.prepare(
          `UPDATE sources SET crawl_status = 'failed', fail_reason = ?2, crawl_run_id = ?3, crawler = ?4,
             final_url = ?5, http_status = ?6, content_chars = ?7, page_title = ?8, r2_key = ?9, html_r2_key = ?10,
             parsed_at = ?11, batch = NULL,
             retry_count = CASE WHEN ?12 = 1 THEN 99 ELSE COALESCE(retry_count, 0) + 1 END
           WHERE id = ?1`,
        ).bind(s.id, x.status + (x.statusDetail ? `: ${x.statusDetail}` : ''), crawlRunId, crawler, x.finalUrl, x.httpStatus, x.chars, x.title, extractKey, htmlKey, t, permanent ? 1 : 0),
      );
    }
  }
  if (!pageOk) {
    // A dead homepage means the operator's site is gone: worth flagging to the reviewer.
    if (permanent && isHomePath(x.url)) {
      for (const pid of new Set(sources.map((s) => s.prospect_id))) {
        out.push(db.prepare(`UPDATE prospects SET website_status = ?2 WHERE id = ?1`).bind(pid, `dead: ${x.status}`));
      }
    }
    return out;
  }

  const prospectIds = [...new Set(sources.map((s) => s.prospect_id))];
  for (const pid of prospectIds) {
    const sourceId = sources.find((s) => s.prospect_id === pid)!.id;
    for (const img of x.images) out.push(imageStatement(db, pid, sourceId, x.finalUrl, img, batch, t));
    for (const c of x.contacts) {
      const evidence = `${c.evidence}${c.sameDomain === false ? ', other domain' : ''}${c.localFormat ? ', written without country code' : ''}`;
      out.push(
        db.prepare(
          `INSERT INTO contacts (prospect_id, kind, value, evidence, source_url, source_tag, found_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'operator', 'parser', ?6)
           ON CONFLICT DO NOTHING`,
        ).bind(pid, c.kind, c.value, evidence, x.finalUrl, t),
      );
    }
    for (const d of x.documents) {
      out.push(
        db.prepare(`INSERT INTO documents (prospect_id, url, batch) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING`).bind(pid, d, batch),
      );
    }
    if (x.status === 'ok') {
      out.push(db.prepare(`UPDATE prospects SET website_status = 'ok' WHERE id = ?1 AND website_status IS NULL`).bind(pid));
    }
  }
  return out;
}

function imageStatement(db: D1Database, pid: string, sourceId: number, pageUrl: string, img: ImageCandidate, batch: string, t: string): D1PreparedStatement {
  // Upsert on the size-independent key; keep the larger known size and the better score.
  return db
    .prepare(
      `INSERT INTO images (prospect_id, source_id, page_url, image_url, width, height, width_hint, alt, section,
                           canonical_key, discovery, rank_score, third_party, batch, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT(prospect_id, canonical_key) DO UPDATE SET
         width = MAX(COALESCE(images.width, 0), COALESCE(excluded.width, 0)),
         height = COALESCE(images.height, excluded.height),
         width_hint = MAX(COALESCE(images.width_hint, 0), COALESCE(excluded.width_hint, 0)),
         alt = CASE WHEN COALESCE(images.alt, '') = '' THEN excluded.alt ELSE images.alt END,
         rank_score = MAX(COALESCE(images.rank_score, 0), excluded.rank_score),
         section = CASE WHEN excluded.section = 'hero' THEN 'hero' ELSE images.section END,
         updated_at = excluded.updated_at
       ON CONFLICT DO NOTHING`,
    )
    .bind(pid, sourceId, pageUrl, img.url, img.width, img.height, img.widthHint, img.alt.slice(0, 160), img.section, img.canonicalKey, img.discovery, img.score, img.thirdParty ? 1 : 0, batch, t);
}

/** URLs the crawler never returned. A failed Apify run is not the page's fault, so it is released without penalty. */
export function releaseStatements(db: D1Database, ids: number[], reason: string, penalise: boolean, crawlRunId: string): D1PreparedStatement[] {
  const permanent = PERMANENT_REASONS.has(reason.split(':')[0]);
  const robots = /robots/i.test(reason);
  return ids.map((id) =>
    penalise
      ? db
          .prepare(
            `UPDATE sources SET crawl_status = ?2, fail_reason = ?3, batch = NULL, crawl_run_id = ?4,
               retry_count = CASE WHEN ?5 = 1 THEN 99 ELSE COALESCE(retry_count, 0) + 1 END
             WHERE id = ?1 AND crawl_status IN ('pending', 'failed')`,
          )
          .bind(id, robots ? 'skip' : 'failed', reason.slice(0, 200), crawlRunId, permanent || robots ? 1 : 0)
      : db
          .prepare(`UPDATE sources SET batch = NULL, fail_reason = ?2 WHERE id = ?1 AND crawl_status IN ('pending', 'failed')`)
          .bind(id, `not crawled: ${reason}`.slice(0, 200)),
  );
}

/** Images that need their size read from the file: no known width, top-ranked, not yet tried. */
export async function imagesToSniff(db: D1Database, batch: string, perProspect: number): Promise<{ id: number; image_url: string }[]> {
  const res = await db
    .prepare(
      `SELECT id, image_url FROM (
         SELECT id, image_url, ROW_NUMBER() OVER (PARTITION BY prospect_id ORDER BY rank_score DESC) AS rn
         FROM images WHERE batch = ?1 AND width IS NULL AND COALESCE(sniffed, 0) = 0 AND COALESCE(third_party, 0) = 0)
       WHERE rn <= ?2 LIMIT 400`,
    )
    .bind(batch, perProspect)
    .all<{ id: number; image_url: string }>();
  return res.results;
}

export async function prospectsInBatch(db: D1Database, batch: string): Promise<string[]> {
  const res = await db
    .prepare(`SELECT DISTINCT prospect_id FROM sources WHERE batch = ?1 OR (parsed_at >= ?2 AND parsed_at < ?3)`)
    .bind(batch, `${batch}T00:00:00`, `${batch}T99`)
    .all<{ prospect_id: string }>();
  return res.results.map((r) => r.prospect_id);
}
