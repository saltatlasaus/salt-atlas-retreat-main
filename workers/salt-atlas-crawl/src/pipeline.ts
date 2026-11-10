// The work done inside the workflow's steps, kept free of Workflow imports so it can be
// tested in Node against a local SQLite copy of the database.

import { datasetPage, fetchRecord, skippedUrls, type RunKind } from './apify.ts';
import { indexByKey, imagesToSniff, logEvent, pageStatements, releaseStatements, upsertCrawlRun } from './db.ts';
import { postToTeams } from './notify.ts';
import { processPage, sameSiteAsProspect } from './process.ts';
import { sniffRemoteSize } from './sniff.ts';
import type { BatchSource, Env, PageExtract, WccItem } from './types.ts';
import { looseKey, matchKey, safeUrl, shortHash } from './urls.ts';

export const PAGE_SIZE = 15; // dataset items per processing step (keeps each step well inside CPU limits)

/** Process one page of the Apify dataset. Returns how many items it read. */
export async function processChunk(env: Env, a: { batch: string; kind: RunKind; runRowId: string; datasetId: string; offset: number }): Promise<number> {
  const items = await datasetPage(env, a.datasetId, a.offset, PAGE_SIZE);
  if (!items.length) return 0;
  // Rows still in today's batch (crawled rows keep their batch; finished failures do not).
  const rows = (
    await env.DB
      .prepare(`SELECT s.id, s.prospect_id, s.url, s.feeds, COALESCE(s.retry_count, 0) AS retry_count, p.country
                FROM sources s JOIN prospects p ON p.id = s.prospect_id WHERE s.batch = ?1 AND s.tag = 'operator'`)
      .bind(a.batch)
      .all<BatchSource>()
  ).results;
  const exact = indexByKey(rows);
  const loose = new Map<string, BatchSource[]>();
  for (const [k, v] of exact) {
    const lk = looseKey('https://' + k);
    if (lk) loose.set(lk, [...(loose.get(lk) || []), ...v]);
  }
  const byDomain = new Map(rows.map((r) => [r.prospect_id, r]));

  await pool(items, 4, async (item) => {
    try {
      await handleItem(env, a, item, exact, loose, byDomain);
    } catch (e) {
      // One bad page must not sink the chunk; it shows up as "not returned" in reconcile.
      await logEvent(env.DB, a.runRowId, 'item_error', { url: item.url, error: e instanceof Error ? e.message : String(e) });
    }
  });
  await env.DB.prepare(`UPDATE crawl_runs SET items_processed = MAX(COALESCE(items_processed, 0), ?2) WHERE id = ?1`).bind(a.runRowId, a.offset + items.length).run();
  return items.length;
}

async function handleItem(
  env: Env,
  a: { batch: string; kind: RunKind; runRowId: string },
  item: WccItem,
  exact: Map<string, BatchSource[]>,
  loose: Map<string, BatchSource[]>,
  byDomain: Map<string, BatchSource>,
) {
  const candidates = [item.url, item.crawl?.loadedUrl];
  let sources: BatchSource[] | undefined;
  for (const c of candidates) sources ??= exact.get(matchKey(c) || '');
  for (const c of candidates) sources ??= loose.get(looseKey(c) || '');

  const isPdf = /pdf/i.test(item.crawl?.contentType || item.metadata?.headers?.['content-type'] || '') || /\.pdf(\?|$)/i.test(item.url || '');
  if (!sources) {
    if (isPdf && item.url) {
      // A rate sheet or brochure linked from one of today's pages: keep its text for the brief.
      const host = safeUrl(item.url)?.hostname.replace(/^www\./, '') || '';
      const owner = [...byDomain.values()].find((r) => host === r.prospect_id || host.endsWith('.' + r.prospect_id));
      if (owner) {
        const key = `docs/${owner.prospect_id}/${shortHash(item.url)}.txt`;
        const text = (item.text || item.markdown || '').slice(0, 200_000);
        await env.SCRAPE_BUCKET.put(key, text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
        await env.DB
          .prepare(`INSERT INTO documents (prospect_id, url, title, chars, r2_key, batch) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                    ON CONFLICT(prospect_id, url) DO UPDATE SET chars = excluded.chars, r2_key = excluded.r2_key, title = excluded.title`)
          .bind(owner.prospect_id, item.url, item.metadata?.title || null, text.length, key, a.batch)
          .run();
      }
    }
    return;
  }

  const lead = sources[0];
  const html = item.htmlUrl ? await fetchRecord(env, item.htmlUrl) : null;
  const extract: PageExtract = processPage({
    item, html, requestedUrl: lead.url, feeds: lead.feeds, prospectDomain: lead.prospect_id, country: lead.country,
  });
  if (extract.status === 'ok' && !sameSiteAsProspect(extract.finalUrl, lead.prospect_id)) {
    extract.status = 'off_site';
    extract.statusDetail = `now redirects to ${safeUrl(extract.finalUrl)?.hostname || extract.finalUrl}`;
  }
  const base = `crawl/${a.batch}/${lead.prospect_id}/${shortHash(lead.url)}`;
  const extractKey = `${base}.json`;
  const htmlKey = html ? `${base}.html` : null;
  // Raw HTML and markdown are kept so the parser can be improved and re-run without paying Apify again.
  await Promise.all([
    env.SCRAPE_BUCKET.put(extractKey, JSON.stringify(extract), { httpMetadata: { contentType: 'application/json' } }),
    html ? env.SCRAPE_BUCKET.put(htmlKey!, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' } }) : Promise.resolve(),
    item.markdown ? env.SCRAPE_BUCKET.put(`${base}.md`, item.markdown, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } }) : Promise.resolve(),
  ]);
  const crawler = a.kind === 'retry' ? 'playwright:firefox' : 'playwright:adaptive';
  await env.DB.batch(
    pageStatements(env.DB, {
      sources, extract, crawlRunId: a.runRowId, crawler, batch: a.batch, extractKey, htmlKey, pageOk: extract.status === 'ok',
    }),
  );
}

/** Mark every URL we asked for but never got back, with the best reason we can find. */
export async function reconcile(
  env: Env,
  a: { batch: string; kind: RunKind; runRowId: string; runId: string; kvId: string; urls: string[]; processed: number; final: { status: string; usage: number | null } },
): Promise<Record<string, unknown>> {
  const wanted = new Set(a.urls.map((u) => matchKey(u)));
  const rows = (
    await env.DB
      .prepare(`SELECT id, url FROM sources WHERE batch = ?1 AND tag = 'operator' AND crawl_status IN ('pending', 'failed')`)
      .bind(a.batch)
      .all<{ id: number; url: string }>()
  ).results.filter((r) => wanted.has(matchKey(r.url)));

  const runOk = a.final.status === 'SUCCEEDED' && a.processed > 0;
  const skipped = rows.length ? await skippedUrls(env, a.kvId) : new Map<string, string>();
  const byReason = new Map<string, number[]>();
  for (const r of rows) {
    const s = skipped.get(matchKey(r.url) || '');
    const reason = s ? (/robot/i.test(s) ? 'robots' : `skipped: ${s}`) : runOk ? 'not_returned' : `run ${a.final.status.toLowerCase()}`;
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason)!.push(r.id);
  }
  const stmts = [...byReason].flatMap(([reason, ids]) => releaseStatements(env.DB, ids, reason, runOk || reason === 'robots', a.runRowId));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  const tally = await env.DB
    .prepare(`SELECT SUM(crawl_status = 'crawled') AS ok, SUM(crawl_status <> 'crawled') AS bad FROM sources WHERE crawl_run_id = ?1`)
    .bind(a.runRowId)
    .first<{ ok: number | null; bad: number | null }>();
  const summary = {
    kind: a.kind, status: a.final.status, usage: a.final.usage, urls: a.urls.length, items: a.processed,
    ok: tally?.ok ?? 0, failed: tally?.bad ?? 0, notReturned: Object.fromEntries([...byReason].map(([k, v]) => [k, v.length])),
  };
  await upsertCrawlRun(env.DB, {
    id: a.runRowId, status: a.final.status, items_total: a.processed, pages_ok: summary.ok, pages_failed: summary.failed,
    usage_usd: a.final.usage, finished_at: new Date().toISOString(),
    error: runOk ? null : `Apify run ${a.final.status}; ${rows.length} URLs released without penalty`,
  });
  await logEvent(env.DB, a.runRowId, 'reconciled', summary);
  if (!runOk) await postToTeams(env, `⚠️ Apify ${a.kind} run ${a.final.status}`, [['Batch', a.batch], ['Run', a.runId], ['URLs put back in the queue', String(rows.length)]], true);
  return summary;
}

/** One round of size sniffing: up to 40 images, 5 at a time. Returns how many it tried. */
export async function sniffRound(env: Env, batch: string): Promise<number> {
  const list = (await imagesToSniff(env.DB, batch, 25)).slice(0, 40);
  if (!list.length) return 0;
  const results: { id: number; size: { width: number; height: number } | null }[] = [];
  await pool(list, 5, async (img) => {
    results.push({ id: img.id, size: await sniffRemoteSize(img.image_url) });
  });
  const stmts = results.map((r) =>
    r.size
      ? env.DB
          .prepare(
            `UPDATE images SET width = ?2, height = ?3, sniffed = 1,
               rank_score = MAX(0, MIN(100, COALESCE(rank_score, 0) - 12
                 + CASE WHEN ?2 >= 2000 THEN 30 WHEN ?2 >= 1600 THEN 26 WHEN ?2 >= 1200 THEN 22 WHEN ?2 >= 1000 THEN 14 WHEN ?2 >= 800 THEN 8 ELSE -20 END
                 + CASE WHEN ?2 * 1.0 / ?3 BETWEEN 1.3 AND 2.2 THEN 10 WHEN ?2 >= ?3 THEN 4 WHEN ?2 * 1.0 / ?3 < 0.9 THEN -4 ELSE 0 END))
             WHERE id = ?1`,
          )
          .bind(r.id, r.size.width, r.size.height)
      : env.DB.prepare(`UPDATE images SET sniffed = 1 WHERE id = ?1`).bind(r.id),
  );
  if (stmts.length) await env.DB.batch(stmts);
  return list.length;
}

/** Run `fn` over `items` with at most `n` in flight (Workers allow 6 open connections). */
export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}
