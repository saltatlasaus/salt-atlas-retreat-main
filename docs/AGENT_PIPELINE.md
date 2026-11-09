# Salt Atlas — CEO agent pipeline

This branch implements the **first server-side agent wiring** on top of the existing TanStack Start + Apify + Cloudflare code. The existing four detailed pages remain intact. The new `/ops` page provides one human-supervised command surface.

## Agent roles and handoffs

| Role | Entry point | Output | Guard |
| --- | --- | --- | --- |
| Scout | `executeAgent({kind:"scout"})` | Candidates, planned competitor and official source URLs | Claude web search URLs only; human checks identity |
| Apify crawler | `createScrapeRun` | Dataset in R2/D1 with per-URL content | Not Claude; actual WCC actor; no fabricated extraction |
| Reviewer | `executeAgent({kind:"reviewer"})` | Source-quoted fact candidates, gaps, exclusivity recommendation | Match quote to saved scraped text; human exclusivity decision |
| HTML Writer | `executeAgent({kind:"writer"})` | JSON title/body per existing section ID | Uses selected facts; section IDs and fact IDs validated |
| Visual editor | `executeAgent({kind:"editor"})` | Single-section title/body patch | Human accepts; layout/HTML/CSS untouched |

The CEO is an orchestrator, **not another scraper**. Its controls call the same operations used by the detailed pages.

## Models per role

Defined in `src/lib/agents/models.ts`. **Every role runs on `ANTHROPIC_MODEL` (Haiku) by default**, so the model cost profile is unchanged. Extraction quality comes from the context work below, not a bigger model.

A bigger model is strictly opt-in: `ANTHROPIC_MODEL_STRONG` moves Scout, Search, Reviewer, Writer and the `/pipeline` orchestrator together (the Editor stays on the fast model), and `ANTHROPIC_MODEL_<ROLE>` pins a single role. Spend tracking and the per-call approval gate price each call by the model that answered; the Sonnet/Opus rates in code are rough estimates, so set `CLAUDE_SONNET_*` / `CLAUDE_OPUS_*` if you opt in. A rejected opt-in model id retries once on the fast model instead of failing the run. A stronger model only helps when the evidence is already in the prompt, so try it on one role (the Reviewer) and compare before moving more.

## Extraction path (what each stage hands the next)

1. **Scout** (2 web searches) returns the official URL plus several same-domain URLs (rates, rooms, surf, contact) taken from search evidence.
2. **Crawl** (Apify, `RESORT_CRAWL_PRESET`: depth 2, 35 pages, concurrency 2). One preset is shared by CEO step 2 and the `/pipeline` scrape tool.
3. **Reviewer pass 1 (crawl only, no search spend).** `src/lib/agents/fact-hints.ts` picks, for every *open* field, its best-matching page (so contact and getting-here pages are not crowded out by rates and surf pages), keeps the head, tail and field-relevant lines of long pages inside a 60k-char budget, and passes regex **leads** (email, price/promo lines, airport…) next to the pages. Nothing is rewritten, so quote validation still holds.
4. **Reviewer pass 2 (web search, 2 uses)** runs only for fields pass 1 could not fill. If the search returns no snippets, the crawl-only result is kept and no second model call is spent.
5. **Reviewer pass 3 (surf search, 3 uses)** runs only if break / wave / season / level are still open.
6. **Merge** keeps a fact only if its quote appears in saved page text or a live snippet; a person decides exclusivity.
7. **Writer / Editor** only use selected `verified` / `single` facts.

On `/pipeline`, the orchestrator reads per-target excerpts built the same way and must save facts with the template keys (`Object.keys(FACT_HINTS)`), as verbatim phrases, in one `research` call.

On **`/ops`**, the default is a **manual four-step pipeline** (Discover → Crawl → Verify → Generate HTML): each button runs **one** Scout, Apify, Reviewer, or Writer call. Before step 2, expand **Crawl options** to pick crawler type, depth, page budget, concurrency, timeout, and markdown output (same actor as `/scrape`; the API still applies `constrainCrawl` caps). **Default CEO crawl settings** use **depth 2**, **up to 35 pages**, and **concurrency 2** so one run follows enough internal links to find rates, rooms, surf, and contact — *not* a single start URL at depth 0 (which only loads that one page). Older saved run tabs that still had depth 0 / 8 pages / concurrency 1 are **migrated** to these defaults on load. Scout is instructed to add **multiple official-domain URLs** from search evidence (rates, surf, contact, etc.) so the crawler has strong entry points, which matters when scaling to many resorts. Use **Queue all new** after discovery to enqueue every not-yet-queued candidate, then **Crawl all pending** to run **one Apify run per resort** in sequence (still one polite crawl per site). Optional **“Then auto-run 3”** after a **single-resort** crawl and **“Agentic test: 3 → 4”** chain two steps so you can stress-test automation without hiding individual operations.

If you start a crawl from **`/scrape`** or the **pipeline** (server-side) instead of step 2, **`/ops` still polls the server** for a finished run that matches the resort’s selected URLs and then **writes `runId` onto sources and moves the resort to research** (same linkage as in-session crawls). Thin or empty pages still advance the workflow so you can see the failure path in Research.

**CEO board tabs (center column):** **Pipeline** is steps 1–4 for the selected resort. **Crawl results** lists every resort with linked Apify run ids, groups **all dataset pages per run** (same run = together), and shows a short text snippet per URL. **Verify** lists every resort on **research** (and beyond): **Verify all on research** runs the reviewer once per resort in sequence; each row shows open facts and a link to `/research`. **HTML** lists draft status: “has not been generated” until the Writer has run, then Studio link + section count. The active tab is saved on the **run tab** (`ceoBoardTab` in `salt-atlas-ceo-sessions-v1`).

**Browser persistence (demo studio):** queued resorts, discovery results, pages, and facts are stored in **`localStorage`** (`salt-atlas-studio-state-v1`) so leaving CEO or refreshing does not reset the workflow. Each time you run **step 1**, a new **run tab** is created (`salt-atlas-ceo-sessions-v1`) with its own log stream, instruction block, country/region, selected resort id, crawl options for step 2, CEO board tab, and “auto-verify after crawl” toggle. Switch tabs to revisit earlier 1→4 attempts; remove a tab with **×**. This is per-browser, not shared across devices or team members.

## How to use

1. Copy `.dev.vars.example` to `.dev.vars`; set server secrets there, **never in frontend env variables**.
2. Keep `ENABLE_LIVE_AGENT_CALLS=false` until you have protected the deployment with a real access boundary (Cloudflare Access or equivalent). Otherwise an anonymous visitor could incur paid Claude and search charges.
3. Set `ANTHROPIC_API_KEY`. Discovery uses Claude web search (two searches max). Apify crawls the pages.
4. After access is secured, set `ENABLE_LIVE_AGENT_CALLS=true`. Set `APIFY_TOKEN` separately for live scraping.
5. Open `/ops` to Scout candidates, confirm the resort identity, crawl with Apify, review citations, resolve exclusivity, then generate a section-mapped draft. Open Studio for manual and AI edits.

All Claude agent operations (Discover, Research, Studio editor, `/ops`, and `/pipeline`) stay off while **`ENABLE_LIVE_AGENT_CALLS`** is not `true`. CEO calls also use **`AGENT_PER_CALL_APPROVAL_GBP`** (default **£0.40**) as the estimated per-call preflight review threshold. The `/pipeline` orchestrator uses **`PIPELINE_DAILY_BUDGET_GBP`** (default **£1.00**) per UTC day. Higher CEO estimates require explicit approval in the UI; these are **not guaranteed hard billing caps**, because input token estimation and exchange rates are approximate, and Apify usage is separately billed. Claude web search is part of the Claude bill (capped at two searches per discovery).

Crawl starts go through `constrainCrawl` (depth 3, 50 pages, concurrency 2). Saved pages are flagged with `checkPage`. Pipeline research keeps a fact only when its value appears in usable page text. Pipeline publish moves a draft to **review**; a person approves it on `/pipeline`. That approval still does not deploy the public site. Shared prompt rules live in `src/lib/methodology.ts`. Pipeline targets are mirrored into the D1 `resorts` table (`drizzle/0003_resorts.sql`). The stage pages still use the seeded browser store.

## Evidence safeguards

- Scout only returns URLs found in Claude web search results; candidates are not treated as verified resort identities.
- Scrape → Research now creates **blank template fields**, not fictional example facts.
- **A crawl is only linked to a resort if it contains that resort's own website** (`strictPagesForSources`, same URL prefix or host). Earlier the matcher fell back to "every page in the run" when nothing matched, so the newest crawl of *any* site was attached to a queued resort and the Reviewer read another resort's text. The lenient `pagesForSources` is display-only (crawl boards). If a resort is found linked to a crawl that does not contain its site, CEO step 3 unlinks it, clears the facts read from that crawl, and returns the resort to the crawl step.
- Demo/diagnostic: `src/test/extraction-demo.test.ts` (skipped unless `DEMO_PAGES_JSON` is set) prints what the Reviewer prompt would contain under the old vs new evidence selection for a saved crawl, with no Claude call.
- Reviewer fact additions require a real matching source URL and a quote actually appearing in saved Apify content. The reviewer prompt prioritises **pricing** (`price7`, `inclusions`): page excerpts sent to the model are ranked toward **rates / packages / booking** URLs and lines with currency cues, and Claude’s **gap-fill web search** uses structured tasks (official domain, “7 night”, “per person”, rates pages) instead of a single vague line — capped at 0 + 2 + 3 search tool uses per review (pass 1 is crawl-only; pass 2 searches only the remaining gaps; the surf pass is optional). **Promo copy without a currency** (stay X get Y free, promo code, validity, “rates subject to change”) still counts for **price7** if quoted from the page or snippet.
- If **7-night package (pp)** (`price7`) still has **no** quoted price after merge, the client sets a single **`salt_atlas`** candidate **“Rates on request”** so the slot is not empty forever and completeness can advance; resolve with a real quoted rate when available. The Studio **Surf week** pricing row uses the same tone in copy when no rate is on file (no “[Price — awaiting verification]” in that row).
- Reviewer **web search** tasks spell out **surf / geography**: when **Primary break**, **Wave type**, **Best season**, or **Ability** stay open after the crawl-only pass and the gap search, a **surf-focused** search runs (broader web, named breaks near the destination, surf guides). Page excerpts sent to the model also rank URLs like `/surfing/` and text with surf keywords higher. Snippet-backed quotes still gate facts (see `METHODOLOGY`). Search budget per reviewer run is up to **0 + 2 + 3** tool uses (crawl-only pass, gap pass, optional surf pass).
- Claude's exclusivity recommendation remains **Needs review** until a human records a decision.
- Writer may only edit existing template section IDs using selected referenced fact IDs.
- Editor returns a proposed patch for one section only. Direct visual edits remain AI-free.
- Current public-site publishing continues to be **simulated**; no GitHub or Cloudflare deployment call is triggered by the UI.

## Not yet production-ready

- A durable Cloudflare Workflow with retries/webhooks for long-running operations. Currently `/ops` coordinates on the client and resets on page reload.
- A true per-domain Durable Object crawl gate with daily budgets, spacing, and lock control. The `/ops` flow uses conservative WCC options, but the existing manual WCC form is still configurable.
- Persistent research facts, decisions, approvals and agent traces in D1. Apify datasets/runs already have D1 + R2 adapters.
- Independent second-pass claim/originality check on Writer output, plus approved photo library and exact production HTML template files.
- Real repository publishing and rollback. The existing Studio uses a provisional page template.
- Robust real-world API smoke tests with valid service credentials and a secured environment. Do not mistake seeded UI demo records for verified resort data.

## Main code

- `src/lib/agents/contracts.ts`: input/output contracts.
- `src/lib/agents/agent-server.ts`: server-only Claude calls, including web search, plus validation and cost preflight.
- `src/lib/agents/agent-client.ts`: source-ranked mappings into existing Resort, Fact and PageSection types.
- `src/routes/ops.tsx`: CEO control surface.
- `src/routes/discover.tsx`, `research.tsx`, `studio.tsx`: direct page hooks.

## Data safety

The source text returned from competitor pages is untrusted. The agents are instructed to treat it solely as evidence. Do not expose any server keys in the browser. Do not enable paid endpoints on an unauthenticated public deployment.
