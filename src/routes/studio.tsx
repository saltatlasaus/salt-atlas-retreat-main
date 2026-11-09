import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Download, Eye, Sparkles, Undo2, Redo2, Save, Rocket, Monitor, Smartphone, Tablet } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Mono, PageHeader, Panel, Pill } from "@/components/studio/ui-bits";
import { mutateResort, useStudio } from "@/lib/store";
import { openResearchFacts, qualityChecks } from "@/lib/workflow";
import { fetchResolvedScrapeRunId, fetchScrapeRunItems, sleep, type AiEditResponse } from "@/lib/api";
import { strictPagesForSources } from "@/lib/scrape-match";
import { ApprovalRequired, applyEditorPatch, fillOpenFacts, invokeAgent, mergeVerifiedResearch, withLiveEvidence } from "@/lib/agents/agent-client";
import { AGENT_PER_CALL_APPROVAL_GBP_DEFAULT } from "@/lib/agents/spend-limits";
import { applyVerifiedGaps, stamp } from "@/lib/page-gen";
import { resortPageToStaticHtml } from "@/lib/page-html";
import type { PageSection } from "@/lib/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/studio")({
  validateSearch: (s: Record<string, unknown>): { resort?: string } => (s["resort"] ? { resort: String(s["resort"]) } : {}),
  head: () => ({ meta: [
    { title: "Generate, Edit & Publish — Salt Atlas Resort Studio" },
    { name: "description", content: "Visually edit generated resort pages, make targeted AI edits and publish to Salt Atlas." },
    { property: "og:title", content: "Page studio — Salt Atlas" },
    { property: "og:description", content: "Visual editor and simulated publishing." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Studio,
});

const WIDTH = { desktop: "100%", tablet: "768px", mobile: "390px" } as const;

function Studio() {
  const { resorts } = useStudio();
  const { resort: resortParam } = Route.useSearch();
  const nav = useNavigate();
  /** Only studios with a generated page (dropdown). URL can still point at a resort without a draft. */
  const resortsWithPage = useMemo(() => resorts.filter((x) => x.page), [resorts]);

  const unknownResortId = Boolean(resortParam && !resorts.some((x) => x.id === resortParam));

  const r = useMemo(() => {
    if (resortParam) {
      const exact = resorts.find((x) => x.id === resortParam);
      if (exact) return exact;
    }
    return resortsWithPage[0];
  }, [resortParam, resorts, resortsWithPage]);

  const [sel, setSel] = useState<string>();
  const [device, setDevice] = useState<keyof typeof WIDTH>("desktop");
  const [undo, setUndo] = useState<PageSection[][]>([]);
  const [redo, setRedo] = useState<PageSection[][]>([]);
  const [instr, setInstr] = useState("Make this paragraph more engaging without changing the facts.");
  const [proposal, setProposal] = useState<AiEditResponse & { attempt: number }>();
  const [busy, setBusy] = useState(false);
  const [editApproval, setEditApproval] = useState<number | null>(null);
  const [gapBusy, setGapBusy] = useState(false);
  const [gapApproval, setGapApproval] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);
  const [deploy, setDeploy] = useState<string>();
  if (unknownResortId) {
    return (
      <div className="p-10">
        <PageHeader
          title="Resort not found"
          crumbs={[{ label: "Studio" }]}
          description={`No resort with id “${resortParam}” in this browser session.`}
        />
        <Button className="mt-4" variant="outline" onClick={() => nav({ to: "/studio", search: {} })}>
          Open studio (first draft)
        </Button>
      </div>
    );
  }

  if (r && !r.page) {
    return (
      <div className="space-y-4 p-10">
        <PageHeader
          eyebrow="Stage 04"
          title={r.name}
          crumbs={[{ label: "Studio" }]}
          description="This resort has no HTML draft yet — the editor only opens after CEO step 4 (or equivalent) creates a page."
        />
        <p className="max-w-lg text-sm text-muted-foreground">
          Opening <Mono>/studio?resort={r.id}</Mono> used to fall back to another resort with a page; it now stays on{" "}
          <b>{r.name}</b>. Run <b>4 · Generate HTML</b> on <Mono>/ops</Mono> when research gates pass, then return here.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => nav({ to: "/ops" })}>Open CEO</Button>
          <Button variant="outline" onClick={() => nav({ to: "/research", search: { resort: r.id } })}>
            Open research
          </Button>
        </div>
        {resortsWithPage[0] ? (
          <p className="text-xs text-muted-foreground">
            Or edit an existing draft:{" "}
            <button type="button" className="text-primary underline" onClick={() => nav({ to: "/studio", search: { resort: resortsWithPage[0]!.id } })}>
              {resortsWithPage[0]!.name}
            </button>
          </p>
        ) : null}
      </div>
    );
  }

  if (!r?.page) {
    return (
      <div className="p-10">
        <PageHeader title="Generate, Edit & Publish" crumbs={[{ label: "Studio" }]} description="No pages yet. Generate one from Research & Verify or CEO step 4." />
      </div>
    );
  }
  const page = r.page;
  const section = page.sections.find((s) => s.id === sel);

  const commit = (fn: (s: PageSection[]) => void) => {
    setUndo((u) => [...u, structuredClone(page.sections)]); setRedo([]);
    mutateResort(r.id, (x) => { fn(x.page!.sections); if (x.page!.status !== "live") x.page!.status = "draft"; });
  };
  const restore = (from: PageSection[][], setFrom: typeof setUndo, setTo: typeof setUndo) => {
    const last = from.at(-1); if (!last) return;
    setTo((t) => [...t, structuredClone(page.sections)]); setFrom(from.slice(0, -1));
    mutateResort(r.id, (x) => { x.page!.sections = last; });
  };
  const setField = (id: string, field: "title" | "body", v: string) => commit((ss) => { ss.find((s) => s.id === id)![field] = v; });
  const move = (i: number, d: number) => commit((ss) => { const [x] = ss.splice(i, 1); if (x) ss.splice(i + d, 0, x); });
  const ask = async (attempt = 0, approveOverBudget = false) => {
    if (!section) return;
    setBusy(true); setEditApproval(null);
    try {
      const facts = r.facts.filter((f) => section.factIds.includes(f.id))
        .map((f) => ({ id: f.id, label: f.label, ...(f.selected !== undefined ? { selected: f.selected } : {}), status: f.status }));
      const reply = await invokeAgent({
        kind: "editor", input: { section, instruction: instr, facts }, approveOverBudget,
      });
      const patch = applyEditorPatch(section, reply.data);
      setProposal({
        patch, attempt, model: "light",
        tokens: reply.usage.inputTokens + reply.usage.outputTokens,
        notes: `Claude ${reply.usage.model}; cost £${(reply.usage.actualCostGbp ?? 0).toFixed(3)}. ${reply.warnings.join("; ")}`,
      });
    } catch (error) {
      if (error instanceof ApprovalRequired) setEditApproval(error.estimatedCostGbp);
      else toast.error(error instanceof Error ? error.message : "Claude edit failed");
    } finally { setBusy(false); }
  };
  const fillGaps = async (approveOverBudget = false) => {
    setGapBusy(true); setGapApproval(null);
    try {
      let runs = [...new Set(r.sources.map((source) => source.runId).filter((id): id is string => !!id))];
      if (!runs.length) {
        const resolved = await fetchResolvedScrapeRunId(r.sources.map((source) => source.url));
        if (resolved) {
          mutateResort(r.id, (x) => {
            for (const source of x.sources) if (!source.runId) source.runId = resolved;
          });
          runs = [resolved];
        }
      }
      const pages = runs.length ? strictPagesForSources(r.sources, (await Promise.all(runs.map((id) => fetchScrapeRunItems(id)))).flat()) : [];
      const reply = await invokeAgent({ kind: "reviewer", input: { resort: r, pages }, approveOverBudget });
      let filled = 0;
      let left: string[] = [];
      mutateResort(r.id, (x) => {
        fillOpenFacts(x);
        mergeVerifiedResearch(x, reply.data, withLiveEvidence(pages, reply.evidence));
        if (x.page) filled = applyVerifiedGaps(x.page.sections, x);
        x.researchLog.push(...reply.warnings);
        left = openResearchFacts(x).map((fact) => fact.label);
      });
      toast.success(left.length
        ? `Filled ${filled} gap${filled === 1 ? "" : "s"}. Still open: ${left.join(", ")}.`
        : "Every open field now has a source.");
    } catch (error) {
      if (error instanceof ApprovalRequired) setGapApproval(error.estimatedCostGbp);
      else toast.error(error instanceof Error ? error.message : "Gap search failed");
    } finally { setGapBusy(false); }
  };
  const save = () => { mutateResort(r.id, (x) => { const p = x.page!; p.versions.push({ id: `v${p.versions.length + 1}`, number: p.versions.length + 1, savedAt: stamp(), note: "Editor save", sections: structuredClone(p.sections) }); }); toast.success("New version saved"); };
  const checks = qualityChecks(r);
  const blocked = checks.some((c) => c.blocking && !c.ok && c.id !== "editorial");
  const publish = async () => {
    for (const s of ["Validating template…", "Writing page files (simulated)…", "Triggering deployment (simulated)…"]) { setDeploy(s); await sleep(800); }
    mutateResort(r.id, (x) => { const p = x.page!; p.status = "live"; p.publishedVersion = p.versions.length; p.pendingFactChanges = []; x.stage = "published"; p.history.unshift({ id: `h${Date.now()}`, at: stamp(), action: p.history.length ? "Updated existing page (simulated)" : "Published new page (simulated)", version: p.versions.length, url: `https://saltatlas.com/${p.slug}`, simulated: true }); });
    setDeploy(undefined); toast.success("Simulated publish complete — no real deployment happened.");
  };

  return (
    <div className="px-5 py-8 md:px-8">
      <PageHeader eyebrow="Stage 04" title={r.name} crumbs={[{ label: "Research & Verify", to: "/research" }, { label: "Generate, Edit & Publish" }]}
        description={<>Export uses the <b>.sa-tp</b> resort template (Telo reference). Status: <Pill tone={page.status === "live" ? "ok" : "info"}>{page.status}</Pill></>}
        actions={<>
          <select value={r.id} onChange={(e) => nav({ to: "/studio", search: { resort: e.target.value } })} className="rounded-md border bg-card px-2 text-sm">{resortsWithPage.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <Button variant="outline" size="icon" onClick={() => restore(undo, setUndo, setRedo)} disabled={!undo.length}><Undo2 className="size-4" /></Button>
          <Button variant="outline" size="icon" onClick={() => restore(redo, setRedo, setUndo)} disabled={!redo.length}><Redo2 className="size-4" /></Button>
          <Button variant="outline" onClick={save}><Save className="size-4" />Save version</Button>
          <Button variant="outline" onClick={() => setPreview(true)}><Eye className="size-4" />Preview website</Button>
          <Button
            variant="outline"
            onClick={() => {
              const html = resortPageToStaticHtml(r, page);
              const blob = new Blob([html], { type: "text/html;charset=utf-8" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `${page.slug.replace(/\//g, "-")}-salt-atlas.html`;
              a.click();
              URL.revokeObjectURL(a.href);
              toast.success("Downloaded static HTML (self-contained, for QA).");
            }}
          >
            <Download className="size-4" />
            HTML
          </Button>
        </>} />
      {page.pendingFactChanges.length > 0 && <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">Research changed since publish: <b>7-night price</b> is now {r.facts.find((f) => f.id === page.pendingFactChanges[0])?.selected}. <Button size="sm" className="ml-2 h-7" onClick={() => commit((ss) => { const p = ss.find((s) => s.type === "pricing")!; if (p.items[0]) p.items[0].meta = r.facts.find((f) => f.id === page.pendingFactChanges[0])!.selected!; })}>Update pricing section only</Button></div>}
      <div className="grid gap-4 xl:grid-cols-[220px_1fr_320px]">
        <Panel className="h-fit p-3">
          <div className="eyebrow mb-2 px-1">Sections</div>
          {page.sections.map((s, i) => (
            <div key={s.id} className={cn("flex items-center gap-1 rounded-md px-2 py-1.5 text-sm", sel === s.id && "bg-accent")}>
              <button className="flex-1 text-left capitalize" onClick={() => setSel(s.id)}>{s.type}</button>
              <button disabled={i === 0} onClick={() => move(i, -1)} className="text-xs text-muted-foreground">↑</button>
              <button disabled={i === page.sections.length - 1} onClick={() => move(i, 1)} className="text-xs text-muted-foreground">↓</button>
            </div>
          ))}
        </Panel>
        <div>
          <div className="mb-2 flex justify-center gap-1">{([["desktop", Monitor], ["tablet", Tablet], ["mobile", Smartphone]] as const).map(([d, I]) => <Button key={d} size="sm" variant={device === d ? "default" : "ghost"} onClick={() => setDevice(d)}><I className="size-4" /></Button>)}</div>
          <div className="mx-auto overflow-hidden rounded-xl border bg-card shadow-soft transition-all" style={{ maxWidth: WIDTH[device] }}>
            <ResortPageView sections={page.sections} editable selected={sel} onSelect={setSel} onEdit={setField} highlight={page.pendingFactChanges.length ? "pricing" : undefined} />
          </div>
        </div>
        <div className="space-y-4">
          {openResearchFacts(r).length > 0 && <Panel className="p-4">
            <div className="mb-2 font-medium">Open gaps</div>
            <p className="text-xs text-muted-foreground">Search the scrape and the live web for these fields before the page is treated as clear.</p>
            <ul className="my-2 space-y-1 text-xs">
              {openResearchFacts(r).map((fact) => <li key={fact.id}>{fact.label} · {fact.status.replace(/_/g, " ")}</li>)}
            </ul>
            <Button className="w-full" onClick={() => void fillGaps()} disabled={gapBusy}><Sparkles className="size-4" />{gapBusy ? "Verifying and filling…" : "Verify and fill"}</Button>
            {gapApproval !== null && <div className="mt-3 rounded-lg border border-amber-400/60 p-3 text-xs">
              Estimated £{gapApproval.toFixed(3)} exceeds £{AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)}.{" "}
              <Button size="sm" onClick={() => void fillGaps(true)}>Approve this search</Button>
            </div>}
          </Panel>}
          <Panel className="p-4">
            <div className="mb-2 font-medium">Edit with AI</div>
            {!section ? <p className="text-sm text-muted-foreground">Select a section to edit. Ordinary text edits are free — click text on the page.</p> : <>
              <Mono className="text-muted-foreground">Scope: {section.type} section only</Mono>
              <Textarea value={instr} onChange={(e) => setInstr(e.target.value)} rows={3} className="mt-2 text-sm" />
              <Button className="mt-2 w-full" onClick={() => ask()} disabled={busy}><Sparkles className="size-4" />{busy ? "Drafting patch…" : "Propose change"}</Button>
              {editApproval !== null && <div className="mt-3 rounded-lg border border-amber-400/60 p-3 text-xs">
                Estimated £{editApproval.toFixed(3)} exceeds £{AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)}.{" "}
                <Button size="sm" onClick={() => void ask(0, true)}>Approve this edit</Button>
              </div>}
              {proposal && <div className="mt-3 space-y-2 text-xs">
                <div className="rounded bg-destructive/10 p-2 line-through">{section.body}</div>
                <div className="rounded bg-success/10 p-2">{proposal.patch.body}</div>
                <Mono className="text-muted-foreground">Claude · {proposal.tokens} tokens · {proposal.notes}</Mono>
                <div className="flex gap-1"><Button size="sm" onClick={() => { commit((ss) => { const target = ss.find((x) => x.id === section.id); if (target) { target.title = proposal.patch.title; target.body = proposal.patch.body; } }); setProposal(undefined); }}>Accept</Button><Button size="sm" variant="outline" onClick={() => setProposal(undefined)}>Reject</Button><Button size="sm" variant="ghost" onClick={() => ask(proposal.attempt + 1)}>Regenerate</Button></div>
              </div>}
            </>}
          </Panel>
          <Panel className="p-4">
            <div className="mb-2 font-medium">Publish to Salt Atlas</div>
            <Mono className="text-primary">saltatlas.com/{page.slug}</Mono>
            <div className="my-3 space-y-1">{checks.map((c) => <div key={c.id} className="flex items-center justify-between text-xs"><span>{c.label}</span><Pill tone={c.ok ? "ok" : c.blocking ? "bad" : "warn"}>{c.ok ? "OK" : "Check"}</Pill></div>)}</div>
            <div className="flex flex-wrap gap-1">
              {page.status === "draft" && <Button size="sm" variant="outline" onClick={() => mutateResort(r.id, (x) => { x.page!.status = "review"; })}>Submit for review</Button>}
              {page.status === "review" && <Button size="sm" variant="outline" onClick={() => mutateResort(r.id, (x) => { x.page!.status = "approved"; })}>Approve</Button>}
              <Button size="sm" disabled={blocked || page.status !== "approved" || !!deploy} onClick={publish}><Rocket className="size-3" />{page.history.length ? "Update existing page" : "Publish new page"}</Button>
            </div>
            {deploy && <div className="mt-2 text-xs text-primary">{deploy}</div>}
            {blocked && <p className="mt-2 text-xs text-destructive">Blocking checks must pass before publishing.</p>}
            <div className="mt-3 space-y-1">{page.history.map((h) => <div key={h.id} className="text-xs"><Mono>{h.at} · v{h.version}</Mono> {h.action}</div>)}</div>
            <div className="mt-2 space-y-1">{page.versions.map((v) => <button key={v.id} className="block text-xs text-muted-foreground hover:text-foreground" onClick={() => commit((ss) => { ss.splice(0, ss.length, ...structuredClone(v.sections)); })}>Restore v{v.number} · {v.savedAt}</button>)}</div>
          </Panel>
        </div>
      </div>
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto p-0">
          <DialogTitle className="sr-only">Website preview</DialogTitle>
          <div className="sticky top-0 z-10 flex gap-1 border-b bg-card p-2">{(["desktop", "mobile"] as const).map((d) => <Button key={d} size="sm" variant={device === d ? "default" : "ghost"} onClick={() => setDevice(d)}>{d}</Button>)}<Button size="sm" variant="outline" className="ml-auto" onClick={() => setPreview(false)}>Back to editing</Button></div>
          <div className="mx-auto" style={{ maxWidth: WIDTH[device] }}><ResortPageView sections={page.sections} /></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResortPageView({ sections, editable, selected, onSelect, onEdit, highlight }: { sections: PageSection[]; editable?: boolean; selected?: string | undefined; onSelect?: (id: string) => void; onEdit?: (id: string, f: "title" | "body", v: string) => void; highlight?: string | undefined }) {
  const T = ({ s, f, className }: { s: PageSection; f: "title" | "body"; className?: string }) => (
    <div className={className} contentEditable={editable} suppressContentEditableWarning onBlur={(e) => { const v = e.currentTarget.textContent ?? ""; if (v !== s[f]) onEdit?.(s.id, f, v); }}>{s[f]}</div>
  );
  return (
    <div className="bg-shell text-deep">
      {sections.filter((s) => s.visible).map((s) => (
        <section key={s.id} onClick={() => onSelect?.(s.id)} className={cn("relative", editable && "cursor-pointer outline-offset-[-2px] hover:outline hover:outline-1 hover:outline-sky", selected === s.id && "outline outline-2 outline-primary", highlight === s.type && "ring-4 ring-inset ring-warning")}>
          {s.type === "hero" ? (
            <div className="relative min-h-[420px] overflow-hidden bg-deep text-shell">
              {s.image && <img src={s.image} alt="" className="absolute inset-0 h-full w-full object-cover opacity-75" />}
              <div className="absolute inset-0 bg-gradient-to-t from-deep via-deep/30" />
              <div className="relative flex min-h-[420px] flex-col justify-end p-8">
                <div className="font-mono text-xs uppercase tracking-widest text-sky">{s.eyebrow}</div>
                <T s={s} f="title" className="mt-2 text-4xl font-semibold" />
                <T s={s} f="body" className="mt-2 max-w-lg text-shell/80" />
                {s.cta && <span className="mt-4 w-fit rounded bg-primary px-4 py-2 text-sm text-primary-foreground">{s.cta.label}</span>}
              </div>
            </div>
          ) : (
            <div className="px-8 py-10">
              {s.eyebrow && <div className="eyebrow mb-1">{s.eyebrow}</div>}
              <T s={s} f="title" className="text-2xl font-semibold" />
              {s.body && <T s={s} f="body" className="mt-2 max-w-2xl text-[15px] text-muted-foreground" />}
              {s.items.length > 0 && <div className={cn("mt-5 grid gap-3", s.type === "mosaic" ? "grid-cols-2 md:grid-cols-4" : "md:grid-cols-3")}>
                {s.items.map((it) => s.type === "mosaic" ? <img key={it.id} src={it.image} alt={it.title} className="aspect-square w-full rounded object-cover" loading="lazy" /> : (
                  <div key={it.id} className="rounded-lg bg-card p-4 ring-1 ring-mist">
                    {it.image && <img src={it.image} alt="" className="mb-3 aspect-video w-full rounded object-cover" loading="lazy" />}
                    <div className="font-medium">{it.title}</div>
                    {it.meta && <div className="font-mono text-lg text-primary">{it.meta}</div>}
                    {it.body && <div className="text-sm text-muted-foreground">{it.body}</div>}
                  </div>))}
              </div>}
              {s.image && s.type !== "mosaic" && <img src={s.image} alt="" className="mt-5 aspect-[21/9] w-full rounded-lg object-cover" loading="lazy" />}
              {s.cta && <span className="mt-4 inline-block rounded bg-primary px-4 py-2 text-sm text-primary-foreground">{s.cta.label}</span>}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
