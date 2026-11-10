// The 9am review list: pages the 07:03 staging session put on the staging preview this morning,
// posted to Teams by the 07:30 watchdog with a preview link and what to check for each.

import type { D1Database } from './types.ts';

export const STAGING_BASE = 'https://staging.saltatlas-website.pages.dev/destinations/';

export interface StagedPage { slug: string; name: string; url: string; check: string }

/** Drafts marked staged ('built') in the last 2 hours, i.e. by this morning's staging run. */
export async function stagedForReview(db: D1Database): Promise<StagedPage[]> {
  const rows = (await db
    .prepare(`SELECT slug, kit_json, notes FROM page_drafts WHERE status = 'built' AND updated_at > datetime('now', '-2 hours') ORDER BY slug`)
    .all<{ slug: string; kit_json: string; notes: string | null }>()).results;
  return rows.map((r) => {
    let name = r.slug;
    try { name = (JSON.parse(r.kit_json) as { name?: string }).name || r.slug; } catch { /* keep the slug */ }
    // Drop the "· staged <date>" stamps the staging session appends; keep what a person must check.
    const check = (r.notes || '').replace(/\s*·\s*staged \S+/g, '').trim() || 'Nothing flagged';
    return { slug: r.slug, name, url: `${STAGING_BASE}${r.slug}/`, check: check.slice(0, 300) };
  });
}
