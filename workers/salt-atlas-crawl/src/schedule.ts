// Cron dispatch, kept free of Worker-only imports so it can be tested with plain Node.

export type Job = 'watchdog' | 'photos' | 'auto_crawl' | 'crawl';

/** Which job a cron firing is, decided by its UTC time (not by comparing cron strings, which is brittle).
 *  Must match "triggers.crons" in wrangler.jsonc. */
export function jobFor(scheduledTime: number): Job {
  const d = new Date(scheduledTime);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  if (m === 30 && h === 7) return 'watchdog';
  if (m === 30 && h >= 3 && h <= 6) return 'photos';
  if (m === 7 || m === 22 || m === 37 || m === 52) return 'auto_crawl';
  return 'crawl';
}

/** Minutes the scout must have been quiet (no new pending pages) before an automatic crawl starts. */
export const QUIET_MINUTES = 20;
