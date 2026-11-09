import { afterEach, describe, expect, it, vi } from "vitest";
import { extractLeads, focusExcerpt, keyScore, pickPagesForFacts } from "./fact-hints";
import { modelChain, modelFor, postAnthropic, pricingFor, usdCost } from "./models";
import { cleanPageText, evidenceQuoteMatchesPage } from "../page-text";
import type { WccPage } from "../wcc-types";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} about the lodge atmosphere and the friendly team.`).join("\n");

const home: WccPage = { url: "https://reef.example/", markdown: `# Reef\n${filler(80)}` };
const rates: WccPage = { url: "https://reef.example/rates", markdown: `# Rates\nSurf week from US$2,450 pp · 7 nights\nStay 3 nights, get the 4th night free. Promo code STAY3GET4\n${filler(80)}` };
const surf: WccPage = { url: "https://reef.example/surfing", markdown: `# Surf\nThe reef break at Pavones is a long left for intermediate surfers.\n${filler(80)}` };
const contact: WccPage = {
  url: "https://reef.example/contact",
  markdown: `# Contact\nGetting here: the nearest airport is Liberia (LIR), 2 hours by shuttle.\nReservations: book@reef.example\nPhotos: imagery@sentry.io`,
};

describe("field-aware page choice", () => {
  it("scores the contact page for email and airport, not the homepage", () => {
    expect(keyScore(contact, "email")).toBeGreaterThan(keyScore(home, "email"));
    expect(keyScore(contact, "airport")).toBeGreaterThan(keyScore(home, "airport"));
  });

  it("keeps the contact page in a small selection even when bigger pages rank higher", () => {
    const ranked = [rates, surf, home, contact];
    const chosen = pickPagesForFacts(ranked, ["price7", "break", "email", "airport"], 3);
    expect(chosen).toContain(contact);
    expect(chosen).toContain(rates);
    expect(chosen).toContain(surf);
  });

  it("never exceeds the limit and returns pages in ranked order", () => {
    const ranked = [rates, surf, home, contact];
    const chosen = pickPagesForFacts(ranked, ["email"], 2);
    expect(chosen).toHaveLength(2);
    expect(ranked.indexOf(chosen[0]!)).toBeLessThan(ranked.indexOf(chosen[1]!));
  });
});

describe("focusExcerpt", () => {
  const long = `${filler(120)}\nReservations: book@reef.example\n${filler(5)}\nOur nearest airport is Liberia (LIR).\n${filler(120)}\nFooter: write to hello@reef.example`;

  it("returns short pages unchanged", () => {
    expect(focusExcerpt("short page", ["email"], 500)).toBe("short page");
  });

  it("keeps relevant middle lines and the footer that a head-only cut would drop", () => {
    const out = focusExcerpt(cleanPageText(long), ["email", "airport"], 3000);
    expect(out.length).toBeLessThanOrEqual(3600);
    expect(out).toContain("book@reef.example");
    expect(out).toContain("Liberia (LIR)");
    expect(out).toContain("hello@reef.example");
    expect(out).toContain("…");
  });

  it("only emits text that exists in the page, so quote validation still passes", () => {
    const cleaned = cleanPageText(long);
    const out = focusExcerpt(cleaned, ["email", "airport"], 3000);
    const lines = out.split("\n").filter((l) => l !== "…");
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(cleaned.includes(line)).toBe(true);
    // and a quote lifted from the excerpt is accepted by the same gate the Reviewer merge uses
    expect(evidenceQuoteMatchesPage("Reservations: book@reef.example", long)).toBe(true);
    expect(out).toContain("Reservations: book@reef.example");
  });
});

describe("extractLeads", () => {
  it("finds the resort-domain email first and drops junk addresses", () => {
    const leads = extractLeads([contact], ["email"], { officialHost: "reef.example" });
    expect(leads.map((l) => l.line).join("\n")).toContain("book@reef.example");
    expect(leads.some((l) => l.line.includes("sentry.io"))).toBe(false);
    expect(leads[0]?.line).toContain("book@reef.example");
  });

  it("surfaces price and promo lines with no currency", () => {
    const lines = extractLeads([rates], ["price7"]).map((l) => l.line);
    expect(lines.some((l) => /US\$2,450/.test(l))).toBe(true);
    expect(lines.some((l) => /STAY3GET4/.test(l))).toBe(true);
  });

  it("is capped and tagged with the source url", () => {
    const leads = extractLeads([home, rates, surf, contact], ["price7", "email", "airport", "break"], { max: 5 });
    expect(leads.length).toBeLessThanOrEqual(5);
    expect(leads.every((l) => l.url.startsWith("https://reef.example"))).toBe(true);
  });
});

describe("model roles and pricing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const ROLES = ["scout", "search", "reviewer", "writer", "editor", "pipeline"] as const;

  it("defaults every role to the existing fast model, so cost does not change", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    vi.stubEnv("ANTHROPIC_MODEL_STRONG", "");
    for (const role of ROLES) expect(modelFor(role)).toBe("claude-haiku-5-5");
  });

  it("follows ANTHROPIC_MODEL when set, for every role", () => {
    vi.stubEnv("ANTHROPIC_MODEL_STRONG", "");
    vi.stubEnv("ANTHROPIC_MODEL", "my-model");
    for (const role of ROLES) expect(modelFor(role)).toBe("my-model");
  });

  it("is opt-in: STRONG moves only the judgement roles, a role pin wins, and fast is the fallback", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-haiku-5-5");
    vi.stubEnv("ANTHROPIC_MODEL_STRONG", "claude-opus-x");
    expect(modelFor("reviewer")).toBe("claude-opus-x");
    expect(modelFor("editor")).toBe("claude-haiku-5-5");
    vi.stubEnv("ANTHROPIC_MODEL_REVIEWER", "pinned-model");
    expect(modelFor("reviewer")).toBe("pinned-model");
    expect(modelFor("scout")).toBe("claude-opus-x");
    expect(modelChain("reviewer")).toEqual(["pinned-model", "claude-haiku-5-5"]);
  });

  it("has a single-entry chain by default (nothing to fall back to)", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    vi.stubEnv("ANTHROPIC_MODEL_STRONG", "");
    expect(modelChain("reviewer")).toEqual(["claude-haiku-5-5"]);
  });

  it("prices stronger tiers higher and lets env override the estimate", () => {
    expect(pricingFor("claude-sonnet-5-5").inUsdPerM).toBeGreaterThan(pricingFor("claude-haiku-5-5").inUsdPerM);
    expect(pricingFor("claude-opus-5").inUsdPerM).toBeGreaterThan(pricingFor("claude-sonnet-5-5").inUsdPerM);
    vi.stubEnv("CLAUDE_SONNET_INPUT_USD_PER_M", "7");
    expect(usdCost("claude-sonnet-5-5", 1_000_000, 0)).toBeCloseTo(7, 5);
  });

  it("retries with the fast model when an opted-in model id is rejected, and reports which answered", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-haiku-5-5");
    vi.stubEnv("ANTHROPIC_MODEL_STRONG", "claude-sonnet-5-5");
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const model = (JSON.parse(init.body) as { model: string }).model;
      seen.push(model);
      return model.includes("sonnet")
        ? new Response(JSON.stringify({ error: { type: "not_found_error", message: `model: ${model}` } }), { status: 404 })
        : new Response("{}", { status: 200 });
    }));
    const out = await postAnthropic("reviewer", "key", { max_tokens: 10 });
    expect(out.res.ok).toBe(true);
    expect(out.model).toMatch(/haiku/);
    expect(seen).toEqual([expect.stringMatching(/sonnet/), expect.stringMatching(/haiku/)]);
  });

  it("does not retry on an unrelated failure", async () => {
    vi.stubEnv("ANTHROPIC_MODEL_STRONG", "claude-sonnet-5-5");
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await postAnthropic("reviewer", "key", {});
    expect(out.res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
