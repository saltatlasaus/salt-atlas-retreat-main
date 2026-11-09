import { syncScrapeRun } from "../scrape-server";
import { addSpendGbp, anthropicModel, budgetRemainingGbp, dailyCapGbp, spendTodayGbp } from "./budget";
import { assistantBlocks, claudeConfigured, claudeTurn, toolResultMessage, type ApiMessage } from "./claude";
import {
  addMessage,
  getJob,
  listDrafts,
  listFactsForTargets,
  listJobs,
  listMessages,
  listTargets,
  listTargetsForJob,
  patchJob,
  settleJob,
} from "./store";
import { executeTool, excerptsForTarget } from "./tools";
import type { PipelineBoard, PipelineJob, PipelineScrapeProgress } from "./types";

const MAX_ROUNDS = 5;
/** Evidence the orchestrator reads per turn (chars). Shared across all targets in research/scrape/generate. */
const SNAPSHOT_EXCERPT_BUDGET = 24_000;
const SNAPSHOT_MAX_CHARS = 30_000;

/** Sync Apify status into storage and return one row per run (targets may share a run). */
async function scrapeProgressForJob(jobId: string): Promise<PipelineScrapeProgress[]> {
  const targets = (await listTargetsForJob(jobId)).filter((t) => t.stage === "scrape" && t.scrapeRunId);
  const byRun = new Map<string, { names: string[] }>();
  for (const t of targets) {
    const id = t.scrapeRunId!;
    const cur = byRun.get(id);
    if (cur) cur.names.push(t.name);
    else byRun.set(id, { names: [t.name] });
  }
  const out: PipelineScrapeProgress[] = [];
  for (const [runId, { names }] of byRun) {
    const run = await syncScrapeRun(runId);
    out.push({
      runId: run.id,
      apifyRunId: run.apifyRunId,
      status: run.status,
      itemCount: run.itemCount,
      simulated: run.simulated,
      targetNames: names,
    });
  }
  return out;
}

export async function buildStateSnapshot(): Promise<string> {
  const targets = await listTargets();
  const open = targets.filter((t) => t.stage !== "published").slice(0, 8);
  const facts = await listFactsForTargets(open.map((t) => t.id));
  const drafts = await listDrafts();
  const lines: string[] = [];
  lines.push(`Spend today £${(await spendTodayGbp()).toFixed(4)} / £${dailyCapGbp().toFixed(2)} (${anthropicModel()}).`);
  if (!open.length) {
    lines.push("No unpublished targets.");
  }
  const needsExcerpt = (t: { stage: string }) => t.stage === "research" || t.stage === "scrape" || t.stage === "generate";
  const excerptTargets = open.filter(needsExcerpt).length;
  // Split one evidence budget across the targets that need it, so the final slice never cuts a target off blind.
  const excerptBudget = Math.min(9000, Math.max(2500, Math.floor(SNAPSHOT_EXCERPT_BUDGET / Math.max(1, excerptTargets))));
  for (const target of open) {
    const factLine = facts
      .filter((f) => f.targetId === target.id)
      .slice(0, 8)
      .map((f) => `${f.key}=${f.value}`)
      .join("; ");
    const draft = drafts.find((d) => d.targetId === target.id);
    lines.push(
      `- ${target.name} id=${target.id} stage=${target.stage} url=${target.url} scrape=${target.scrapeRunId ?? "none"}${
        draft ? ` draft=${draft.title}` : ""
      }${factLine ? ` facts: ${factLine}` : ""}`,
    );
    if (needsExcerpt(target)) {
      const excerpt = await excerptsForTarget(target, excerptBudget);
      if (excerpt) lines.push(excerpt);
    }
  }
  return lines.join("\n").slice(0, SNAPSHOT_MAX_CHARS);
}

function transcript(job: PipelineJob, prior: Array<{ role: string; content: string }>): ApiMessage[] {
  const messages: ApiMessage[] = prior
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  if (!messages.length) {
    messages.push({ role: "user", content: job.instruction });
  }
  return messages;
}

function attachState(messages: ApiMessage[], state: string): ApiMessage[] {
  const note = `Current pipeline state:\n${state}`;
  const copy = messages.map((m) => ({ ...m }));
  const last = copy[copy.length - 1];
  if (last && last.role === "user" && typeof last.content === "string") {
    last.content = `${last.content}\n\n${note}`;
    return copy;
  }
  copy.push({ role: "user", content: note });
  return copy;
}

export async function runAgent(jobId: string, nudge?: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) throw new Error("Job not found");

  if (nudge) await addMessage(jobId, "status", nudge);

  if (!claudeConfigured()) {
    await patchJob(jobId, { status: "failed", errorMessage: "ANTHROPIC_API_KEY is not set" });
    await addMessage(jobId, "assistant", "Claude is not configured. Add ANTHROPIC_API_KEY to .dev.vars and restart.");
    return;
  }

  const remaining = await budgetRemainingGbp();
  if (remaining <= 0) {
    await patchJob(jobId, { status: "paused_budget", errorMessage: "Daily £ cap reached" });
    await addMessage(
      jobId,
      "assistant",
      `Paused. Today's Claude spend is at the £${dailyCapGbp().toFixed(2)} cap.`,
    );
    return;
  }

  await patchJob(jobId, { status: "running" });
  const prior = await listMessages(jobId);
  let apiMessages = attachState(transcript(job, prior), await buildStateSnapshot());

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if ((await budgetRemainingGbp()) <= 0) {
      await patchJob(jobId, { status: "paused_budget", errorMessage: "Daily £ cap reached" });
      await addMessage(jobId, "assistant", `Paused. Today's Claude spend hit £${dailyCapGbp().toFixed(2)}.`);
      return;
    }

    let turn;
    try {
      turn = await claudeTurn(apiMessages);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Claude call failed";
      await patchJob(jobId, { status: "failed", errorMessage: message.slice(0, 300) });
      await addMessage(jobId, "assistant", message);
      return;
    }
    await addSpendGbp(turn.costGbp);
    if (turn.text) await addMessage(jobId, "assistant", turn.text);

    if (!turn.toolUses.length) {
      await settleJob(jobId);
      return;
    }

    const results: Array<{ id: string; text: string; isError?: boolean }> = [];
    let halt = false;
    for (const tool of turn.toolUses) {
      const result = await executeTool(jobId, tool.name, tool.input);
      const isError = /required|missing|Rejected|Unknown tool|not a crawled|no verified|no draft/i.test(result.text);
      results.push({ id: tool.id, text: result.text, ...(isError ? { isError: true } : {}) });
      await addMessage(jobId, "status", `${tool.name}: ${result.text}`.slice(0, 2000));
      if (result.halt === "apify") halt = true;
    }

    if (halt) {
      await patchJob(jobId, { status: "waiting_apify", stage: "scrape" });
      return;
    }

    apiMessages = [
      ...apiMessages,
      { role: "assistant", content: assistantBlocks(turn) },
      toolResultMessage(results),
    ];
  }

  await patchJob(jobId, { status: "idle" });
}

export async function boardFor(jobId?: string, note?: string): Promise<PipelineBoard> {
  const jobs = await listJobs();
  const job = (jobId ? await getJob(jobId) : undefined) ?? jobs[0];

  const messages = job ? await listMessages(job.id) : [];
  const targets = await listTargets();
  const facts = await listFactsForTargets(targets.map((t) => t.id));
  const drafts = (await listDrafts()).map((d) => ({
    id: d.id,
    targetId: d.targetId,
    title: d.title,
    ...(d.r2Key ? { r2Key: d.r2Key } : {}),
  }));
  const scrapeProgress =
    job && (job.status === "waiting_apify" || targets.some((t) => t.jobId === job.id && t.stage === "scrape"))
      ? await scrapeProgressForJob(job.id)
      : [];
  return {
    spendGbp: await spendTodayGbp(),
    capGbp: dailyCapGbp(),
    model: anthropicModel(),
    jobs,
    ...(job ? { job } : {}),
    messages,
    targets,
    facts,
    drafts,
    scrapeProgress,
    ...(note ? { note } : {}),
  };
}
