import { FACT_HINTS, focusExcerpt, pickPagesForFacts } from "../agents/fact-hints";
import { checkPage, RESORT_CRAWL_PRESET } from "../crawl-policy";
import { cleanPageText, evidenceQuoteMatchesPage } from "../page-text";
import { getScrapeStorage } from "../scrape-storage";
import { createScrapeRunRecord } from "../scrape-server";
import { DEFAULT_WCC_INPUT, type WccPage } from "../wcc-types";
import { pipelineBucket } from "./db";
import {
  getJob,
  getTarget,
  insertDraft,
  insertFact,
  insertTarget,
  latestDraft,
  listFactsForTargets,
  listMessages,
  listOpenTargets,
  listTargets,
  patchJob,
  patchTarget,
  resortKey,
  settleJob,
} from "./store";
import type { PipelineDraftSection, PipelineTarget } from "./types";

export interface ToolResult {
  text: string;
  halt?: "apify";
}

const TOOLS = [
  {
    name: "discover",
    description:
      "Save official surf-resort websites for a destination. Call this before scrape. Max 8 resorts. Use real official URLs only.",
    input_schema: {
      type: "object",
      properties: {
        destination: { type: "string" },
        resorts: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              url: { type: "string" },
            },
            required: ["name", "url"],
          },
        },
      },
      required: ["destination", "resorts"],
    },
  },
  {
    name: "scrape",
    description:
      "Start one polite Apify crawl per target URL (follows internal links to depth 2, up to 35 pages per resort: rates, rooms, surf, getting here, contact; concurrency capped). Multiple resorts crawl in parallel. Returns immediately; poll scrape progress until SUCCEEDED, then research.",
    input_schema: {
      type: "object",
      properties: {
        targetIds: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "research",
    description:
      `Save facts taken only from scraped page excerpts. "value" must be a short verbatim phrase copied from the page at sourceUrl (it is checked against the stored page text; paraphrases are rejected). sourceUrl must be one of the crawled page URLs for that target. Use these keys, and try to cover every one the excerpts support: ${Object.keys(FACT_HINTS).join(", ")}. Do not invent values; skip a key the excerpts do not state.`,
    input_schema: {
      type: "object",
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              targetId: { type: "string" },
              key: { type: "string" },
              value: { type: "string" },
              sourceUrl: { type: "string" },
            },
            required: ["targetId", "key", "value", "sourceUrl"],
          },
        },
      },
      required: ["facts"],
    },
  },
  {
    name: "generate",
    description:
      "Write a draft page from verified facts only. Each section body must stay inside those facts. Missing facts stay as gaps, never guesses.",
    input_schema: {
      type: "object",
      properties: {
        drafts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              targetId: { type: "string" },
              title: { type: "string" },
              sections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    body: { type: "string" },
                  },
                  required: ["title", "body"],
                },
              },
            },
            required: ["targetId", "title", "sections"],
          },
        },
      },
      required: ["drafts"],
    },
  },
  {
    name: "publish",
    description:
      "Queue a stored draft for a person to approve. Does not mark the resort published and does not deploy the public site.",
    input_schema: {
      type: "object",
      properties: {
        targetIds: { type: "array", items: { type: "string" } },
      },
      required: ["targetIds"],
    },
  },
] as const;

export function pipelineToolSchemas(): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as unknown as Record<string, unknown>,
  }));
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pagesForTarget(target: PipelineTarget, pages: WccPage[]): WccPage[] {
  const host = hostname(target.url);
  return pages.filter((p) => {
    const h = hostname(p.url);
    return h === host || p.url.startsWith(target.url.replace(/\/$/, ""));
  });
}

function usablePages(pages: WccPage[]): WccPage[] {
  return pages.filter((page) => (page.quality ?? checkPage(page)) === "usable");
}

/** Prefer official URL, then deeper paths, then most text — for better model excerpts. */
function rankPagesForExcerpt(canonicalUrl: string, pages: WccPage[]): WccPage[] {
  const norm = canonicalUrl.replace(/\/$/, "");
  const score = (p: WccPage) => {
    const u = p.url.replace(/\/$/, "");
    let s = cleanPageText(p.markdown || p.text || "").length;
    if (u === norm) s += 5000;
    else if (u.startsWith(`${norm}/`)) s += 2000;
    try {
      s += Math.min(500, new URL(p.url).pathname.split("/").filter(Boolean).length * 80);
    } catch {
      /* skip */
    }
    const code = p.crawl?.httpStatusCode ?? 200;
    if (code >= 200 && code < 300) s += 100;
    return s;
  };
  return [...pages].sort((a, b) => score(b) - score(a));
}

/**
 * Excerpts the orchestrator reads before calling `research`. Picks a page per template field (so contact,
 * getting-here, rooms pages are not crowded out by the homepage), then keeps head + tail + relevant lines
 * of each page within `charBudget` characters for this target.
 */
export async function excerptsForTarget(target: PipelineTarget, charBudget = 9000): Promise<string> {
  if (!target.scrapeRunId) return "";
  const pages = await getScrapeStorage().getPages(target.scrapeRunId);
  const ranked = rankPagesForExcerpt(target.url, usablePages(pagesForTarget(target, pages)));
  const keys = Object.keys(FACT_HINTS);
  const chosen = pickPagesForFacts(ranked, keys, 6);
  const perPage = Math.max(1200, Math.floor(charBudget / Math.max(1, chosen.length)));
  return chosen
    .map((p) => `- ${p.url}\n${focusExcerpt(cleanPageText(p.markdown || p.text || ""), keys, perPage)}`)
    .join("\n");
}

export async function executeTool(jobId: string, name: string, input: unknown): Promise<ToolResult> {
  try {
    if (name === "discover") return await discover(jobId, input);
    if (name === "scrape") return await scrape(jobId, input);
    if (name === "research") return await research(input);
    if (name === "generate") return await generate(input);
    if (name === "publish") return await publish(jobId, input);
    return { text: `Unknown tool ${name}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool failed";
    return { text: message };
  }
}

async function discover(jobId: string, input: unknown): Promise<ToolResult> {
  const data = asRecord(input);
  const destination = String(data["destination"] ?? "").trim();
  const resorts = Array.isArray(data["resorts"]) ? data["resorts"] : [];
  if (!destination) return { text: "destination is required" };
  const job = await getJob(jobId);
  const messages = await listMessages(jobId);
  const supplied = `${job?.instruction ?? ""}\n${messages.map((message) => message.content).join("\n")}`.toLowerCase();
  const existing = await listTargets();
  const seen = new Set(existing.map((t) => t.url.replace(/\/$/, "")));
  const saved: string[] = [];
  const rejected: string[] = [];
  for (const raw of resorts.slice(0, 8)) {
    const row = asRecord(raw);
    const name = String(row["name"] ?? "").trim();
    let url = String(row["url"] ?? "").trim();
    if (!name || !url) continue;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      url = new URL(url).href;
    } catch {
      continue;
    }
    const host = hostname(url);
    if (!host || (!supplied.includes(url.toLowerCase()) && !supplied.includes(host))) {
      rejected.push(url);
      continue;
    }
    const key = url.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const target = await insertTarget({ jobId, resortKey: resortKey(name), name, url });
    saved.push(`${target.name} (${target.id}) ${target.url}`);
  }
  await patchJob(jobId, { stage: "discover", status: "running" });
  const rejectedNote = rejected.length
    ? `\nRejected ${rejected.length} URL(s) that were not in the conversation.`
    : "";
  if (!saved.length) return { text: `No new resorts saved for ${destination}.${rejectedNote}` };
  return { text: `Saved ${saved.length} resort(s) for ${destination}:\n${saved.join("\n")}${rejectedNote}` };
}

async function scrape(jobId: string, input: unknown): Promise<ToolResult> {
  const data = asRecord(input);
  const requested = Array.isArray(data["targetIds"])
    ? new Set(data["targetIds"].map((id) => String(id)))
    : null;
  const open = await listOpenTargets();
  const targets = open.filter((t) => {
    if (requested && !requested.has(t.id)) return false;
    return t.stage === "discover" || t.stage === "scrape";
  });
  if (!targets.length) return { text: "No discover/scrape targets to crawl." };

  /** One polite run per resort, same preset as CEO step 2 (depth 2, 35 pages) so extraction sees more than the homepage. */
  const lines: string[] = [];
  let anyAsync = false;
  for (const target of targets) {
    const record = await createScrapeRunRecord({
      ...DEFAULT_WCC_INPUT,
      startUrls: [{ url: target.url }],
      maxCrawlDepth: RESORT_CRAWL_PRESET.maxCrawlDepth,
      maxCrawlPages: RESORT_CRAWL_PRESET.maxCrawlPages,
      maxResults: RESORT_CRAWL_PRESET.maxCrawlPages,
      initialConcurrency: RESORT_CRAWL_PRESET.initialConcurrency,
      maxConcurrency: RESORT_CRAWL_PRESET.maxConcurrency,
      saveMarkdown: true,
    });
    await patchTarget(target.id, { stage: "scrape", scrapeRunId: record.id });
    if (record.status !== "SUCCEEDED") anyAsync = true;
    lines.push(
      `${target.name}: run ${record.id} apify=${record.apifyRunId} status=${record.status} simulated=${record.simulated}`,
    );
  }
  await patchJob(jobId, { stage: "scrape", status: anyAsync ? "waiting_apify" : "running" });

  if (!anyAsync) {
    lines.push("All runs finished locally (simulated). Call research next.");
    return { text: lines.join("\n") };
  }

  return {
    text: `${lines.join("\n")}\nApify is crawling in parallel. Progress appears on the right; the next step runs when all runs succeed.`,
    halt: "apify",
  };
}

async function research(input: unknown): Promise<ToolResult> {
  const data = asRecord(input);
  const facts = Array.isArray(data["facts"]) ? data["facts"] : [];
  const saved: string[] = [];
  const rejected: string[] = [];
  const touched = new Set<string>();

  for (const raw of facts.slice(0, 40)) {
    const row = asRecord(raw);
    const targetId = String(row["targetId"] ?? "");
    const key = String(row["key"] ?? "").trim().slice(0, 80);
    const value = String(row["value"] ?? "").trim().slice(0, 500);
    const sourceUrl = String(row["sourceUrl"] ?? "").trim();
    if (!targetId || !key || !value || !sourceUrl) {
      rejected.push("incomplete fact");
      continue;
    }
    const target = await getTarget(targetId);
    if (!target?.scrapeRunId) {
      rejected.push(`${key}: target has no scrape`);
      continue;
    }
    const pages = usablePages(pagesForTarget(target, await getScrapeStorage().getPages(target.scrapeRunId)));
    const page = pages.find((item) => item.url === sourceUrl);
    if (!page) {
      rejected.push(`${key}: sourceUrl is not a usable crawled page`);
      continue;
    }
    const body = cleanPageText(page.markdown || page.text || "");
    if (!evidenceQuoteMatchesPage(value, body)) {
      rejected.push(`${key}: value is not in the page text`);
      continue;
    }
    await insertFact({ targetId, key, value, sourceUrl });
    touched.add(targetId);
    saved.push(`${key}=${value}`);
  }

  for (const targetId of touched) {
    await patchTarget(targetId, { stage: "generate" });
  }

  return {
    text: `Saved ${saved.length} fact(s).${saved.length ? `\n${saved.slice(0, 12).join("\n")}` : ""}${
      rejected.length ? `\nRejected: ${rejected.slice(0, 6).join("; ")}` : ""
    }`,
  };
}

async function generate(input: unknown): Promise<ToolResult> {
  const data = asRecord(input);
  const drafts = Array.isArray(data["drafts"]) ? data["drafts"] : [];
  const lines: string[] = [];
  for (const raw of drafts.slice(0, 8)) {
    const row = asRecord(raw);
    const targetId = String(row["targetId"] ?? "");
    const title = String(row["title"] ?? "").trim().slice(0, 180);
    const sectionsRaw = Array.isArray(row["sections"]) ? row["sections"] : [];
    const target = await getTarget(targetId);
    if (!target) {
      lines.push(`${targetId}: missing target`);
      continue;
    }
    const facts = await listFactsForTargets([targetId]);
    if (!facts.length) {
      lines.push(`${target.name}: no verified facts yet`);
      continue;
    }
    const sections: PipelineDraftSection[] = sectionsRaw.slice(0, 12).flatMap((section) => {
      const s = asRecord(section);
      const sectionTitle = String(s["title"] ?? "").trim();
      const body = String(s["body"] ?? "").trim();
      if (!sectionTitle || !body) return [];
      return [{ title: sectionTitle.slice(0, 140), body: body.slice(0, 1200) }];
    });
    if (!title || !sections.length) {
      lines.push(`${target.name}: draft needs a title and sections`);
      continue;
    }
    const r2Key = `drafts/${targetId}.json`;
    await pipelineBucket().put(r2Key, JSON.stringify({ title, sections, facts }), {
      httpMetadata: { contentType: "application/json" },
    });
    await insertDraft({ targetId, title, sections, r2Key });
    await patchTarget(targetId, { stage: "generate" });
    lines.push(`${target.name}: draft stored at ${r2Key}`);
  }
  return { text: lines.join("\n") || "No drafts saved." };
}

async function publish(jobId: string, input: unknown): Promise<ToolResult> {
  const data = asRecord(input);
  const ids = Array.isArray(data["targetIds"]) ? data["targetIds"].map((id) => String(id)) : [];
  const lines: string[] = [];
  for (const targetId of ids.slice(0, 8)) {
    const target = await getTarget(targetId);
    if (!target) {
      lines.push(`${targetId}: missing`);
      continue;
    }
    if (target.stage === "review") {
      lines.push(`${target.name}: waiting for a person to approve publish`);
      continue;
    }
    if (target.stage === "published") {
      lines.push(`${target.name}: already approved`);
      continue;
    }
    const draft = await latestDraft(targetId);
    if (!draft) {
      lines.push(`${target.name}: no draft to publish`);
      continue;
    }
    await patchTarget(targetId, { stage: "review" });
    lines.push(`${target.name}: draft queued for a person to approve. Public site was not deployed.`);
  }
  await settleJob(jobId);
  return { text: lines.join("\n") || "Nothing queued for review." };
}
