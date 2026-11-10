// Salt Atlas crawl Worker: entry points.
//
//   Cron 05:00 UTC   start today's crawl workflow (pages the scout logged the day before)
//   Cron 09:00 UTC   watchdog: alert if today's crawl failed or never ran
//   POST /apify/webhook          Apify says a run finished (wakes the workflow early)
//   GET  /health                 liveness check
//   Admin (Authorization: Bearer ADMIN_TOKEN):
//   POST /admin/crawl?date=YYYY-MM-DD[&force=1]   start a crawl now
//   GET  /admin/status?date=YYYY-MM-DD            workflow + database status for a batch
//   GET  /admin/brief?prospect=<domain>[&format=json]   the brief Claude reads
//   POST /admin/brief?prospect=<domain>           rebuild a brief
//   POST /admin/reparse?prospect=<domain>         re-run the parser on stored HTML (no Apify cost)

import { buildBrief } from './brief.ts';
import { logEvent, pageStatements } from './db.ts';
import { postToTeams } from './notify.ts';
import { processPage } from './process.ts';
import type { BatchSource, Env, PageExtract } from './types.ts';
import { CrawlWorkflow } from './workflow.ts';

export { CrawlWorkflow };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const today = (d = new Date()) => d.toISOString().slice(0, 10);
const validDate = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function startCrawl(env: Env, batch: string, trigger: 'cron' | 'manual', force: boolean): Promise<{ id: string; created: boolean }> {
  const id = force ? `crawl-${batch}-r${Date.now().toString(36)}` : `crawl-${batch}`;
  try {
    await env.CRAWL.create({ id, params: { batch, trigger } });
    return { id, created: true };
  } catch (e) {
    // The deterministic id makes a second cron firing (or a double click) harmless.
    if (/exist/i.test(e instanceof Error ? e.message : String(e))) return { id, created: false };
    throw e;
  }
}

async function handleWebhook(req: Request, env: Env, url: URL): Promise<Response> {
  if (!timingSafeEqual(url.searchParams.get('key') || '', env.WEBHOOK_SECRET || '')) return new Response('Forbidden', { status: 403 });
  const instanceId = url.searchParams.get('instance') || '';
  const kind = url.searchParams.get('kind') === 'retry' ? 'retry' : 'primary';
  let runId: string | null = null;
  try {
    const body = (await req.json()) as { eventData?: { actorRunId?: string } };
    runId = body?.eventData?.actorRunId ?? null;
  } catch {
    /* body is optional; the workflow re-reads the run from Apify anyway */
  }
  try {
    const instance = await env.CRAWL.get(instanceId);
    await instance.sendEvent({ type: `apify-${kind}`, payload: { runId } });
  } catch (e) {
    // Workflow not running (finished, or already past the wait): nothing to do. Return 200 so Apify stops retrying.
    console.log('webhook: could not deliver event', instanceId, e instanceof Error ? e.message : e);
  }
  return new Response('OK');
}

async function status(env: Env, batch: string): Promise<unknown> {
  const runs = await env.DB.prepare(`SELECT * FROM crawl_runs WHERE batch = ?1 ORDER BY started_at`).bind(batch).all();
  const pages = await env.DB
    .prepare(`SELECT crawl_status, COALESCE(fail_reason, '') AS reason, count(*) AS n FROM sources WHERE tag = 'operator' AND (batch = ?1 OR substr(parsed_at, 1, 10) = ?1) GROUP BY 1, 2 ORDER BY n DESC`)
    .bind(batch)
    .all();
  const queue = await env.DB.prepare(`SELECT crawl_status, count(*) AS n FROM sources WHERE tag = 'operator' AND batch IS NULL GROUP BY 1`).all();
  const log = await env.DB.prepare(`SELECT run_id, event, detail, created_at FROM run_log WHERE run_id LIKE 'crawl-' || ?1 || '%' ORDER BY id DESC LIMIT 25`).bind(batch).all();
  let workflow: unknown = null;
  try {
    workflow = await (await env.CRAWL.get(`crawl-${batch}`)).status();
  } catch {
    workflow = 'no instance for this date';
  }
  return { batch, workflow, runs: runs.results, pages: pages.results, queue_outside_batches: queue.results, log: log.results };
}

/** Re-run the parser on HTML already stored in R2. Costs nothing on Apify. */
async function reparse(env: Env, prospectId: string): Promise<unknown> {
  const rows = (
    await env.DB
      .prepare(`SELECT s.id, s.prospect_id, s.url, s.feeds, COALESCE(s.retry_count, 0) AS retry_count, p.country,
                       s.r2_key, s.html_r2_key, s.crawl_run_id, s.crawler, s.batch
                FROM sources s JOIN prospects p ON p.id = s.prospect_id
                WHERE s.prospect_id = ?1 AND s.tag = 'operator' AND s.html_r2_key IS NOT NULL`)
      .bind(prospectId)
      .all<BatchSource & { r2_key: string; html_r2_key: string; crawl_run_id: string; crawler: string; batch: string | null }>()
  ).results;
  let done = 0;
  for (const r of rows) {
    const [htmlObj, oldObj, mdObj] = await Promise.all([
      env.SCRAPE_BUCKET.get(r.html_r2_key),
      env.SCRAPE_BUCKET.get(r.r2_key),
      env.SCRAPE_BUCKET.get(r.html_r2_key.replace(/\.html$/, '.md')),
    ]);
    if (!htmlObj) continue;
    const old = oldObj ? (JSON.parse(await oldObj.text()) as PageExtract) : null;
    const extract = processPage({
      item: {
        url: r.url,
        markdown: mdObj ? await mdObj.text() : undefined,
        crawl: { loadedUrl: old?.finalUrl || r.url, httpStatusCode: old?.httpStatus ?? undefined },
        metadata: { title: old?.title, languageCode: old?.language, description: old?.description },
      },
      html: await htmlObj.text(),
      requestedUrl: r.url, feeds: r.feeds, prospectDomain: r.prospect_id, country: r.country,
    });
    await env.SCRAPE_BUCKET.put(r.r2_key, JSON.stringify(extract), { httpMetadata: { contentType: 'application/json' } });
    if (extract.status === 'ok') {
      await env.DB.batch(pageStatements(env.DB, {
        sources: [r], extract, crawlRunId: r.crawl_run_id || 'reparse', crawler: r.crawler || 'stored', batch: r.batch || 'reparse',
        extractKey: r.r2_key, htmlKey: r.html_r2_key, pageOk: true,
      }));
    }
    done++;
  }
  const brief = await buildBrief(env.DB, env.SCRAPE_BUCKET, prospectId);
  await logEvent(env.DB, 'reparse', 'reparsed', { prospectId, pages: done });
  return { prospect: prospectId, pagesReparsed: done, brief };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/apify/webhook' && req.method === 'POST') return handleWebhook(req, env, url);

    if (url.pathname.startsWith('/admin/')) {
      const auth = req.headers.get('Authorization') || '';
      if (!timingSafeEqual(auth, `Bearer ${env.ADMIN_TOKEN || ''}`) || !env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 });
      const date = validDate(url.searchParams.get('date')) || today();
      const prospect = url.searchParams.get('prospect') || '';
      try {
        if (url.pathname === '/admin/crawl' && req.method === 'POST') {
          return json(await startCrawl(env, date, 'manual', url.searchParams.get('force') === '1'));
        }
        if (url.pathname === '/admin/status') return json(await status(env, date));
        if (url.pathname === '/admin/brief' && prospect) {
          if (req.method === 'POST') return json(await buildBrief(env.DB, env.SCRAPE_BUCKET, prospect));
          if (url.searchParams.get('format') === 'json') {
            const obj = await env.SCRAPE_BUCKET.get(`briefs/${prospect}.json`);
            return obj ? new Response(await obj.text(), { headers: { 'Content-Type': 'application/json' } }) : json({ error: 'no brief yet' }, 404);
          }
          const row = await env.DB.prepare(`SELECT brief_md FROM prospects WHERE id = ?1`).bind(prospect).first<{ brief_md: string | null }>();
          return row?.brief_md
            ? new Response(row.brief_md, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
            : json({ error: 'no brief yet' }, 404);
        }
        if (url.pathname === '/admin/reparse' && req.method === 'POST' && prospect) return json(await reparse(env, prospect));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
      return json({ error: 'unknown admin route' }, 404);
    }
    void ctx;
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const batch = today(new Date(controller.scheduledTime));
    if (controller.cron === '0 9 * * *') {
      ctx.waitUntil(watchdog(env, batch));
      return;
    }
    ctx.waitUntil(
      startCrawl(env, batch, 'cron', false).then(
        (r) => logEvent(env.DB, r.id, r.created ? 'started' : 'already_started', { batch }),
        (e) => postToTeams(env, `⚠️ Crawl ${batch} could not start`, [['Error', String(e).slice(0, 300)]], true),
      ),
    );
  },
};

/** Evening check: tell a person if today's crawl failed or never started while work is waiting. */
async function watchdog(env: Env, batch: string): Promise<void> {
  let state = 'missing';
  try {
    state = (await (await env.CRAWL.get(`crawl-${batch}`)).status()).status;
  } catch {
    /* no instance */
  }
  if (state === 'complete' || state === 'running' || state === 'waiting') return;
  const waiting = await env.DB
    .prepare(`SELECT count(*) AS n FROM sources WHERE tag = 'operator' AND crawl_status = 'pending'`)
    .first<{ n: number }>();
  if ((waiting?.n ?? 0) === 0 && state === 'missing') return;
  await postToTeams(env, `⚠️ Crawl ${batch} needs a look`, [['Workflow state', state], ['Pages waiting', String(waiting?.n ?? 0)]], true,
    `Check GET /admin/status?date=${batch}, then restart with POST /admin/crawl?date=${batch}&force=1`);
}

// Minimal runtime types (the real ones come from @cloudflare/workers-types when installed).
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}
