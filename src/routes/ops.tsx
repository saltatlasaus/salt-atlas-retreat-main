import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel, PageHeader, Mono, Pill } from "@/components/studio/ui-bits";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { getState, mutate, mutateResort, useStudio } from "@/lib/store";
import { createScrapeRun, fetchResolvedScrapeRunId, fetchScrapeRun, fetchScrapeRunItems, sleep } from "@/lib/api";
import { DEFAULT_WCC_INPUT } from "@/lib/wcc-types";
import { pagesForSources, strictPagesForSources } from "@/lib/scrape-match";
import { applyVerifiedGaps, newPage } from "@/lib/page-gen";
import { canGenerate, completeness, generateBlockReason, openIssues, openResearchFacts } from "@/lib/workflow";
import {
  ApprovalRequired, activeCompetitors, applyWrittenSections, blankFacts,
  discoveredResorts, fillOpenFacts, invokeAgent, mergeVerifiedResearch, withLiveEvidence,
} from "@/lib/agents/agent-client";
import { getClaudeSpend } from "@/lib/agents/agent-server";
import { AGENT_PER_CALL_APPROVAL_GBP_DEFAULT } from "@/lib/agents/spend-limits";
import {
  DEFAULT_CEO_CRAWL_OPTIONS,
  loadActiveCeoSessionId,
  loadCeoSessions,
  newRunSessionLabel,
  saveActiveCeoSessionId,
  saveCeoSessions,
  type CeoBoardTab,
  type CeoCrawlOptions,
  type CeoRunSession,
} from "@/lib/ceo-sessions";
import type { Resort } from "@/lib/types";
import type { WccCrawlerType, WccPage } from "@/lib/wcc-types";

const CRAWL_CAP_NOTE = "Caps: depth ≤3, pages ≤50, concurrency ≤2 (server)";

/** Taller scroll regions — main column and board tabs should use most of the viewport. */
const SCROLL_BOARD = "h-[min(76vh,920px)] max-h-[min(76vh,920px)]";
const SCROLL_CRAWL_PAGES = "max-h-[min(44vh,520px)]";
const SCROLL_DISCOVER = "max-h-[min(58vh,36rem)]";
const SCROLL_EVIDENCE = "max-h-[min(62vh,720px)]";
const SCROLL_ACTIVITY = "max-h-[min(56vh,680px)]";

const CEO_BOARD_TABS: { id: CeoBoardTab; label: string; hint: string }[] = [
  { id: "pipeline", label: "Pipeline", hint: "Steps 1–4 for the selected resort" },
  { id: "crawls", label: "Crawl results", hint: "Every linked Apify run and pages" },
  { id: "research", label: "Verify", hint: "Research stage — validate many at once" },
  { id: "html", label: "HTML", hint: "Generated draft vs not yet" },
];

function pageTextSnippet(p: WccPage, max = 220): string {
  const raw = (p.markdown ?? p.text ?? "").trim().replace(/\s+/g, " ");
  if (!raw.length) return "(no text)";
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}

export const Route = createFileRoute("/ops")({
  component: Operations,
  head: () => ({ meta: [{ title: "CEO orchestration — Salt Atlas Resort Studio" }] }),
});

type Step = "scout" | "scrape" | "review" | "write";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

function resortById(id: string): Resort | undefined {
  return getState().resorts.find((r) => r.id === id);
}

/** Discovery ids use `d-` prefix; queued workflow resorts drop it. */
function workflowResortId(candidate: Resort): string {
  return candidate.id.replace(/^d-/, "");
}

/** Mark selected sources with run id, move to research — same whether crawl was started from /ops or /scrape. */
function attachCompletedCrawlToResort(resortId: string, runId: string, pages: WccPage[]): boolean {
  const r0 = getState().resorts.find((x) => x.id === resortId);
  if (!r0 || r0.stage !== "scrape") return false;
  const urls = [...new Set(r0.sources.filter((s) => s.selected).map((s) => s.url))];
  if (!urls.length) return false;
  if (!pages.length) return false;
  const usable = pages.filter(
    (p) => (p.markdown ?? p.text ?? "").trim().length >= 100 && (p.crawl?.httpStatusCode ?? 200) < 400,
  );
  mutateResort(resortId, (r) => {
    for (const src of r.sources) {
      if (!urls.includes(src.url)) continue;
      src.runId = runId;
      src.scrape = usable.some((p) => p.url === src.url || p.url.startsWith(src.url.replace(/\/$/, "") + "/"))
        ? "completed"
        : "failed";
      src.extractedAt = new Date().toISOString();
    }
    r.facts = blankFacts(r.id);
    r.exclusivity.status = "needs_review";
    r.stage = "research";
    r.researchLog.push(
      usable.length
        ? `Apify run ${runId} returned ${usable.length} usable page(s). No facts verified yet.`
        : `Apify run ${runId} returned ${pages.length} page row(s); thin or low-text — review in Research. No facts verified yet.`,
    );
  });
  return true;
}

/**
 * A resort was linked to a crawl that does not contain its website (older versions attached the newest crawl of
 * ANY site). Unlink it, blank the facts that were read from the wrong pages, and send it back to the crawl step.
 */
function resetMismatchedCrawl(resortId: string): void {
  mutateResort(resortId, (r) => {
    for (const src of r.sources) {
      delete src.runId;
      delete src.extractedAt;
      if (src.selected) src.scrape = "pending";
    }
    r.facts = blankFacts(r.id);
    r.exclusivity.status = "needs_review";
    r.stage = "scrape";
    r.researchLog.push("Crawl was for a different website. Unlinked it and cleared facts read from it; re-crawl this resort.");
  });
}

function Operations() {
  const { competitors, resorts, discoveryResults } = useStudio();
  const nav = useNavigate();
  const [sessions, setSessions] = useState<CeoRunSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("Find high-fit surf resorts and trace official websites. Prioritise authentic waves, prices and accommodation.");
  const [country, setCountry] = useState("Indonesia");
  const [region, setRegion] = useState("Mentawai Islands");
  const [selected, setSelected] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ step: Step; estimate: number; bulkReview?: boolean } | null>(null);
  const [spend, setSpend] = useState(0);
  const [activity, setActivity] = useState<string[]>([
    "CEO: click “1 · Discover” to open a saved run tab (this page + resorts persist in the browser).",
  ]);
  const [autoVerifyAfterCrawl, setAutoVerifyAfterCrawl] = useState(false);
  const [crawlOptions, setCrawlOptions] = useState<CeoCrawlOptions>(DEFAULT_CEO_CRAWL_OPTIONS);
  const [crawlOptionsOpen, setCrawlOptionsOpen] = useState(false);
  const [ceoBoardTab, setCeoBoardTab] = useState<CeoBoardTab>("pipeline");
  const [crawlBoardPages, setCrawlBoardPages] = useState<Record<string, WccPage[]>>({});
  const [crawlBoardLoading, setCrawlBoardLoading] = useState(false);
  const current = resorts.find((r) => r.id === selected);
  const add = (line: string) => setActivity((prev) => [...prev, `${new Date().toLocaleTimeString()} · ${line}`]);

  useEffect(() => {
    const list = loadCeoSessions();
    setSessions(list);
    const savedActive = loadActiveCeoSessionId();
    const pick = savedActive && list.some((s) => s.id === savedActive) ? savedActive : list[0]?.id ?? null;
    setActiveSessionId(pick);
    saveActiveCeoSessionId(pick);
    if (pick) {
      const s = list.find((x) => x.id === pick);
      if (s) {
        setInstruction(s.instruction);
        setCountry(s.country);
        setRegion(s.region);
        setSelected(s.selectedResortId);
        setActivity(s.activity.length ? s.activity : ["Restored session log."]);
        setAutoVerifyAfterCrawl(s.autoVerifyAfterCrawl);
        setCrawlOptions(s.crawlOptions);
        setCeoBoardTab(s.ceoBoardTab ?? "pipeline");
      }
    }
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === activeSessionId);
      if (idx < 0) return prev;
      const next = [...prev];
      const cur = next[idx]!;
      next[idx] = {
        ...cur,
        instruction,
        country,
        region,
        selectedResortId: selected,
        activity,
        autoVerifyAfterCrawl,
        crawlOptions,
        ceoBoardTab,
      };
      saveCeoSessions(next);
      return next;
    });
  }, [activeSessionId, instruction, country, region, selected, activity, autoVerifyAfterCrawl, crawlOptions, ceoBoardTab]);

  function openRunTabForDiscover() {
    const id = crypto.randomUUID();
    const label = newRunSessionLabel(country, region);
    const session: CeoRunSession = {
      id,
      createdAt: new Date().toISOString(),
      label,
      instruction,
      country,
      region,
      selectedResortId: selected,
      activity: [
        `${new Date().toLocaleTimeString()} · Run tab “${label}” — step 1 (Discover) starting.`,
      ],
      autoVerifyAfterCrawl,
      crawlOptions: { ...crawlOptions },
      ceoBoardTab,
    };
    setSessions((prev) => {
      const next = [...prev, session];
      saveCeoSessions(next);
      return next;
    });
    setActiveSessionId(id);
    saveActiveCeoSessionId(id);
    setActivity(session.activity);
  }

  function switchSession(id: string | null) {
    setActiveSessionId(id);
    saveActiveCeoSessionId(id);
    if (!id) return;
    const list = loadCeoSessions();
    const s = list.find((x) => x.id === id);
    if (s) {
      setInstruction(s.instruction);
      setCountry(s.country);
      setRegion(s.region);
      setSelected(s.selectedResortId);
      setActivity(s.activity.length ? s.activity : ["Empty log."]);
      setAutoVerifyAfterCrawl(s.autoVerifyAfterCrawl);
      setCrawlOptions(s.crawlOptions);
      setCeoBoardTab(s.ceoBoardTab ?? "pipeline");
    }
  }

  function removeSession(id: string, e?: MouseEvent) {
    e?.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveCeoSessions(next);
      if (activeSessionId === id) {
        const fallback = next[0]?.id ?? null;
        setActiveSessionId(fallback);
        saveActiveCeoSessionId(fallback);
        if (fallback) {
          const s = next.find((x) => x.id === fallback)!;
          setInstruction(s.instruction);
          setCountry(s.country);
          setRegion(s.region);
          setSelected(s.selectedResortId);
          setActivity(s.activity.length ? s.activity : []);
          setAutoVerifyAfterCrawl(s.autoVerifyAfterCrawl);
          setCrawlOptions(s.crawlOptions);
          setCeoBoardTab(s.ceoBoardTab ?? "pipeline");
        } else {
          setActivity(["CEO: click “1 · Discover” to start a run tab."]);
          setCrawlOptions(DEFAULT_CEO_CRAWL_OPTIONS);
          setCeoBoardTab("pipeline");
        }
      }
      return next;
    });
  }
  const refreshSpend = () => {
    void getClaudeSpend()
      .then((saved) => setSpend(saved.totalGbp))
      .catch(() => {});
  };
  useEffect(() => { refreshSpend(); }, []);

  const record = (usage: { actualCostGbp?: number; estimatedCostGbp: number }) => {
    const added = usage.actualCostGbp ?? usage.estimatedCostGbp;
    if (added > 0) setSpend((prev) => prev + added);
  };

  const stepGates = useMemo(() => {
    const r = current;
    const selectedUrls = r ? [...new Set(r.sources.filter((s) => s.selected).map((s) => s.url))] : [];
    const hasCrawl = Boolean(r?.sources.some((s) => s.runId));
    const canReview =
      !!r &&
      r.stage !== "discover" &&
      r.stage !== "scrape" &&
      hasCrawl;
    const canWrite =
      !!r &&
      r.stage === "research" &&
      r.exclusivity.status === "clear" &&
      canGenerate(r);
    return {
      s1: !busy,
      s2: !!r && r.stage === "scrape" && selectedUrls.length > 0,
      s3: canReview,
      s4: canWrite,
      s2Reason:
        !r || r.stage !== "scrape"
          ? "Queue a resort and stay on the scrape stage first."
          : selectedUrls.length === 0
            ? "Select at least one source URL on the resort before crawling."
            : "",
      s3Reason:
        !r || r.stage === "discover" || r.stage === "scrape"
          ? "Run Apify crawl first (step 2)."
          : !hasCrawl
            ? "No crawl linked to sources yet — run step 2 or resolve runs on /scrape."
            : "",
      s4Reason: !r
        ? "Select a resort."
        : r.stage !== "research"
          ? "Writer runs from the research stage after verify (step 3)."
          : r.exclusivity.status !== "clear"
            ? "Mark exclusivity clear with evidence (panel right)."
            : generateBlockReason(r) || "Complete research gates (60%+ verified, etc.).",
    };
  }, [busy, current]);

  const pendingScrapeResorts = useMemo(
    () =>
      resorts.filter(
        (r) =>
          r.stage === "scrape" &&
          r.sources.some((s) => s.selected) &&
          !r.sources.some((s) => s.selected && s.runId),
      ),
    [resorts],
  );

  const pendingScrapeKey = useMemo(
    () =>
      pendingScrapeResorts
        .map((r) => r.id)
        .sort()
        .join(","),
    [pendingScrapeResorts],
  );

  /** If Apify finished elsewhere (/scrape, pipeline), attach run ids + advance stage in this browser store. */
  useEffect(() => {
    if (typeof window === "undefined" || !pendingScrapeKey) return;
    let cancelled = false;
    async function syncServerCrawls() {
      const list = getState().resorts.filter(
        (r) =>
          r.stage === "scrape" &&
          r.sources.some((s) => s.selected) &&
          !r.sources.some((s) => s.selected && s.runId),
      );
      if (!list.length) return;
      let linked = 0;
      for (const r of list) {
        if (cancelled) return;
        const urls = [...new Set(r.sources.filter((s) => s.selected).map((s) => s.url))];
        if (!urls.length) continue;
        let resolved: string | null = null;
        try {
          resolved = await fetchResolvedScrapeRunId(urls);
        } catch {
          continue;
        }
        if (cancelled || !resolved) continue;
        let pages: WccPage[];
        try {
          pages = await fetchScrapeRunItems(resolved);
        } catch {
          continue;
        }
        if (cancelled) return;
        if (!attachCompletedCrawlToResort(r.id, resolved, pages)) continue;
        linked += 1;
        const line = `Synced server crawl for ${r.name} · run ${resolved} (usable pages linked).`;
        setActivity((prev) => [...prev, `${new Date().toLocaleTimeString()} · ${line}`]);
      }
      if (!cancelled && linked > 0) {
        toast.success(`CEO: linked ${linked} completed crawl(s) from the server. Step 3 is available for those resorts.`);
      }
    }
    void syncServerCrawls();
    const id = window.setInterval(() => void syncServerCrawls(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pendingScrapeKey]);

  const crawlBoardRunKey = useMemo(() => {
    const set = new Set<string>();
    for (const r of resorts) {
      for (const s of r.sources) {
        if (s.runId) set.add(s.runId);
      }
    }
    return [...set].sort().join(",");
  }, [resorts]);

  /** Load dataset pages for every linked run when viewing the Crawl results board. */
  useEffect(() => {
    if (ceoBoardTab !== "crawls" || typeof window === "undefined") return;
    let cancel = false;
    async function load() {
      const ids = [...new Set(getState().resorts.flatMap((r) => r.sources.map((s) => s.runId).filter((id): id is string => !!id)))];
      setCrawlBoardLoading(true);
      const next: Record<string, WccPage[]> = {};
      try {
        for (const id of ids) {
          if (cancel) return;
          try {
            next[id] = await fetchScrapeRunItems(id);
          } catch {
            next[id] = [];
          }
        }
        if (!cancel) setCrawlBoardPages(next);
      } finally {
        if (!cancel) setCrawlBoardLoading(false);
      }
    }
    void load();
    return () => {
      cancel = true;
    };
  }, [ceoBoardTab, crawlBoardRunKey]);

  const researchBoardResorts = useMemo(
    () => resorts.filter((r) => r.stage === "research" || r.stage === "generate" || r.stage === "published"),
    [resorts],
  );

  const htmlBoardResorts = useMemo(() => resorts.filter((r) => r.stage !== "discover"), [resorts]);

  /** Step 3 for one resort by id (used by pipeline button and bulk verify). */
  async function runSingleReview(resortId: string, approveOverBudget: boolean) {
    const r0 = resortById(resortId);
    if (!r0 || r0.stage === "discover" || r0.stage === "scrape") {
      throw new Error(`${r0?.name ?? resortId}: not ready for verify (stage ${r0?.stage ?? "unknown"}).`);
    }
    let runIds = [...new Set(r0.sources.map((s) => s.runId).filter((id): id is string => !!id))];
    if (!runIds.length) {
      const resolved = await fetchResolvedScrapeRunId(r0.sources.map((s) => s.url));
      if (resolved) {
        mutateResort(r0.id, (r) => {
          for (const s of r.sources) {
            if (!s.runId) s.runId = resolved;
          }
        });
        runIds = [resolved];
      }
    }
    if (!runIds.length) throw new Error("No stored crawl matched these URLs; run a crawl that includes this site.");
    const linkedPages = (await Promise.all(runIds.map(fetchScrapeRunItems))).flat();
    const pages = strictPagesForSources(r0.sources, linkedPages);
    if (!pages.length) {
      if (linkedPages.length) {
        // The linked run is another website's crawl. Facts taken from it belong to the wrong resort, so drop them.
        resetMismatchedCrawl(r0.id);
        throw new Error(
          `${r0.name}: the linked crawl was for a different website (${[...new Set(linkedPages.map((p) => new URL(p.url).hostname))].slice(0, 3).join(", ")}). It was unlinked and the facts reset. Run step 2 to crawl this resort.`,
        );
      }
      throw new Error("The linked crawl stored no page text to research.");
    }
    const resortForAgent = resortById(r0.id)!;
    mutateResort(r0.id, (r) => {
      fillOpenFacts(r);
      if (r.page) applyVerifiedGaps(r.page.sections, r);
    });
    const result = await invokeAgent({ kind: "reviewer", input: { resort: resortForAgent, pages }, approveOverBudget });
    record(result.usage);
    mutateResort(r0.id, (r) => {
      const outcome = mergeVerifiedResearch(r, result.data, withLiveEvidence(pages, result.evidence));
      for (const url of outcome.suggestedSources) {
        if (!r.sources.some((s) => s.url === url)) {
          r.sources.push({
            id: `suggested-${crypto.randomUUID()}`,
            url,
            type: "independent",
            selected: false,
            scrape: "pending",
          });
        }
      }
      r.researchLog.push(...result.warnings);
      if (r.page) applyVerifiedGaps(r.page.sections, r);
    });
  }

  async function runBulkVerifyAllResearch(approveOverBudget: boolean) {
    const ids = [...new Set(getState().resorts.filter((r) => r.stage === "research").map((r) => r.id))];
    if (!ids.length) {
      toast.message("No resorts on research to verify.");
      return;
    }
    add(`Bulk verify: ${ids.length} resort(s) (Reviewer per resort)…`);
    let ok = 0;
    for (const id of ids) {
      try {
        setSelected(id);
        await runSingleReview(id, approveOverBudget);
        ok += 1;
        const u = resortById(id);
        add(`Verify done: ${u?.name ?? id} · ${u ? completeness(u) : 0}% verified`);
      } catch (err) {
        if (err instanceof ApprovalRequired) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        add(`Bulk verify skipped ${id}: ${msg}`);
        toast.error(msg.slice(0, 120));
      }
    }
    add(`Bulk verify finished (${ok}/${ids.length} succeeded).`);
  }

  const resortRunGroups = useMemo(() => {
    return resorts.map((r) => {
      const byRun = new Map<string, string[]>();
      for (const s of r.sources) {
        if (!s.runId) continue;
        if (!byRun.has(s.runId)) byRun.set(s.runId, []);
        byRun.get(s.runId)!.push(s.url);
      }
      return { resort: r, runs: [...byRun.entries()] as [string, string[]][] };
    });
  }, [resorts]);

  async function runBulkReviewWithGates(approveOverBudget = false): Promise<boolean> {
    if (busy) return false;
    setPending(null);
    setBusy(true);
    try {
      await runBulkVerifyAllResearch(approveOverBudget);
      return true;
    } catch (err) {
      if (err instanceof ApprovalRequired) {
        setPending({ step: "review", estimate: err.estimatedCostGbp, bulkReview: true });
        add(
          `Spend approval needed (bulk verify): £${err.estimatedCostGbp.toFixed(3)} estimate exceeds £${AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)} per Claude call.`,
        );
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      add(`Bulk verify stopped: ${message}`);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
      refreshSpend();
    }
  }

  /** One Apify run for one resort's selected URLs. */
  async function executeScrapeForResort(resortId: string, approveOverBudget: boolean, options?: { skipAutoVerify?: boolean }) {
    const r0 = resortById(resortId);
    if (!r0) throw new Error(`Resort ${resortId} not found.`);
    if (r0.stage !== "scrape") throw new Error(`${r0.name} is not waiting for a crawl (stage ${r0.stage}).`);
    const urls = [...new Set(r0.sources.filter((s) => s.selected).map((s) => s.url))];
    if (!urls.length) throw new Error(`No selected URLs for ${r0.name}.`);
    const n = urls.length;
    const maxPagesTotal = Math.max(n, crawlOptions.maxPagesTotal);
    const maxCrawlDepth = crawlOptions.maxCrawlDepth;
    const ic = crawlOptions.initialConcurrency;
    const mc = crawlOptions.maxConcurrency;
    add(
      `Apify: ${r0.name} — ${n} start URL(s), depth ${maxCrawlDepth}, up to ${maxPagesTotal} page(s), crawler ${crawlOptions.crawlerType}, concurrency ${ic}/${mc}.`,
    );
    const started = await createScrapeRun({
      ...DEFAULT_WCC_INPUT,
      startUrls: urls.map((url) => ({ url })),
      crawlerType: crawlOptions.crawlerType,
      maxCrawlDepth,
      maxCrawlPages: maxPagesTotal,
      maxResults: maxPagesTotal,
      initialConcurrency: ic,
      maxConcurrency: mc,
      maxRequestRetries: 1,
      useSitemaps: false,
      saveMarkdown: crawlOptions.saveMarkdown,
      requestTimeoutSecs: crawlOptions.requestTimeoutSecs,
    });
    let finished = started;
    for (let i = 0; !TERMINAL.has(finished.status) && i < 80; i++) {
      await sleep(2500);
      finished = await fetchScrapeRun(started.id);
    }
    if (!TERMINAL.has(finished.status)) throw new Error(`Crawl still running for ${r0.name}. Check /scrape for ${started.id}.`);
    if (finished.status !== "SUCCEEDED") throw new Error(`${r0.name}: Apify ${finished.status}.`);
    const pages = await fetchScrapeRunItems(finished.id);
    const usable = pages.filter((p) => (p.markdown ?? p.text ?? "").trim().length >= 100 && (p.crawl?.httpStatusCode ?? 200) < 400);
    if (!attachCompletedCrawlToResort(r0.id, finished.id, pages)) {
      throw new Error(`${r0.name}: could not attach crawl (resort state changed).`);
    }
    add(
      usable.length
        ? `${r0.name}: ${usable.length} usable page(s) · run ${finished.id}`
        : `${r0.name}: crawl saved · run ${finished.id} · thin or empty text (check Crawl results tab).`,
    );
    if (autoVerifyAfterCrawl && !options?.skipAutoVerify) {
      const fresh = resortById(resortId)!;
      const runIds = [...new Set(fresh.sources.map((s) => s.runId).filter((id): id is string => !!id))];
      if (!runIds.length) throw new Error("Verify after crawl: no run id linked.");
      const pageRows = strictPagesForSources(fresh.sources, (await Promise.all(runIds.map(fetchScrapeRunItems))).flat());
      if (!pageRows.length) throw new Error("Verify after crawl: the crawl has no page from this resort's website.");
      mutateResort(fresh.id, (r) => {
        fillOpenFacts(r);
        if (r.page) applyVerifiedGaps(r.page.sections, r);
      });
      add(`Auto verify (after crawl): ${fresh.name}…`);
      const result = await invokeAgent({ kind: "reviewer", input: { resort: fresh, pages: pageRows }, approveOverBudget });
      record(result.usage);
      mutateResort(fresh.id, (r) => {
        const outcome = mergeVerifiedResearch(r, result.data, withLiveEvidence(pageRows, result.evidence));
        for (const url of outcome.suggestedSources) {
          if (!r.sources.some((s) => s.url === url)) r.sources.push({
            id: `suggested-${crypto.randomUUID()}`, url, type: "independent", selected: false, scrape: "pending",
          });
        }
        r.researchLog.push(...result.warnings);
        if (r.page) applyVerifiedGaps(r.page.sections, r);
      });
    }
  }

  async function runBulkPendingScrapes(approveOverBudget = false) {
    if (busy || pendingScrapeResorts.length === 0) return;
    setPending(null);
    setBusy(true);
    const ids = pendingScrapeResorts.map((r) => r.id);
    add(`Bulk crawl: ${ids.length} resort(s) pending (sequential Apify runs).`);
    try {
      for (const id of ids) {
        try {
          setSelected(id);
          await executeScrapeForResort(id, approveOverBudget, { skipAutoVerify: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          add(`Bulk crawl skipped/failed ${id}: ${msg}`);
          toast.error(msg.slice(0, 120));
        }
      }
      add(`Bulk crawl finished (${ids.length} attempted). Pick a resort for step 3.`);
    } finally {
      setBusy(false);
      refreshSpend();
    }
  }

  function queueAllNew() {
    const fresh = discoveryResults.filter((c) => !c.knownBefore && !resorts.some((r) => r.id === workflowResortId(c)));
    if (!fresh.length) {
      toast.message("Nothing new to queue — all candidates are already queued or marked known.");
      return;
    }
    let lastId = selected;
    mutate((s) => {
      for (const candidate of fresh) {
        const id = workflowResortId(candidate);
        if (s.resorts.some((r) => r.name.toLowerCase() === candidate.name.toLowerCase() && r.id !== id)) continue;
        if (s.resorts.some((r) => r.id === id)) continue;
        s.resorts.push({
          ...structuredClone(candidate), id, stage: "scrape", facts: blankFacts(id),
          sources: candidate.sources.map((src) => ({ ...src, id: src.id.replace(candidate.id, id) })),
        });
        lastId = id;
      }
    });
    setSelected(lastId);
    add(`Queued ${fresh.length} candidate(s) for crawl. Use “Crawl all pending” or step 2 per resort.`);
    toast.success(`Queued ${fresh.length} resort(s).`);
  }

  async function runStep(step: Step, approveOverBudget: boolean) {
    if (step === "scout") {
      openRunTabForDiscover();
      add("Scout: seeking competitor listings and official source candidates…");
      const input = {
        country, region, instruction, competitors: activeCompetitors(competitors, competitors.map((c) => c.id)),
        knownResortNames: resorts.map((r) => r.name),
      };
      const result = await invokeAgent({ kind: "scout", input, approveOverBudget });
      record(result.usage);
      const found = discoveredResorts(result.data, input);
      mutate((s) => { s.discoveryResults = found; });
      add(`Scout found ${found.length} candidates. Check identity evidence and choose a resort to queue.`);
      for (const warning of result.warnings) add(warning);
      return;
    }
    if (step === "scrape") {
      if (!selected) throw new Error("Select a queued resort first.");
      await executeScrapeForResort(selected, approveOverBudget);
      if (!autoVerifyAfterCrawl) add("Step 3 (verify) is next — run per resort when ready.");
      return;
    }
    if (step === "review") {
      const r0 = resortById(selected);
      if (!r0 || r0.stage === "discover" || r0.stage === "scrape") throw new Error("Verify runs after a crawl, while facts are still open.");
      let preview = 0;
      let runIds = [...new Set(r0.sources.map((s) => s.runId).filter((id): id is string => !!id))];
      if (runIds.length) {
        preview = strictPagesForSources(
          r0.sources,
          (await Promise.all(runIds.map(fetchScrapeRunItems))).flat(),
        ).length;
      }
      add(`Verify and fill: ${r0.name}${preview ? ` · ${preview} scraped page row(s)` : ""}…`);
      await runSingleReview(r0.id, approveOverBudget);
      const updated = resortById(r0.id);
      const left = updated ? openResearchFacts(updated) : [];
      add(left.length
        ? `Still open: ${left.map((fact) => `${fact.label} (${fact.status.replace(/_/g, " ")})`).join(", ")}. Verify and fill stays available.`
        : "Every field has a source.");
      return;
    }
    if (step === "write") {
      const r0 = resortById(selected);
      if (!r0 || r0.stage !== "research") throw new Error("Select a reviewed resort in the research stage.");
      if (r0.exclusivity.status !== "clear") throw new Error("CEO must clear exclusivity with evidence before writing.");
      if (!canGenerate(r0)) throw new Error(generateBlockReason(r0) || "Research is not ready to generate.");
      const provisional = newPage(r0);
      add("Writer: generating structured copy in existing template fields…");
      const result = await invokeAgent({ kind: "writer", input: { resort: r0, sections: provisional.sections }, approveOverBudget });
      record(result.usage);
      mutateResort(r0.id, (r) => {
        r.page = newPage(r);
        const written = applyWrittenSections(r, result.data);
        r.page!.versions[0]!.sections = structuredClone(r.page!.sections);
        r.stage = "generate";
        r.researchLog.push(`Writer updated ${written.length} supported sections. Human approval required.`);
        r.researchLog.push(...result.warnings);
      });
      add("Writer finished. Open the page editor for preview and publication checks.");
    }
  }

  /** @returns false if blocked (e.g. already busy, spend approval needed, or error). */
  async function run(step: Step, approveOverBudget = false): Promise<boolean> {
    if (busy) return false;
    setPending(null); setBusy(true);
    try {
      await runStep(step, approveOverBudget);
      return true;
    } catch (err) {
      if (err instanceof ApprovalRequired) {
        setPending({ step, estimate: err.estimatedCostGbp });
        add(
          `Spend approval needed: £${err.estimatedCostGbp.toFixed(3)} estimate exceeds £${AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)} per Claude call.`,
        );
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      add(`Stopped: ${message}`);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
      refreshSpend();
    }
  }

  /** Agentic test: verify, then HTML in one sequence (stops if gates or spend approval block). */
  async function runVerifyThenWrite(approveOverBudget = false) {
    if (busy) return;
    const reviewOk = await run("review", approveOverBudget);
    if (!reviewOk) return;
    const r = resortById(selected);
    if (!r) return;
    if (r.stage !== "research") {
      add("Agentic chain: resort left research stage — skipped HTML.");
      return;
    }
    if (r.exclusivity.status !== "clear" || !canGenerate(r)) {
      add(`Agentic chain: skipped HTML — ${generateBlockReason(r) || "exclusivity or completeness"}.`);
      return;
    }
    await run("write", approveOverBudget);
  }
  function queue(candidate: Resort) {
    const id = workflowResortId(candidate);
    const existingSameName = resorts.some((r) => r.name.toLowerCase() === candidate.name.toLowerCase() && r.id !== id);
    if (existingSameName) {
      toast.error("This resort may already exist; compare its identity before merging.");
      return;
    }
    if (resorts.some((r) => r.id === id)) {
      setSelected(id);
      add(`Selected ${candidate.name} (already queued). Crawl step 2 runs for the current resort.`);
      return;
    }
    mutate((s) => {
      s.resorts.push({
        ...structuredClone(candidate), id, stage: "scrape", facts: blankFacts(id),
        sources: candidate.sources.map((src) => ({ ...src, id: src.id.replace(candidate.id, id) })),
      });
      // Keep candidate visible in “Discovered” so you can queue many in a row and still see all URLs.
    });
    setSelected(id);
    const urls = [...new Set(candidate.sources.filter((x) => x.selected).map((x) => x.url))];
    add(`Queued ${candidate.name} → workflow id ${id}. URLs for crawl (${urls.length}): ${urls.join("; ") || "(none selected)"}`);
  }
  function decide(status: "clear" | "blocked") {
    if (!current) return;
    if (reviewNote.trim().length < 12) { toast.error("Record a specific evidence-based reason (at least 12 characters)."); return; }
    mutateResort(current.id, (r) => {
      r.exclusivity.status = status;
      r.exclusivity.confirmedBy = "Human editor";
      r.exclusivity.evidence.push({ note: reviewNote.trim(), sourceType: "salt_atlas" });
      r.researchLog.push(`CEO ${status} exclusivity: ${reviewNote.trim()}`);
    });
    setReviewNote(""); add(`Exclusivity marked ${status} by human editor.`);
  }
  return (
    <div className="mx-auto max-w-[1480px] px-5 py-8 md:px-8">
      <PageHeader eyebrow="CEO · Orchestration" title="Agent operations"
        crumbs={[{ label: "Overview", to: "/" }, { label: "CEO" }]}
        description="Manual pipeline: run each step in order (1→4). Step 1 opens a saved run tab (log + form). Resort data persists in this browser (localStorage)." />
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
        <span className="px-2 text-xs font-medium text-muted-foreground">Run tabs</span>
        <div className="flex max-w-full flex-1 flex-wrap gap-1 overflow-x-auto">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => switchSession(s.id)}
                className={cn(
                  "max-w-[200px] truncate rounded-md border px-2 py-1 text-left text-xs transition-colors",
                  activeSessionId === s.id ? "border-primary bg-primary/10 font-medium" : "border-transparent bg-card hover:bg-accent",
                )}
                title={s.label}
              >
                {s.label}
              </button>
              <button
                type="button"
                className="rounded px-1 text-[10px] text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${s.label}`}
                onClick={(e) => removeSession(s.id, e)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {sessions.length === 0 && <span className="text-xs text-muted-foreground">No runs yet — use step 1 to create one.</span>}
      </div>
      <div className="grid gap-4 xl:grid-cols-[340px_1fr_300px]">
        <Panel className="h-fit space-y-3 p-4">
          <div className="font-semibold">CEO instruction</div>
          <Textarea rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <Input value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country" placeholder="Country" />
            <Input value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region" placeholder="Region" />
          </div>
          <Button className="w-full" disabled={busy || !stepGates.s1} onClick={() => void run("scout")}>
            1 · Discover (Scout)
          </Button>
          {!stepGates.s1 && busy ? <p className="text-[11px] text-muted-foreground">Wait for the current step to finish.</p> : null}
          <div className="border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">Discovered candidates</div>
              <Button size="sm" variant="secondary" disabled={busy || !discoveryResults.some((c) => !c.knownBefore && !resorts.some((r) => r.id === workflowResortId(c)))} onClick={() => queueAllNew()}>
                Queue all new
              </Button>
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Queued resorts stay listed here. Use <b>Queue all new</b> once, then <b>Crawl all pending</b> in step 2 (one Apify run per resort).
            </p>
            <div className={cn("space-y-2 overflow-y-auto", SCROLL_DISCOVER)}>
              {discoveryResults.map((candidate) => {
                const wfId = workflowResortId(candidate);
                const queued = resorts.some((r) => r.id === wfId);
                return (
                  <div
                    key={candidate.id}
                    className={cn("rounded-lg border p-2 text-xs", queued && "border-emerald-500/40 bg-emerald-500/5")}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="font-semibold">{candidate.name}</span>
                      {queued ? <Pill tone="ok">Queued</Pill> : <Pill tone="muted">Not queued</Pill>}
                    </div>
                    {queued && <Mono className="mt-1 block text-[10px] text-muted-foreground">Crawl target id: {wfId}</Mono>}
                    <div className="mt-1 text-muted-foreground">{candidate.identityNote}</div>
                    <div className="mt-1 font-mono text-[10px] leading-relaxed text-foreground/90">
                      <span className="text-muted-foreground">Selected for crawl:</span>
                      {candidate.sources.filter((s) => s.selected).length ? (
                        <ul className="mt-0.5 list-inside list-disc space-y-0.5">
                          {candidate.sources.filter((s) => s.selected).map((s) => (
                            <li key={s.id} className="break-all">
                              <span className="text-muted-foreground">[{s.type}]</span> {s.url}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-destructive"> No URL selected — adjust on Research after queue.</span>
                      )}
                    </div>
                    <div className="mt-1 text-muted-foreground">{candidate.sources.length} source URLs · {candidate.competitors.length} competitors</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {queued ? (
                        <Button size="sm" variant={selected === wfId ? "default" : "outline"} disabled={busy} onClick={() => setSelected(wfId)}>
                          {selected === wfId ? "Current for crawl" : "Select for crawl"}
                        </Button>
                      ) : (
                        <Button className="flex-1" size="sm" variant="outline" onClick={() => queue(candidate)} disabled={busy || candidate.knownBefore}>
                          Identity checked — queue
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {!discoveryResults.length && <p className="text-xs text-muted-foreground">Run Scout to populate candidate resorts.</p>}
            </div>
          </div>
        </Panel>
        <div className="space-y-4">
          <Panel className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold">Current resort</div>
              <select className="max-w-full rounded-md border bg-card px-3 py-2 text-sm" value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">Choose a resort</option>
                {resorts.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.stage}</option>)}
              </select>
            </div>
            {current ? (
              <>
              <div className="text-lg font-semibold">{current.name}</div>
              <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center text-xs">
                <div><div className="font-semibold">{current.sources.length}</div>Sources</div>
                <div><div className="font-semibold">{completeness(current)}%</div>Verified fields</div>
                <div><div className="font-semibold">{current.exclusivity.status}</div>Exclusivity</div>
              </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Pick a resort for the summary row and pipeline controls.</p>
            )}
              <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-1">
                {CEO_BOARD_TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    title={t.hint}
                    onClick={() => setCeoBoardTab(t.id)}
                    className={cn(
                      "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                      ceoBoardTab === t.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {ceoBoardTab === "pipeline" ? (
              current ? (
              <div className="space-y-2 rounded-lg border bg-card/40 p-3">
                <div className="text-sm font-semibold">Pipeline (synced steps)</div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Run <b>1 → 2 → 3 → 4</b> in order. Each button triggers one Scout, Apify, Reviewer, or Writer call. Exclusivity is still human on the right before step 4. Use the tabs above to see every resort’s crawls, batch verify, or HTML status.
                </p>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-2 py-2 text-xs">
                    <div>
                      <span className="font-mono text-[10px] text-muted-foreground">1</span>
                      <div className="font-medium">Discover sources</div>
                      <div className="text-muted-foreground">Scout (Claude + web)</div>
                    </div>
                    <Pill tone="muted">uses card ←</Pill>
                  </div>
                  <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-2 py-2 text-xs">
                    <div className="min-w-0 flex-1 space-y-2">
                      <span className="font-mono text-[10px] text-muted-foreground">2</span>
                      <div className="font-medium">Crawl official URLs</div>
                      <div className="text-muted-foreground">Apify Website Content Crawler — set options below, then run.</div>
                      <Collapsible open={crawlOptionsOpen} onOpenChange={setCrawlOptionsOpen} className="rounded-md border border-dashed bg-muted/20 p-2">
                        <CollapsibleTrigger
                          type="button"
                          className="flex w-full items-center justify-between gap-2 text-left font-medium text-foreground hover:underline"
                        >
                          Crawl options
                          <span className="text-[10px] font-normal text-muted-foreground">{crawlOptionsOpen ? "Hide" : "Show"}</span>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-2 space-y-2 data-[state=closed]:hidden">
                          <label className="block text-[10px] text-muted-foreground">
                            Crawler
                            <select
                              className="mt-0.5 w-full rounded-md border bg-card px-2 py-1.5 font-mono text-[11px]"
                              disabled={busy}
                              value={crawlOptions.crawlerType}
                              onChange={(e) =>
                                setCrawlOptions((p) => ({ ...p, crawlerType: e.target.value as WccCrawlerType }))
                              }
                            >
                              <option value="playwright:adaptive">playwright:adaptive</option>
                              <option value="playwright:firefox">playwright:firefox</option>
                              <option value="cheerio">cheerio (static)</option>
                            </select>
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="text-[10px] text-muted-foreground">
                              Max depth
                              <Input
                                className="mt-0.5 h-8 font-mono text-[11px]"
                                type="number"
                                min={0}
                                max={3}
                                disabled={busy}
                                value={crawlOptions.maxCrawlDepth}
                                onChange={(e) =>
                                  setCrawlOptions((p) => ({
                                    ...p,
                                    maxCrawlDepth: Math.min(3, Math.max(0, Number(e.target.value) || 0)),
                                  }))
                                }
                              />
                            </label>
                            <label className="text-[10px] text-muted-foreground">
                              Max pages total
                              <Input
                                className="mt-0.5 h-8 font-mono text-[11px]"
                                type="number"
                                min={1}
                                max={50}
                                disabled={busy}
                                value={crawlOptions.maxPagesTotal}
                                onChange={(e) =>
                                  setCrawlOptions((p) => ({
                                    ...p,
                                    maxPagesTotal: Math.min(50, Math.max(1, Number(e.target.value) || 1)),
                                  }))
                                }
                              />
                            </label>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="text-[10px] text-muted-foreground">
                              Initial concurrency
                              <Input
                                className="mt-0.5 h-8 font-mono text-[11px]"
                                type="number"
                                min={1}
                                max={2}
                                disabled={busy}
                                value={crawlOptions.initialConcurrency}
                                onChange={(e) =>
                                  setCrawlOptions((p) => ({
                                    ...p,
                                    initialConcurrency: Math.min(2, Math.max(1, Number(e.target.value) || 1)),
                                  }))
                                }
                              />
                            </label>
                            <label className="text-[10px] text-muted-foreground">
                              Max concurrency
                              <Input
                                className="mt-0.5 h-8 font-mono text-[11px]"
                                type="number"
                                min={1}
                                max={2}
                                disabled={busy}
                                value={crawlOptions.maxConcurrency}
                                onChange={(e) =>
                                  setCrawlOptions((p) => ({
                                    ...p,
                                    maxConcurrency: Math.min(2, Math.max(1, Number(e.target.value) || 1)),
                                  }))
                                }
                              />
                            </label>
                          </div>
                          <label className="block text-[10px] text-muted-foreground">
                            Request timeout (seconds)
                            <Input
                              className="mt-0.5 h-8 font-mono text-[11px]"
                              type="number"
                              min={15}
                              max={120}
                              disabled={busy}
                              value={crawlOptions.requestTimeoutSecs}
                              onChange={(e) =>
                                setCrawlOptions((p) => ({
                                  ...p,
                                  requestTimeoutSecs: Math.min(120, Math.max(15, Number(e.target.value) || 60)),
                                }))
                              }
                            />
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={crawlOptions.saveMarkdown}
                              disabled={busy}
                              onChange={(e) => setCrawlOptions((p) => ({ ...p, saveMarkdown: e.target.checked }))}
                            />
                            Save markdown (recommended for research)
                          </label>
                          <p className="text-[10px] leading-snug text-muted-foreground">
                            {CRAWL_CAP_NOTE}. At least as many pages as selected start URLs are always requested. Robots.txt is always enforced on the server.
                          </p>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Button size="sm" disabled={busy || !stepGates.s2} onClick={() => void run("scrape")}>Run crawl (current)</Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || pendingScrapeResorts.length === 0}
                        onClick={() => void runBulkPendingScrapes()}
                        title="Runs Apify once per queued resort that has selected URLs and no crawl yet"
                      >
                        Crawl all pending ({pendingScrapeResorts.length})
                      </Button>
                      {!stepGates.s2 && stepGates.s2Reason ? <span className="max-w-[200px] text-[10px] text-destructive">{stepGates.s2Reason}</span> : null}
                      <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground">
                        <input type="checkbox" checked={autoVerifyAfterCrawl} onChange={(e) => setAutoVerifyAfterCrawl(e.target.checked)} />
                        Then auto-run 3
                      </label>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-2 py-2 text-xs">
                    <div>
                      <span className="font-mono text-[10px] text-muted-foreground">3</span>
                      <div className="font-medium">Validate &amp; fill facts</div>
                      <div className="text-muted-foreground">Reviewer (scrape + search)</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Button size="sm" disabled={busy || !stepGates.s3} onClick={() => void run("review")}>Verify &amp; fill</Button>
                      {!stepGates.s3 && stepGates.s3Reason ? <span className="max-w-[200px] text-[10px] text-destructive">{stepGates.s3Reason}</span> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-2 py-2 text-xs">
                    <div>
                      <span className="font-mono text-[10px] text-muted-foreground">4</span>
                      <div className="font-medium">Generate HTML copy</div>
                      <div className="text-muted-foreground">Writer → Studio</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Button size="sm" variant="outline" disabled={busy || !stepGates.s4} onClick={() => void run("write")}>Generate HTML</Button>
                      {!stepGates.s4 && stepGates.s4Reason ? <span className="max-w-[200px] text-[10px] text-destructive">{stepGates.s4Reason}</span> : null}
                      <Button size="sm" variant="ghost" className="h-7 text-[11px]" disabled={busy || !stepGates.s3} onClick={() => void runVerifyThenWrite()}>
                        Agentic test: 3 → 4
                      </Button>
                    </div>
                  </div>
                </div>
                {openResearchFacts(current).length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    Still open: {openResearchFacts(current).map((fact) => fact.label).join(", ")}. Re-run step 3 until clear enough for step 4.
                  </p>
                )}
                {current.stage === "research" && generateBlockReason(current) ? (
                  <p className="text-[11px] text-muted-foreground">{generateBlockReason(current)}</p>
                ) : null}
              </div>
              ) : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Choose a resort to use steps 1–4 here.</p>
              ) : null}
              {ceoBoardTab === "crawls" ? (
                <div className="space-y-3 rounded-lg border bg-card/40 p-3">
                  <div className="text-sm font-semibold">Crawl results (all resorts)</div>
                  <p className="text-[11px] text-muted-foreground">
                    Apify runs are grouped by internal run id. All pages returned in one run are listed together. Resort names link the same sources that share that run.
                  </p>
                  {crawlBoardLoading ? <p className="text-xs text-muted-foreground">Loading datasets…</p> : null}
                  <ScrollArea className={cn(SCROLL_BOARD, "pr-3")}>
                    <div className="space-y-3">
                      {resortRunGroups.map(({ resort: rr, runs }) =>
                        runs.length ? (
                          <div key={rr.id} className="rounded-lg border bg-background/50 p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-semibold text-sm">{rr.name}</span>
                              <Pill tone="muted">{rr.stage}</Pill>
                            </div>
                            {runs.map(([runId, srcUrls]) => {
                              const all = crawlBoardPages[runId] ?? [];
                              const matched = pagesForSources(
                                srcUrls.map((url) => ({ url })),
                                all,
                              );
                              return (
                                <div key={`${rr.id}-${runId}`} className="mt-2 rounded-md border border-dashed p-2 text-xs">
                                  <div className="font-mono text-[10px] text-muted-foreground">
                                    Run <span className="text-foreground">{runId}</span> · {matched.length || all.length} page row(s) loaded
                                    {matched.length < all.length && all.length ? ` (${matched.length} after source filter)` : ""}
                                  </div>
                                  <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground">
                                    {srcUrls.map((u) => (
                                      <li key={u} className="break-all">{u}</li>
                                    ))}
                                  </ul>
                                  {(matched.length ? matched : all).length ? (
                                    <div className={cn("mt-2 space-y-2 overflow-y-auto rounded border bg-muted/20 p-2", SCROLL_CRAWL_PAGES)}>
                                      {(matched.length ? matched : all).map((p) => (
                                        <div key={p.url} className="border-b border-border/40 pb-2 last:border-0 last:pb-0">
                                          <a href={p.url} target="_blank" rel="noreferrer" className="break-all text-[11px] font-medium text-primary underline">
                                            {p.url}
                                          </a>
                                          <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{pageTextSnippet(p)}</p>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="mt-2 text-[10px] text-destructive">No rows in storage for this run yet.</p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div key={rr.id} className="rounded-lg border border-dashed p-2 text-xs text-muted-foreground">
                            <span className="font-semibold text-foreground">{rr.name}</span> — no run id linked to sources yet.
                          </div>
                        ),
                      )}
                      {resorts.length === 0 && <p className="text-xs text-muted-foreground">No resorts in the studio store.</p>}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
              {ceoBoardTab === "research" ? (
                <div className="space-y-3 rounded-lg border bg-card/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">Verify (research stage)</div>
                      <p className="text-[11px] text-muted-foreground">Run reviewer once per resort; bulk processes every resort currently on <b>research</b>.</p>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy || !researchBoardResorts.some((r) => r.stage === "research")}
                      onClick={() => void runBulkReviewWithGates()}
                    >
                      Verify all on research ({researchBoardResorts.filter((r) => r.stage === "research").length})
                    </Button>
                  </div>
                  <ScrollArea className={cn(SCROLL_BOARD, "pr-3")}>
                    <div className="space-y-2">
                      {researchBoardResorts.length === 0 && (
                        <p className="text-xs text-muted-foreground">Nothing past crawl yet — queue and run step 2 first.</p>
                      )}
                      {researchBoardResorts.map((rr) => {
                        const open = openResearchFacts(rr);
                        const issues = openIssues(rr);
                        return (
                          <div
                            key={rr.id}
                            className={cn(
                              "rounded-lg border p-2 text-xs",
                              rr.id === selected && "border-primary/40 bg-primary/5",
                            )}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-semibold">{rr.name}</span>
                              <div className="flex flex-wrap items-center gap-1">
                                <Pill tone={rr.stage === "research" ? "info" : "ok"}>{rr.stage}</Pill>
                                <span className="text-muted-foreground">{completeness(rr)}% verified</span>
                              </div>
                            </div>
                            <div className="mt-1 text-[10px] text-muted-foreground">
                              Runs: {[...new Set(rr.sources.map((s) => s.runId).filter(Boolean))].join(", ") || "—"}
                            </div>
                            {open.length > 0 ? (
                              <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
                                Open facts: {open.map((f) => f.label).join(", ")}
                              </p>
                            ) : rr.stage === "research" ? (
                              <p className="mt-1 text-[10px] text-emerald-700 dark:text-emerald-400">No open template fields.</p>
                            ) : null}
                            {issues.length > 0 && (
                              <p className="mt-1 text-[10px] text-muted-foreground">{issues.join(" · ")}</p>
                            )}
                            <div className="mt-2 flex flex-wrap gap-1">
                              <Button size="sm" variant="outline" disabled={busy} onClick={() => { setSelected(rr.id); setCeoBoardTab("pipeline"); }}>
                                Select in pipeline
                              </Button>
                              {rr.stage === "research" && (
                                <Button
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => {
                                    setSelected(rr.id);
                                    void run("review");
                                  }}
                                >
                                  Verify this resort
                                </Button>
                              )}
                              <Button size="sm" variant="secondary" disabled={busy} onClick={() => nav({ to: "/research", search: { resort: rr.id } })}>
                                Open Research
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
              {ceoBoardTab === "html" ? (
                <div className="space-y-3 rounded-lg border bg-card/40 p-3">
                  <div className="text-sm font-semibold">HTML generation</div>
                  <p className="text-[11px] text-muted-foreground">Draft exists after step 4; exclusivity clear + 60%+ verified required before running Writer from the Pipeline tab.</p>
                  <ScrollArea className={cn(SCROLL_BOARD, "pr-3")}>
                    <div className="space-y-2">
                      {htmlBoardResorts.map((rr) => {
                        const hasDraft = !!rr.page?.sections?.length;
                        return (
                          <div key={rr.id} className="rounded-lg border p-2 text-xs">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-semibold">{rr.name}</span>
                              <Pill tone={rr.stage === "generate" || rr.stage === "published" ? "ok" : "muted"}>{rr.stage}</Pill>
                            </div>
                            {!hasDraft ? (
                              <p className="mt-2 text-[11px] text-muted-foreground">Has not been generated — complete verify and run step 4 (Writer).</p>
                            ) : (
                              <div className="mt-2 space-y-1">
                                <p className="text-[11px] text-muted-foreground">
                                  Draft: <span className="font-mono text-foreground">{rr.page!.versions[0]?.savedAt ?? "—"}</span> · {rr.page!.sections.length} section(s) · status {rr.page!.status}
                                </p>
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => nav({ to: "/studio", search: { resort: rr.id } })}>
                                  Open Studio
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
              {ceoBoardTab === "pipeline" && current ? (
                <>
              {(current.stage === "generate" || current.stage === "published") && (
                <Button variant="outline" onClick={() => nav({ to: "/studio", search: { resort: current.id } })}>Open HTML editor</Button>
              )}
              <div className="text-sm font-semibold">Current evidence</div>
              <div className={cn("space-y-2 overflow-y-auto", SCROLL_EVIDENCE)}>
                {current.facts.map((fact) => (
                  <div key={fact.id} className="rounded-md border px-3 py-2 text-xs">
                    <div className="flex items-center justify-between"><span className="font-semibold">{fact.label}</span><span>{fact.status}</span></div>
                    <div className="mt-1">{fact.selected ?? "Missing — research needed"}</div>
                    {fact.selectedCandidateId && <Mono className="text-muted-foreground">{fact.candidates.find((c) => c.id === fact.selectedCandidateId)?.sourceUrl ?? ""}</Mono>}
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => nav({ to: "/research", search: { resort: current.id } })}>Open detailed research</Button>
                </>
              ) : null}
          </Panel>
          <Panel className="p-4">
            <div className="mb-3 font-semibold">Live stage stream</div>
            <div className={cn("space-y-1 overflow-y-auto font-mono text-xs", SCROLL_ACTIVITY)}>
              {activity.map((line, i) => <p key={i} className="border-l-2 border-primary/30 py-1 pl-3">{line}</p>)}
            </div>
          </Panel>
        </div>
        <Panel className="h-fit space-y-4 p-4">
          <div className="font-semibold">Approvals and spend</div>
          <div className="rounded-lg bg-muted/50 p-3">
            <div className="text-xs text-muted-foreground">Claude cost, kept across every operation</div>
            <div className="text-2xl font-semibold">£{spend.toFixed(3)}</div>
            <Mono>£{AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)} pre-call approval threshold</Mono>
          </div>
          {pending && <div className="rounded-lg border border-amber-500/60 p-3 text-sm">
            <div className="font-semibold">Approval required</div>
            <p>
              Estimated £{pending.estimate.toFixed(3)} for {pending.bulkReview ? "bulk verify (all research)" : pending.step}. No Claude call was made.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void (pending.bulkReview ? runBulkReviewWithGates(true) : run(pending.step, true))
                }
              >
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPending(null)}>Reject</Button>
            </div>
          </div>}
          {current?.stage === "research" && <div className="space-y-2 border-t pt-3">
            <div className="font-semibold">Exclusivity cross-check</div>
            <Pill tone={current.exclusivity.status === "clear" ? "ok" : current.exclusivity.status === "blocked" ? "bad" : "warn"}>{current.exclusivity.status}</Pill>
            {current.exclusivity.evidence.map((e, i) => <div key={i} className="text-xs text-muted-foreground">
              {e.note} {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="underline">Evidence</a>}
            </div>)}
            <Textarea rows={3} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="Human decision and evidence supporting it…" />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("clear")}>Mark clear</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("blocked")}>Block</Button>
            </div>
          </div>}
          <p className="text-xs text-muted-foreground">AI does not approve publishing, verify photograph rights, or override human exclusivity decisions. Live deployment remains separate.</p>
        </Panel>
      </div>
    </div>
  );
}
