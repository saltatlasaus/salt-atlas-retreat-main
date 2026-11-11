// Starting crawl workflows: by date (cron, admin) and automatically once the scout has finished.
// Kept free of Worker-only imports so it can be tested with plain Node.

import { logEvent } from './db.ts';
import { QUIET_MINUTES } from './schedule.ts';
import type { Env } from './types.ts';

export async function startCrawl(env: Env, batch: string, trigger: 'cron' | 'manual', force: boolean, suffix = ''): Promise<{ id: string; created: boolean }> {
  const id = force ? `crawl-${batch}-r${Date.now().toString(36)}` : `crawl-${batch}${suffix}`;
  try {
    await env.CRAWL.create({ id, params: { batch, trigger } });
    return { id, created: true };
  } catch (e) {
    // The deterministic id makes a second cron firing (or a double click) harmless.
    if (/exist/i.test(e instanceof Error ? e.message : String(e))) return { id, created: false };
    throw e;
  }
}

/**
 * Every 15 minutes: start a crawl by itself once the scout has finished logging pages, so nobody has to.
 * Starts only when operator pages are waiting, none was logged in the last QUIET_MINUTES (the scout is done),
 * and no crawl is still running. One id per 15-minute slot, so a double firing starts one run.
 */
export async function autoCrawl(env: Env, batch: string, scheduledTime: number): Promise<{ id: string; created: boolean } | null> {
  const waiting = await env.DB
    .prepare(
      `SELECT count(*) AS n, MAX(s.created_at) > datetime('now', ?1) AS busy
       FROM sources s JOIN prospects p ON p.id = s.prospect_id
       WHERE s.tag = 'operator' AND s.crawl_status = 'pending' AND s.batch IS NULL AND COALESCE(p.status, 'new') <> 'rejected'`,
    )
    .bind(`-${QUIET_MINUTES} minutes`)
    .first<{ n: number; busy: number | null }>();
  if (!waiting || !waiting.n || waiting.busy) return null;
  const running = await env.DB
    .prepare(
      `SELECT count(*) AS n FROM crawl_runs
       WHERE finished_at IS NULL AND COALESCE(started_at, claimed_at) > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-4 hours')`,
    )
    .first<{ n: number }>();
  if (running && running.n) return null;
  const t = new Date(scheduledTime);
  const slot = `-a${String(t.getUTCHours()).padStart(2, '0')}${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const r = await startCrawl(env, batch, 'cron', false, slot);
  await logEvent(env.DB, r.id, r.created ? 'started' : 'already_started', { batch, trigger: 'auto', pages_waiting: waiting.n });
  return r;
}
