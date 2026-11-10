// The daily crawl as a Cloudflare Workflow. Each step is durable: if anything crashes,
// that step (and only that step) is retried, and finished steps are never repeated.
//
//  claim batch -> start Apify (primary, then retry) -> wait for webhook or poll -> process
//  results in chunks -> reconcile missing pages -> read image sizes -> build briefs -> report

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { abortRun, buildCrawlInput, getRun, recentRuns, startRun, TERMINAL, type RunKind } from './apify.ts';
import { buildBrief } from './brief.ts';
import { claimBatch, getCrawlRun, indexByKey, logEvent, prospectsInBatch, upsertCrawlRun } from './db.ts';
import { postToTeams } from './notify.ts';
import { PAGE_SIZE, processChunk, reconcile, sniffRound } from './pipeline.ts';
import type { Env } from './types.ts';
import { interleaveByDomain } from './urls.ts';

export interface CrawlParams {
  batch: string; // YYYY-MM-DD
  trigger: 'cron' | 'manual';
}

const WAIT_CYCLES = 12; // x 15 minutes = 3 hours before we abort a stuck crawl
const SHORT = { retries: { limit: 3, delay: '20 seconds', backoff: 'exponential' as const }, timeout: '5 minutes' };
const LONG = { retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' as const }, timeout: '15 minutes' };

export function webhookUrl(env: Env, instanceId: string, kind: RunKind): string {
  const base = env.PUBLIC_URL.replace(/\/+$/, '');
  const qs = new URLSearchParams({ instance: instanceId, kind, key: env.WEBHOOK_SECRET });
  return `${base}/apify/webhook?${qs}`;
}

export class CrawlWorkflow extends WorkflowEntrypoint<Env, CrawlParams> {
  async run(event: WorkflowEvent<CrawlParams>, step: WorkflowStep) {
    const env = this.env;
    const { batch } = event.payload;
    const instanceId = event.instanceId;

    try {
      const claim = await step.do('claim batch', SHORT, async () => {
        if (!env.APIFY_TOKEN || !env.WEBHOOK_SECRET || !env.PUBLIC_URL) {
          throw new NonRetryableError('Missing APIFY_TOKEN, WEBHOOK_SECRET or PUBLIC_URL');
        }
        const rows = await claimBatch(env.DB, batch, Number(env.MAX_URLS_PER_DAY || 300));
        const groups = indexByKey(rows);
        const primary: { url: string }[] = [];
        const retry: { url: string }[] = [];
        for (const [, group] of groups) {
          const item = { url: group[0].url };
          (group.some((g) => g.retry_count >= 1) ? retry : primary).push(item);
        }
        const out = {
          primary: interleaveByDomain(primary).map((x) => x.url),
          retry: interleaveByDomain(retry).map((x) => x.url),
          rows: rows.length,
        };
        await logEvent(env.DB, instanceId, 'claimed', { batch, rows: rows.length, primary: out.primary.length, retry: out.retry.length });
        return out;
      });

      if (claim.primary.length + claim.retry.length === 0) {
        await step.do('report empty', SHORT, async () => {
          await logEvent(env.DB, instanceId, 'nothing_to_crawl', { batch });
        });
        return { batch, crawled: 0 };
      }

      const results: Record<string, unknown>[] = [];
      for (const kind of ['primary', 'retry'] as const) {
        const urls = claim[kind];
        if (!urls.length) continue;
        const runRowId = `${instanceId}:${kind}`;

        // 1. Start the Apify run. Never starts a second run if a previous attempt already did.
        const started = await step.do(`start apify ${kind}`, { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '5 minutes' }, async () => {
          const existing = await getCrawlRun(env.DB, runRowId);
          if (existing?.apify_run_id) {
            return { runId: String(existing.apify_run_id), datasetId: String(existing.dataset_id), kvId: String(existing.kv_store_id) };
          }
          if (existing?.status === 'starting' && existing.started_at) {
            const adopt = (await recentRuns(env, String(existing.started_at)))[0];
            if (adopt) {
              await upsertCrawlRun(env.DB, { id: runRowId, apify_run_id: adopt.id, status: adopt.status, dataset_id: adopt.defaultDatasetId, kv_store_id: adopt.defaultKeyValueStoreId });
              return { runId: adopt.id, datasetId: adopt.defaultDatasetId, kvId: adopt.defaultKeyValueStoreId };
            }
          }
          const startedAt = new Date(Date.now() - 5000).toISOString();
          await upsertCrawlRun(env.DB, { id: runRowId, instance_id: instanceId, batch, kind, status: 'starting', url_count: urls.length, claimed_at: startedAt, started_at: startedAt });
          const run = await startRun(env, buildCrawlInput(urls, kind, env), webhookUrl(env, instanceId, kind));
          await upsertCrawlRun(env.DB, { id: runRowId, apify_run_id: run.id, status: run.status, dataset_id: run.defaultDatasetId, kv_store_id: run.defaultKeyValueStoreId });
          return { runId: run.id, datasetId: run.defaultDatasetId, kvId: run.defaultKeyValueStoreId };
        });

        // 2. Wait: the webhook wakes us early; polling every 15 minutes is the guarantee.
        let final: { status: string; usage: number | null } | null = null;
        for (let i = 0; i < WAIT_CYCLES && !final; i++) {
          try {
            await step.waitForEvent(`wait ${kind} ${i}`, { type: `apify-${kind}`, timeout: '15 minutes' });
          } catch {
            /* timed out: fall through to a status check */
          }
          const st = await step.do(`check ${kind} ${i}`, SHORT, async () => {
            const r = await getRun(env, started.runId);
            return { status: r.status, usage: r.usageTotalUsd ?? null };
          });
          if (TERMINAL.has(st.status)) final = st;
        }
        if (!final) {
          // Stuck for 3 hours: stop paying for it and keep whatever it already collected.
          final = await step.do(`abort ${kind}`, LONG, async () => {
            await abortRun(env, started.runId);
            for (let t = 0; t < 20; t++) {
              const r = await getRun(env, started.runId);
              if (TERMINAL.has(r.status)) return { status: r.status, usage: r.usageTotalUsd ?? null };
              await new Promise((res) => setTimeout(res, 15000));
            }
            return { status: 'ABORTED', usage: null };
          });
          await step.do(`log abort ${kind}`, SHORT, () => logEvent(env.DB, instanceId, 'aborted_stuck_run', { kind, runId: started.runId }));
        }

        // 3. Process results in small chunks; each chunk is its own retryable step.
        let processed = 0;
        for (let offset = 0; offset < 5000; offset += PAGE_SIZE) {
          const n = await step.do(`process ${kind} ${offset}`, LONG, async () =>
            processChunk(env, { batch, kind, runRowId, datasetId: started.datasetId, offset }),
          );
          processed += n;
          if (n < PAGE_SIZE) break;
        }

        // 4. Anything we asked for and did not get back.
        const summary = await step.do(`reconcile ${kind}`, LONG, async () =>
          reconcile(env, { batch, kind, runRowId, runId: started.runId, kvId: started.kvId, urls, processed, final: final! }),
        );
        results.push(summary);
      }

      // 5. Read pixel sizes for top images whose size the page did not state.
      for (let round = 0; round < 10; round++) {
        const n = await step.do(`image sizes ${round}`, LONG, async () => sniffRound(env, batch));
        if (n === 0) break;
      }

      // 6. Briefs: one per prospect touched today.
      const pids = await step.do('list prospects', SHORT, () => prospectsInBatch(env.DB, batch));
      for (let i = 0; i < pids.length; i += 6) {
        const chunk = pids.slice(i, i + 6);
        await step.do(`briefs ${i}`, LONG, async () => {
          for (const pid of chunk) await buildBrief(env.DB, env.SCRAPE_BUCKET, pid);
          return chunk.length;
        });
      }

      // 7. Report.
      await step.do('report', SHORT, async () => {
        const counts = await env.DB
          .prepare(`SELECT crawl_status, COALESCE(fail_reason, '') AS reason, count(*) AS n FROM sources WHERE crawl_run_id LIKE ?1 || ':%' GROUP BY 1, 2 ORDER BY n DESC`)
          .bind(instanceId)
          .all<{ crawl_status: string; reason: string; n: number }>();
        const imgs = await env.DB.prepare(`SELECT count(*) AS n FROM images WHERE batch = ?1`).bind(batch).first<{ n: number }>();
        const ok = counts.results.filter((r) => r.crawl_status === 'crawled').reduce((a, r) => a + r.n, 0);
        const bad = counts.results.filter((r) => r.crawl_status !== 'crawled');
        const usd = results.reduce((a, r) => a + Number(r.usage || 0), 0);
        const facts: [string, string][] = [
          ['Batch', batch],
          ['Pages read', String(ok)],
          ['Pages not read', bad.length ? bad.map((r) => `${r.n} × ${r.reason.split(':')[0] || r.crawl_status}`).join(', ') : '0'],
          ['Photo links stored', String(imgs?.n ?? 0)],
          ['Briefs updated', String(pids.length)],
          ['Apify cost', usd ? `US$${usd.toFixed(2)}` : 'n/a'],
        ];
        await logEvent(env.DB, instanceId, 'finished', Object.fromEntries(facts));
        await postToTeams(env, `🌊 Crawl ${batch} finished`, facts, bad.length > ok);
      });
      return { batch, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do('report failure', SHORT, async () => {
        await logEvent(env.DB, instanceId, 'failed', message);
        await postToTeams(env, `⚠️ Crawl ${batch} failed`, [['Instance', instanceId], ['Error', message.slice(0, 300)]], true,
          'Finished steps are kept. Fix the cause, then restart with POST /admin/crawl?date=' + batch + '&force=1');
      });
      throw err;
    }
  }
}
