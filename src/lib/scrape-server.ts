import { createServerFn } from "@tanstack/react-start";
import {
  apifyConfigured,
  getApifyRun,
  listDatasetItems,
  mockPagesForInput,
  startWebsiteContentCrawl,
} from "./apify";
import { checkPage, constrainCrawl } from "./crawl-policy";
import { getScrapeStorage, r2DatasetKey, scrapeStorageMode } from "./scrape-storage";
import { resolveScrapeRunIdForSources } from "./scrape-resolve";
import type { ScrapeRunRecord, WccInput, WccPage } from "./wcc-types";

function withQuality(pages: WccPage[]): WccPage[] {
  return pages.map((page) => ({ ...page, quality: checkPage(page) }));
}

function newId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

export const getApifyStatus = createServerFn({ method: "GET" }).handler(async () => ({
  configured: apifyConfigured(),
  actorId: process.env["APIFY_ACTOR_ID"]?.trim() || "apify/website-content-crawler",
  build: process.env["APIFY_ACTOR_BUILD"]?.trim() || "version-0",
  storage: scrapeStorageMode(),
}));

export const listScrapeRuns = createServerFn({ method: "GET" }).handler(async () => {
  return getScrapeStorage().listRuns();
});

export async function createScrapeRunRecord(input: WccInput): Promise<ScrapeRunRecord> {
  const storage = getScrapeStorage();
  const limited = constrainCrawl(input);
  const started = await startWebsiteContentCrawl(limited);
  const record: ScrapeRunRecord = {
    id: newId(),
    apifyRunId: started.apifyRunId,
    status: started.status,
    input: limited,
    startedAt: new Date().toISOString(),
    itemCount: 0,
    simulated: started.simulated,
    ...(started.datasetId ? { datasetId: started.datasetId } : {}),
  };

  if (started.simulated) {
    const pages = withQuality(mockPagesForInput(limited));
    record.status = "SUCCEEDED";
    record.finishedAt = new Date().toISOString();
    record.itemCount = pages.length;
    record.r2Key = r2DatasetKey(record.id);
    await storage.saveRun(record);
    await storage.savePages(record.id, pages);
    return record;
  }

  await storage.saveRun(record);
  return record;
}

/** Pull Apify status. On success, persist dataset pages to R2 + D1. */
export async function syncScrapeRun(id: string): Promise<ScrapeRunRecord> {
  const storage = getScrapeStorage();
  const run = await storage.getRun(id);
  if (!run) throw new Error("Run not found");

  if (TERMINAL.has(run.status) || run.simulated) return run;

  const live = await getApifyRun(run.apifyRunId);
  const patch: Partial<ScrapeRunRecord> = {
    status: live.status,
    ...(live.datasetId ? { datasetId: live.datasetId } : {}),
    ...(live.finishedAt ? { finishedAt: live.finishedAt } : {}),
    ...(live.statusMessage ? { errorMessage: live.statusMessage } : {}),
  };

  if (live.status === "SUCCEEDED" && (live.datasetId || run.datasetId)) {
    const datasetId = live.datasetId ?? run.datasetId!;
    const pages = withQuality(await listDatasetItems(datasetId));
    await storage.savePages(run.id, pages);
    patch.itemCount = pages.length;
    patch.r2Key = r2DatasetKey(run.id);
    patch.datasetId = datasetId;
    if (!patch.finishedAt) patch.finishedAt = new Date().toISOString();
  }

  if (live.status === "FAILED" || live.status === "TIMED-OUT" || live.status === "ABORTED") {
    if (!patch.finishedAt) patch.finishedAt = new Date().toISOString();
  }

  return (await storage.updateRun(run.id, patch)) ?? run;
}

export const startScrapeRun = createServerFn({ method: "POST" })
  .validator((data: WccInput) => {
    if (!data?.startUrls?.length) throw new Error("At least one start URL is required");
    return data;
  })
  .handler(async ({ data: input }) => {
    const { assertStudioUnlocked } = await import("./studio-gate.server");
    assertStudioUnlocked();
    return createScrapeRunRecord(input);
  });

export const getScrapeRun = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => syncScrapeRun(data.id));

export const getScrapeRunItems = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const storage = getScrapeStorage();
    const run = await storage.getRun(data.id);
    if (!run) throw new Error("Run not found");
    return storage.getPages(data.id);
  });

/** Link workflow when sources have scrape=completed but no internal run id (e.g. bulk crawl URL mismatch). */
export const resolveScrapeRunForSources = createServerFn({ method: "POST" })
  .validator((data: { urls: string[] } | undefined) => {
    const urls = (data?.urls ?? []).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) throw new Error("No source URLs to match");
    return { urls };
  })
  .handler(async ({ data }) => {
    const runId = await resolveScrapeRunIdForSources(data.urls.map((url) => ({ url })));
    return { runId: runId ?? null };
  });

export const exportScrapeRun = createServerFn({ method: "GET" })
  .validator((data: { id: string; format: "json" | "csv" }) => data)
  .handler(async ({ data }) => {
    const storage = getScrapeStorage();
    const run = await storage.getRun(data.id);
    if (!run) throw new Error("Run not found");
    const pages = await storage.getPages(data.id);

    if (data.format === "json") {
      return {
        format: "json" as const,
        filename: `scrape-${run.id}.json`,
        contentType: "application/json",
        body: JSON.stringify({ run, pages }, null, 2),
      };
    }

    return {
      format: "csv" as const,
      filename: `scrape-${run.id}.csv`,
      contentType: "text/csv",
      body: pagesToCsv(pages),
    };
  });

function pagesToCsv(pages: WccPage[]): string {
  const header = ["url", "title", "depth", "loadedTime", "httpStatus", "markdown", "text"];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = pages.map((p) =>
    [
      p.url,
      p.metadata?.title ?? "",
      String(p.crawl?.depth ?? ""),
      p.crawl?.loadedTime ?? "",
      String(p.crawl?.httpStatusCode ?? ""),
      (p.markdown ?? "").slice(0, 2000),
      (p.text ?? "").slice(0, 2000),
    ]
      .map((c) => escape(c))
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}
