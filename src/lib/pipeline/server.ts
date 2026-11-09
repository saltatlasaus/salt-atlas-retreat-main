import { createServerFn } from "@tanstack/react-start";
import { dailyCapGbp } from "./budget";
import { utcDay } from "./db";
import { tryAdvancePipelineJob } from "./apify-advance";
import { runPipelineTick } from "./cron";
import { boardFor, runAgent } from "./runner";
import { addMessage, createJob, getJob, getTarget, latestDraft, latestOpenChatJob, patchTarget } from "./store";
import type { PipelineBoard } from "./types";

export const getPipelineBoard = createServerFn({ method: "GET" })
  .validator((data: { jobId?: string; advanceApify?: boolean } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<PipelineBoard> => {
    if (data.jobId && data.advanceApify) await tryAdvancePipelineJob(data.jobId);
    return boardFor(data.jobId);
  });

export const sendPipelineMessage = createServerFn({ method: "POST" })
  .validator((data: { text: string; jobId?: string }) => {
    const text = data?.text?.trim() ?? "";
    if (!text) throw new Error("Message is empty");
    if (text.length > 4000) throw new Error("Message is too long");
    return { text, ...(data.jobId ? { jobId: data.jobId } : {}) };
  })
  .handler(async ({ data }): Promise<PipelineBoard> => {
    const { assertStudioUnlocked } = await import("../studio-gate.server");
    assertStudioUnlocked();
    let job = data.jobId ? await getJob(data.jobId) : await latestOpenChatJob();
    if (!job || job.kind !== "chat" || job.status === "done" || job.status === "failed") {
      job = await createJob({ kind: "chat", instruction: data.text });
    }
    await addMessage(job.id, "user", data.text);

    if (job.status === "waiting_apify") {
      const { outcome } = await tryAdvancePipelineJob(job.id);
      if (outcome === "pending") {
        await addMessage(
          job.id,
          "assistant",
          "Apify is still crawling (see Scrape progress). I'll continue automatically when all runs succeed.",
        );
        return boardFor(job.id);
      }
      if (outcome === "continued" || outcome === "failed") return boardFor(job.id);
    }
    if (job.status === "paused_budget" && job.day === utcDay()) {
      await addMessage(
        job.id,
        "assistant",
        `Paused until tomorrow. Today's Claude cap is £${dailyCapGbp().toFixed(2)}.`,
      );
      return boardFor(job.id);
    }

    await runAgent(job.id);
    return boardFor(job.id);
  });

export const approvePipelinePublish = createServerFn({ method: "POST" })
  .validator((data: { targetId: string }) => {
    const targetId = data?.targetId?.trim() ?? "";
    if (!targetId) throw new Error("targetId is required");
    return { targetId };
  })
  .handler(async ({ data }): Promise<PipelineBoard> => {
    const { assertStudioUnlocked } = await import("../studio-gate.server");
    assertStudioUnlocked();
    const target = await getTarget(data.targetId);
    if (!target || target.stage !== "review") throw new Error("This resort is not waiting for publish approval");
    const draft = await latestDraft(data.targetId);
    if (!draft) throw new Error("No draft to publish");
    await patchTarget(data.targetId, { stage: "published" });
    return boardFor(target.jobId, `${target.name} approved. Public site was not deployed.`);
  });

export const tickPipeline = createServerFn({ method: "POST" }).handler(async (): Promise<PipelineBoard> => {
  const { assertStudioUnlocked } = await import("../studio-gate.server");
  assertStudioUnlocked();
  const note = await runPipelineTick();
  return boardFor(undefined, note);
});
