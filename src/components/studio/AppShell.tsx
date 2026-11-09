import { Link, useRouterState } from "@tanstack/react-router";
import {
  BrainCircuit,
  Compass,
  Download,
  LayoutGrid,
  Menu,
  MessageSquare,
  Moon,
  PenTool,
  ScanSearch,
  Sun,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { studioGateStatus, unlockStudio } from "@/lib/studio-gate";
import { cn } from "@/lib/utils";
import { useStudio } from "@/lib/store";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutGrid, n: "" , stage: null },
  { to: "/ops", label: "CEO · Agent operations", icon: BrainCircuit, n: "", stage: null },
  { to: "/pipeline", label: "Pipeline", icon: MessageSquare, n: "", stage: null },
  { to: "/discover", label: "Discover", icon: Compass, n: "01", stage: "discover" },
  { to: "/scrape", label: "Scrape", icon: Download, n: "02", stage: "scrape" },
  { to: "/research", label: "Research & Verify", icon: ScanSearch, n: "03", stage: "research" },
  { to: "/studio", label: "Generate, Edit & Publish", icon: PenTool, n: "04", stage: "generate" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { resorts, discoveryResults } = useStudio();
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(true);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  useEffect(() => {
    void studioGateStatus()
      .then((s) => setLocked(!s.unlocked))
      .catch(() => setLocked(true));
  }, []);
  const unlock = async () => {
    setUnlocking(true);
    try {
      await unlockStudio({ data: { password } });
      setLocked(false);
      setPassword("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unlock failed");
    } finally {
      setUnlocking(false);
    }
  };
  useEffect(() => { setDark(localStorage.getItem("sa-theme") === "dark"); }, []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  const toggle = () => { const d = !dark; setDark(d); localStorage.setItem("sa-theme", d ? "dark" : "light"); };
  const count = (st: string | null) => st === null ? null : st === "discover" ? discoveryResults.length + resorts.filter(r => r.stage === "discover").length : resorts.filter((r) => r.stage === st || (st === "generate" && r.stage === "published")).length;

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-3">
      {NAV.map((item) => {
        const active = item.to === "/" ? path === "/" : path.startsWith(item.to);
        const c = count(item.stage);
        return (
          <Link key={item.to} to={item.to} onClick={() => setOpen(false)}
            className={cn("group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] transition-colors",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground")}>
            {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded bg-sidebar-primary" />}
            <item.icon className={cn("size-4", active ? "text-sidebar-primary" : "opacity-70")} />
            <span className="flex-1">{item.label}</span>
            {item.n && <span className="font-mono text-[10px] opacity-50">{c ?? ""}</span>}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-sidebar py-6 text-sidebar-foreground transition-transform lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="mb-8 px-6">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-md bg-ocean-gradient ring-1 ring-sidebar-border">
              <svg viewBox="0 0 24 24" className="size-4 text-sidebar-primary" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 15c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3" /><path d="M2 19c2.5 0 2.5-3 5-3s2.5 3 5 3 2.5-3 5-3 2.5 3 5 3" opacity=".5" /></svg>
            </div>
            <div>
              <div className="text-[15px] font-semibold tracking-tight text-sidebar-accent-foreground">Salt Atlas</div>
              <div className="font-mono text-[9.5px] uppercase tracking-[0.2em] opacity-55">Resort Studio</div>
            </div>
          </div>
        </div>
        <div className="eyebrow mb-2 px-6 !text-sidebar-foreground/40">Workflow</div>
        {nav}
        <div className="mx-3 mt-4 space-y-3 rounded-lg border border-sidebar-border p-3 text-[11.5px] leading-relaxed text-sidebar-foreground/60">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-sidebar-primary"><span className="size-1.5 animate-pulse rounded-full bg-sidebar-primary" />{locked ? "Locked" : "Unlocked"}</div>
          Paid Claude, search, and new scrapes need the studio password. Publishing stays simulated.
        </div>
        <button onClick={toggle} className="mx-6 mt-4 flex items-center gap-2 text-xs text-sidebar-foreground/60 hover:text-sidebar-accent-foreground">
          {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />} {dark ? "Light" : "Dark"} mode
        </button>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-foreground/30 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/85 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <span className="font-semibold">Salt Atlas Studio</span>
        </header>
        {locked && (
          <form
            className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void unlock();
            }}
          >
            <span className="text-sm text-muted-foreground">Unlock the studio before live research.</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Studio password"
              className="max-w-xs"
              autoComplete="current-password"
            />
            <Button type="submit" disabled={unlocking || !password.trim()}>
              {unlocking ? "Checking…" : "Unlock"}
            </Button>
          </form>
        )}
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
