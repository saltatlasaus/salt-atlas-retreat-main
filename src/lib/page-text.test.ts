import { describe, expect, it } from "vitest";
import { checkPage, constrainCrawl } from "./crawl-policy";
import { assessSample } from "./e2e-acceptance";
import { COMPETITORS } from "./mock-data";
import { matchFactId } from "./agents/fact-match";
import { applyVerifiedGaps, PRICING_SURF_WEEK_BODY_PENDING, PRICING_SURF_WEEK_META_PENDING } from "./page-gen";
import { cleanPageText, evidenceQuoteMatchesPage, quoteAppearsIn } from "./page-text";
import type { PageSection, Resort } from "./types";
import { DEFAULT_WCC_INPUT, type WccPage } from "./wcc-types";

describe("crawl policy and page evidence", () => {
  it("clamps an aggressive crawl to the studio limits", () => {
    const next = constrainCrawl({
      ...DEFAULT_WCC_INPUT,
      startUrls: [{ url: "https://awavetravel.com/mentawai" }],
      maxCrawlDepth: 20,
      maxConcurrency: 10,
      maxRequestRetries: 3,
      useSitemaps: true,
    });
    expect(next.maxCrawlDepth).toBe(3);
    expect(next.maxConcurrency).toBe(2);
    expect(next.maxRequestRetries).toBe(1);
    expect(next.useSitemaps).toBe(false);
    expect(next.respectRobotsTxtFile).toBe(true);
  });

  it("flags challenge and database-error pages", () => {
    const challenge: WccPage = {
      url: "https://example.com",
      markdown: "One moment, please. Your request is being verified.",
      crawl: { httpStatusCode: 200 },
    };
    const db: WccPage = {
      url: "https://example.com/rooms",
      markdown: "Error establishing a database connection. Please try again later. ".repeat(4),
      crawl: { httpStatusCode: 200 },
    };
    expect(checkPage(challenge)).toBe("challenge");
    expect(checkPage(db)).toBe("challenge");
  });

  it("keeps a quote only when it survives page cleaning", () => {
    const raw = "Home\nAccept all cookies\n\nThe lodge sleeps 12 guests in bungalows.";
    const cleaned = cleanPageText(raw);
    expect(cleaned).not.toMatch(/cookies/i);
    expect(quoteAppearsIn("sleeps 12 guests", cleaned)).toBe(true);
    expect(quoteAppearsIn("unlimited guests", cleaned)).toBe(false);
    expect(quoteAppearsIn("surf", cleaned)).toBe(false);
  });

  it("evidence matching tolerates case and unicode quotes", () => {
    const page = "The lodge offers dining from €45 per person per night in season.";
    expect(evidenceQuoteMatchesPage("€45 per person per night", page)).toBe(true);
    expect(evidenceQuoteMatchesPage("“€45” per person per night", page)).toBe(true);
    expect(evidenceQuoteMatchesPage("SURF PACKAGES START AT $1,200", "surf packages start at $1200 per week")).toBe(true);
  });

  it("replaces Surf week pricing row when price7 is verified or on file", () => {
    const sections: PageSection[] = [{
      id: "pricing-reef", type: "pricing", visible: true, title: "Surf packages", body: "", items: [
        { id: "p1", title: "Surf week", meta: PRICING_SURF_WEEK_META_PENDING, body: PRICING_SURF_WEEK_BODY_PENDING },
      ], factIds: [],
    }];
    const resort = { id: "reef", facts: [{ id: "reef-price7", status: "verified", selected: "From US$2,450 pp · 7 nights" }] } as Resort;
    expect(applyVerifiedGaps(sections, resort)).toBeGreaterThanOrEqual(2);
    expect(sections[0]?.items[0]?.meta).toBe("From US$2,450 pp · 7 nights");
    expect(sections[0]?.items[0]?.body).toMatch(/Confirm seasonal validity/);
  });

  it("replaces an awaiting-verification gap once the field has a source", () => {
    const sections: PageSection[] = [{
      id: "accommodation-reef", type: "accommodation", visible: true, title: "Stay",
      body: "Capacity: [capacity — awaiting verification].", items: [], factIds: [],
    }];
    const resort = { id: "reef", facts: [{ id: "reef-capacity", status: "verified", selected: "12 guests" }] } as Resort;
    expect(applyVerifiedGaps(sections, resort)).toBe(1);
    expect(sections[0]?.body).toBe("Capacity: 12 guests.");
  });

  it("maps a short fact key back to the checklist id", () => {
    expect(matchFactId("capacity", ["reef-capacity", "reef-price7"])).toBe("reef-capacity");
    expect(matchFactId("reef-price7", ["reef-capacity", "reef-price7"])).toBe("reef-price7");
  });

  it("uses the real competitor listing domains", () => {
    expect(COMPETITORS.find((c) => c.id === "awave")?.domain).toBe("awavetravel.com");
    expect(COMPETITORS.find((c) => c.id === "tpw")?.domain).toBe("perfectwavetravel.com");
  });

  it("fails a sample that has no linked scrape or human exclusivity decision", () => {
    const result = assessSample({
      url: "https://example.com",
      usablePages: 2,
      facts: [{ value: "sleeps 12 guests", quoted: true }],
      exclusivityClearedByHuman: false,
      draftStored: true,
    });
    expect(result.pass).toBe(false);
    expect(result.checks.linkedRun).toBe(false);
    expect(result.checks.exclusivity).toBe(false);
  });
});
