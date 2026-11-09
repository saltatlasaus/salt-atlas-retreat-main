/**
 * Scrape persistence ports.
 *
 * Production: Cloudflare R2 (raw dataset JSON) + D1 (scrape_runs / scrape_pages).
 * Fallback: in-memory local adapter when bindings are missing or D1 is unusable.
 */
import { getCloudflareEnv } from "@/lib/cf-bindings";
import type { ScrapeRunRecord, WccPage } from "./wcc-types";
import { createCloudflareScrapeStorage } from "./scrape-storage-cf";

export interface ScrapeStorage {
  saveRun(run: ScrapeRunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<ScrapeRunRecord>): Promise<ScrapeRunRecord | undefined>;
  getRun(id: string): Promise<ScrapeRunRecord | undefined>;
  listRuns(): Promise<ScrapeRunRecord[]>;
  savePages(runId: string, pages: WccPage[]): Promise<void>;
  getPages(runId: string): Promise<WccPage[]>;
}

export function r2DatasetKey(runId: string): string {
  return `scrapes/${runId}/dataset.json`;
}

const runs = new Map<string, ScrapeRunRecord>();
const pages = new Map<string, WccPage[]>();

export const localScrapeStorage: ScrapeStorage = {
  async saveRun(run) {
    runs.set(run.id, structuredClone(run));
  },
  async updateRun(id, patch) {
    const cur = runs.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    runs.set(id, next);
    return structuredClone(next);
  },
  async getRun(id) {
    const r = runs.get(id);
    return r ? structuredClone(r) : undefined;
  },
  async listRuns() {
    return [...runs.values()]
      .map((r) => structuredClone(r))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },
  async savePages(runId, items) {
    pages.set(runId, structuredClone(items));
  },
  async getPages(runId) {
    return structuredClone(pages.get(runId) ?? []);
  },
};

let cachedMode: "cloudflare" | "local" = "local";

function cloudStorage(): ScrapeStorage | undefined {
  try {
    const e = getCloudflareEnv();
    if (!e?.DB || !e.SCRAPE_BUCKET) return undefined;
    return createCloudflareScrapeStorage({ DB: e.DB, SCRAPE_BUCKET: e.SCRAPE_BUCKET });
  } catch {
    return undefined;
  }
}

/** Use this request's D1/R2. Fall back to memory when that store is empty or unavailable. */
export function getScrapeStorage(): ScrapeStorage {
  const cf = cloudStorage();
  if (!cf) {
    cachedMode = "local";
    return localScrapeStorage;
  }
  cachedMode = "cloudflare";
  return {
    async saveRun(run) {
      try {
        await cf.saveRun(run);
      } catch (err) {
        console.warn("[scrape-storage] D1/R2 saveRun failed — using local memory", err);
        cachedMode = "local";
        await localScrapeStorage.saveRun(run);
      }
    },
    async updateRun(id, patch) {
      try {
        return await cf.updateRun(id, patch);
      } catch (err) {
        console.warn("[scrape-storage] D1 updateRun failed — using local memory", err);
        cachedMode = "local";
        return localScrapeStorage.updateRun(id, patch);
      }
    },
    async getRun(id) {
      try {
        const run = await cf.getRun(id);
        if (run) return run;
      } catch (err) {
        console.warn("[scrape-storage] D1 getRun failed — using local memory", err);
      }
      return localScrapeStorage.getRun(id);
    },
    async listRuns() {
      try {
        const runs = await cf.listRuns();
        if (runs.length) return runs;
      } catch (err) {
        console.warn("[scrape-storage] D1 listRuns failed — using local memory", err);
      }
      return localScrapeStorage.listRuns();
    },
    async savePages(runId, items) {
      try {
        await cf.savePages(runId, items);
      } catch (err) {
        console.warn("[scrape-storage] D1/R2 savePages failed — using local memory", err);
        cachedMode = "local";
        await localScrapeStorage.savePages(runId, items);
      }
    },
    async getPages(runId) {
      try {
        const pages = await cf.getPages(runId);
        if (pages.length) return pages;
      } catch (err) {
        console.warn("[scrape-storage] D1/R2 getPages failed — using local memory", err);
      }
      return localScrapeStorage.getPages(runId);
    },
  };
}

export function scrapeStorageMode(): "cloudflare" | "local" {
  getScrapeStorage();
  return cachedMode;
}
