/** Seeded studio demo. The prompt pipeline keeps its own durable rows in D1.
 *  Client: full state persists to localStorage so CEO / Research / Studio survive refresh and navigation. */
import { useSyncExternalStore } from "react";
import type { AppState, Resort } from "./types";
import { seedState } from "./mock-data";
import { newPage } from "./page-gen";

const STUDIO_STORAGE_KEY = "salt-atlas-studio-state-v1";

function loadPersistedState(): AppState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STUDIO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (!Array.isArray(o["competitors"]) || !Array.isArray(o["resorts"]) || !Array.isArray(o["discoveryResults"])) return null;
    return parsed as AppState;
  } catch {
    return null;
  }
}

function persistState(next: AppState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STUDIO_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[store] localStorage persist failed", err);
  }
}

function initial(): AppState {
  const s = seedState();
  const get = (id: string) => s.resorts.find((r) => r.id === id)!;
  const w = get("weligama");
  w.page = newPage(w);
  const t = get("thulus");
  t.page = { ...newPage(t), status: "approved" };
  const a = get("anchor");
  a.page = newPage(a);
  a.page.status = "live";
  a.page.publishedVersion = 1;
  a.page.history = [{ id: "h1", at: "2026-09-14 10:02", action: "Published new page (simulated)", version: 1, url: "https://saltatlas.com/morocco/anchor-bay-surf-house", simulated: true }];
  // Research has since changed the 7-night price -> affected section flagged.
  const price = a.facts.find((f) => f.id === "anchor-price7")!;
  price.candidates.unshift({ id: "c-new", value: "€1,290", sourceUrl: "https://anchor-bay-surf-house.com/packages-2027", sourceType: "official", checkedAt: "2026-11-04" });
  price.selected = "€1,290";
  price.selectedCandidateId = "c-new";
  price.reason = "Resort published 2027 rates on 4 Nov 2026.";
  a.page.pendingFactChanges = ["anchor-price7"];
  for (const r of [w, t, a]) r.page!.versions[0]!.savedAt = "2026-11-03 09:12";
  return s;
}

/** SSR / first paint: seeded demo. Client after microtask: may replace with localStorage. */
const serverStateSnapshot: AppState = initial();
let state: AppState = structuredClone(serverStateSnapshot);
const listeners = new Set<() => void>();
let hydrated = false;

function applyHydrationFromStorage() {
  if (typeof window === "undefined" || hydrated) return;
  hydrated = true;
  const persisted = loadPersistedState();
  if (persisted) {
    state = persisted;
    listeners.forEach((l) => l());
  }
}

function scheduleHydration() {
  if (typeof window === "undefined" || hydrated) return;
  queueMicrotask(() => applyHydrationFromStorage());
}

export function getState() {
  return state;
}
export function mutate(fn: (draft: AppState) => void) {
  applyHydrationFromStorage();
  const next = structuredClone(state);
  fn(next);
  state = next;
  persistState(state);
  listeners.forEach((l) => l());
}
export function mutateResort(id: string, fn: (r: Resort) => void) {
  mutate((s) => {
    const r = s.resorts.find((x) => x.id === id);
    if (r) fn(r);
  });
}
function subscribe(l: () => void) {
  scheduleHydration();
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStudio() {
  return useSyncExternalStore(subscribe, getState, () => serverStateSnapshot);
}
export function useResort(id?: string) {
  const s = useStudio();
  return s.resorts.find((r) => r.id === id);
}
