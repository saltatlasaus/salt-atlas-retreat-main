import { getScrapeStorage } from "./scrape-storage";
import { strictPagesForSources } from "./scrape-match";

const SUCCEEDED = "SUCCEEDED";

/**
 * Latest finished crawl that contains a page from this resort's own source URLs / host.
 * Strict on purpose: the lenient display matcher returns every page when nothing matches, which made any
 * resort "match" the newest crawl of an unrelated site.
 */
export async function resolveScrapeRunIdForSources(sources: { url: string }[]): Promise<string | undefined> {
  if (!sources.length) return undefined;
  const storage = getScrapeStorage();
  const runs = (await storage.listRuns())
    .filter((run) => run.status === SUCCEEDED && (run.itemCount > 0 || run.simulated))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const run of runs) {
    const pages = await storage.getPages(run.id);
    const matched = strictPagesForSources(sources, pages);
    if (matched.length > 0) return run.id;
  }
  return undefined;
}
