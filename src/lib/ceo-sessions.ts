/** Browser-persisted CEO run tabs: one session per “1 · Discover” to keep 1–4 progress and logs across navigation. */

import { RESORT_CRAWL_PRESET } from "./crawl-policy";
import type { WccCrawlerType } from "./wcc-types";

const STORAGE_KEY = "salt-atlas-ceo-sessions-v1";
const ACTIVE_KEY = "salt-atlas-ceo-active-session-v1";

/** First shipped defaults were very shallow (depth 0, 8 pages) — one official URL produced a single page row. */
const LEGACY_WEAK_DEFAULTS = { maxCrawlDepth: 0, maxPagesTotal: 8, initialConcurrency: 1, maxConcurrency: 1 } as const;

function isLegacyWeakCrawlOptions(opts: CeoCrawlOptions): boolean {
  return (
    opts.maxCrawlDepth === LEGACY_WEAK_DEFAULTS.maxCrawlDepth &&
    opts.maxPagesTotal === LEGACY_WEAK_DEFAULTS.maxPagesTotal &&
    opts.initialConcurrency === LEGACY_WEAK_DEFAULTS.initialConcurrency &&
    opts.maxConcurrency === LEGACY_WEAK_DEFAULTS.maxConcurrency
  );
}

/** Website Content Crawl knobs for CEO runs (server still applies `constrainCrawl` caps). */
export interface CeoCrawlOptions {
  crawlerType: WccCrawlerType;
  maxCrawlDepth: number;
  /** Total page budget; raised to at least `startUrls.length` when building the run. */
  maxPagesTotal: number;
  initialConcurrency: number;
  maxConcurrency: number;
  saveMarkdown: boolean;
  requestTimeoutSecs: number;
}

/** Which overview is expanded on /ops for this run tab (Pipeline vs stage boards). */
export type CeoBoardTab = "pipeline" | "crawls" | "research" | "html";

export const DEFAULT_CEO_CRAWL_OPTIONS: CeoCrawlOptions = {
  crawlerType: "playwright:adaptive",
  /** Depth 0 only loads start URLs — too thin for fact extraction. Server caps depth at 3. */
  maxCrawlDepth: RESORT_CRAWL_PRESET.maxCrawlDepth,
  /** Wide enough for rates, rooms, surf, contact; server `constrainCrawl` caps at 50. */
  maxPagesTotal: RESORT_CRAWL_PRESET.maxCrawlPages,
  initialConcurrency: RESORT_CRAWL_PRESET.initialConcurrency,
  maxConcurrency: RESORT_CRAWL_PRESET.maxConcurrency,
  saveMarkdown: true,
  requestTimeoutSecs: 60,
};

export interface CeoRunSession {
  id: string;
  createdAt: string;
  label: string;
  instruction: string;
  country: string;
  region: string;
  selectedResortId: string;
  activity: string[];
  autoVerifyAfterCrawl: boolean;
  crawlOptions: CeoCrawlOptions;
  /** Saved board view on /ops (Pipeline, Crawls, Verify, HTML). */
  ceoBoardTab?: CeoBoardTab;
}

function safeParse<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function normalizeSession(raw: CeoRunSession): CeoRunSession {
  const merged: CeoCrawlOptions = { ...DEFAULT_CEO_CRAWL_OPTIONS, ...raw.crawlOptions };
  const crawlOptions = isLegacyWeakCrawlOptions(merged) ? { ...DEFAULT_CEO_CRAWL_OPTIONS } : merged;
  return {
    ...raw,
    crawlOptions,
    ceoBoardTab: raw.ceoBoardTab ?? "pipeline",
  };
}

export function loadCeoSessions(): CeoRunSession[] {
  if (typeof window === "undefined") return [];
  const list = safeParse<CeoRunSession[]>(localStorage.getItem(STORAGE_KEY));
  if (!Array.isArray(list)) return [];
  return list.map((s) => normalizeSession(s));
}

export function saveCeoSessions(sessions: CeoRunSession[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (err) {
    console.warn("[ceo-sessions] save failed", err);
  }
}

export function loadActiveCeoSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveCeoSessionId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

export function newRunSessionLabel(country: string, region: string): string {
  const t = new Date();
  const stamp = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return `${region || country || "Run"} · ${stamp}`;
}
