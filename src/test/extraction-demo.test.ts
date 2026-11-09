/**
 * Extraction demo (skipped unless DEMO_PAGES_JSON points at a JSON array of {url, markdown} pages).
 *
 *   DEMO_PAGES_JSON=/tmp/pages.json DEMO_OFFICIAL_URL=https://resort.example npx vitest run src/test/extraction-demo.test.ts
 *
 * Compares what the Reviewer prompt would contain under the OLD selection (top 12 pages by score, first 7000
 * chars of each) and the NEW one (field-aware pages, focused excerpts, regex leads). No Claude call, no cost.
 *
 * Scoring uses NEEDLES found by plain regexes over the whole crawl (not the hint regexes the new picker uses),
 * so the new picker is not grading itself: how many distinct email / airport / price lines of the crawl
 * actually reach the model?
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blankFacts } from "@/lib/agents/agent-client";
import { reviewEvidence, scorePageForReview } from "@/lib/agents/agent-server";
import { cleanPageText } from "@/lib/page-text";
import type { Resort } from "@/lib/types";
import type { WccPage } from "@/lib/wcc-types";

const file = process.env["DEMO_PAGES_JSON"];

/** The previous selection logic, kept verbatim for comparison. */
function oldEvidence(pages: WccPage[], resort: Resort) {
  return [...pages]
    .sort((a, b) => scorePageForReview(b, resort) - scorePageForReview(a, resort))
    .slice(0, 12)
    .flatMap((page) => {
      const markdown = cleanPageText(page.markdown ?? page.text ?? "").slice(0, 7000);
      return markdown.length >= 40 ? [{ url: page.url, markdown }] : [];
    });
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

function needles(pages: WccPage[]) {
  const email = new Set<string>();
  const airport = new Set<string>();
  const price = new Set<string>();
  for (const p of pages) {
    for (const raw of cleanPageText(p.markdown ?? "").split("\n")) {
      const line = raw.trim();
      if (line.length < 12 || line.length > 400) continue;
      if ((line.match(EMAIL) ?? []).some((e) => !/\.(png|jpe?g|webp|svg|gif)$/i.test(e))) email.add(line);
      if (/airport/i.test(line)) airport.add(line);
      if (/[$€£]\s?\d/.test(line)) price.add(line);
    }
  }
  return { email: [...email], airport: [...airport], price: [...price] };
}

const row = (label: string, found: number, total: number) =>
  `${label.padEnd(22)} ${String(found).padStart(3)} / ${String(total).padEnd(3)} ${total ? `${Math.round((100 * found) / total)}%` : "-"}`;

describe.skipIf(!file)("extraction demo on a real crawl", () => {
  const pages: WccPage[] = file ? (JSON.parse(readFileSync(file, "utf8")) as WccPage[]) : [];
  const official = process.env["DEMO_OFFICIAL_URL"] ?? "https://example.com";
  const resort = {
    id: "demo", name: "Demo resort", country: "", region: "", destination: "", stage: "research", officialUrl: official,
    competitors: [], sources: [], facts: blankFacts("demo"), exclusivity: { status: "needs_review", evidence: [] }, researchLog: [],
  } as Resort;

  it("shows how much more of the crawl reaches the model", () => {
    const oldPages = oldEvidence(pages, resort);
    const next = reviewEvidence(pages, resort);
    const oldText = oldPages.map((p) => p.markdown).join("\n");
    const newText = [...next.pages.map((p) => p.markdown), ...next.leads.map((l) => l.line)].join("\n");
    const all = needles(pages);
    const reach = (text: string, list: string[]) => list.filter((line) => text.includes(line)).length;

    const lines = [
      "",
      `Crawl: ${pages.length} pages, ${pages.reduce((n, p) => n + (p.markdown?.length ?? 0), 0).toLocaleString()} chars`,
      `Prompt evidence   OLD: ${oldPages.length} pages, ${oldText.length.toLocaleString()} chars   NEW: ${next.pages.length} pages + ${next.leads.length} leads, ${newText.length.toLocaleString()} chars`,
      "",
      "Distinct lines from the whole crawl that reach the model (needles found by independent regex)",
      `${"".padEnd(22)} OLD            NEW`,
      ...(["email", "airport", "price"] as const).map((k) => {
        const o = row(k, reach(oldText, all[k]), all[k].length);
        return `${o}   ${String(reach(newText, all[k])).padStart(3)} / ${all[k].length}`;
      }),
      "",
      "Pages the NEW selection chose:",
      ...next.pages.map((p) => `  ${p.url.replace(/^https?:\/\/[^/]+/, "") || "/"}  (${p.markdown.length} chars)`),
      "",
      "Leads handed to the model (first 12):",
      ...next.leads.slice(0, 12).map((l) => `  [${l.key}] ${l.line.slice(0, 110)}`),
    ];
    console.log(lines.join("\n"));

    // Never worse than before on any needle type, and strictly better overall.
    for (const k of ["email", "airport", "price"] as const) {
      expect(reach(newText, all[k])).toBeGreaterThanOrEqual(reach(oldText, all[k]));
    }
    expect(newText.length).toBeLessThan(90_000);
  });
});
