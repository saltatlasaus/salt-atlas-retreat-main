// The prospect brief: one short Markdown document per resort that holds everything the
// crawl found, with the source page for every fact. Claude reads this instead of raw
// pages. Target size is about 10–14 KB (a few thousand tokens) however big the site is.

import type { D1Database, PageExtract, R2Bucket } from './types.ts';

export interface BriefInput {
  prospect: { id: string; name: string; country: string | null; region: string | null; type: string | null; website: string | null };
  pages: { url: string; status: string; reason: string | null; extract: PageExtract | null }[];
  images: { section: string; image_url: string; width: number | null; height: number | null; alt: string | null; rank_score: number | null; page_url: string }[];
  scoutContacts: { kind: string; value: string }[];
  documents: { url: string }[];
}

const SECTION_ORDER = ['hero', 'waves', 'rooms', 'amenities', 'gallery', 'getting_there', 'other'] as const;
const IMAGES_PER_SECTION: Record<string, number> = { hero: 4, waves: 5, rooms: 6, amenities: 4, gallery: 10, getting_there: 2, other: 3 };

function path(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/ (home)' : u.pathname;
  } catch {
    return url;
  }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s\S*$/, '') + '…';
}

/** Navigation menus show up as a pile of short links before the first heading. */
function looksLikeMenu(text: string): boolean {
  const bullets = (text.match(/•/g) || []).length;
  const words = text.split(/\s+/).length;
  return bullets >= 6 && words / Math.max(bullets, 1) < 4;
}

export function renderBrief(input: BriefInput, budget = 14000): { markdown: string; json: Record<string, unknown>; complete: boolean } {
  const { prospect: p, pages } = input;
  const ok = pages.filter((x) => x.status === 'crawled' && x.extract);
  const pending = pages.filter((x) => x.status === 'pending' || (x.status === 'failed' && !/^(gone|parked|redirect_home|robots|off_site)/.test(x.reason || '')));
  const complete = pending.length === 0;
  const L: string[] = [];

  L.push(`# ${p.name} — crawl brief`);
  L.push(`${p.id} · ${[p.region, p.country].filter(Boolean).join(', ')} · ${p.type || 'type unknown'} · ${ok.length}/${pages.length} pages read${complete ? '' : ' · more pages still to crawl'}`);
  L.push('Everything below was pulled from the operator\'s own pages by code. Treat prices and wave names as leads to check, not facts. Season and surf levels must come from public sources, not from here.');

  // Contacts: what the site shows, compared with what the scout recorded.
  const contacts = new Map<string, { kind: string; value: string; evidence: string; page: string }>();
  for (const pg of ok) {
    for (const c of pg.extract!.contacts) {
      const key = `${c.kind}|${c.value}`;
      if (!contacts.has(key)) contacts.set(key, { kind: c.kind, value: c.value, evidence: c.evidence + (c.sameDomain === false ? ', other domain' : ''), page: path(pg.url) });
    }
  }
  const scoutSet = new Set(input.scoutContacts.map((c) => `${c.kind}|${c.value}`));
  L.push('\n## Contacts on the website');
  const order = ['whatsapp', 'email', 'phone', 'instagram', 'facebook'];
  const list = [...contacts.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  if (!list.length) L.push('- None found on the crawled pages.');
  for (const c of list.slice(0, 14)) {
    L.push(`- ${c.kind}: ${c.value} (${c.evidence}; ${c.page})${scoutSet.has(`${c.kind}|${c.value}`) ? ' — matches scout' : ' — new'}`);
  }
  const socials: Record<string, string> = {};
  const reviewLinks = new Set<string>();
  const bookingLinks = new Set<string>();
  for (const pg of ok) {
    Object.assign(socials, { ...pg.extract!.socials, ...socials });
    pg.extract!.reviewLinks.forEach((r) => reviewLinks.add(r));
    pg.extract!.bookingLinks.forEach((r) => bookingLinks.add(r));
  }
  const otherSocial = Object.entries(socials).filter(([k]) => k !== 'instagram' && k !== 'facebook');
  if (otherSocial.length) L.push(`- Other profiles: ${otherSocial.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (bookingLinks.size) L.push(`- Booking links (direct-booking evidence): ${[...bookingLinks].slice(0, 6).join(' · ')}`);
  if (reviewLinks.size) L.push(`- Review / map links on the site (start points for the review check): ${[...reviewLinks].slice(0, 6).join(' · ')}`);

  // Location
  const ld = ok.map((x) => x.extract!.jsonLd).find((j) => j && (j.address || j.geo || j.name));
  const geo = ok.map((x) => x.extract!.geo).find(Boolean);
  const airports = [...new Set(ok.flatMap((x) => x.extract!.airports))];
  if (ld || geo || airports.length) {
    L.push('\n## Location');
    if (ld?.address) L.push(`- Address (structured data): ${ld.address}`);
    if (geo) L.push(`- Coordinates: ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)} (${geo.source})`);
    if (airports.length) L.push(`- Airports mentioned: ${airports.join(', ')}`);
    if (ld?.priceRange) L.push(`- Price range (structured data): ${ld.priceRange}`);
  }

  // Prices, capacity, transfer times
  const prices = ok.flatMap((x) => x.extract!.prices.map((pr) => ({ ...pr, page: path(x.url) })));
  if (prices.length) {
    L.push('\n## Prices on the site (raw, unverified)');
    for (const pr of prices.slice(0, 12)) {
      L.push(`- ${pr.raw}${pr.unit ? ` — ${pr.unit}` : ''} (${pr.page}): "${clip(pr.context, 150)}"`);
    }
  }
  const capacity = [...new Set(ok.flatMap((x) => x.extract!.capacity))];
  const durations = [...new Set(ok.flatMap((x) => x.extract!.durations))];
  if (capacity.length || durations.length) {
    L.push('\n## Capacity and transfer times');
    capacity.slice(0, 6).forEach((c) => L.push(`- ${clip(c, 160)}`));
    durations.slice(0, 10).forEach((d) => L.push(`- "${clip(d, 120)}"`));
  }
  const waves = [...new Set(ok.flatMap((x) => x.extract!.waveNames))];
  if (waves.length) {
    L.push('\n## Possible wave names (headings on wave pages; confirm before use)');
    L.push(waves.slice(0, 30).join(' · '));
  }

  // Photos (links only)
  if (input.images.length) {
    L.push('\n## Photo links (ranked; permission pending until the resort agrees)');
    for (const s of SECTION_ORDER) {
      const rows = input.images.filter((i) => i.section === s).slice(0, IMAGES_PER_SECTION[s]);
      if (!rows.length) continue;
      L.push(`### ${s}`);
      for (const r of rows) {
        const size = r.width ? `${r.width}${r.height ? '×' + r.height : ''}` : 'size unknown';
        L.push(`- ${r.image_url} · ${size}${r.alt ? ` · "${clip(r.alt, 60)}"` : ''}`);
      }
    }
  }
  if (input.documents.length) {
    L.push('\n## Documents linked (e.g. rate sheets)');
    input.documents.slice(0, 8).forEach((d) => L.push(`- ${d.url}`));
  }

  // Page sections last: they are the largest part and are trimmed to fit the budget.
  const head = L.join('\n');
  const tail: string[] = [];
  const failed = pages.filter((x) => x.status !== 'crawled');
  if (failed.length) {
    tail.push('\n## Pages not read');
    failed.forEach((f) => tail.push(`- ${f.url} — ${f.status}${f.reason ? `: ${f.reason}` : ''}`));
  }
  const tailText = tail.join('\n');
  const room = budget - head.length - tailText.length - 200;
  const S: string[] = ['\n## What each page says'];
  const perPage = Math.max(600, Math.floor(room / Math.max(ok.length, 1)));
  for (const pg of ok) {
    const x = pg.extract!;
    const block: string[] = [`### ${path(pg.url)} — ${clip(x.title || 'untitled', 80)} (${x.section})`];
    if (x.description) block.push(`> ${clip(x.description, 200)}`);
    let used = block.join('\n').length;
    for (const sec of x.sections) {
      if (sec.heading === 'Intro' && looksLikeMenu(sec.text)) continue;
      if (!sec.text && sec.level === 0) continue;
      const line = `- **${clip(sec.heading, 70)}**${sec.text ? ': ' + clip(sec.text, 260) : ''}`;
      if (used + line.length > perPage) break;
      block.push(line);
      used += line.length + 1;
    }
    S.push(block.join('\n'));
  }
  let sectionsText = S.join('\n');
  if (room < 0) sectionsText = '';
  else if (sectionsText.length > room) sectionsText = sectionsText.slice(0, room).replace(/\n[^\n]*$/, '') + '\n…';

  const markdown = `${head}\n${sectionsText}\n${tailText}`.trim() + '\n';
  const json = {
    prospect: p,
    complete,
    pages: pages.map((x) => ({ url: x.url, status: x.status, reason: x.reason })),
    contacts: list,
    socials,
    bookingLinks: [...bookingLinks],
    reviewLinks: [...reviewLinks],
    location: { address: ld?.address ?? null, geo: geo ?? null, airports },
    prices,
    capacity,
    durations,
    waveNames: waves,
    images: input.images,
    documents: input.documents,
  };
  return { markdown, json, complete };
}

/** Load everything for one prospect, render the brief, store it in R2 and D1. */
export async function buildBrief(db: D1Database, bucket: R2Bucket, prospectId: string): Promise<{ chars: number; complete: boolean } | null> {
  const prospect = await db
    .prepare(`SELECT id, name, country, region, type, website FROM prospects WHERE id = ?1`)
    .bind(prospectId)
    .first<BriefInput['prospect']>();
  if (!prospect) return null;
  const srcs = await db
    .prepare(`SELECT url, crawl_status AS status, fail_reason AS reason, r2_key FROM sources WHERE prospect_id = ?1 AND tag = 'operator' ORDER BY id`)
    .bind(prospectId)
    .all<{ url: string; status: string; reason: string | null; r2_key: string | null }>();
  const pages: BriefInput['pages'] = [];
  for (const s of srcs.results) {
    let extract: PageExtract | null = null;
    if (s.r2_key && s.status === 'crawled') {
      const obj = await bucket.get(s.r2_key);
      if (obj) {
        try {
          extract = JSON.parse(await obj.text()) as PageExtract;
        } catch {
          extract = null;
        }
      }
    }
    pages.push({ url: s.url, status: s.status, reason: s.reason, extract });
  }
  const images = await db
    .prepare(
      `SELECT section, image_url, COALESCE(width, NULLIF(width_hint, 0)) AS width, height, alt, rank_score, page_url
       FROM images WHERE prospect_id = ?1 AND COALESCE(third_party, 0) = 0 AND permission <> 'refused'
       ORDER BY rank_score DESC LIMIT 120`,
    )
    .bind(prospectId)
    .all<BriefInput['images'][number]>();
  const scout = await db
    .prepare(`SELECT kind, value FROM contacts WHERE prospect_id = ?1 AND COALESCE(found_by, 'scout') = 'scout'`)
    .bind(prospectId)
    .all<{ kind: string; value: string }>();
  const docs = await db.prepare(`SELECT url FROM documents WHERE prospect_id = ?1 ORDER BY id LIMIT 10`).bind(prospectId).all<{ url: string }>();

  const { markdown, json, complete } = renderBrief({ prospect, pages, images: images.results, scoutContacts: scout.results, documents: docs.results });
  const key = `briefs/${prospectId}.json`;
  await bucket.put(key, JSON.stringify(json), { httpMetadata: { contentType: 'application/json' } });
  await bucket.put(`briefs/${prospectId}.md`, markdown, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
  await db
    .prepare(`UPDATE prospects SET brief_md = ?2, brief_r2_key = ?3, brief_updated_at = ?4, brief_complete = ?5 WHERE id = ?1`)
    .bind(prospectId, markdown, key, new Date().toISOString(), complete ? 1 : 0)
    .run();
  return { chars: markdown.length, complete };
}
