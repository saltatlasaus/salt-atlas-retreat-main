# Salt Atlas crawl Worker

Turns the scout's source links into short, structured **briefs** that Claude reads instead of crawling websites itself.
Code does everything that is mechanical (fetching, finding contacts, photo links, prices, capacity, dead pages);
Claude only does the judgement work (verifying, writing the destination page).

```
Scout (Claude, 2 runs a day)          Worker (this repo, no Claude tokens)                       Claude (verify + write)
───────────────────────────           ──────────────────────────────────────────                 ───────────────────────
logs operator URLs to D1  ──────────▶ 01:00 UTC cron starts one Workflow per day                 reads prospects.brief_md
  sources.crawl_status='pending'       1 claim today's pending + retryable pages                 (≈2–4k tokens per resort)
                                       2 start ONE Apify run (hard $ cap)                        + v_page_images for photos
                                       3 wait: Apify webhook, or poll every 15 min
                                       4 parse each page (15 per step) → D1 + R2
                                       5 reconcile pages Apify did not return
                                       6 read real pixel sizes of top photos (header bytes only)
                                       7 build one brief per resort → prospects.brief_md
                                       8 Teams summary · 07:30 watchdog if anything went wrong
```

## What Claude reads

| Need | Query |
|---|---|
| Everything for one resort | `SELECT brief_md FROM prospects WHERE id = 'tengirri.com'` |
| Which briefs are ready | `SELECT * FROM v_briefs` (`brief_complete = 1` means every page was read) |
| Best photo links | `SELECT * FROM v_page_images WHERE prospect_id = ? ORDER BY section, rank_score DESC` |
| Today's crawl result | `SELECT * FROM v_crawl_status WHERE batch = '2026-11-11'` |
| Cost and outcome per run | `SELECT batch, kind, status, pages_ok, pages_failed, usage_usd FROM crawl_runs ORDER BY started_at DESC` |

A brief contains: contacts found on the site (each marked *matches scout* or *new*, with how it was found),
other social profiles, booking and review links, location, raw prices with their unit, capacity facts,
transfer times, possible wave names, ranked photo links per section with real pixel sizes, PDFs, a trimmed
summary of what each page says, and the pages that could not be read and why. It is capped at ~14,000 characters.

Rules the parser follows (from the scout prompt): a number is **WhatsApp only** if it is a wa.me / WhatsApp link,
an official WhatsApp button, or text explicitly labelled WhatsApp next to it; otherwise it is **Phone**.
Prices are *leads*, never facts. Season and surf level are never taken from operator sites. Photos are stored
as **links only**, `permission = 'pending'` until the resort agrees; family imagery ranks lower.

## Setup (once)

Needs the **Workers Paid** plan: the free plan's 10 ms CPU limit is too small for parsing.

```bash
npm install
npx wrangler login
npx wrangler secret put APIFY_TOKEN        # Apify → Settings → API & Integrations
npx wrangler secret put WEBHOOK_SECRET     # any long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put ADMIN_TOKEN        # another long random string, for the /admin endpoints
npx wrangler secret put TEAMS_WEBHOOK_URL  # optional: same kind of URL the fb-leads worker uses
npx wrangler deploy
```

Then put the URL wrangler printed into `PUBLIC_URL` in `wrangler.jsonc` and deploy again (Apify calls it back).

The database migration (`migrations/0100_crawl_pipeline.sql`) is **already applied** to `salt-atlas-scrape`
and recorded in `d1_migrations`, so `wrangler d1 migrations apply` will skip it.

Recommended: in R2 → `salt-atlas-scrape` → Lifecycle, delete objects under `crawl/` after 90 days.
Raw HTML is kept so the parser can be improved and re-run for free (`/admin/reparse`).

## Day to day

Nothing to do. The scout logs URLs; the Worker crawls at 01:00 UTC; a Teams card arrives when it finishes.

```bash
H="Authorization: Bearer $ADMIN_TOKEN"; W=https://salt-atlas-crawl.<account>.workers.dev
curl -X POST -H "$H" "$W/admin/crawl?date=2026-11-11"          # start now (safe to repeat: same day = same run)
curl -X POST -H "$H" "$W/admin/crawl?date=2026-11-11&force=1"  # start a fresh run for leftovers after fixing something
curl -H "$H" "$W/admin/status?date=2026-11-11"                 # workflow state + page counts
curl -H "$H" "$W/admin/brief?prospect=tengirri.com"            # the brief as Claude sees it
curl -X POST -H "$H" "$W/admin/reparse?prospect=tengirri.com"  # re-parse stored HTML, no Apify cost
curl -X POST -H "$H" "$W/admin/photos"                         # run the 06:30 photo download now (skips photos already copied)
python3 tools/fetch_failed_photos.py                           # on your computer: fetch photos a resort site refused the Worker
npx wrangler tail                                              # live logs
```

## Barriers and how the system handles them

| Barrier | What happens |
|---|---|
| Cron fires twice / someone clicks twice | Workflow id is `crawl-<date>`; a second start is ignored. |
| Worker crashes mid-day | Each step is durable and retried on its own; finished steps never repeat. Every write is an upsert, so a repeated step changes nothing (tested). |
| Crash right after Apify started, before we saved the run id | The step finds the run started in the last minutes and adopts it — never pays for two runs. |
| Apify webhook never arrives | Workflow polls the run every 15 minutes anyway. |
| Apify run hangs | Aborted after 3 hours; whatever it already collected is still processed. |
| Apify run fails or is aborted | URLs go back in the queue **without** using up their retry. Teams alert. |
| Runaway cost | `maxTotalChargeUsd` per run (`APIFY_MAX_USD_PER_RUN`, default $3), depth 0 (only the exact URLs the scout logged), max 300 URLs/day, no screenshots, no image downloads. |
| Site blocks bots (Cloudflare challenge, 403, 429) | Marked `blocked`; next day it goes to a separate **retry run** with a full Firefox browser, longer waits and fewer parallel requests. Optional residential proxy (`RETRY_PROXY_GROUP`) only if needed. One retry day, then left for a person (the scout can log another page). |
| Page is JavaScript-heavy (Wix, Squarespace, React) | Adaptive crawler switches to a real browser when plain HTML is empty; we also parse `<noscript>` fallbacks and JSON-LD. |
| robots.txt disallows the page | Respected. Marked `skip: robots`, never retried. The brief says which pages weren't read. |
| Page deleted / domain parked / now redirects to homepage / redirects to another site | Detected and marked permanent (`gone`, `parked`, `redirect_home`, `off_site`); never retried, so the scout can log a replacement. |
| Cookie banners, pop-ups | Removed before text extraction (`removeCookieWarnings`, dialog selectors). |
| Content hidden in accordions (FAQs, rates) | Collapsed elements are clicked open before reading. |
| URLs come back slightly different (http→https, www, trailing slash, tracking params) | Matched by a normalised key, with a looser fallback. |
| One site gets hammered | Requests interleaved across domains, 5 at a time (3 on retries). Polite by design. |
| Thumbnails instead of full-size photos | CDN URLs rewritten to the original (WordPress, Squarespace, Wix, Shopify, Cloudinary, Next.js, imgix and more); `srcset` largest wins; lightbox links captured; duplicates merged. |
| Photo size unknown | First few KB of the file are read to get real pixel size; nothing is downloaded or stored. |
| Logos, icons, tracking pixels, other people's photos | Filtered out or ranked down (`third_party`). |
| Email hidden by Cloudflare or written as "name [at] domain" | Decoded. |
| Local-format phone numbers | Converted to international format only where the country's rule is known; otherwise kept as written and flagged. |
| A huge site produces a huge brief | Brief is capped at ~14k characters; the most useful sections come first. |
| Database limits (1,000 queries per run, 100 values per query) | Pages are processed 15 per step, each page's writes in one transaction. |
| Pages left with an old date by the scout or a crashed run | Adopted by the next day's run, unless that day's crawl is still running. |
| Secrets missing or wrong | Workflow stops at the first step with a clear error (no retries, no cost) and a Teams alert. |
| Nothing happens at all | 07:30 UTC watchdog posts to Teams if the day's crawl failed or never ran while pages are waiting, or if ready pages weren't staged at 07:03. |

## Cost controls in one place

- Apify: one run per day (plus a small retry run only when something failed), depth 0, capped in dollars per run.
  Check `crawl_runs.usage_usd` after the first week and adjust `APIFY_MAX_USD_PER_RUN`.
- Cloudflare: Workers Paid base fee; the Workflow uses around 100 steps a day.
- Claude: reads a ~2–4k token brief per resort instead of the raw pages, which often run to tens of thousands of tokens.
- Re-parsing after a parser improvement uses stored HTML: no Apify cost.

## Files

| Path | What |
|---|---|
| `src/index.ts` | Cron, webhook, admin endpoints, watchdog |
| `src/workflow.ts` | The daily Workflow (steps, waiting, aborting, reporting) |
| `src/pipeline.ts` | Processing Apify results, reconciling missing pages, image sizes |
| `src/apify.ts` | Apify API calls and the crawler input (see `apify/*.example.json` for the exact JSON) |
| `src/process.ts` | One page in → structured extract out |
| `src/html.ts`, `images.ts`, `contacts.ts`, `text.ts`, `sniff.ts`, `urls.ts` | The parsers |
| `src/db.ts` | All database writes (idempotent) |
| `src/brief.ts` | Builds the brief Claude reads |
| `migrations/0100_crawl_pipeline.sql` | Schema changes (already applied) |
| `test/` | 34 tests incl. a full simulated day against a local copy of the real schema |

The Apify input in `src/apify.ts` replaces the JSON config shared earlier in chat: it keeps `<noscript>`
fallbacks and JSON-LD (where many sites put contacts, address and photos) instead of removing them.

```bash
npm test          # node --test test/*.test.ts (Node 22+, no install needed)
npm run typecheck # needs npm install
```

## Verified facts (after gap filling)

`prospect_facts` holds one row per fact per resort, keyed by the app's template fields
(`break`, `season`, `level`, `rooms`, `capacity`, `price7`, `inclusions`, `meals`, `airport`, `transfer`, …,
plus `whatsapp`, `phone`, `trip_length`, `deposit`, `schedule`, `status`). Each row has a status
(`verified`, `single`, `conflict`, `needs_confirmation`, `missing`), where it came from
(`operator`, `public`, `agent`), the source link and the exact quote. Applied as migration `0101_prospect_facts.sql`.

```sql
SELECT field_key, value, status, source_type, source_url FROM prospect_facts WHERE prospect_id = 'tengirri.com' ORDER BY field_key;
SELECT * FROM v_prospect_fact_sheet WHERE prospect_id = 'tengirri.com';
```

## Daily flow and page drafts

| When (UTC, all year) | What | Cost |
|---|---|---|
| 12:47 and 19:47 | Scheduled scout session: up to 15 prospects each, logged to `prospects` / `sources` | Claude (fresh session) |
| 01:00 | This Worker crawls everything pending; briefs by ~02:00 | Apify + Workers |
| 01:53–05:53, hourly | Scheduled gap-fill session: 6 prospects per run → `prospect_facts` and a full page file in `page_drafts` (status `ready`) | Claude (fresh session) |
| 06:30 | This Worker downloads the photos of ready drafts into R2. Photos a resort site refuses are retried on the next mornings (up to 3 tries) | Workers |
| 07:03 | Scheduled staging session: ready drafts → `staging` branch, Teams list of preview links | Claude (fresh session) |
| 07:30 | Watchdog: crawl failed, ready pages not staged, or photos refused by a resort site | Workers |
| When you like | `python3 tools/pull_pages.py --site <saltatlas-website>` on a computer with internet: downloads the photos to WebP, builds the pages, marks drafts `built` | Free |

Every session logs its estimated cost to `cost_ledger`.
