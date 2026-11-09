/**
 * Typed API layer. Browser never talks to Apify/Claude directly —
 * scrape calls go through createServerFn handlers in scrape-server.ts.
 * See docs/HANDOVER.md.
 */
import type { PageSection } from "./types";
import type { ScrapeRunRecord, WccInput, WccPage } from "./wcc-types";
import {
  exportScrapeRun,
  getApifyStatus,
  getScrapeRun,
  getScrapeRunItems,
  listScrapeRuns,
  resolveScrapeRunForSources,
  startScrapeRun,
} from "./scrape-server";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AiEditRequest {
  sectionId: string;
  instruction: string;
  section: PageSection;
  verifiedFacts: string[];
}
export interface AiEditResponse {
  patch: Pick<PageSection, "title" | "body">;
  model: "light" | "skill";
  tokens: number;
  notes: string;
}

/** Future: POST /api/ai/edit-section -> Claude (light model, or HTML Editor Skill for structural edits). */
export async function aiEditSection(req: AiEditRequest, attempt = 0): Promise<AiEditResponse> {
  await sleep(1400);
  const structural = /layout|spacing|cards|structure|css/i.test(req.instruction);
  const shorten = /short|concise|trim/i.test(req.instruction);
  const b = req.section.body;
  const variants = [
    shorten
      ? b.split(/[.,]/)[0] + "."
      : `${b.replace(/\.$/, "")} — and it's the kind of place you plan the next trip from before this one ends.`,
    shorten
      ? b.split(" ").slice(0, 14).join(" ") + "…"
      : `Picture it: ${b.charAt(0).toLowerCase()}${b.slice(1)}`,
  ];
  return {
    patch: { title: req.section.title, body: variants[attempt % 2] ?? b },
    model: structural ? "skill" : "light",
    tokens: structural ? 3120 : 410 + req.section.body.length,
    notes: structural
      ? "Used HTML Editor Skill — section-scoped structural patch."
      : "Copy-only patch. Verified facts preserved verbatim.",
  };
}

export async function fetchApifyStatus() {
  return getApifyStatus();
}

export async function fetchScrapeRuns(): Promise<ScrapeRunRecord[]> {
  return listScrapeRuns();
}

export async function createScrapeRun(input: WccInput): Promise<ScrapeRunRecord> {
  return startScrapeRun({ data: input });
}

export async function fetchScrapeRun(id: string): Promise<ScrapeRunRecord> {
  return getScrapeRun({ data: { id } });
}

export async function fetchScrapeRunItems(id: string): Promise<WccPage[]> {
  return getScrapeRunItems({ data: { id } });
}

export async function fetchResolvedScrapeRunId(urls: string[]): Promise<string | null> {
  const out = await resolveScrapeRunForSources({ data: { urls } });
  return out.runId;
}

export async function downloadScrapeExport(id: string, format: "json" | "csv") {
  return exportScrapeRun({ data: { id, format } });
}
