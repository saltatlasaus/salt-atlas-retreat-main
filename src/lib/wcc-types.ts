/** Website Content Crawler (apify/website-content-crawler) input/output contracts. */

export type WccCrawlerType = "playwright:adaptive" | "playwright:firefox" | "cheerio";

export type WccHtmlTransformer =
  | "readableTextIfPossible"
  | "readableText"
  | "extractus"
  | "defuddle"
  | "none";

export interface WccStartUrl {
  url: string;
}

export interface WccGlob {
  glob: string;
}

export interface WccInput {
  startUrls: WccStartUrl[];
  crawlerType: WccCrawlerType;
  includeUrlGlobs: WccGlob[];
  excludeUrlGlobs: WccGlob[];
  maxCrawlDepth: number;
  maxCrawlPages: number;
  maxResults: number;
  useSitemaps: boolean;
  useLlmsTxt: boolean;
  onlyCrawlPagesModifiedSince: string;
  respectRobotsTxtFile: boolean;
  keepUrlFragments: boolean;
  ignoreCanonicalUrl: boolean;
  proxyConfiguration: { useApifyProxy: boolean };
  initialConcurrency: number;
  maxConcurrency: number;
  maxRequestRetries: number;
  requestTimeoutSecs: number;
  dynamicContentWaitSecs: number;
  maxScrollHeightPixels: number;
  waitForSelector: string;
  softWaitForSelector: string;
  removeCookieWarnings: boolean;
  blockMedia: boolean;
  expandIframes: boolean;
  clickElementsCssSelector: string;
  keepElementsCssSelector: string;
  removeElementsCssSelector: string;
  htmlTransformer: WccHtmlTransformer;
  readableTextCharThreshold: number;
  saveMarkdown: boolean;
}

export interface WccPage {
  url: string;
  text?: string;
  markdown?: string;
  html?: string | null;
  summary?: string | null;
  screenshotUrl?: string | null;
  metadata?: {
    title?: string | null;
    description?: string | null;
    canonicalUrl?: string | null;
    author?: string | null;
    keywords?: string | null;
    languageCode?: string | null;
    openGraph?: Array<{ property?: string; content?: string }>;
    headers?: Record<string, string>;
  };
  crawl?: {
    loadedUrl?: string;
    loadedTime?: string;
    referrerUrl?: string;
    depth?: number;
    httpStatusCode?: number;
    contentType?: string;
  };
  /** Set when pages are saved. Challenge and thin pages are not research evidence. */
  quality?: "usable" | "http_error" | "challenge" | "thin_content" | "blocked_by_robots";
}

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMING-OUT"
  | "TIMED-OUT"
  | "ABORTING"
  | "ABORTED";

export interface ScrapeRunRecord {
  id: string;
  apifyRunId: string;
  status: ApifyRunStatus;
  input: WccInput;
  startedAt: string;
  finishedAt?: string;
  datasetId?: string;
  itemCount: number;
  /** Future R2 object key for the raw dataset blob. */
  r2Key?: string;
  simulated: boolean;
  errorMessage?: string;
}

export const DEFAULT_WCC_INPUT: Omit<WccInput, "startUrls"> = {
  crawlerType: "playwright:adaptive",
  includeUrlGlobs: [],
  excludeUrlGlobs: [],
  maxCrawlDepth: 3,
  maxCrawlPages: 50,
  maxResults: 50,
  useSitemaps: false,
  useLlmsTxt: false,
  onlyCrawlPagesModifiedSince: "",
  respectRobotsTxtFile: true,
  keepUrlFragments: false,
  ignoreCanonicalUrl: false,
  proxyConfiguration: { useApifyProxy: true },
  initialConcurrency: 1,
  maxConcurrency: 2,
  maxRequestRetries: 1,
  requestTimeoutSecs: 60,
  dynamicContentWaitSecs: 10,
  maxScrollHeightPixels: 5000,
  waitForSelector: "",
  softWaitForSelector: "",
  removeCookieWarnings: true,
  blockMedia: false,
  expandIframes: true,
  clickElementsCssSelector: '[aria-expanded="false"]',
  keepElementsCssSelector: "",
  removeElementsCssSelector:
    'nav, footer, script, style, noscript, svg, [role="alert"], [role="banner"], [role="dialog"], [role="alertdialog"], [role="region"][aria-label*="skip" i], [aria-modal="true"]',
  htmlTransformer: "readableText",
  readableTextCharThreshold: 100,
  saveMarkdown: true,
};

export function parseStartUrls(text: string): WccStartUrl[] {
  const urls: WccStartUrl[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(withProtocol);
      if (seen.has(u.href)) continue;
      seen.add(u.href);
      urls.push({ url: u.href });
    } catch {
      // skip invalid lines
    }
  }
  return urls;
}

export function globsFromText(text: string): WccGlob[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((glob) => ({ glob }));
}

export function globsToText(globs: WccGlob[]): string {
  return globs.map((g) => g.glob).join("\n");
}

/** Build actor input payload — omit empty optional strings. */
export function toActorInput(input: WccInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    startUrls: input.startUrls,
    crawlerType: input.crawlerType,
    includeUrlGlobs: input.includeUrlGlobs,
    excludeUrlGlobs: input.excludeUrlGlobs,
    maxCrawlDepth: input.maxCrawlDepth,
    maxCrawlPages: input.maxCrawlPages,
    maxResults: input.maxResults,
    useSitemaps: input.useSitemaps,
    useLlmsTxt: input.useLlmsTxt,
    respectRobotsTxtFile: input.respectRobotsTxtFile,
    keepUrlFragments: input.keepUrlFragments,
    ignoreCanonicalUrl: input.ignoreCanonicalUrl,
    proxyConfiguration: input.proxyConfiguration,
    initialConcurrency: input.initialConcurrency,
    maxConcurrency: input.maxConcurrency,
    maxRequestRetries: input.maxRequestRetries,
    requestTimeoutSecs: input.requestTimeoutSecs,
    dynamicContentWaitSecs: input.dynamicContentWaitSecs,
    maxScrollHeightPixels: input.maxScrollHeightPixels,
    removeCookieWarnings: input.removeCookieWarnings,
    blockMedia: input.blockMedia,
    expandIframes: input.expandIframes,
    htmlTransformer: input.htmlTransformer,
    readableTextCharThreshold: input.readableTextCharThreshold,
    saveMarkdown: input.saveMarkdown,
  };
  if (input.onlyCrawlPagesModifiedSince.trim()) {
    payload["onlyCrawlPagesModifiedSince"] = input.onlyCrawlPagesModifiedSince.trim();
  }
  if (input.waitForSelector.trim()) payload["waitForSelector"] = input.waitForSelector.trim();
  if (input.softWaitForSelector.trim()) {
    payload["softWaitForSelector"] = input.softWaitForSelector.trim();
  }
  if (input.clickElementsCssSelector.trim()) {
    payload["clickElementsCssSelector"] = input.clickElementsCssSelector.trim();
  }
  if (input.keepElementsCssSelector.trim()) {
    payload["keepElementsCssSelector"] = input.keepElementsCssSelector.trim();
  }
  if (input.removeElementsCssSelector.trim()) {
    payload["removeElementsCssSelector"] = input.removeElementsCssSelector.trim();
  }
  return payload;
}
