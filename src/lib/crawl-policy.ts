import type { WccInput, WccPage } from "./wcc-types";

const MAX_PAGES_PER_RUN = 50;
const MAX_DEPTH = 3;
const MAX_CONCURRENCY = 2;
const MAX_RETRIES = 1;

/**
 * One crawl shape for resort fact extraction, used by CEO step 2 and the /pipeline scrape tool.
 * Depth 0 only loads the start URL (one page), which cannot cover rates, rooms, surf and contact.
 * Values stay inside the server caps above.
 */
export const RESORT_CRAWL_PRESET = {
  maxCrawlDepth: 2,
  maxCrawlPages: 35,
  initialConcurrency: 2,
  maxConcurrency: 2,
} as const;

export type PageCheck = "usable" | "http_error" | "challenge" | "thin_content" | "blocked_by_robots";

export function safePublicUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    if (u.username || u.password || u.port) return false;
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    if (host === "metadata.google.internal" || host.endsWith(".internal")) return false;
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
    // Protect against common private IPv4 and metadata targets.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const o = host.split(".").map(Number);
      if (o.length !== 4 || o.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
      if (o[0] === 0 || o[0] === 10 || o[0] === 127 || o[0] === 169 && o[1] === 254 ||
        o[0] === 172 && o[1]! >= 16 && o[1]! <= 31 || o[0] === 192 && o[1] === 168 ||
        o[0] === 100 && o[1]! >= 64 && o[1]! <= 127 || o[0]! >= 224) return false;
    }
    return true;
  } catch { return false; }
}

/** Enforce limits on the server even when a browser passes unrestricted actor options. */
export function constrainCrawl(input: WccInput): WccInput {
  const startUrls = [...new Map(input.startUrls.map((s) => [s.url, s])).values()];
  if (!startUrls.length) throw new Error("At least one URL is required.");
  if (startUrls.length > MAX_PAGES_PER_RUN) throw new Error("Select at most 50 URLs per run.");
  for (const source of startUrls) {
    if (!safePublicUrl(source.url)) throw new Error(`Unsafe or unsupported crawl URL: ${source.url}`);
  }
  const max = (value: number, fallback: number) => Number.isFinite(value) ? Math.max(0, value) : fallback;
  return {
    ...input,
    startUrls,
    respectRobotsTxtFile: true,
    maxCrawlDepth: Math.min(MAX_DEPTH, max(input.maxCrawlDepth, 0)),
    maxCrawlPages: Math.min(MAX_PAGES_PER_RUN, Math.max(startUrls.length, max(input.maxCrawlPages, startUrls.length))),
    maxResults: Math.min(MAX_PAGES_PER_RUN, Math.max(startUrls.length, max(input.maxResults, startUrls.length))),
    initialConcurrency: Math.max(1, Math.min(MAX_CONCURRENCY, max(input.initialConcurrency, 1))),
    maxConcurrency: Math.max(1, Math.min(MAX_CONCURRENCY, max(input.maxConcurrency, 1))),
    maxRequestRetries: Math.min(MAX_RETRIES, max(input.maxRequestRetries, 1)),
    useSitemaps: false,
  };
}

export function checkPage(page: WccPage): PageCheck {
  const http = page.crawl?.httpStatusCode;
  if (http === 403 && /robots/i.test(page.text ?? page.markdown ?? "")) return "blocked_by_robots";
  if (http && http >= 400) return "http_error";
  const body = (page.markdown ?? page.text ?? "").trim();
  if (
    /cloudflare ray id|verify you are human|checking your browser|captcha challenge|access denied.*security|one moment, please|request being verified|error establishing a database connection/i.test(
      body.slice(0, 5000),
    )
  ) {
    return "challenge";
  }
  if (body.length < 100) return "thin_content";
  return "usable";
}
