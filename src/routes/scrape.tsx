import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Download, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { WccConfigForm } from "@/components/studio/scrape/WccConfigForm";
import { Mono, PageHeader, Panel, Pill } from "@/components/studio/ui-bits";
import { Button } from "@/components/ui/button";
import {
  createScrapeRun,
  downloadScrapeExport,
  fetchApifyStatus,
  fetchScrapeRun,
  fetchScrapeRunItems,
  fetchScrapeRuns,
} from "@/lib/api";
import { blankFacts } from "@/lib/agents/agent-client";
import { loadScrapePrefs, saveScrapePrefs } from "@/lib/scrape-prefs";
import { mutateResort, useStudio } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  parseStartUrls,
  type ScrapeRunRecord,
  type WccInput,
  type WccPage,
} from "@/lib/wcc-types";

export const Route = createFileRoute("/scrape")({
  validateSearch: (s: Record<string, unknown>): { resort?: string } =>
    s["resort"] ? { resort: String(s["resort"]) } : {},
  head: () => ({
    meta: [
      { title: "Scrape — Salt Atlas Resort Studio" },
      {
        name: "description",
        content:
          "Run Website Content Crawler bulk scrapes — paste start URLs, configure crawl options, export results.",
      },
      { property: "og:title", content: "Scrape resorts — Salt Atlas" },
      { property: "og:description", content: "Apify Website Content Crawler console for Salt Atlas." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Scrape,
});

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

function statusTone(status: string): "ok" | "warn" | "bad" | "info" | "muted" {
  if (status === "SUCCEEDED") return "ok";
  if (status === "FAILED" || status === "TIMED-OUT" || status === "ABORTED") return "bad";
  if (status === "RUNNING" || status === "READY") return "info";
  return "muted";
}

function Scrape() {
  const { resorts } = useStudio();
  const nav = useNavigate();
  const queue = resorts.filter((r) => r.stage === "scrape");

  const seedUrls = useMemo(
    () =>
      queue.flatMap((r) =>
        r.sources.filter((s) => s.selected !== false).map((s) => s.url),
      ),
    [queue],
  );

  const [startUrlsText, setStartUrlsText] = useState(() => loadScrapePrefs().startUrlsText);
  const [options, setOptions] = useState(() => loadScrapePrefs().options);
  const seeded = useRef(false);
  useEffect(() => {
    // Only auto-fill from discover queue when the user has no saved/pasted URLs yet.
    if (!seeded.current && seedUrls.length && !startUrlsText.trim()) {
      setStartUrlsText(seedUrls.join("\n"));
      seeded.current = true;
    }
  }, [seedUrls, startUrlsText]);

  useEffect(() => {
    saveScrapePrefs({ options, startUrlsText });
  }, [options, startUrlsText]);
  const [runs, setRuns] = useState<ScrapeRunRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [pages, setPages] = useState<WccPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [apifyOk, setApifyOk] = useState<boolean | null>(null);
  const [storageMode, setStorageMode] = useState<"cloudflare" | "local" | null>(null);
  const [actorLabel, setActorLabel] = useState("apify/website-content-crawler");

  const selected = runs.find((r) => r.id === selectedId);

  const refreshRuns = async (preferId?: string) => {
    const list = await fetchScrapeRuns();
    setRuns(list);
    const id = preferId ?? selectedId ?? list[0]?.id;
    if (id) {
      setSelectedId(id);
      const items = await fetchScrapeRunItems(id);
      setPages(items);
    } else {
      setPages([]);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const st = await fetchApifyStatus();
        setApifyOk(st.configured);
        setStorageMode(st.storage);
        setActorLabel(`${st.actorId} · ${st.build}`);
      } catch {
        setApifyOk(false);
      }
      try {
        await refreshRuns();
      } catch {
        /* empty store */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll active run
  useEffect(() => {
    if (!selected || TERMINAL.has(selected.status)) return;
    const t = window.setInterval(() => {
      void (async () => {
        try {
          const updated = await fetchScrapeRun(selected.id);
          setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
          if (TERMINAL.has(updated.status)) {
            const items = await fetchScrapeRunItems(updated.id);
            setPages(items);
            if (updated.status === "SUCCEEDED") {
              applyResultsToQueue(updated, items);
              toast.success(`Run finished · ${items.length} pages`);
            } else {
              toast.error(`Run ${updated.status.toLowerCase()}`);
            }
          }
        } catch (e) {
          console.error(e);
        }
      })();
    }, 2500);
    return () => window.clearInterval(t);
  }, [selected?.id, selected?.status]);

  const applyResultsToQueue = (run: ScrapeRunRecord, items: WccPage[]) => {
    const startSet = new Set(run.input.startUrls.map((s) => s.url.replace(/\/$/, "")));
    for (const r of queue) {
      mutateResort(r.id, (x) => {
        for (const s of x.sources) {
          const key = s.url.replace(/\/$/, "");
          const hit = startSet.has(key) || items.some((p) => {
            const pUrl = p.url.replace(/\/$/, "");
            return pUrl === key || pUrl.startsWith(key + "/");
          });
          if (!hit) continue;
          s.scrape = "completed";
          s.runId = run.id;
          s.extractedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
          s.fieldsFound = items.filter((p) => {
            try {
              return new URL(p.url).hostname === new URL(s.url).hostname;
            } catch {
              return false;
            }
          }).length;
        }
      });
    }
  };

  const start = async () => {
    const startUrls = parseStartUrls(startUrlsText);
    if (!startUrls.length) {
      toast.error("Paste at least one valid start URL");
      return;
    }
    setBusy(true);
    try {
      const input: WccInput = { ...options, startUrls };
      const run = await createScrapeRun(input);
      await refreshRuns(run.id);
      if (run.status === "SUCCEEDED") {
        const items = await fetchScrapeRunItems(run.id);
        setPages(items);
        applyResultsToQueue(run, items);
        toast.success(
          run.simulated
            ? `Simulated run · ${items.length} pages (set APIFY_TOKEN for live crawls)`
            : `Run finished · ${items.length} pages`,
        );
      } else {
        toast.message("Bulk crawl started");
      }
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Failed to start run");
    } finally {
      setBusy(false);
    }
  };

  const selectRun = async (id: string) => {
    setSelectedId(id);
    try {
      const updated = await fetchScrapeRun(id);
      setRuns((prev) => {
        const exists = prev.some((r) => r.id === id);
        return exists
          ? prev.map((r) => (r.id === updated.id ? updated : r))
          : [updated, ...prev];
      });
      setPages(await fetchScrapeRunItems(id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load run");
    }
  };

  const exportRun = async (format: "json" | "csv") => {
    if (!selectedId) return;
    try {
      const file = await downloadScrapeExport(selectedId, format);
      const blob = new Blob([file.body], { type: file.contentType });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Exported ${file.filename}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    }
  };

  const doneResorts = queue.filter(
    (r) =>
      r.sources.length &&
      r.sources.every((s) => s.scrape === "completed" || s.scrape === "failed") &&
      r.sources.some((s) => s.scrape === "completed"),
  );

  const sendToResearch = () => {
    for (const resort of doneResorts) {
      mutateResort(resort.id, (x) => {
        x.facts = blankFacts(x.id);
        x.stage = "research";
        x.exclusivity.status = "needs_review";
        x.researchLog = [
          `Apify crawl complete; raw evidence stored under run ${selected?.id ?? "linked sources"}.`,
          "No facts have been verified yet. Run Claude Reviewer against the collected pages.",
        ];
      });
    }
    toast.success(`${doneResorts.length} resorts sent to Research with no fabricated facts`);
    nav({ to: "/research", search: doneResorts[0] ? { resort: doneResorts[0].id } : {} });
  };

  const fillFromQueue = () => {
    setStartUrlsText(seedUrls.join("\n"));
    toast.message(`Loaded ${seedUrls.length} URLs from discover queue`);
  };

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8 md:px-10 md:py-10">
      <PageHeader
        eyebrow="Stage 02"
        title="Scrape"
        crumbs={[{ label: "Discover", to: "/discover" }, { label: "Scrape" }]}
        description="Website Content Crawler — paste start URLs, deepen the crawl, run one bulk job, export that run’s dataset."
        actions={
          <Button onClick={sendToResearch} disabled={!doneResorts.length || busy}>
            Send {doneResorts.length || ""} to Research <ArrowRight className="size-4" />
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2 text-[13px]">
        <Pill tone={apifyOk ? "ok" : "warn"}>{apifyOk ? "Apify connected" : "Mock mode · set APIFY_TOKEN"}</Pill>
        <Pill tone={storageMode === "cloudflare" ? "ok" : "warn"}>
          {storageMode === "cloudflare" ? "R2 + D1" : "Local storage"}
        </Pill>
        <Mono className="text-muted-foreground">{actorLabel}</Mono>
        {queue.length > 0 && (
          <Button size="sm" variant="outline" className="h-7" onClick={fillFromQueue}>
            Fill from queue ({seedUrls.length})
          </Button>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Panel className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">Actor input</div>
                <p className="text-xs text-muted-foreground">
                  Mirrors apify/website-content-crawler — one run crawls every start URL.
                </p>
              </div>
              <Button onClick={start} disabled={busy}>
                <Play className="size-4" />
                {busy ? "Starting…" : "Start"}
              </Button>
            </div>
            <WccConfigForm
              value={options}
              onChange={setOptions}
              startUrlsText={startUrlsText}
              onStartUrlsChange={setStartUrlsText}
              disabled={busy}
            />
          </Panel>

          <Panel className="overflow-hidden">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <div className="font-medium">
                Results{selected ? ` · ${selected.itemCount || pages.length} pages` : ""}
              </div>
              {selected && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => void selectRun(selected.id)}
                >
                  <RefreshCw className="size-3.5" /> Refresh
                </Button>
              )}
            </div>
            {!selected ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                Start a bulk run to see crawled pages here.
              </div>
            ) : pages.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {TERMINAL.has(selected.status)
                  ? "No pages stored for this run."
                  : "Crawl in progress…"}
              </div>
            ) : (
              <div className="max-h-[min(75vh,920px)] overflow-auto">
                <table className="w-full min-w-[720px] text-[13px]">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b text-left text-muted-foreground">
                      {["URL", "Title", "Depth", "Excerpt"].map((h) => (
                        <th key={h} className="px-4 py-2 font-normal">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((p) => (
                      <tr key={p.url + (p.crawl?.loadedTime ?? "")} className="border-b align-top">
                        <td className="px-4 py-2">
                          <Mono className="break-all text-[11px]">{p.url.replace(/^https?:\/\//, "")}</Mono>
                        </td>
                        <td className="px-4 py-2">{p.metadata?.title ?? "—"}</td>
                        <td className="px-4 py-2">
                          <Mono>{p.crawl?.depth ?? "—"}</Mono>
                        </td>
                        <td className="max-w-[280px] px-4 py-2 text-muted-foreground">
                          {(p.markdown ?? p.text ?? "").slice(0, 140)}
                          {(p.markdown ?? p.text ?? "").length > 140 ? "…" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel className="p-5">
            <div className="mb-3 font-medium">Runs</div>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => void selectRun(r.id)}
                      className={cn(
                        "w-full rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                        selectedId === r.id && "border-primary/40 bg-primary/5",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Mono className="truncate text-[11px]">{r.id}</Mono>
                        <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {r.input.startUrls.length} start URL
                        {r.input.startUrls.length === 1 ? "" : "s"} · {r.itemCount} pages
                        {r.simulated ? " · simulated" : ""}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {new Date(r.startedAt).toLocaleString()}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel className="p-5">
            <div className="mb-3 font-medium">Export</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Download this run’s dataset only (JSON full payload or CSV flat table).
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!selectedId || !pages.length}
                onClick={() => void exportRun("json")}
              >
                <Download className="size-3.5" /> JSON
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!selectedId || !pages.length}
                onClick={() => void exportRun("csv")}
              >
                <Download className="size-3.5" /> CSV
              </Button>
            </div>
            {selected?.r2Key && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Storage key (future R2): <Mono>{selected.r2Key}</Mono>
              </p>
            )}
          </Panel>

          {selected && (
            <Panel className="p-5 text-[13px]">
              <div className="mb-2 font-medium">Selected run</div>
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  Apify id: <Mono>{selected.apifyRunId}</Mono>
                </li>
                <li>
                  Status: <Pill tone={statusTone(selected.status)}>{selected.status}</Pill>
                </li>
                <li>
                  Crawler: <Mono>{selected.input.crawlerType}</Mono>
                </li>
                <li>
                  Depth / pages:{" "}
                  <Mono>
                    {selected.input.maxCrawlDepth} / {selected.input.maxCrawlPages}
                  </Mono>
                </li>
              </ul>
              <div className="mt-3 max-h-40 overflow-y-auto rounded-md bg-muted/50 p-2">
                {selected.input.startUrls.map((s) => (
                  <div key={s.url} className="truncate font-mono text-[11px]">
                    {s.url.replace(/^https?:\/\//, "")}
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
