/**
 * Per-role Claude model selection, pricing, and a fetch wrapper with a safe fallback.
 *
 * Default: every role uses ANTHROPIC_MODEL (claude-haiku-5-5), exactly as before. Nothing gets more expensive
 * unless you opt in:
 *   ANTHROPIC_MODEL_STRONG   → moves the judgement roles (scout, search, reviewer, writer, pipeline) to a bigger model
 *   ANTHROPIC_MODEL_<ROLE>   → pin one role (SCOUT, SEARCH, REVIEWER, WRITER, EDITOR, PIPELINE)
 */

export type AgentRole = "scout" | "search" | "reviewer" | "writer" | "editor" | "pipeline";

export const DEFAULT_FAST_MODEL = "claude-haiku-5-5";

/** Which tier each role belongs to. With no STRONG override both tiers resolve to the same (fast) model. */
const ROLE_TIER: Record<AgentRole, "fast" | "strong"> = {
  scout: "strong", // decides what is "official"; feeds the whole run
  search: "strong", // writes queries and follows up on results during gap fill
  reviewer: "strong", // long-context extraction with strict quoting
  writer: "strong", // customer-facing copy under a facts-only constraint
  editor: "fast", // minimal single-section patch
  pipeline: "strong", // multi-step tool-use orchestrator on /pipeline
};

const env = (key: string) => process.env[key]?.trim() ?? "";

export function fastModel(): string {
  return env("ANTHROPIC_MODEL") || DEFAULT_FAST_MODEL;
}

/** Opt-in only: unset means the fast model, so the default cost profile is unchanged. */
export function strongModel(): string {
  return env("ANTHROPIC_MODEL_STRONG") || fastModel();
}

export function modelFor(role: AgentRole): string {
  return env(`ANTHROPIC_MODEL_${role.toUpperCase()}`) || (ROLE_TIER[role] === "strong" ? strongModel() : fastModel());
}

/** Primary model first; the fast model is the fallback when the primary id is rejected (404 / unknown model). */
export function modelChain(role: AgentRole): string[] {
  return [...new Set([modelFor(role), fastModel()])];
}

type Tier = "haiku" | "sonnet" | "opus";

export function modelTier(model: string): Tier {
  if (/opus/i.test(model)) return "opus";
  if (/sonnet/i.test(model)) return "sonnet";
  return "haiku";
}

const num = (key: string, fallback: number) => {
  const n = Number(env(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * USD per million tokens. Haiku keeps the existing env names. Sonnet/Opus values are conservative
 * ESTIMATES used for spend tracking and the approval gate — set the env vars to your real contract rates.
 */
export function pricingFor(model: string): { inUsdPerM: number; outUsdPerM: number } {
  switch (modelTier(model)) {
    case "opus":
      return { inUsdPerM: num("CLAUDE_OPUS_INPUT_USD_PER_M", 15), outUsdPerM: num("CLAUDE_OPUS_OUTPUT_USD_PER_M", 75) };
    case "sonnet":
      return { inUsdPerM: num("CLAUDE_SONNET_INPUT_USD_PER_M", 3), outUsdPerM: num("CLAUDE_SONNET_OUTPUT_USD_PER_M", 15) };
    default:
      return { inUsdPerM: num("CLAUDE_INPUT_USD_PER_M", 0.1), outUsdPerM: num("CLAUDE_OUTPUT_USD_PER_M", 0.5) };
  }
}

export function usdCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = pricingFor(model);
  return (inputTokens * p.inUsdPerM + outputTokens * p.outUsdPerM) / 1_000_000;
}

const API = "https://api.anthropic.com/v1/messages";

async function rejectedModel(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  const text = await res.clone().text().catch(() => "");
  return /model/i.test(text) && /(not.?found|invalid|unknown|does not exist|not supported)/i.test(text);
}

/**
 * POST to the Messages API with the role's model. If that model id is rejected, retry once with the fast
 * model so a wrong/unavailable id degrades quality instead of taking the whole pipeline down.
 * Returns the response plus the model that actually answered (use it for cost accounting).
 */
export async function postAnthropic(
  role: AgentRole,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; model: string }> {
  const chain = modelChain(role);
  let last: { res: Response; model: string } | undefined;
  for (const model of chain) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ ...body, model }),
    });
    last = { res, model };
    if (res.ok || !(await rejectedModel(res))) return last;
    console.warn(`[claude] model "${model}" rejected for role ${role} (${res.status}); trying next`);
  }
  return last!;
}
