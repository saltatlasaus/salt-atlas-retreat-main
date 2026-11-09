import { syncScrapeRun } from "../scrape-server";
import { addMessage, getJob, listTargetsForJob, patchJob, patchTarget } from "./store";

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);
const FAILED = new Set(["FAILED", "TIMED-OUT", "ABORTED"]);

export type ApifyAdvanceOutcome = "noop" | "pending" | "failed" | "continued";

/** Sync Apify runs for a waiting job; continue the agent when every run finishes OK. */
export async function tryAdvancePipelineJob(jobId: string): Promise<{ outcome: ApifyAdvanceOutcome; note: string }> {
  const job = await getJob(jobId);
  if (!job || job.status !== "waiting_apify") return { outcome: "noop", note: "" };

  const targets = (await listTargetsForJob(jobId)).filter((t) => t.stage === "scrape" && t.scrapeRunId);
  if (!targets.length) {
    await patchJob(jobId, { status: "failed", errorMessage: "Waiting on Apify but no scrape targets" });
    return { outcome: "failed", note: `${jobId} failed: no scrape targets` };
  }

  let pending = false;
  let failed = false;
  const seen = new Set<string>();
  for (const target of targets) {
    const runId = target.scrapeRunId;
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const run = await syncScrapeRun(runId);
    if (!TERMINAL.has(run.status)) pending = true;
    if (FAILED.has(run.status)) failed = true;
  }

  if (pending) return { outcome: "pending", note: `${jobId} still crawling` };

  if (failed) {
    await patchJob(jobId, { status: "failed", errorMessage: "Apify scrape failed" });
    await addMessage(jobId, "assistant", "Apify scrape failed. Nothing was published.");
    return { outcome: "failed", note: `${jobId} scrape failed` };
  }

  for (const target of targets) {
    await patchTarget(target.id, { stage: "research" });
  }
  const { runAgent } = await import("./runner");
  await runAgent(
    jobId,
    "Apify scrape finished. Call research using only the excerpts, then generate. Publish only queues a draft for a person. Do not invent facts.",
  );
  return { outcome: "continued", note: `Continued ${jobId}` };
}
