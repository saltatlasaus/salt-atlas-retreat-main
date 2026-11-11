// Shared types for the Salt Atlas crawl pipeline.
// Pure type declarations only: safe to import from tests and from the Worker.

export interface Env {
  DB: D1Database;
  SCRAPE_BUCKET: R2Bucket;
  CRAWL: Workflow;

  // Secrets
  APIFY_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  TEAMS_WEBHOOK_URL?: string;

  // Plain variables (strings, as Wrangler passes them)
  PUBLIC_URL: string;
  APIFY_ACTOR?: string;
  APIFY_MEMORY_MB?: string;
  APIFY_TIMEOUT_SECS?: string;
  APIFY_MAX_USD_PER_RUN?: string;
  RETRY_PROXY_GROUP?: string;
  CRAWL_DEPTH?: string;
  FOLLOW_PAGES_PER_SITE?: string;
  MAX_URLS_PER_DAY?: string;
}

/** Minimal D1/R2/Workflow shapes so the pure modules type-check without @cloudflare/workers-types. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(col?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}
export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer, opts?: Record<string, unknown>): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; body?: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  head?(key: string): Promise<unknown | null>;
}
export interface Workflow {
  create(opts: { id?: string; params?: unknown }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}
export interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string; error?: unknown; output?: unknown }>;
  sendEvent(ev: { type: string; payload: unknown }): Promise<void>;
}

/** A row from `sources` that is part of today's batch. */
export interface BatchSource {
  id: number;
  prospect_id: string;
  url: string;
  feeds: string | null;
  retry_count: number;
  country: string | null;
}

/** One item from the Website Content Crawler dataset (fields we use; all optional, we code defensively). */
export interface WccItem {
  url?: string;
  text?: string;
  markdown?: string;
  htmlUrl?: string;
  crawl?: {
    loadedUrl?: string;
    loadedTime?: string;
    referrerUrl?: string;
    depth?: number;
    httpStatusCode?: number;
    contentType?: string;
  };
  metadata?: {
    title?: string | null;
    description?: string | null;
    canonicalUrl?: string | null;
    languageCode?: string | null;
    headers?: Record<string, string>;
    openGraph?: Array<{ property?: string; content?: string }>;
  };
}

export type ImageSection = 'hero' | 'waves' | 'rooms' | 'amenities' | 'gallery' | 'getting_there' | 'other';

export interface ImageCandidate {
  url: string; // upgraded, absolute
  canonicalKey: string;
  width: number | null; // exact, when known
  height: number | null;
  widthHint: number | null; // lower bound when only a resized copy was seen
  alt: string;
  discovery: string; // img | srcset | og | link | css | preload | jsonld | poster | sqs
  order: number; // position on page
  thirdParty: boolean;
  section: ImageSection;
  score: number;
}

export interface ContactFound {
  kind: 'email' | 'whatsapp' | 'phone' | 'instagram' | 'facebook';
  value: string;
  evidence: string; // mailto | cfemail | text | obfuscated | tel | wa.me | labelled_text | labelled_link | link
  sameDomain?: boolean;
  localFormat?: boolean;
}

export interface PriceFound {
  amount: number;
  currency: string; // ISO-ish code, or "$?" when the symbol is ambiguous
  raw: string;
  unit: string | null; // per night, per person, per week, per trip, full boat ...
  context: string;
}

export interface Section {
  heading: string;
  level: number;
  text: string;
}

/** Everything the parser pulls from one page. Saved to R2 as JSON; summarised into D1 and the brief. */
export interface PageExtract {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  language: string | null;
  httpStatus: number | null;
  chars: number;
  section: ImageSection;
  status: 'ok' | 'thin' | 'blocked' | 'gone' | 'parked' | 'redirect_home' | 'off_site';
  statusDetail: string | null;
  contacts: ContactFound[];
  socials: Record<string, string>;
  reviewLinks: string[];
  bookingLinks: string[];
  videos: string[];
  documents: string[];
  images: ImageCandidate[];
  prices: PriceFound[];
  capacity: string[];
  durations: string[];
  airports: string[];
  waveNames: string[];
  headings: string[];
  sections: Section[];
  jsonLd: {
    name?: string;
    telephone?: string;
    email?: string;
    address?: string;
    geo?: { lat: number; lng: number };
    priceRange?: string;
    sameAs?: string[];
  };
  geo: { lat: number; lng: number; source: string } | null;
}
