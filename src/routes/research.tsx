import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Sparkles, Check, X, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActivityLog, ExclPill, FactPill, Mono, PageHeader, Panel, SourceTag } from "@/components/studio/ui-bits";
import { CATEGORY_LABELS } from "@/lib/mock-data";
import { mutateResort, useStudio } from "@/lib/store";
import { canGenerate, completeness, generateBlockReason } from "@/lib/workflow";
import { newPage } from "@/lib/page-gen";
import { fetchResolvedScrapeRunId, fetchScrapeRunItems } from "@/lib/api";
import { strictPagesForSources } from "@/lib/scrape-match";
import type { WccPage } from "@/lib/wcc-types";
import { ApprovalRequired, invokeAgent, mergeVerifiedResearch, applyWrittenSections, withLiveEvidence } from "@/lib/agents/agent-client";
import { AGENT_PER_CALL_APPROVAL_GBP_DEFAULT } from "@/lib/agents/spend-limits";
import type { Category, ExclusivityStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/research")({
  validateSearch: (s: Record<string, unknown>): { resort?: string } => (s["resort"] ? { resort: String(s["resort"]) } : {}),
  head: () => ({ meta: [
    { title: "Research & Verify — Salt Atlas Resort Studio" },
    { name: "description", content: "Verify every resort fact against trusted sources before publication." },
    { property: "og:title", content: "Research & Verify — Salt Atlas" },
    { property: "og:description", content: "Evidence-first resort verification." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Research,
});

function Research() {
  const { resorts } = useStudio();
  const { resort } = Route.useSearch();
  const nav = useNavigate();
  const list = resorts.filter((r) => r.stage === "research");
  const r = list.find((x) => x.id === resort) ?? list[0];
  const [cat, setCat] = useState<Category>("overview");
  const [running, setRunning] = useState(false);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [costApproval, setCostApproval] = useState<number | null>(null);
  const [writerApproval, setWriterApproval] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [scraped, setScraped] = useState<WccPage[]>([]);
  const [scrapeNote, setScrapeNote] = useState("Loading scraped pages…");
  const runKey = r?.sources.map((s) => s.runId ?? "").join(",") ?? "";
  useEffect(() => {
    if (!r) return;
    let cancel = false;
    const load = async () => {
      let runs = [...new Set(r.sources.map((s) => s.runId).filter((id): id is string => !!id))];
      if (!runs.length) {
        setScrapeNote("Looking for a matching crawl…");
        const urls = r.sources.map((s) => s.url).filter(Boolean);
        const resolved = urls.length ? await fetchResolvedScrapeRunId(urls) : null;
        if (cancel) return;
        if (resolved) {
          mutateResort(r.id, (x) => {
            for (const s of x.sources) {
              if (!s.runId) s.runId = resolved;
            }
          });
          runs = [resolved];
        }
      }
      if (!runs.length) {
        setScraped([]);
        setScrapeNote(
          "No stored crawl matched these source URLs. Run a bulk crawl from /scrape that includes this site, or send from queue so run ids attach.",
        );
        return;
      }
      setScrapeNote("Loading scraped pages…");
      const groups = await Promise.all(runs.map((id) => fetchScrapeRunItems(id)));
      if (cancel) return;
      const pages = strictPagesForSources(r.sources, groups.flat());
      setScraped(pages);
      setScrapeNote(pages.length ? "" : "The linked crawl has no page from this resort's website. Re-crawl it from the CEO page.");
    };
    void load().catch(() => {
      if (!cancel) setScrapeNote("Could not load the scraped pages.");
    });
    return () => {
      cancel = true;
    };
  }, [r, runKey]);
  if (!r) return <div className="p-10"><PageHeader title="Research & Verify" crumbs={[{ label: "Research & Verify" }]} description="No resorts in research. Send scraped resorts here." /></div>;

  const gapResearch = async (approveOverBudget = false) => {
    setRunning(true); setCostApproval(null);
    try {
      let runs = [...new Set(r.sources.map((x) => x.runId).filter((id): id is string => !!id))];
      if (!runs.length) {
        const resolved = await fetchResolvedScrapeRunId(r.sources.map((s) => s.url));
        if (resolved) {
          mutateResort(r.id, (x) => {
            for (const s of x.sources) {
              if (!s.runId) s.runId = resolved;
            }
          });
          runs = [resolved];
        }
      }
      if (!runs.length) throw new Error("No stored crawl matched these URLs. Crawl this site from /scrape first.");
      const all = (await Promise.all(runs.map((id) => fetchScrapeRunItems(id)))).flat();
      const pages = strictPagesForSources(r.sources, all);
      setScraped(pages);
      if (!pages.length) throw new Error("The linked crawl has no page from this resort's website, so there is nothing of its own to research. Re-crawl it from the CEO page.");
      const reply = await invokeAgent({ kind: "reviewer", input: { resort: r, pages }, approveOverBudget });
      mutateResort(r.id, (x) => {
        const outcome = mergeVerifiedResearch(x, reply.data, withLiveEvidence(pages, reply.evidence));
        for (const url of outcome.suggestedSources) {
          if (x.sources.some((s) => s.url === url)) continue;
          x.sources.push({ id: `suggested-${crypto.randomUUID()}`, url, type: "independent", selected: false, scrape: "pending" });
        }
        x.researchLog.push(...reply.warnings);
        x.researchLog.push(`Claude Reviewer: £${(reply.usage.actualCostGbp ?? 0).toFixed(3)} for this call.`);
      });
      toast.success("Reviewer filled quoted fields and searched for the ones still missing.");
    } catch (error) {
      if (error instanceof ApprovalRequired) {
        setCostApproval(error.estimatedCostGbp);
      } else {
        toast.error(error instanceof Error ? error.message : "Reviewer failed");
      }
    } finally { setRunning(false); }
  };
  const pick = (fid: string, cid: string) => mutateResort(r.id, (x) => { const f = x.facts.find((y) => y.id === fid)!; const c = f.candidates.find((y) => y.id === cid)!; f.selected = c.value; f.selectedCandidateId = cid; f.status = "verified"; f.reason = `Editor selected ${c.sourceType} value.`; });
  const reject = (fid: string, cid: string) => mutateResort(r.id, (x) => { const c = x.facts.find((y) => y.id === fid)!.candidates.find((y) => y.id === cid)!; c.rejected = true; });
  const correct = (fid: string) => mutateResort(r.id, (x) => { const f = x.facts.find((y) => y.id === fid)!; const c = { id: `sa${Date.now()}`, value: edit[fid] ?? "", sourceUrl: "https://saltatlas.com/knowledge", sourceType: "salt_atlas" as const, checkedAt: "2026-11-06" }; f.candidates.push(c); f.selected = c.value; f.selectedCandidateId = c.id; f.status = "verified"; f.reason = "Salt Atlas knowledge added by editor."; });
  const accept = (fid: string) => mutateResort(r.id, (x) => { const f = x.facts.find((y) => y.id === fid)!; f.status = "verified"; f.reason = "Accepted by editor."; });
  const setExcl = (s: ExclusivityStatus) => mutateResort(r.id, (x) => { x.exclusivity.status = s; x.exclusivity.confirmedBy = "Editor"; });
  const generate = async (approveOverBudget = false) => {
    setGenerating(true); setWriterApproval(null);
    try {
      if (!canGenerate(r)) throw new Error(generateBlockReason(r) || "Research is not ready to generate.");
      const provisional = newPage(r);
      const reply = await invokeAgent({
        kind: "writer", input: { resort: r, sections: provisional.sections }, approveOverBudget,
      });
      mutateResort(r.id, (x) => {
        x.page = newPage(x);
        const changed = applyWrittenSections(x, reply.data);
        x.page!.versions[0]!.sections = structuredClone(x.page!.sections);
        x.stage = "generate";
        x.researchLog.push(`Writer prepared ${changed.length} source-linked sections (Claude £${(reply.usage.actualCostGbp ?? 0).toFixed(3)}).`);
        x.researchLog.push(...reply.warnings);
      });
      toast.success("Draft generated from verified research. Review every claim before publishing.");
      nav({ to: "/studio", search: { resort: r.id } });
    } catch (error) {
      if (error instanceof ApprovalRequired) setWriterApproval(error.estimatedCostGbp);
      else toast.error(error instanceof Error ? error.message : "HTML writer failed");
    } finally { setGenerating(false); }
  };

  const facts = r.facts.filter((f) => f.category === cat);

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-8 md:px-10 md:py-10">
      <PageHeader eyebrow="Stage 03" title={r.name} crumbs={[{ label: "Scrape", to: "/scrape" }, { label: "Research & Verify" }]}
        description={<><span>{r.destination} · </span><Mono className="text-primary">{r.officialUrl}</Mono></>}
        actions={<><Button variant="outline" onClick={() => void gapResearch()} disabled={running}><Sparkles className="size-4" />{running ? "Verifying and filling…" : "Verify and fill"}</Button><Button onClick={() => void generate()} disabled={!canGenerate(r) || generating}>{generating ? "Generating…" : "Generate HTML"} <ArrowRight className="size-4" /></Button></>} />
      {writerApproval !== null && <Panel className="mb-4 flex items-center justify-between gap-3 p-3 text-sm">
        <span>
          Writer estimate £{writerApproval.toFixed(3)} exceeds the £
          {AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)} per-call approval threshold.
        </span>
        <Button onClick={() => void generate(true)} disabled={generating}>Approve writer call</Button>
      </Panel>}
      {costApproval !== null && <Panel className="mb-4 flex items-center justify-between gap-3 p-3 text-sm">
        <span>
          Reviewer estimate £{costApproval.toFixed(3)} exceeds the £
          {AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)} per-call approval threshold.
        </span>
        <Button onClick={() => void gapResearch(true)} disabled={running}>Approve this call</Button>
      </Panel>}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {list.map((x) => <button key={x.id} onClick={() => nav({ to: "/research", search: { resort: x.id } })} className={cn("rounded-full border px-3 py-1 text-xs", x.id === r.id ? "border-primary bg-primary text-primary-foreground" : "bg-card")}>{x.name}</button>)}
        <Mono className="ml-auto">{completeness(r)}% verified</Mono><ExclPill s={r.exclusivity.status} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[200px_1fr_300px]">
        <div className="space-y-0.5">{(Object.keys(CATEGORY_LABELS) as Category[]).map((c) => <button key={c} onClick={() => setCat(c)} className={cn("block w-full rounded-md px-3 py-2 text-left text-sm", c === cat ? "bg-accent font-medium" : "hover:bg-muted")}>{CATEGORY_LABELS[c]}</button>)}</div>
        <div className="space-y-3">
          {facts.map((f) => (
            <Panel key={f.id} className="p-4">
              <div className="flex items-center justify-between gap-2"><div className="font-medium">{f.label}</div><FactPill s={f.status} /></div>
              <div className="mt-1 text-[15px]">{f.selected ?? <span className="text-muted-foreground">No verified value</span>}</div>
              {f.reason && <div className="mt-1 text-xs text-muted-foreground">{f.reason}</div>}
              <div className="mt-3 space-y-1.5">
                {f.candidates.map((c) => (
                  <div key={c.id} className={cn("flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs", c.rejected && "opacity-40 line-through")}>
                    <SourceTag t={c.sourceType} /><span className="font-medium">{c.value}</span>{c.quote && <span className="italic text-muted-foreground" title={c.quote}>“{c.quote.slice(0, 110)}”</span>}<Mono className="truncate text-muted-foreground">{c.sourceUrl.replace("https://", "")} · {c.checkedAt}</Mono>
                    <span className="ml-auto flex gap-1">{f.selectedCandidateId !== c.id && !c.rejected && <Button size="sm" variant="ghost" className="h-6" onClick={() => pick(f.id, c.id)}>Use</Button>}{!c.rejected && <Button size="sm" variant="ghost" className="h-6" onClick={() => reject(f.id, c.id)}><X className="size-3" /></Button>}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Input value={edit[f.id] ?? ""} onChange={(e) => setEdit({ ...edit, [f.id]: e.target.value })} placeholder="Correct or add Salt Atlas knowledge" className="h-8 text-xs" />
                <Button size="sm" variant="outline" disabled={!edit[f.id]} onClick={() => correct(f.id)}>Save</Button>
                {f.status !== "verified" && f.selected && <Button size="sm" onClick={() => accept(f.id)}><Check className="size-3" />Accept</Button>}
              </div>
            </Panel>
          ))}
        </div>
        <div className="space-y-4">
          <Panel className="p-4">
            <div className="mb-2 font-medium">Scraped pages</div>
            {scrapeNote && <p className="text-xs text-muted-foreground">{scrapeNote}</p>}
            <div className="max-h-[min(72vh,780px)] space-y-3 overflow-auto">
              {scraped.map((page) => {
                const body = (page.markdown ?? page.text ?? "").trim();
                return (
                  <div key={page.url} className="rounded-md border px-2 py-2 text-xs">
                    <div className="font-medium">{page.metadata?.title ?? "Untitled page"}</div>
                    <a href={page.url} className="mt-0.5 block truncate text-muted-foreground" target="_blank" rel="noreferrer">{page.url}</a>
                    <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{body.slice(0, 700)}{body.length > 700 ? "…" : ""}</p>
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel className="p-4"><div className="mb-2 font-medium">Exclusivity</div>
            {r.exclusivity.evidence.map((e, i) => <div key={i} className="mb-2 text-xs"><SourceTag t={e.sourceType} /> {e.note}</div>)}
            <div className="flex gap-1">{(["clear", "needs_review", "blocked"] as const).map((s) => <Button key={s} size="sm" variant={r.exclusivity.status === s ? "default" : "outline"} className="h-7 text-xs" onClick={() => setExcl(s)}>{s.replace("_", " ")}</Button>)}</div>
          </Panel>
          <Panel className="p-4"><div className="mb-2 font-medium">AI research activity</div><ActivityLog lines={r.researchLog.length ? r.researchLog : ["Idle"]} running={running} /></Panel>
        </div>
      </div>
    </div>
  );
}
