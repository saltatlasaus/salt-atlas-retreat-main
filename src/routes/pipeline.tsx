import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Mono, PageHeader, Panel, Pill } from "@/components/studio/ui-bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approvePipelinePublish, getPipelineBoard, sendPipelineMessage, tickPipeline } from "@/lib/pipeline/server";
import type { PipelineBoard, PipelineJobStatus } from "@/lib/pipeline/types";

export const Route = createFileRoute("/pipeline")({
  head: () => ({
    meta: [
      { title: "Pipeline — Salt Atlas Resort Studio" },
      {
        name: "description",
        content: "Tell Claude to run discover, scrape, research, generate, and publish. A daily job continues unfinished targets.",
      },
    ],
  }),
  component: PipelinePage,
});

function statusTone(status: PipelineJobStatus): "ok" | "warn" | "bad" | "info" | "muted" {
  if (status === "done") return "ok";
  if (status === "failed") return "bad";
  if (status === "paused_budget") return "warn";
  if (status === "waiting_apify" || status === "running") return "info";
  return "muted";
}

function scrapeSummaryLines(
  rows: NonNullable<PipelineBoard["scrapeProgress"]>,
): { done: number; total: number; lines: string[] } {
  const total = rows.length;
  const done = rows.filter((r) => r.status === "SUCCEEDED").length;
  const lines = rows.map((r) => {
    const who = r.targetNames.length ? r.targetNames.join(", ") : r.runId;
    const extra = r.simulated ? " (simulated)" : "";
    const pages = r.itemCount ? ` · ${r.itemCount} pg` : "";
    return `${who}: ${r.status}${pages}${extra}`;
  });
  return { done, total, lines };
}

function PipelinePage() {
  const [board, setBoard] = useState<PipelineBoard | null>(null);
  const [text, setText] = useState(
    "Discover surf lodges in Ericeira and take them through scrape, research, and a draft.",
  );
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const load = async (jobId?: string, advanceApify?: boolean) => {
    const next = await getPipelineBoard({
      data: jobId ? { jobId, ...(advanceApify ? { advanceApify: true } : {}) } : {},
    });
    setBoard(next);
    setSelectedId(next.job?.id);
    setLastSyncedAt(new Date());
  };

  useEffect(() => {
    void load().catch(() => toast.error("Could not load the pipeline. Is local D1 migrated?"));
  }, []);

  /** While Apify runs, poll: sync status, continue workflow when all runs finish. */
  useEffect(() => {
    if (!board?.job || board.job.status !== "waiting_apify") return;
    const id = board.job.id;
    const t = window.setInterval(() => {
      void load(id, true).catch(() => {});
    }, 4000);
    return () => window.clearInterval(t);
  }, [board?.job?.id, board?.job?.status]);

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setBusy(true);
    try {
      const next = await sendPipelineMessage({
        data: { text: message, ...(selectedId ? { jobId: selectedId } : {}) },
      });
      setBoard(next);
      setSelectedId(next.job?.id);
      setText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (targetId: string) => {
    setBusy(true);
    try {
      const next = await approvePipelinePublish({ data: { targetId } });
      setBoard(next);
      setSelectedId(next.job?.id);
      if (next.note) toast.message(next.note);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  };

  const tick = async () => {
    setBusy(true);
    try {
      const next = await tickPipeline();
      setBoard(next);
      setSelectedId(next.job?.id);
      if (next.note) toast.message(next.note);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Tick failed");
    } finally {
      setBusy(false);
    }
  };

  const spend = board ? `£${board.spendGbp.toFixed(3)} / £${board.capGbp.toFixed(2)}` : "…";
  const waitingApify = board?.job?.status === "waiting_apify";
  const progress = board?.scrapeProgress?.length ? scrapeSummaryLines(board.scrapeProgress) : null;

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8 md:px-10 md:py-10">
      <PageHeader
        eyebrow="Claude"
        title="Pipeline"
        crumbs={[{ label: "Pipeline" }]}
        description="One prompt runs discover, scrape, research, and a draft. Publish waits for a person on this page. Approval stores the draft — it does not deploy the public site."
        actions={
          <Button variant="outline" onClick={() => void tick()} disabled={busy}>
            <RefreshCw className="size-4" />
            Run daily tick
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 text-[13px]">
        <Pill tone={board && board.spendGbp < board.capGbp ? "ok" : "warn"}>{spend} today</Pill>
        {board?.model && <Mono className="text-muted-foreground">{board.model}</Mono>}
        {board?.job && <Pill tone={statusTone(board.job.status)}>{board.job.status}</Pill>}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel className="flex min-h-[520px] flex-col">
          <div className="flex-1 space-y-3 overflow-auto p-5">
            {waitingApify && (
              <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-sky-950 dark:text-sky-100">
                  <Loader2 className="size-4 shrink-0 animate-spin text-sky-600 dark:text-sky-400" />
                  Apify crawls running
                </div>
                <p className="mt-2 text-[13px] leading-snug text-muted-foreground">
                  This page syncs every 4s. When every run below is <span className="font-mono text-foreground">SUCCEEDED</span>,
                  Claude continues research automatically — nothing else required from you.
                </p>
                {lastSyncedAt && (
                  <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                    Last sync {lastSyncedAt.toLocaleTimeString()}
                  </p>
                )}
                {progress ? (
                  <div className="mt-3 space-y-1 rounded-md border border-sky-500/20 bg-background/80 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Progress {progress.done}/{progress.total} runs succeeded
                    </div>
                    {progress.lines.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 font-mono text-[11px] text-muted-foreground">Fetching run status…</p>
                )}
              </div>
            )}
            {!board?.messages.length && (
              <p className="text-sm text-muted-foreground">
                Ask Claude to discover resorts and carry them through scrape, research, a draft, and publish.
              </p>
            )}
            {board?.messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "ml-8" : m.role === "status" ? "mx-2" : "mr-8"}>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {m.role === "status" ? "Pipeline / tools" : m.role}
                </div>
                <div
                  className={
                    m.role === "status"
                      ? "whitespace-pre-wrap rounded-lg border border-dashed border-muted-foreground/25 bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
                      : "whitespace-pre-wrap rounded-lg border bg-background px-3 py-2 text-sm"
                  }
                >
                  {m.content}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t p-4">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              disabled={busy}
              placeholder="Discover surf lodges in Ericeira and take them through scrape, research, and a draft."
            />
            <div className="mt-3 flex justify-end">
              <Button onClick={() => void send()} disabled={busy || !text.trim()}>
                <Play className="size-4" />
                {busy ? "Working…" : "Send"}
              </Button>
            </div>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel className="p-4">
            <div className="mb-3 font-medium">Jobs</div>
            <div className="space-y-2">
              {board?.jobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => void load(job.id)}
                  className="flex w-full items-start justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span>
                    <span className="font-medium">{job.kind}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{job.stage}</span>
                  </span>
                  <Pill tone={statusTone(job.status)}>{job.status}</Pill>
                </button>
              ))}
              {!board?.jobs.length && <p className="text-sm text-muted-foreground">No jobs yet.</p>}
            </div>
          </Panel>

          {!!board?.scrapeProgress?.length && (
            <Panel className="p-4">
              <div className="mb-3 font-medium">Scrape progress</div>
              <div className="space-y-2">
                {board.scrapeProgress.map((row) => (
                  <div key={row.runId} className="rounded-lg border px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{row.targetNames.join(", ") || row.runId}</span>
                      <Pill tone={row.status === "SUCCEEDED" ? "ok" : row.status === "RUNNING" ? "info" : "muted"}>
                        {row.status}
                      </Pill>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      run {row.runId} · apify {row.apifyRunId}
                      {row.simulated ? " · simulated" : ""}
                      {row.itemCount ? ` · ${row.itemCount} page(s)` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel className="p-4">
            <div className="mb-3 font-medium">Targets</div>
            <div className="space-y-2">
              {board?.targets.map((t) => (
                <div key={t.id} className="rounded-lg border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Pill tone={t.stage === "published" ? "ok" : "info"}>{t.stage}</Pill>
                  </div>
                  <a href={t.url} className="mt-1 block truncate text-xs text-muted-foreground" target="_blank" rel="noreferrer">
                    {t.url}
                  </a>
                  {t.stage === "review" && (
                    <Button
                      className="mt-2"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void approve(t.id)}
                    >
                      Approve publish
                    </Button>
                  )}
                </div>
              ))}
              {!board?.targets.length && <p className="text-sm text-muted-foreground">No resorts queued.</p>}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
