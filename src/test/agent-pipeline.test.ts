import { describe, expect, beforeAll, it, vi } from "vitest";
import type { Resort, PageSection } from "@/lib/types";
import {
  blankFacts, fillOpenFacts, mergeVerifiedResearch, applyWrittenSections, applyEditorPatch, discoveredResorts,
} from "@/lib/agents/agent-client";

beforeAll(() => vi.stubGlobal("crypto", { randomUUID: () => "test-uuid" }));
function resort(): Resort {
  return {
    id: "reef", name: "Reef Guesthouse", country: "Indonesia", region: "Mentawai",
    destination: "Mentawai, Indonesia", stage: "research", officialUrl: "https://reef.example",
    competitors: ["awave"],
    sources: [{ id: "s1", url: "https://reef.example", type: "official", selected: true, scrape: "completed" }],
    facts: blankFacts("reef"),
    exclusivity: { status: "needs_review", evidence: [] },
    researchLog: [],
  };
}
const quote = "Accommodation capacity is limited to 12 guests.";
const page = { url: "https://reef.example/about", markdown: `# About\n\n${quote}` };
function review(value: string, sourceQuote = quote) {
  return {
    facts: [{
      factId: "reef-capacity", value, sourceUrl: page.url,
      sourceQuote, reasoning: "Direct quote from the official About page.",
    }],
    missingFactIds: [],
    additionalSourceUrls: [],
    exclusivity: { status: "clear", reasoning: "No exclusivity language found." },
    readyToDraft: true,
  };
}
describe("Agent evidence and patch gates", () => {
  it("starts extracted fields missing, never invented", () => {
    const r = resort();
    expect(r.facts.length).toBeGreaterThan(10);
    expect(r.facts.every((f) => f.status === "missing" && !f.selected)).toBe(true);
  });
  it("keeps the source quote and treats official evidence as a fact candidate", () => {
    const r = resort();
    const result = mergeVerifiedResearch(r, review("12 guests"), [page]);
    expect(result.applied).toEqual(["reef-capacity"]);
    expect(r.facts.find((f) => f.id === "reef-capacity")?.selected).toBe("12 guests");
    expect(r.facts.find((f) => f.id === "reef-capacity")?.status).toBe("verified");
    expect(r.facts.find((f) => f.id === "reef-capacity")?.candidates[0]?.quote).toBe(quote);
    expect(r.exclusivity.status).toBe("needs_review");
  });
  it("keeps a quote when only the line breaks differ", () => {
    const r = resort();
    const wrapped = "Accommodation\ncapacity is limited to 12 guests.";
    const result = mergeVerifiedResearch(r, review("12 guests", wrapped), [page]);
    expect(result.applied).toEqual(["reef-capacity"]);
  });
  it("fills a disagreement with the official value", () => {
    const r = resort();
    const fact = r.facts.find((item) => item.id === "reef-capacity");
    if (!fact) throw new Error("missing fact");
    fact.status = "conflict";
    fact.candidates = [
      { id: "off", value: "12 guests", sourceUrl: "https://reef.example/packages", sourceType: "official", checkedAt: "2026-11-02" },
      { id: "comp", value: "20 guests", sourceUrl: "https://example.com/reef", sourceType: "competitor", checkedAt: "2026-11-02" },
    ];
    fillOpenFacts(r);
    expect(fact.selected).toBe("12 guests");
    expect(fact.status).toBe("conflict");
  });
  it("rejects fabricated source quotes rather than filling missing research", () => {
    const r = resort();
    const result = mergeVerifiedResearch(r, review("12 guests", "Resort has unlimited guests"), [page]);
    expect(result.applied).toEqual([]);
    expect(r.facts.find((f) => f.id === "reef-capacity")?.status).toBe("missing");
  });
  it("sets pricing to Rates on request when no price evidence is returned", () => {
    const r = resort();
    const priceFact = r.facts.find((f) => f.id === "reef-price7");
    if (!priceFact) throw new Error("missing price7 fact");
    expect(priceFact.status).toBe("missing");
    const result = mergeVerifiedResearch(r, {
      facts: [],
      missingFactIds: ["reef-price7"],
      additionalSourceUrls: [],
      exclusivity: { status: "needs_review", reasoning: "Check listings." },
      readyToDraft: false,
    }, [page]);
    expect(result.applied).toEqual([]);
    expect(priceFact.selected).toBe("Rates on request");
    expect(priceFact.status).toBe("single");
    expect(priceFact.reason).toContain("No currency");
  });
  it("only lets the Writer update an existing supported section", () => {
    const r = resort();
    mergeVerifiedResearch(r, review("12 guests"), [page]);
    const section: PageSection = {
      id: "accommodation-reef", type: "accommodation", title: "Stay",
      body: "Unverified information", visible: true, items: [], factIds: ["reef-capacity"],
    };
    r.page = {
      sections: [section], versions: [], status: "draft", slug: "reef", title: "Reef", history: [], pendingFactChanges: [],
    };
    const result = applyWrittenSections(r, {
      sections: [
        { sectionId: section.id, title: "Small-group stays", body: "The resort accommodates 12 guests.", usedFactIds: ["reef-capacity"] },
        { sectionId: "not-real", title: "Fake", body: "Fake", usedFactIds: ["reef-capacity"] },
      ],
      warnings: [],
    });
    expect(result).toEqual([section.id]);
    expect(r.page.sections[0]?.title).toBe("Small-group stays");
  });
  it("rejects AI patches targeting a different section", () => {
    const section: PageSection = { id: "hero-reef", type: "hero", title: "Reef", body: "Surf", visible: true, items: [], factIds: [] };
    expect(() => applyEditorPatch(section, { sectionId: "pricing-reef", title: "Oops", body: "Oops" })).toThrow();
  });
  it("retains candidate identity uncertainty and deduplicates URLs", () => {
    const output = discoveredResorts({
      resorts: [{
        name: "Reef Guesthouse", officialUrl: "https://reef.example",
        competitorUrls: [{ url: "https://awave.com.au/reef", competitorId: "awave" }],
        otherSources: ["https://reef.example"],
        identityEvidence: "Only a candidate; ownership not confirmed.",
        needsIdentityReview: true,
      }],
      notes: [],
    }, {
      country: "Indonesia", region: "Mentawai", instruction: "Find resorts",
      competitors: [{ id: "awave", name: "A Wave", domain: "awave.com.au" }],
      knownResortNames: [],
    });
    expect(output).toHaveLength(1);
    expect(output[0]?.sources).toHaveLength(2);
    expect(output[0]?.identityNote).toContain("Identity review required");
  });
});
