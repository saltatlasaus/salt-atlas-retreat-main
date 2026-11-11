// Cron dispatch, kept free of Worker-only imports so it can be tested with plain Node.

/** Which job a cron firing is, decided by its UTC time (not by comparing cron strings, which is brittle). */
export function jobFor(scheduledTime: number): 'watchdog' | 'photos' | 'evening_crawl' | 'crawl' {
  const d = new Date(scheduledTime);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  if (m === 30 && h === 7) return 'watchdog';
  if (m === 30 && h >= 3 && h <= 6) return 'photos';
  if (h === 20) return 'evening_crawl';
  return 'crawl';
}
