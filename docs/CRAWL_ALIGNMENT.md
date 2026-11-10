# Aligning the app with the crawl Worker

Status: proposal, 10 Nov 2026. Written after reading the app's pipeline code at `76d3c81`.
Goal: the app (Resort Studio) becomes the one place this work happens. The crawl Worker
(`workers/salt-atlas-crawl`) becomes its **crawl + code-extraction stage**, so Claude only does
judgement work (verify, write) and never reads raw pages it doesn't need.

---

## 1. What exists today

### The app has three separate paths, not one

| Path | Where state lives | Scout | Crawl | Extract / verify | Write |
|---|---|---|---|---|---|
| **/ops** (CEO, manual steps 1–4) | **Browser localStorage** (`salt-atlas-studio-state-v1`), per device | `agent-server.ts` Scout (Claude + 2 web searches) | `startScrapeRun` → one Apify run per resort, depth 2, 35 pages | Reviewer: up to 60k chars of excerpts + regex leads, 3 passes, quotes checked against page text | Writer → section JSON; `.sa-tp` HTML export |
| **/pipeline** (orchestrator, cron 06:00 + every 15 min) | **D1** `pipeline_jobs/targets/facts/drafts/messages/spend` | Claude `discover` tool (max 8, URLs must appear in the conversation) | `scrape` tool → `createScrapeRunRecord`, same preset | `research` tool: Claude reads ≤24k chars of excerpts, facts kept only if the quote is in `scrape_pages` text | `generate` tool → `drafts/<id>.json` in R2, human approves |
| **/scrape** (manual) | D1 `scrape_runs`, `scrape_pages`; R2 `scrapes/` | – | Any URLs, any preset within `constrainCrawl` caps | – | – |

`resorts` (drizzle `0003`) mirrors pipeline targets, but "the stage pages still use the seeded
browser store" (AGENT_PIPELINE.md). **0003 is not applied to the live database yet.**

### The crawl Worker + chat scout

| Stage | What |
|---|---|
| Scout (Claude in chat, Scout Prompt v2) | Writes `runs`, `prospects` (id = domain), `sources` (operator/competitor/review/social), `contacts`, `reviews`, `commercial_signals`, `exclusions`, `region_queue` |
| Crawl (Worker, cron) | Exact operator URLs the scout logged, depth 0, one capped Apify run per day, retry run for blocked pages |
| Extract (code) | Contacts with evidence (WhatsApp only when explicit), socials, booking + review links, prices with units, capacity, transfer times, airports, candidate wave names, JSON-LD address/geo, PDFs, ranked full-size photo links per section with real pixel sizes |
| Output | `prospects.brief_md` (~14k chars max), `images` / `v_page_images`, `contacts` (found_by = parser), `documents`; raw HTML/markdown/extract JSON in R2 `crawl/` |

### Shared resources (no clashes today)

| Resource | App | Worker | Clash? |
|---|---|---|---|
| D1 `salt-atlas-scrape` | `scrape_*`, `pipeline_*`, `resorts` | scout tables + `crawl_runs`, `documents` | No shared tables |
| R2 `salt-atlas-scrape` | `scrapes/`, `drafts/` | `crawl/`, `briefs/`, `docs/` | No |
| `d1_migrations` | `drizzle/0001–0003` | `0100_crawl_pipeline.sql` | No, numbers kept apart |
| Apify account | per-resort runs, **no dollar cap** | one run/day, `maxTotalChargeUsd` cap | Shared bill, see 4.3 |
| Cron | 06:00 UTC daily job, every 15 min | 15:00 + 21:00 UTC (moving to 05:00 + 09:00) | No, but order matters (5.1) |

---

## 2. Where the two overlap

1. **Two scouts.** The app's Scout (Claude Haiku, 2 searches, max 8 resorts, no scoring) and the
   chat scout (prompt v2: scoring, exclusions, reviews, contacts, region queue). They write to
   different tables and don't know about each other's resorts.
2. **Two crawls.** The app crawls per resort at depth 2 / 35 pages; the Worker crawls the scout's
   exact URLs at depth 0 once a day. The same resort could be paid for twice.
3. **Two extraction layers.** The app's regex `extractLeads` (email, price, airport…) and
   `checkPage` overlap with the Worker's parser, which is stricter and broader (Cloudflare-hidden
   emails, wa.me, JSON-LD, local phone formats, price units, photo originals).
4. **Two resort identities.** App: `pipeline_targets.id` / `resorts.resort_key` (slug of the name) /
   browser `Resort.id`. Worker: `prospects.id` (root domain). No link between them.

## 3. Gaps the Worker fills that the app has no answer for

- **Photos.** Every image slot in the `.sa-tp` template is `src=""` (hero, signature wave, rooms,
  4-photo mosaic, gallery). The app never collects photo links. The Worker ranks operator photos per
  section (hero, waves, rooms, gallery) with real sizes and `permission = 'pending'`.
- **Contacts in footers.** The app's default crawl removes `footer` and `noscript` and uses the
  `readableText` transformer, which is where many resorts keep their email and WhatsApp. The Worker keeps both.
- **WhatsApp rule.** The app has no WhatsApp handling; the template only has `enquiry.email`.
- **Cost cap on Apify.** App runs have no `maxTotalChargeUsd`.
- **Dead pages.** The Worker detects gone / parked / redirected-home / off-site pages and never retries them.

## 4. Target design

```
Scout (one, see decision A) ─▶ prospects + sources (pending)
                                   │
                    05:00  crawl Worker (one capped Apify run/day)
                                   │  parses in code
                                   ▼
        scrape_runs/scrape_pages  ◀── bridge (4.1) ──▶  contacts, images, prices, brief_md
                                   │
                    06:00  app daily job: import prospects → targets (4.2)
                                   │
              Reviewer / research: Worker leads first, Claude only for open fields (4.4)
                                   │
              Writer → .sa-tp page with real photo links (4.5) → human review → publish
```

### 4.1 Bridge: the Worker writes into the app's scrape tables (smallest, highest value)

So the app's existing Reviewer, `research` tool, quote validation and crawl boards work on Worker
output **with no app changes**:

- Per prospect per batch, upsert one `scrape_runs` row: `id = crawl-<batch>-<prospect>`,
  `apify_run_id` = the Worker's run, `status = 'SUCCEEDED'`, `input_json` = the URLs, `simulated = 0`,
  `item_count`, `r2_key`.
- Per crawled page, upsert `scrape_pages`: `run_id`, `url`, `canonical_url` (final URL), `title`,
  `depth = 0`, `http_status`, `text` (plain text), `markdown`, `metadata_json`, `resort_id = prospect id`.
- Worker change: `src/db.ts` `pageStatements` (one more statement per page) and a `scrape_runs`
  upsert in `reconcile`. Mind the 100-parameter limit and markdown size (cap ~200 KB per page).
- Watch: `scrape_pages.id` must be deterministic (`<run>-<hash(url)>`) so re-runs don't duplicate.

### 4.2 Identity: link app resorts to prospects

- `resort_key` stays the app's key. Add `prospect_id TEXT` to `resorts` and `pipeline_targets`
  (new drizzle migration `0004_prospect_link.sql`), or adopt the domain as `resort_key` for imported
  resorts. Recommend the column: no rewrite of existing keys.
- New `src/lib/pipeline/import-prospects.ts`: for prospects with a complete or partial brief and
  status `new`, create a target (`stage = 'research'`, `url = prospects.website`,
  `scrape_run_id = crawl-<batch>-<prospect>`) and mirror to `resorts`. Skip ones already imported.
- Call it at the start of `startDailyJob()` in `src/lib/pipeline/cron.ts`, and from a button on /pipeline.

### 4.3 One crawl

- The `/pipeline` `scrape` tool and /ops step 2 stop starting their own Apify runs for resorts that
  came from the scout. Instead: insert the URLs into `sources` as `pending` (if missing) and either
  wait for the next daily crawl or call the Worker's `POST /admin/crawl?force=1` (via a service
  binding `CRAWL_WORKER` in the app's `wrangler.jsonc`, so no admin token in the app).
- Keep `/scrape` for ad-hoc crawls, but add `maxTotalChargeUsd` to `startWebsiteContentCrawl`
  (`src/lib/apify.ts`) so both paths have a hard dollar cap.
- Coverage trade-off (decision B): depth 0 depends on the scout finding the right pages; the app's
  depth 2 finds pages the scout missed at roughly 5–6× the pages per resort.

### 4.4 Reviewer reads the Worker's extraction first

- `reviewEvidence()` (`agent-server.ts`) and `excerptsForTarget()` (`pipeline/tools.ts`) already
  accept "leads". Add the Worker's leads for the target's prospect: contacts (with how each was found),
  prices with unit and sentence, capacity, transfer times, airports, wave-name candidates. Keep
  `extractLeads` only for keys the Worker doesn't cover (meals, wellness, activities, boards, photo rights).
- For keys the Worker fills with a sentence that passes `evidenceQuoteMatchesPage` against the
  page text, save the fact directly (status `single` or `needs_confirmation`, decision C) and drop the
  key from Claude's checklist. Expected effect: the Reviewer's 60k-char prompt shrinks to the open
  fields only.
- Season and surf level stay with the Reviewer's public-source search passes (pass 3); the Worker
  never asserts them.

### 4.5 Photos into the template

- `src/lib/sa-tp/build-content.ts`: add `photos: { hero?: string; signature?: string; rooms: string[]; mosaic: string[] }`
  from `v_page_images` (best `rank_score` per section; rooms by section `rooms`; mosaic from
  `gallery` then `other`).
- `src/lib/sa-tp/render.ts`: fill the `<img src="">` slots; keep `data-ph` as fallback; show a
  "permission pending" badge in Studio until `images.permission = 'granted'`. Never publish an image
  whose permission is not granted.
- Studio: a picker per slot listing that section's ranked links.

### 4.6 Make D1 the source of truth for /ops

The biggest structural gap: /ops keeps resorts, facts and pages in one browser's localStorage, so
nothing the Worker or the cron does appears there, and two people see different data. Move /ops to
read `resorts` / `pipeline_targets` / `pipeline_facts` / `pipeline_drafts` via server functions
(the tables exist) and keep localStorage only for UI state (open tab, run tabs). This is the largest
change and can follow 4.1–4.5.

---

## 5. Order of work

| Phase | Change | Where | Effort | Unblocks |
|---|---|---|---|---|
| 0 | Apply `drizzle/0003_resorts.sql` to live; move Worker cron to 05:00 (+ watchdog 09:00) so it finishes before the app's 06:00 job | ops | minutes | everything |
| 1 | Bridge (4.1) | Worker | ½ day | app reads Worker crawls with no app change |
| 2 | Identity + import (4.2) | app: migration 0004, `import-prospects.ts`, `cron.ts` | ½ day | scout resorts appear in /pipeline |
| 3 | Reviewer uses Worker leads; code-filled facts (4.4) | app: `agent-server.ts`, `pipeline/tools.ts`, `fact-hints.ts` | 1 day | lower Claude spend, better contacts/prices |
| 4 | Photos into template (4.5) | app: `sa-tp/*`, Studio | 1 day | pages with real photos |
| 5 | One crawl + Apify cap (4.3) | app: `pipeline/tools.ts`, `apify.ts`, `wrangler.jsonc` | ½ day | no double Apify spend |
| 6 | /ops on D1 (4.6) | app: `store.ts`, routes | 2–3 days | shared, durable state |
| 7 | One scout (decision A) | app or chat | depends | single source of prospects |

Each phase is shippable on its own and leaves the other paths working.

### 5.1 Daily timing after phase 0

05:00 UTC Worker crawl → ~06:00 briefs ready → 06:00 app daily job imports and researches →
morning: human reviews drafts in Studio.

---

## 6. Decisions needed

- **A. Which scout?** Chat scout (prompt v2: richer, scored, logs contacts and reviews, runs in a
  Claude chat or scheduled task) vs the app's Scout (in-app, cheaper model, thinner output). Recommend:
  keep the chat scout's output format (`prospects`/`sources`) as the standard and port its prompt
  into the app's Scout later, so there is one table of prospects either way.
- **B. Crawl depth.** Exact scout URLs at depth 0 (cheap, predictable) vs depth 2 (more coverage,
  more cost). Middle option: Worker adds depth 1 on the official domain only, limited by
  `includeUrlGlobs` to rates / rooms / accommodation / surf / getting-here / contact / FAQ paths.
- **C. Code-filled facts.** May the app save Worker-extracted contacts, prices, capacity and
  transfer times as facts without Claude (they still carry a verbatim quote and need human approval
  before publish), or must every fact pass the Reviewer?

## 7. Risks to check in review

- `scrape_pages` row size and D1 write volume when bridging (markdown can be large).
- `evidenceQuoteMatchesPage` uses `cleanPageText` on the app side; Worker snippets come from
  `mdToPlain`. Code-filled facts must be re-validated with the app's function, not trusted as-is.
- The app's 15-minute cron calls Apify only for jobs in `waiting_apify`; imported targets must not
  enter that state, or it will poll runs the app didn't start.
- `pipeline_targets.url` uniqueness is checked by trimmed URL in `discover`; imported resorts must
  use the same normalisation or the app's Scout will re-add them.
- `contacts.kind` has a CHECK constraint (`email, whatsapp, phone, person, instagram, facebook`);
  anything new needs a migration on the Worker side.
