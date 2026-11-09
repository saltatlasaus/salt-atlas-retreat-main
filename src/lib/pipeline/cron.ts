import { utcDay } from "./db";
import { tryAdvancePipelineJob } from "./apify-advance";
import { runAgent } from "./runner";
import { createJob, listJobsByStatus, listOpenTargets, listTargets, openDailyJob, patchJob } from "./store";

export async function advanceWaitingJobs(): Promise<string> {
  const waiting = await listJobsByStatus("waiting_apify");
  if (!waiting.length) return "No Apify jobs in flight.";

  const notes: string[] = [];
  for (const job of waiting) {
    const { note } = await tryAdvancePipelineJob(job.id);
    if (note) notes.push(note);
  }
  return notes.length ? notes.join(" ") : "No progress.";
}

export async function startDailyJob(): Promise<string> {
  const openTargets = await listOpenTargets();
  const existing = await openDailyJob();
  if (existing) {
    if (existing.status === "waiting_apify" || existing.status === "running") {
      return "Daily job already in flight.";
    }
    if (existing.status === "paused_budget" && existing.day === utcDay()) {
      return "Daily job paused: £ cap reached.";
    }
    if (!openTargets.length) {
      const review = (await listTargets()).some((target) => target.stage === "review");
      if (review) return "Drafts are waiting for a person to approve publish.";
      await patchJob(existing.id, { status: "done", stage: "published" });
      return "Nothing due.";
    }
    await runAgent(existing.id, "Daily run. Continue unpublished targets. Do not invent facts.");
    return `Resumed daily job ${existing.id}.`;
  }
  if (!openTargets.length) {
    const review = (await listTargets()).some((target) => target.stage === "review");
    return review ? "Drafts are waiting for a person to approve publish." : "Nothing due.";
  }
  const stage = openTargets[0]?.stage ?? "discover";
  const job = await createJob({
    kind: "daily",
    instruction:
      "Daily run. Continue unpublished targets through scrape, research, generate, and publish. Do not invent facts.",
    stage,
  });
  await runAgent(job.id, job.instruction);
  return `Started daily job ${job.id}.`;
}

export async function runPipelineTick(): Promise<string> {
  const advanced = await advanceWaitingJobs();
  const daily = await startDailyJob();
  return `${advanced} ${daily}`;
}

export async function runScheduled(cron: string): Promise<void> {
  if (cron === "0 6 * * *") await startDailyJob();
  await advanceWaitingJobs();
}
