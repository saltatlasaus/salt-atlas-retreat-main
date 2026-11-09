import { z } from "zod";
import type { Fact, PageSection, Resort, SourceType } from "../types";
import type { WccPage } from "../wcc-types";

export const agentKind = z.enum(["scout", "reviewer", "writer", "editor"]);
export type AgentKind = z.infer<typeof agentKind>;
const url = z.string().url().refine((s) => /^https?:\/\//i.test(s), "Only HTTP(S) URLs are allowed");

export const discoverySchema = z.object({
  resorts: z.array(z.object({
    name: z.string().min(2).max(180),
    officialUrl: url.optional(),
    competitorUrls: z.array(z.object({ url, competitorId: z.string() })).max(12),
    otherSources: z.array(url).max(12).default([]),
    identityEvidence: z.string().max(700),
    needsIdentityReview: z.boolean(),
  })).max(40),
  notes: z.array(z.string()).max(15).default([]),
});
export const reviewSchema = z.object({
  facts: z.array(z.unknown()).max(80).transform((items) => items.flatMap((item) => {
    const parsed = z.object({
      factId: z.string(),
      value: z.string().min(1).max(3000),
      sourceUrl: url,
      sourceQuote: z.string().min(8).max(600),
      reasoning: z.string().max(800),
    }).safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
  missingFactIds: z.array(z.string()).max(80).default([]),
  additionalSourceUrls: z.array(z.unknown()).max(12).default([]).transform((items) => items.flatMap((item) => {
    const parsed = url.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
  exclusivity: z.object({
    status: z.enum(["clear", "needs_review", "blocked"]),
    reasoning: z.string().min(1),
    sourceUrl: url.optional(),
    sourceQuote: z.string().optional(),
  }),
  readyToDraft: z.boolean(),
});
export const writerSchema = z.object({
  sections: z.array(z.object({
    sectionId: z.string(),
    title: z.string().max(220),
    body: z.string().max(6000),
    usedFactIds: z.array(z.string()).max(30),
  })).max(20),
  warnings: z.array(z.string()).max(30).default([]),
});
export const editSchema = z.object({
  sectionId: z.string(),
  title: z.string().max(220),
  body: z.string().max(6000),
  notes: z.string().max(500).default(""),
});

export interface DiscoverInput {
  country: string;
  region: string;
  instruction: string;
  competitors: { id: string; name: string; domain: string }[];
  optionalUrl?: string;
  knownResortNames: string[];
}
export interface ReviewerInput { resort: Resort; pages: WccPage[] }
export interface WriterInput { resort: Resort; sections: PageSection[] }
export interface EditInput {
  section: PageSection;
  instruction: string;
  facts: Array<Pick<Fact, "id" | "label" | "selected" | "status">>;
}
export type AgentRequest =
  | { kind: "scout"; input: DiscoverInput; approveOverBudget?: boolean }
  | { kind: "reviewer"; input: ReviewerInput; approveOverBudget?: boolean }
  | { kind: "writer"; input: WriterInput; approveOverBudget?: boolean }
  | { kind: "editor"; input: EditInput; approveOverBudget?: boolean };

export interface AgentUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostGbp: number;
  actualCostGbp?: number;
}
export type AgentResponse =
  | { state: "approval_required"; kind: AgentKind; estimatedCostGbp: number; budgetGbp: number; reason: string }
  | { state: "completed"; kind: AgentKind; data: string; usage: AgentUsage; warnings: string[]; evidence?: Array<{ url: string; title: string; snippet: string }> };

export const SOURCE_RANK: Record<SourceType, number> = {
  official: 0, resort_owned: 1, salt_atlas: 2, independent: 3, competitor: 4,
};
