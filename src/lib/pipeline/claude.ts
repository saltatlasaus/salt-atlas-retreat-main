import { METHODOLOGY } from "../methodology";
import { postAnthropic } from "../agents/models";
import { costGbp } from "./budget";
import { pipelineToolSchemas } from "./tools";

export interface ClaudeTurn {
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  inputTokens: number;
  outputTokens: number;
  costGbp: number;
}

type ApiContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type ApiMessage = {
  role: "user" | "assistant";
  content: string | ApiContent[];
};

function apiKey(): string | undefined {
  return process.env["ANTHROPIC_API_KEY"]?.trim() || undefined;
}

export function claudeConfigured(): boolean {
  return Boolean(apiKey());
}

export function liveAgentsEnabled(): boolean {
  return process.env["ENABLE_LIVE_AGENT_CALLS"]?.trim() === "true";
}

export async function claudeTurn(messages: ApiMessage[]): Promise<ClaudeTurn> {
  if (!liveAgentsEnabled()) throw new Error("Live research is turned off.");
  const key = apiKey();
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  // 4096: a research call can carry up to 40 facts; 1200 truncated the tool JSON mid-call.
  const { res, model } = await postAnthropic("pipeline", key, {
    max_tokens: 4096,
    system: SYSTEM,
    tools: pipelineToolSchemas(),
    messages,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude ${res.status}: ${body.slice(0, 400) || res.statusText}`);
  }

  const json = (await res.json()) as {
    content?: ApiContent[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content = json.content ?? [];
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
  const toolUses = content.flatMap((block) => {
    if (block.type !== "tool_use") return [];
    return [{ id: block.id, name: block.name, input: block.input }];
  });
  const inputTokens = json.usage?.input_tokens ?? 0;
  const outputTokens = json.usage?.output_tokens ?? 0;
  return {
    text,
    toolUses,
    inputTokens,
    outputTokens,
    costGbp: costGbp(inputTokens, outputTokens, model),
  };
}

export function toolResultMessage(
  results: Array<{ id: string; text: string; isError?: boolean }>,
): ApiMessage {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.id,
      content: r.text,
      ...(r.isError ? { is_error: true } : {}),
    })),
  };
}

export function assistantBlocks(turn: ClaudeTurn): ApiContent[] {
  const blocks: ApiContent[] = [];
  if (turn.text) blocks.push({ type: "text", text: turn.text });
  for (const tool of turn.toolUses) {
    blocks.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
  }
  return blocks;
}

const SYSTEM = `You run the Salt Atlas resort pipeline. Stages, in order: discover, scrape, research, generate, publish.

Rules:
- You do not crawl websites. Call scrape and wait. Apify crawls.
- discover saves official resort URLs only (max 8). Use URLs the user gave or that you have already confirmed. Do not invent a domain.
- research facts must quote crawled pages. Each value is a short verbatim phrase copied from the page, using the template keys listed in the research tool. Work through every key and save all the excerpts support in ONE research call (one page often answers several keys). If a key is not in an excerpt, skip it and say "Ask the resort".
- generate uses saved facts only. Unknowns stay as gaps.
- publish queues the draft for a person. It does not mark the resort published and does not deploy saltatlas.com.
- ${METHODOLOGY}
- Prefer one stage per tool call. After scrape starts, stop.
- If the queue is empty and the user did not name a destination, say so. Do not invent resorts.
- Keep replies short.`;
