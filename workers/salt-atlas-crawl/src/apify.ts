// Apify client and the crawler input. The input lives here, in code and in git, so a
// change made by hand in the Apify console can never silently break the parser.

import type { Env, WccItem } from './types.ts';
import { matchKey } from './urls.ts';

const API = 'https://api.apify.com/v2';

export type RunKind = 'primary' | 'retry';

/** Pages we parse ourselves need: full HTML (incl. footers, noscript images, JSON-LD), depth 0. */
export const REMOVE_ELEMENTS =
  "nav, style, svg, img[src^='data:'], script:not([type='application/ld+json']), [role='dialog'], [role='alertdialog'], [aria-modal='true']";

/** Words in a link that point at a page with photos or facts the destination page needs. */
export const FOLLOW_WORDS = [
  'gallery', 'galeria', 'photo', 'photos', 'picture', 'pictures', 'media', 'room', 'rooms', 'cabin', 'cabins', 'villa', 'villas',
  'suite', 'suites', 'accommodation', 'accommodations', 'stay', 'lodging', 'bungalow', 'bungalows', 'surf', 'surfing', 'wave',
  'waves', 'break', 'breaks', 'boat', 'boats', 'charter', 'charters', 'yacht', 'vessel', 'activities', 'activity', 'experience',
  'experiences', 'amenities', 'facilities', 'dining', 'food', 'restaurant', 'spa', 'wellness', 'yoga', 'fishing', 'diving',
  'snorkel', 'snorkelling', 'excursion', 'excursions', 'getting-there', 'location', 'the-resort', 'the-boat', 'the-lodge',
];

/** Root domains (no www) of the start URLs. */
export function rootDomains(urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    try { out.add(new URL(u).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* skip */ }
  }
  return [...out];
}

/** Globs that keep the depth-1 crawl on each resort's own site and on photo/room/surf pages only. */
export function followGlobs(domains: string[]): { glob: string }[] {
  const w = `{${FOLLOW_WORDS.join(',')}}`;
  return domains.flatMap((d) => [
    { glob: `https://{www.,}${d}/**/*${w}*` },
    { glob: `https://{www.,}${d}/**/*${w}*/**` },
  ]);
}

export function buildCrawlInput(urls: string[], kind: RunKind, env: Pick<Env, 'RETRY_PROXY_GROUP' | 'CRAWL_DEPTH' | 'FOLLOW_PAGES_PER_SITE'>): Record<string, unknown> {
  const n = urls.length;
  const domains = rootDomains(urls);
  // Depth 1 (default): also read the gallery, rooms, surf and activity pages each logged page links to,
  // so a missed gallery page no longer means a page with no photos. Retries stay at depth 0.
  const depth = kind === 'retry' ? 0 : Math.max(0, Math.min(2, Number(env.CRAWL_DEPTH ?? '1')));
  const perSite = Number(env.FOLLOW_PAGES_PER_SITE || '12');
  const extra = depth > 0 ? domains.length * perSite : 0;
  const input: Record<string, unknown> = {
    startUrls: urls.map((url) => ({ url })),
    crawlerType: 'playwright:adaptive',
    maxCrawlDepth: depth,
    ...(depth > 0 ? { includeUrlGlobs: followGlobs(domains) } : {}),
    maxCrawlPages: n + extra + 10,
    maxResults: (n + extra) * 2 + 20, // headroom (PDF links are listed, not fetched)
    useSitemaps: false,
    useLlmsTxt: false,
    respectRobotsTxtFile: true,
    ignoreCanonicalUrl: true,
    keepUrlFragments: false,
    maxConcurrency: 5,
    maxRequestRetries: 2,
    requestTimeoutSecs: 90,
    dynamicContentWaitSecs: 15,
    maxScrollHeightPixels: 8000,
    removeCookieWarnings: true,
    blockMedia: false,
    expandIframes: true,
    clickElementsCssSelector: '[aria-expanded="false"]',
    removeElementsCssSelector: REMOVE_ELEMENTS,
    htmlTransformer: 'none',
    saveMarkdown: true,
    saveHtmlAsFile: true,
    saveContentTypes: 'application/pdf',
    saveScreenshots: false,
    storeSkippedUrls: true,
    debugMode: false,
    proxyConfiguration: { useApifyProxy: true },
  };
  if (kind === 'retry') {
    // Second attempt: full browser, longer waits, more retries; optionally residential proxies.
    Object.assign(input, {
      crawlerType: 'playwright:firefox',
      dynamicContentWaitSecs: 25,
      requestTimeoutSecs: 150,
      maxRequestRetries: 3,
      maxConcurrency: 3,
    });
    if (env.RETRY_PROXY_GROUP) {
      input.proxyConfiguration = { useApifyProxy: true, apifyProxyGroups: [env.RETRY_PROXY_GROUP] };
    }
  }
  return input;
}

export interface ApifyRun {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string | null;
  defaultDatasetId: string;
  defaultKeyValueStoreId: string;
  usageTotalUsd?: number;
  stats?: Record<string, unknown>;
}

export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export class ApifyError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function apifyFetch(env: Env, path: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  if (!env.APIFY_TOKEN) throw new ApifyError('APIFY_TOKEN secret is not set', 0, false);
  let last: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      const res = await fetch(path.startsWith('http') ? path : API + path, {
        ...init,
        headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, ...(init.headers || {}) },
      });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      last = new ApifyError(`Apify ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 300)}`, res.status, retryable);
      if (!retryable) throw last;
    } catch (e) {
      last = e;
      if (e instanceof ApifyError && !e.retryable) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500 * a * a));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function startRun(env: Env, input: Record<string, unknown>, webhookUrl: string): Promise<ApifyRun> {
  const actor = (env.APIFY_ACTOR || 'apify~website-content-crawler').replace('/', '~');
  const webhooks = [
    {
      eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
      requestUrl: webhookUrl,
    },
  ];
  const qs = new URLSearchParams({
    timeout: env.APIFY_TIMEOUT_SECS || '3600',
    memory: env.APIFY_MEMORY_MB || '4096',
    maxTotalChargeUsd: env.APIFY_MAX_USD_PER_RUN || '3',
    webhooks: btoa(JSON.stringify(webhooks)),
  });
  const res = await apifyFetch(env, `/acts/${actor}/runs?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, 1); // never auto-repeat a run start; the workflow step decides
  return ((await res.json()) as { data: ApifyRun }).data;
}

export async function getRun(env: Env, runId: string): Promise<ApifyRun> {
  const res = await apifyFetch(env, `/actor-runs/${runId}`);
  return ((await res.json()) as { data: ApifyRun }).data;
}

export async function abortRun(env: Env, runId: string): Promise<void> {
  await apifyFetch(env, `/actor-runs/${runId}/abort`, { method: 'POST' }).catch(() => {});
}

/** Runs of the crawler started after `sinceIso` (used to adopt a run if a step crashed after starting it). */
export async function recentRuns(env: Env, sinceIso: string): Promise<ApifyRun[]> {
  const actor = (env.APIFY_ACTOR || 'apify~website-content-crawler').replace('/', '~');
  const res = await apifyFetch(env, `/acts/${actor}/runs?desc=1&limit=10`);
  const items = ((await res.json()) as { data: { items: ApifyRun[] } }).data.items || [];
  return items.filter((r) => (r.startedAt || '') >= sinceIso);
}

export async function datasetPage(env: Env, datasetId: string, offset: number, limit: number): Promise<WccItem[]> {
  const qs = new URLSearchParams({
    offset: String(offset), limit: String(limit), clean: 'true', format: 'json',
    fields: 'url,crawl,metadata,markdown,text,htmlUrl',
  });
  const res = await apifyFetch(env, `/datasets/${datasetId}/items?${qs}`);
  return (await res.json()) as WccItem[];
}

/** Fetch a stored HTML record. The token is only ever sent to api.apify.com. */
export async function fetchRecord(env: Env, recordUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(recordUrl);
  } catch {
    return null;
  }
  if (u.hostname !== 'api.apify.com') return null;
  try {
    const res = await apifyFetch(env, u.toString(), {}, 2);
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * The crawler's SKIPPED_URLS record: reasons it did not crawl some URLs (robots.txt, errors...).
 * The record's exact shape is not documented, so we read it leniently into url-key -> reason.
 */
export async function skippedUrls(env: Env, kvStoreId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const res = await apifyFetch(env, `/key-value-stores/${kvStoreId}/records/SKIPPED_URLS`, {}, 2);
    const data = (await res.json()) as unknown;
    const visit = (reason: string, v: unknown) => {
      if (typeof v === 'string') {
        const k = matchKey(v);
        if (k) out.set(k, reason);
      } else if (Array.isArray(v)) v.forEach((x) => visit(reason, x));
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.url === 'string') visit(String(o.reason || o.error || reason), o.url);
        else for (const [k, x] of Object.entries(o)) visit(k, x);
      }
    };
    visit('skipped', data);
  } catch {
    /* record missing: nothing was skipped, or the option was off */
  }
  return out;
}
