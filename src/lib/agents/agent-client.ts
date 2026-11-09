import type { Candidate, Fact, Resort, SourceUrl, PageSection, Competitor } from "../types";
import { slugify, FIELD_SPECS } from "../mock-data";
import type { AgentRequest, DiscoverInput } from "./contracts";
import { discoverySchema, reviewSchema, writerSchema, editSchema } from "./contracts";
import { executeAgent } from "./agent-server";
import type { WccPage } from "../wcc-types";
import { matchFactId } from "./fact-match";
import { evidenceQuoteMatchesPage } from "../page-text";
import { SOURCE_RANK } from "./contracts";
import { AGENT_PER_CALL_APPROVAL_GBP_DEFAULT } from "./spend-limits";

export type AgentReply = Awaited<ReturnType<typeof executeAgent>>;
export class ApprovalRequired extends Error {
  constructor(public readonly estimatedCostGbp: number, public readonly kind: string) {
    super(
      `${kind} requires approval: estimated £${estimatedCostGbp.toFixed(3)} exceeds £${AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)}`,
    );
  }
}
export async function invokeAgent(req: AgentRequest) {
  const reply = await executeAgent({ data: req });
  if (reply.state === "approval_required") throw new ApprovalRequired(reply.estimatedCostGbp, reply.kind);
  return { ...reply, data: JSON.parse(reply.data) as unknown };
}
const canonical = (s: string) => { try { const u = new URL(s); u.hash = ""; u.search = ""; return u.toString().replace(/\/$/, ""); } catch { return s; } };

export function discoveredResorts(raw: unknown, input: DiscoverInput): Resort[] {
  const data = discoverySchema.parse(raw);
  const date = new Date().toISOString();
  return data.resorts.map((entry, i) => {
    const id = `d-${slugify(entry.name)}-${i}`;
    const urls = [
      ...entry.competitorUrls.map((x) => ({ url: x.url, type: "competitor" as const, competitorId: x.competitorId })),
      ...(entry.officialUrl ? [{ url: entry.officialUrl, type: "official" as const }] : []),
      ...entry.otherSources.map((url) => ({ url, type: "independent" as const })),
    ];
    const seen = new Set<string>();
    const sources: SourceUrl[] = urls.filter((x) => {
      const key = canonical(x.url);
      if (seen.has(key)) return false; seen.add(key); return true;
    }).map((x, j) => ({
      id: `${id}-source-${j}`, url: x.url, type: x.type,
      ...("competitorId" in x && x.competitorId ? { competitorId: x.competitorId } : {}),
      selected: true, scrape: "pending",
    }));
    return {
      id, name: entry.name, region: input.region, country: input.country,
      destination: `${input.region}, ${input.country}`, stage: "discover",
      ...(entry.officialUrl ? { officialUrl: entry.officialUrl } : {}),
      identityNote: `${entry.identityEvidence} ${entry.needsIdentityReview ? "Identity review required." : ""}`.trim(),
      competitors: [...new Set(entry.competitorUrls.map((x) => x.competitorId))],
      knownBefore: input.knownResortNames.some((n) => n.toLowerCase() === entry.name.toLowerCase()),
      sources, facts: blankFacts(id),
      exclusivity: { status: "needs_review", evidence: [{ note: "No direct evidence of non-exclusivity yet.", sourceType: "independent" }] },
      researchLog: [`Discovered ${date}. Source URLs must be crawled and identity verified.`],
    } satisfies Resort;
  });
}
export function blankFacts(id: string): Fact[] {
  return FIELD_SPECS.map((f) => ({
    id: `${id}-${f.key}`, label: f.label, category: f.category,
    templateField: f.templateField, candidates: [], status: "missing" as const,
    reason: "Awaiting source-backed extraction.",
  }));
}
export function ensureResearchFacts(resort: Resort): void {
  if (!resort.facts.length) resort.facts = blankFacts(resort.id);
}
export function withLiveEvidence(
  pages: WccPage[],
  evidence?: Array<{ url: string; snippet: string }>,
): WccPage[] {
  const live = (evidence ?? [])
    .filter((item) => item.snippet.trim().length >= 8)
    .map((item) => ({ url: item.url, markdown: item.snippet, text: item.snippet }));
  return [...pages, ...live];
}

/** Write the best saved source into an open field. A disagreement stays marked, with the official value filled in. */
export function fillOpenFacts(resort: Resort): string[] {
  const filled: string[] = [];
  for (const fact of resort.facts) {
    if (fact.status !== "missing" && fact.status !== "conflict") continue;
    const active = fact.candidates.filter((candidate) => !candidate.rejected);
    if (!active.length) continue;
    const winner = [...active].sort((a, b) => SOURCE_RANK[a.sourceType] - SOURCE_RANK[b.sourceType])[0];
    if (!winner) continue;
    fact.selected = winner.value;
    fact.selectedCandidateId = winner.id;
    const distinct = new Set(active.map((candidate) => candidate.value.trim().toLowerCase()));
    if (distinct.size > 1) {
      fact.status = "conflict";
      fact.reason = "Sources disagree. The highest-ranked value is filled in.";
    } else {
      fact.status = winner.sourceType === "official" || winner.sourceType === "resort_owned" ? "verified" : "single";
      fact.reason = fact.reason || "Filled from the saved source.";
    }
    filled.push(fact.id);
  }
  return filled;
}

const PRICE_PLACEHOLDER = "Rates on request";
const PRICE_PLACEHOLDER_REASON =
  "No currency or package price appeared on scraped pages or in search snippets — editorial placeholder until a quoted rate exists.";

/** When Reviewer finds no quotable price, publish a clear single-source placeholder instead of leaving the field empty forever. */
function applyPriceMissingPlaceholder(resort: Resort) {
  const pf = resort.facts.find((f) => f.id.endsWith("-price7"));
  if (!pf || pf.status === "conflict") return;
  const hasRealSelection =
    pf.selected?.trim() &&
    pf.selected.trim().toLowerCase() !== PRICE_PLACEHOLDER.toLowerCase() &&
    (pf.status === "verified" || pf.status === "single" || pf.status === "needs_confirmation");
  if (hasRealSelection) return;

  const official = resort.officialUrl?.trim();
  let sourceUrl = resort.sources.find((s) => s.type === "official")?.url ?? resort.sources[0]?.url;
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    sourceUrl = official && /^https?:\/\//i.test(official) ? official : "https://saltatlas.com";
  }
  const now = new Date().toISOString();
  const existing = pf.candidates.find((c) => c.value === PRICE_PLACEHOLDER);
  const id = existing?.id ?? `fallback-price-${crypto.randomUUID()}`;
  if (!existing) {
    pf.candidates.push({
      id,
      value: PRICE_PLACEHOLDER,
      sourceUrl,
      sourceType: "salt_atlas",
      checkedAt: now,
      quote: "Reviewer pass: no priced package or nightly rate found in evidence — editorial placeholder.",
    });
  }
  pf.selected = PRICE_PLACEHOLDER;
  pf.selectedCandidateId = id;
  pf.status = "single";
  pf.reason = PRICE_PLACEHOLDER_REASON;
}

export function mergeVerifiedResearch(resort: Resort, raw: unknown, pages: WccPage[]) {
  const response = reviewSchema.parse(raw);
  ensureResearchFacts(resort);
  const allowed = pages.map((p) => ({
    url: canonical(p.url),
    text: p.markdown ?? p.text ?? "",
  }));
  const quoteSeen = (quote: string, sourceUrl: string) => {
    const cited = allowed.find((page) => page.url === canonical(sourceUrl));
    if (cited && evidenceQuoteMatchesPage(quote, cited.text)) return true;
    return allowed.some((page) => evidenceQuoteMatchesPage(quote, page.text));
  };
  const now = new Date().toISOString();
  const applied: string[] = [];
  for (const item of response.facts) {
    const factId = matchFactId(item.factId, resort.facts.map((fact) => fact.id));
    const f = resort.facts.find((fact) => fact.id === factId);
    if (!f || !quoteSeen(item.sourceQuote, item.sourceUrl)) continue;
    const candidate: Candidate = {
      id: `ai-${crypto.randomUUID()}`, value: item.value, sourceUrl: item.sourceUrl,
      sourceType: resort.sources.filter((s) => canonical(item.sourceUrl) === canonical(s.url) ||
        canonical(item.sourceUrl).startsWith(canonical(s.url) + "/"))
        .sort((a, b) => SOURCE_RANK[a.type] - SOURCE_RANK[b.type])[0]?.type ?? "independent",
      checkedAt: now, quote: item.sourceQuote,
    };
    if (f.candidates.some((c) => c.value === candidate.value && canonical(c.sourceUrl) === canonical(candidate.sourceUrl))) continue;
    f.candidates.push(candidate);
    const active = f.candidates.filter((c) => !c.rejected);
    const distinct = new Set(active.map((c) => c.value.trim().toLowerCase()));
    if (distinct.size > 1) {
      const winner = [...active].sort((a, b) => SOURCE_RANK[a.sourceType] - SOURCE_RANK[b.sourceType])[0];
      f.status = "conflict";
      if (winner) {
        f.selected = winner.value;
        f.selectedCandidateId = winner.id;
      }
      f.reason = "Sources disagree. The highest-ranked value is filled in.";
    } else {
      const winner = [...active].sort((a, b) => SOURCE_RANK[a.sourceType] - SOURCE_RANK[b.sourceType])[0];
      if (winner) {
        f.selected = winner.value; f.selectedCandidateId = winner.id;
        f.status = winner.sourceType === "official" || winner.sourceType === "resort_owned" ? "verified" : "single";
        f.reason = item.reasoning;
      }
    }
    applied.push(f.id);
  }
  const ex = response.exclusivity;
  const exUrl = ex.sourceUrl;
  // A model cannot clear exclusivity by itself. A human checks the decision.
  resort.exclusivity = {
    status: ex.status === "blocked" ? "needs_review" : ex.status === "clear" ? "needs_review" : ex.status,
    evidence: [...resort.exclusivity.evidence, {
      note: `AI recommendation (${ex.status}): ${ex.reasoning}`,
      ...(ex.sourceUrl ? { url: ex.sourceUrl } : {}),
      sourceType: exUrl ? resort.sources.find((s) => canonical(s.url) === canonical(exUrl))?.type ?? "independent" : "independent",
    }],
  };
  fillOpenFacts(resort);
  applyPriceMissingPlaceholder(resort);
  resort.researchLog.push(`Reviewer processed ${applied.length} evidenced facts; ${response.additionalSourceUrls.length} suggested follow-up sources.`);
  return { applied, suggestedSources: response.additionalSourceUrls, exclusivitySuggestion: ex, readyToDraft: response.readyToDraft };
}
export function applyWrittenSections(resort: Resort, raw: unknown): string[] {
  if (!resort.page) return [];
  const response = writerSchema.parse(raw);
  const allowed = new Map(resort.page.sections.map((s) => [s.id, s]));
  const changed: string[] = [];
  for (const item of response.sections) {
    const s = allowed.get(item.sectionId);
    if (!s) continue;
    const valid = item.usedFactIds.length > 0 && item.usedFactIds.every((id) =>
      s.factIds.includes(id) && resort.facts.some((f) => f.id === id && f.selected && ["verified", "single"].includes(f.status)));
    if (!valid) continue;
    s.title = item.title; s.body = item.body; changed.push(s.id);
  }
  return changed;
}
export function applyEditorPatch(section: PageSection, raw: unknown): Pick<PageSection, "title" | "body"> {
  const patch = editSchema.parse(raw);
  if (patch.sectionId !== section.id) throw new Error("AI patch does not target the selected section");
  return { title: patch.title, body: patch.body };
}
export function activeCompetitors(all: Competitor[], ids: string[]) {
  return all.filter((c) => ids.includes(c.id));
}
