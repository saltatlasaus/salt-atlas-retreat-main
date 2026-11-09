import { describe, expect, it } from "vitest";
import { pagesForSources, strictPagesForSources } from "./scrape-match";
import { resolveScrapeRunIdForSources } from "./scrape-resolve";
import { localScrapeStorage } from "./scrape-storage";
import type { WccPage, ScrapeRunRecord } from "./wcc-types";

const lamangata: WccPage = { url: "https://lamangata.com/", markdown: "# Lamangata Luxury Surf Resort\n".repeat(20) };
const witchsRock: WccPage = { url: "https://www.witchsrocksurfcamp.com/rates", markdown: "# Rates\nBoard rental included.\n".repeat(10) };

describe("strictPagesForSources", () => {
  it("returns nothing when the crawl is for a different website", () => {
    expect(strictPagesForSources([{ url: "https://witchsrocksurfcamp.com" }], [lamangata])).toEqual([]);
  });

  it("matches the resort's own pages by prefix or host, ignoring www", () => {
    const got = strictPagesForSources([{ url: "https://witchsrocksurfcamp.com" }], [lamangata, witchsRock]);
    expect(got).toEqual([witchsRock]);
  });

  it("display matcher still falls back to the run's pages, strict never does", () => {
    const sources = [{ url: "https://witchsrocksurfcamp.com" }];
    expect(pagesForSources(sources, [lamangata])).toEqual([lamangata]);
    expect(strictPagesForSources(sources, [lamangata])).toEqual([]);
  });
});

describe("resolveScrapeRunIdForSources", () => {
  const run = (id: string, startedAt: string): ScrapeRunRecord => ({
    id, apifyRunId: id, status: "SUCCEEDED", startedAt, itemCount: 1, simulated: false,
    input: { startUrls: [] } as unknown as ScrapeRunRecord["input"],
  });

  it("does not link a resort to the newest crawl of an unrelated site", async () => {
    await localScrapeStorage.saveRun(run("run_lamangata", "2026-11-06T15:25:20.000Z"));
    await localScrapeStorage.savePages("run_lamangata", [lamangata]);
    const id = await resolveScrapeRunIdForSources([{ url: "https://witchsrocksurfcamp.com" }]);
    expect(id).toBeUndefined();
  });

  it("links to the run that actually contains the resort, even when a newer unrelated run exists", async () => {
    await localScrapeStorage.saveRun(run("run_witch", "2026-11-06T10:00:00.000Z"));
    await localScrapeStorage.savePages("run_witch", [witchsRock]);
    const id = await resolveScrapeRunIdForSources([{ url: "https://witchsrocksurfcamp.com" }]);
    expect(id).toBe("run_witch");
  });
});
