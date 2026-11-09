import type { WccPage } from "./wcc-types";

function host(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Pages from a crawl that genuinely belong to these source URLs (same URL prefix or same host).
 * Returns [] when the crawl is for some other site. Use this anywhere a result is LINKED to a resort or
 * fed to the Reviewer: text from another resort's website must never be treated as this resort's evidence.
 */
export function strictPagesForSources(sources: { url: string }[], pages: WccPage[]): WccPage[] {
  if (!pages.length) return [];
  const prefixes = sources.map((s) => s.url.replace(/\/$/, "")).filter(Boolean);
  const hosts = new Set(prefixes.map(host).filter(Boolean));
  const matched = pages.filter((page) => {
    const url = page.url.replace(/\/$/, "");
    if (prefixes.some((start) => url === start || url.startsWith(`${start}/`) || start.startsWith(url))) return true;
    const pageHost = host(page.url);
    return Boolean(pageHost && hosts.has(pageHost));
  });
  const withText = matched.filter((page) => (page.markdown ?? page.text ?? "").trim().length > 0);
  return withText.length ? withText : matched;
}

/**
 * DISPLAY ONLY (crawl boards): like the strict match, but when nothing matches it returns the run's pages
 * so the text is not hidden. Never use this to link a run to a resort or to feed an agent.
 */
export function pagesForSources(sources: { url: string }[], pages: WccPage[]): WccPage[] {
  if (!pages.length) return [];
  const matched = strictPagesForSources(sources, pages);
  const chosen = matched.length ? matched : pages;
  const withText = chosen.filter((page) => (page.markdown ?? page.text ?? "").trim().length > 0);
  return withText.length ? withText : chosen;
}
