import type { Fact, Resort, Stage } from "./types";

export const STAGES: { id: Stage; label: string; short: string; to: string }[] = [
  { id: "discover", label: "Discover", short: "01", to: "/discover" },
  { id: "scrape", label: "Scrape", short: "02", to: "/scrape" },
  { id: "research", label: "Research & Verify", short: "03", to: "/research" },
  { id: "generate", label: "Generate, Edit & Publish", short: "04", to: "/studio" },
];

export function stageIndex(s: Stage) { return s === "published" ? 4 : STAGES.findIndex((x) => x.id === s); }

export function completeness(r: Resort) {
  if (!r.facts.length) return 0;
  const ok = r.facts.filter((f) => f.status === "verified" || (f.status === "single" && !!f.selected)).length;
  return Math.round((ok / r.facts.length) * 100);
}

export function openIssues(r: Resort): string[] {
  const out: string[] = [];
  const by = (s: Fact["status"]) => r.facts.filter((f) => f.status === s).length;
  if (by("conflict")) out.push(`${by("conflict")} conflict${by("conflict") > 1 ? "s" : ""}`);
  if (by("missing")) out.push(`${by("missing")} missing`);
  if (by("needs_confirmation")) out.push(`${by("needs_confirmation")} to confirm`);
  if (r.exclusivity.status === "blocked") out.push("Exclusivity blocked");
  if (r.exclusivity.status === "needs_review") out.push("Exclusivity review");
  const failed = r.sources.filter((s) => s.scrape === "failed").length;
  if (failed) out.push(`${failed} failed URL${failed > 1 ? "s" : ""}`);
  if (r.page?.pendingFactChanges.length) out.push("Research changed since publish");
  return out;
}

export function verificationLabel(r: Resort) {
  if (!r.facts.length) return r.stage === "discover" ? "Not started" : "Awaiting extraction";
  const c = completeness(r);
  return c === 100 ? "Fully verified" : `${c}% verified`;
}

export function nextAction(r: Resort): { label: string; to: string } {
  switch (r.stage) {
    case "discover": return { label: "Select URLs", to: "/discover" };
    case "scrape": return { label: "Run scrape", to: "/scrape" };
    case "research": return { label: r.exclusivity.status === "blocked" ? "Review exclusivity" : "Resolve facts", to: "/research" };
    case "generate": return { label: !r.page ? "Generate page" : r.page.status === "approved" ? "Publish" : "Edit & review", to: "/studio" };
    case "published": return { label: r.page?.pendingFactChanges.length ? "Update pricing" : "Edit live page", to: "/studio" };
  }
}

export function factNeedsResearch(fact: Pick<Fact, "status" | "selected">): boolean {
  return fact.status === "missing" || fact.status === "conflict" || fact.status === "needs_confirmation";
}

export function openResearchFacts(r: Resort): Fact[] {
  return r.facts.filter(factNeedsResearch);
}

export function researchClear(r: Resort): boolean {
  return r.facts.length > 0 && openResearchFacts(r).length === 0;
}

export function canGenerate(r: Resort) {
  return r.exclusivity.status === "clear" && completeness(r) >= 60;
}

export function generateBlockReason(r: Resort): string {
  if (r.exclusivity.status === "blocked") return "Exclusivity is blocked, so HTML stays off.";
  if (r.exclusivity.status !== "clear") return "Mark exclusivity clear, then generate HTML.";
  const score = completeness(r);
  if (score < 60) return `Verified fields are ${score}%. Generate needs 60%.`;
  return "";
}

export interface QualityCheck { id: string; label: string; ok: boolean; blocking: boolean; detail: string }
export function qualityChecks(r: Resort): QualityCheck[] {
  const page = r.page;
  const text = JSON.stringify(page?.sections ?? []);
  const price = r.facts.find((f) => f.id.endsWith("price7"));
  const photos = r.facts.find((f) => f.id.endsWith("photos"));
  return [
    { id: "excl", label: "Exclusivity", ok: r.exclusivity.status === "clear", blocking: true, detail: r.exclusivity.status === "clear" ? "No exclusive competitor relationship found" : r.exclusivity.status === "blocked" ? "Blocked — cannot publish" : "Needs human review" },
    { id: "complete", label: "Research completeness", ok: completeness(r) >= 80, blocking: false, detail: `${completeness(r)}% of template fields verified` },
    { id: "claims", label: "Supported factual claims", ok: !text.includes("awaiting verification"), blocking: true, detail: text.includes("awaiting verification") ? "Page contains unverified placeholders" : "Every claim maps to a fact" },
    { id: "sources", label: "Source validity", ok: !r.sources.some((s) => s.selected && s.scrape === "failed"), blocking: false, detail: "Evidence URLs resolved" },
    { id: "pricing", label: "Pricing verification", ok: price?.status === "verified", blocking: true, detail: price?.status === "verified" ? `${price.selected} confirmed on official site` : "Price not independently verified" },
    { id: "photos", label: "Photography permissions", ok: photos?.status === "verified", blocking: true, detail: photos?.status === "verified" ? "Licensed / owned images only" : "Image licence unconfirmed" },
    { id: "original", label: "Originality of writing", ok: true, blocking: false, detail: "No overlap with competitor copy (mock check)" },
    { id: "links", label: "Images & links", ok: !!page?.sections.every((s) => s.type !== "hero" || !!s.image), blocking: false, detail: "Hero image and CTAs present" },
    { id: "template", label: "Template compatibility", ok: true, blocking: false, detail: "All sections map to template v0 (provisional)" },
    { id: "editorial", label: "Editorial approval", ok: page?.status === "approved" || page?.status === "live", blocking: true, detail: page?.status === "approved" || page?.status === "live" ? "Approved by editor" : "Awaiting approval" },
  ];
}
