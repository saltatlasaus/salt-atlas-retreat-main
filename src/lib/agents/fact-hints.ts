/**
 * Field-aware evidence selection shared by the Reviewer (/ops) and the /pipeline orchestrator.
 *
 * Goal: when the crawl returns many pages, make sure every OPEN field has at least one page that is
 * likely to answer it in the prompt, keep the useful lines of long pages (not just the head), and hand
 * the model regex "leads" for needle-in-haystack fields (email, price, airport…).
 *
 * Everything returned is a substring of the cleaned page text, so quote validation still passes.
 */
import { cleanPageText } from "../page-text";
import type { WccPage } from "../wcc-types";

export interface FactHint {
  /** Tested against pathname + search of the page URL. */
  path?: RegExp;
  /** Tested against single lines of cleaned page text. */
  text?: RegExp;
}

const SURF_PATH = /surf|wave|break|swell|spot|coast|beach|reef|point|line-?up|playa|forecast|guid(e|ing)|conditions|ability|beginner|intermediate|advanced/i;
const SURF_TEXT = /\b(surf|waves?|break|swell|reef|point|beach|beginner|intermediate|advanced|off-?season|peak\s*season|high season|low season)\b/i;
const ROOM_PATH = /room|accommodation|stay|villa|bungalow|suite|lodging|lodge|bed|where-to-stay/i;
const GETTING_PATH = /getting|travel|how-to|location|transfer|direction|airport|arriv|contact|find-us|map/i;
const PRICE_PATH = /pricing|rates?|packages?|book(ing)?|stay|accommodation|surf.?camp|offer|special|tarif|deal|promo/i;

/** Currency amounts or night-based promos. */
const PRICE_TEXT =
  /(?:[$€£]|\b(?:USD|EUR|GBP|CRC)\b)\s?\d|\d\s?(?:USD|EUR|GBP)\b|\bnights?\b[^.\n]*\bfree\b|promo(?:tion)?\s*code|valid\s+(?:through|until|for stays)|per\s+(?:night|person)|\bpp\b/i;

export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(?:.*\.)?(?:example\.(?:com|org)|sentry\.io|wixpress\.com|domain\.com|email\.com)$|^(?:you|your|name|user|email)@/i;

/** Keys match FIELD_SPECS in mock-data.ts. */
export const FACT_HINTS: Record<string, FactHint> = {
  tagline: { path: /^\/?$|about|story|welcome|home/i },
  summary: { path: /^\/?$|about|story|welcome|home|the-camp|resort/i },
  break: { path: SURF_PATH, text: SURF_TEXT },
  waveType: { path: SURF_PATH, text: /\b(reef|point|beach\s*break|rivermouth|left|right|barrel|peeler|fast|mellow|gentle|hollow)\b/i },
  season: { path: SURF_PATH, text: /\b(season|swell|months?|january|february|march|april|may|june|july|august|september|october|november|december|dry|wet|rainy)\b/i },
  level: { path: SURF_PATH, text: /\b(beginner|intermediate|advanced|all levels|all abilities|expert|novice|improver)\b/i },
  rooms: { path: ROOM_PATH, text: /\b(rooms?|suites?|villas?|bungalows?|dorms?|ensuite|en-suite|air.?con|bunk|private)\b/i },
  capacity: { path: ROOM_PATH, text: /\b\d+\s*(?:guests?|people|persons|pax|beds?)\b|\bsleeps?\s*\d+|\bcapacity\b|\bmax(?:imum)?\s*(?:of\s*)?\d+/i },
  price7: { path: PRICE_PATH, text: PRICE_TEXT },
  inclusions: { path: PRICE_PATH, text: /\b(includ\w*|all.?inclusive|package|free|complimentary|every full day)\b/i },
  meals: { path: /food|dining|meal|restaurant|menu|cuisine|kitchen|eat/i, text: /\b(breakfast|lunch|dinner|meals?|vegetarian|vegan|chef|buffet|half.?board|full.?board)\b/i },
  wellness: { path: /wellness|spa|yoga|massage|health|fitness|relax/i, text: /\b(yoga|spa|massage|sauna|wellness|pilates|meditation|ice bath|gym)\b/i },
  airport: { path: GETTING_PATH, text: /\bairport\b|\bairfield\b|\([A-Z]{3}\)/ },
  transfer: { path: GETTING_PATH, text: /\b(transfers?|shuttle|pick.?up|taxi|boat|minutes?\s+(?:from|by|drive)|hours?\s+(?:from|by|drive)|bus)\b/i },
  activities: { path: /activit|experience|adventure|tour|excursion|things-to-do|yoga|extras/i, text: /\b(zip.?line|hike|hiking|tours?|kayak|snorkel|div(?:e|ing)|horse|sup|paddle|fishing|rafting|waterfall|adventure)\b/i },
  photos: { path: /photo|gallery|media|press|terms|policy|legal|faq/i, text: /\b(photograph\w*|photos?|videos?|drone|gopro|imagery|usage rights|copyright|licen[sc]e)\b/i },
  boards: { path: /board|rental|hire|faq|gear|equipment|surf/i, text: /\b(board (?:hire|rental)|rent(?:al)?\s+boards?|surfboards?|longboards?|foam(?:ie|board)s?|soft.?top|wetsuits?)\b/i },
  email: { path: /contact|book|reserv|enquir|inquir|about|faq|find-us/i, text: EMAIL_RE },
};

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function pageText(page: WccPage): string {
  return cleanPageText(page.markdown ?? page.text ?? "");
}

/** How likely this page is to answer one field (0 = no signal). */
export function keyScore(page: WccPage, key: string, text = pageText(page)): number {
  const hint = FACT_HINTS[key];
  if (!hint) return 0;
  let score = 0;
  if (hint.path?.test(pathOf(page.url))) score += 3000;
  if (hint.text) {
    let hits = 0;
    for (const line of text.split("\n")) if (hint.text.test(line)) hits++;
    score += Math.min(2500, hits * 250);
  }
  return score;
}

/**
 * Coverage-first page choice: best page for every open field, then fill remaining slots by the
 * caller's ranking. `ranked` must already be sorted best-first.
 */
export function pickPagesForFacts(ranked: WccPage[], keys: string[], limit: number): WccPage[] {
  const chosen = new Set<WccPage>();
  const texts = new Map<WccPage, string>(ranked.map((p) => [p, pageText(p)]));
  for (const key of keys) {
    if (chosen.size >= limit) break;
    let best: WccPage | undefined;
    let bestScore = 0;
    for (const page of ranked) {
      const s = keyScore(page, key, texts.get(page));
      if (s > bestScore) {
        best = page;
        bestScore = s;
      }
    }
    if (best) chosen.add(best);
  }
  for (const page of ranked) {
    if (chosen.size >= limit) break;
    chosen.add(page);
  }
  return ranked.filter((p) => chosen.has(p));
}

/**
 * Keep up to `max` chars of an already-cleaned page: the head, the tail (footer/contact), and the lines
 * (±1) that match an open field. Original order is preserved; skipped runs are marked with "…".
 */
export function focusExcerpt(cleaned: string, keys: string[], max: number): string {
  if (cleaned.length <= max) return cleaned;
  const lines = cleaned.split("\n").map((l) => (l.length > 600 ? l.slice(0, 600) : l));
  const hints = keys.map((k) => FACT_HINTS[k]?.text).filter((r): r is RegExp => !!r);
  const keep = new Set<number>();
  let used = 0;
  const add = (i: number, cap: number) => {
    if (i < 0 || i >= lines.length || keep.has(i)) return true;
    const cost = lines[i]!.length + 1;
    if (used + cost > cap) return false;
    keep.add(i);
    used += cost;
    return true;
  };
  const headCap = Math.floor(max * 0.4);
  for (let i = 0; i < lines.length && add(i, headCap); i++);
  const tailCap = headCap + Math.floor(max * 0.12);
  for (let i = lines.length - 1; i >= 0 && add(i, tailCap); i--);
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i) || !hints.some((r) => r.test(lines[i]!))) continue;
    for (const j of [i - 1, i, i + 1]) if (!add(j, max)) break;
  }
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push("…");
    out.push(lines[i]!);
    prev = i;
  }
  return out.join("\n");
}

export interface Lead {
  key: string;
  url: string;
  line: string;
}

const LEAD_CAP: Record<string, number> = { email: 4, price7: 5, inclusions: 3 };
const LEAD_LINE_MAX = 240;

function emailsIn(line: string): string[] {
  return (line.match(new RegExp(EMAIL_RE.source, "gi")) ?? []).filter((e) => !BAD_EMAIL.test(e));
}

/**
 * Regex-found lines per open field, taken verbatim from page text. They are starting points only —
 * the model must still quote the sentence that answers the field.
 */
export function extractLeads(pages: WccPage[], keys: string[], opts: { max?: number; officialHost?: string } = {}): Lead[] {
  const max = opts.max ?? 30;
  const host = opts.officialHost?.replace(/^www\./, "").toLowerCase();
  const out: Lead[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const hint = FACT_HINTS[key];
    if (!hint?.text) continue;
    const found: Lead[] = [];
    for (const page of pages) {
      for (const raw of pageText(page).split("\n")) {
        const line = raw.trim();
        if (line.length < 12 || line.length > LEAD_LINE_MAX * 2) continue;
        if (key === "email" ? !emailsIn(line).length : !hint.text.test(line)) continue;
        const id = `${key}|${line}`;
        if (seen.has(id)) continue;
        seen.add(id);
        found.push({ key, url: page.url, line: line.slice(0, LEAD_LINE_MAX) });
      }
    }
    // For email, an address on the resort's own domain beats a third-party one.
    if (key === "email" && host) {
      const own = (l: Lead) => (emailsIn(l.line).some((e) => e.toLowerCase().endsWith(`@${host}`) || e.toLowerCase().endsWith(`.${host}`)) ? 1 : 0);
      found.sort((a, b) => own(b) - own(a));
    }
    out.push(...found.slice(0, LEAD_CAP[key] ?? 2));
  }
  return out.slice(0, max);
}
