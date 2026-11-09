import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Copy, Globe, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ActivityLog, Mono, PageHeader, Panel, Pill, SourceTag } from "@/components/studio/ui-bits";
import { DESTINATIONS } from "@/lib/mock-data";
import { ApprovalRequired, discoveredResorts, activeCompetitors, invokeAgent } from "@/lib/agents/agent-client";
import { AGENT_PER_CALL_APPROVAL_GBP_DEFAULT } from "@/lib/agents/spend-limits";
import { mutate, useStudio } from "@/lib/store";

import { cn } from "@/lib/utils";

export const Route = createFileRoute("/discover")({
  validateSearch: (s: Record<string, unknown>): { resort?: string } => (s["resort"] ? { resort: String(s["resort"]) } : {}),
  head: () => ({ meta: [
    { title: "Discover — Salt Atlas Resort Studio" },
    { name: "description", content: "Research which surf resorts and official websites to scrape across competitor listings." },
    { property: "og:title", content: "Discover resorts — Salt Atlas" },
    { property: "og:description", content: "AI-assisted competitor and official-site discovery." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Discover,
});


function Discover() {
  const { competitors, discoveryResults, resorts } = useStudio();
  const nav = useNavigate();
  const [country, setCountry] = useState("Indonesia");
  const [region, setRegion] = useState("Mentawai Islands");
  const [comps, setComps] = useState<string[]>(["awave", "worldsurfaris", "tpw"]);
  const [instruction, setInstruction] = useState("Find all surf resorts in the Mentawai Islands listed by our competitors, identify their official websites and prepare the relevant URLs for scraping.");
  const [url, setUrl] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [newComp, setNewComp] = useState("");
  const [costApproval, setCostApproval] = useState<number | null>(null);

  const run = async (approveOverBudget = false) => {
    setRunning(true); setCostApproval(null); setLog(["Scout: finding candidate source URLs (no crawl)…"]);
    try {
      const input = {
        country, region, instruction, ...(url.trim() ? { optionalUrl: url.trim() } : {}),
        competitors: activeCompetitors(competitors, comps), knownResortNames: resorts.map((r) => r.name),
      };
      const reply = await invokeAgent({ kind: "scout", input, approveOverBudget });
      const found = discoveredResorts(reply.data, input);
      mutate((s) => { s.discoveryResults = found; });
      setPicked(new Set(found.filter((r) => !r.knownBefore).map((r) => r.id)));
      setLog((l) => [...l, `Scout returned ${found.length} resort candidates; review identity and sources before crawling.`,
        `Claude cost estimated £${reply.usage.estimatedCostGbp.toFixed(3)}; actual £${(reply.usage.actualCostGbp ?? 0).toFixed(3)}.`,
        ...reply.warnings]);
    } catch (error) {
      if (error instanceof ApprovalRequired) {
        setCostApproval(error.estimatedCostGbp);
        setLog((l) => [...l, error.message]);
      } else {
        setLog((l) => [...l, `Discovery failed: ${error instanceof Error ? error.message : String(error)}`]);
        toast.error("Scout discovery failed — see activity log");
      }
    } finally { setRunning(false); }
  };

  const toggleSource = (rid: string, sid: string) => mutate((s) => {
    const src = s.discoveryResults.find((r) => r.id === rid)?.sources.find((x) => x.id === sid);
    if (src) src.selected = !src.selected;
  });

  const send = () => {
    const chosen = discoveryResults.filter((r) => picked.has(r.id));
    mutate((s) => {
      for (const r of chosen) {
        if (s.resorts.some((x) => x.name === r.name)) continue;
        s.resorts.push({ ...r, id: r.id.replace(/^d-/, ""), stage: "scrape", sources: r.sources.filter((x) => x.selected) });
      }
      s.discoveryResults = s.discoveryResults.filter((r) => !picked.has(r.id));
    });
    toast.success(`${chosen.length} resorts sent to Scrape`);
    nav({ to: "/scrape" });
  };

  const addComp = () => {
    if (!newComp.trim()) return;
    const domain = newComp.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    mutate((s) => { s.competitors.push({ id: domain, name: domain, domain }); });
    setComps((c) => [...c, domain]); setNewComp("");
  };

  return (
    <div className="mx-auto max-w-[1320px] px-5 py-8 md:px-10 md:py-10">
      <PageHeader eyebrow="Stage 01" title="Discover" crumbs={[{ label: "Discover" }]}
        description="Plan which competitor pages and official resort websites are worth scraping — before a single Apify request is made." />

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <Panel className="h-fit p-5 lg:sticky lg:top-6">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country">
                <Select value={country} onValueChange={(v) => { setCountry(v); setRegion(DESTINATIONS.find((d) => d.country === v)!.regions[0] ?? ""); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{DESTINATIONS.map((d) => <SelectItem key={d.country} value={d.country}>{d.country}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Region">
                <Select value={region} onValueChange={setRegion}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{DESTINATIONS.find((d) => d.country === country)!.regions.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>
            <Field label={`Competitors · ${comps.length} selected`}>
              <div className="flex flex-wrap gap-1.5">
                {competitors.map((c) => {
                  const on = comps.includes(c.id);
                  return (
                    <button key={c.id} onClick={() => setComps((x) => on ? x.filter((y) => y !== c.id) : [...x, c.id])}
                      className={cn("rounded-full border px-2.5 py-1 text-xs transition", on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:border-primary/50")}>
                      {c.name}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex gap-2">
                <Input value={newComp} onChange={(e) => setNewComp(e.target.value)} placeholder="Add competitor domain" className="h-8 font-mono text-xs" />
                <Button size="sm" variant="outline" onClick={addComp}><Plus className="size-3.5" /></Button>
              </div>
            </Field>
            <Field label="Research instruction">
              <Textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={4} className="text-[13px]" />
            </Field>
            <Field label="Specific competitor URL (optional)">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="font-mono text-xs" />
            </Field>
            <Button className="w-full" onClick={() => void run()} disabled={running || !comps.length}>
              <Sparkles className="size-4" /> {running ? "Researching…" : "Start discovery"}
            </Button>
            {costApproval !== null && <div className="rounded-lg border border-amber-400/60 bg-amber-50 p-3 text-xs text-amber-950">
              <p>
                Estimated Claude cost £{costApproval.toFixed(3)}, above £
                {AGENT_PER_CALL_APPROVAL_GBP_DEFAULT.toFixed(2)} per-call limit.
              </p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void run(true)} disabled={running}>Approve this call</Button>
            </div>}
            {log.length > 0 && <div className="rounded-lg bg-muted/60 p-3"><ActivityLog lines={log} running={running} /></div>}
          </div>
        </Panel>

        <div>
          {discoveryResults.length === 0 ? (
            <Panel className="grid min-h-[420px] place-items-center p-10 text-center">
              <div>
                <Globe className="mx-auto size-8 text-muted-foreground" />
                <div className="mt-3 font-medium">No discovery results yet</div>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Choose a destination and competitors, then start a discovery to see candidate resorts and their source URLs.</p>
              </div>
            </Panel>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 text-sm">
                  <Checkbox checked={picked.size === discoveryResults.length} onCheckedChange={(c) => setPicked(c ? new Set(discoveryResults.map((r) => r.id)) : new Set())} />
                  <span><Mono>{picked.size}</Mono> of <Mono>{discoveryResults.length}</Mono> selected</span>
                </div>
                <Button onClick={send} disabled={!picked.size}>Send to Scrape <ArrowRight className="size-4" /></Button>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {discoveryResults.map((r) => {
                  const on = picked.has(r.id);
                  return (
                    <Panel key={r.id} className={cn("p-5 transition", on && "ring-2 ring-primary/50")}>
                      <div className="flex items-start gap-3">
                        <Checkbox checked={on} className="mt-1" onCheckedChange={() => setPicked((p) => { const n = new Set(p); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold">{r.name}</span>
                            {r.knownBefore && <Pill tone="info"><Check className="size-3" />Already in Salt Atlas</Pill>}
                            {r.duplicateOf && <Pill tone="warn"><Copy className="size-3" />Possible duplicate</Pill>}
                            {!r.knownBefore && !r.duplicateOf && <Pill tone="ok">New</Pill>}
                          </div>
                          <div className="text-xs text-muted-foreground">{r.destination} · listed by {r.competitors.length} competitor{r.competitors.length > 1 ? "s" : ""}</div>
                          {r.identityNote && <p className="mt-2 rounded-md bg-warning/10 p-2 text-xs">{r.identityNote}</p>}
                          <div className="mt-3 text-[11px] text-muted-foreground">Suggested official site</div>
                          <Mono className="text-primary">{r.officialUrl}</Mono>
                          <div className="mt-3 space-y-1.5">
                            {r.sources.map((s) => (
                              <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted/60">
                                <Checkbox checked={s.selected} onCheckedChange={() => toggleSource(r.id, s.id)} className="size-3.5" />
                                <SourceTag t={s.type} />
                                <Mono className="truncate text-muted-foreground">{s.url.replace("https://", "")}</Mono>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    </Panel>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="eyebrow mb-1.5">{label}</div>{children}</div>;
}
