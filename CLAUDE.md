# Salt Atlas Resort Studio

Salt Atlas is a UK surf travel company building a worldwide surf atlas: the place to find and book
premium surf resorts, lodges, villas and charters. This repo is the internal tool that finds new partner
resorts, crawls their websites, verifies facts and generates destination pages for saltatlas.com.

## Layout

| Path | What |
|---|---|
| `src/` | The app: TanStack Start + React, deployed as the `salt-atlas-retreat` Worker (`wrangler.jsonc`, entry `src/worker.ts`) |
| `src/lib/pipeline/`, `src/lib/agents/` | The app's agent pipeline (Scout → Apify → Reviewer → Writer); see `docs/AGENT_PIPELINE.md` |
| `src/routes/` | Pages: `/ops`, `/pipeline`, `/scrape`, `/research`, `/studio`, `/discover` |
| `drizzle/` | The app's D1 migrations |
| `workers/salt-atlas-crawl/` | **Separate** Worker: daily capped Apify crawl + code parsing → one brief per resort (`prospects.brief_md`). Own `package.json`, `wrangler.jsonc`, migrations and tests; see its `README.md` |
| `docs/` | `HANDOVER.md`, `AGENT_PIPELINE.md`, `CRAWL_ALIGNMENT.md` (plan to merge the two pipelines) |

## Two pipelines, one database (important)

Both Workers use the same D1 database (`salt-atlas-scrape`) and R2 bucket (`salt-atlas-scrape`).

- **App pipeline** tables: `scrape_runs`, `scrape_pages`, `pipeline_*`, `resorts`. R2 prefix `scrapes/`.
- **Crawl Worker / scout** tables: `runs`, `prospects`, `sources`, `contacts`, `reviews`, `images`,
  `documents`, `crawl_runs`, `exclusions`, `region_queue`, `run_log`. R2 prefixes `crawl/`, `briefs/`, `docs/`.

They do not read each other's tables yet; the phased plan is in `docs/CRAWL_ALIGNMENT.md`. **Direction:** the app is where this work should end up.
The crawl Worker is meant to become the app's crawl-and-pre-extract stage (cheap code extraction
before any Claude call), not a permanent parallel system. When changing either side, keep the two
compatible and don't duplicate a stage the other already does; flag overlaps instead of building around them.

Migrations: both folders record into the same `d1_migrations` table. App migrations live in `drizzle/`
(0001–0099); crawl Worker migrations in `workers/salt-atlas-crawl/migrations/` (0100+). Never reuse a
number or alter the other side's tables without saying so.

## Commands

App (Bun preferred, npm works):
```sh
bun install && bun run dev
bunx tsc --noEmit && bun run test && bun run build   # what CI runs on every PR
bun run lint
```

Crawl Worker (separate install, Node 22+):
```sh
cd workers/salt-atlas-crawl && npm install
npm test                 # node --test, includes a simulated full day against the real schema
npx wrangler deploy      # deploys the salt-atlas-crawl Worker only
```

The app's lint, Prettier, tsconfig, vitest and build only cover `src/`; `workers/` is excluded.

## Code style

- App: Prettier (double quotes, semicolons, width 100, trailing commas). Strict TypeScript with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Crawl Worker: single quotes, no dependencies at runtime, `.ts` imports that Node can run directly
  (no TypeScript parameter properties or enums, since tests run with Node's type stripping).
- Secrets only in `.dev.vars` locally or `wrangler secret put`; never in code, frontend env or commits.
- Keep `ENABLE_LIVE_AGENT_CALLS=false` unless the deployment is behind real access control.

## Salt Atlas content rules (apply to scraping, extraction and generated pages)

- **WhatsApp:** label a number WhatsApp only if the operator explicitly advertises it as WhatsApp,
  links to wa.me / WhatsApp, or has an official WhatsApp button. Otherwise it is Phone. Never guess.
- Don't copy contact details from random directories; prefer the operator's own site.
- Photos: only from the operator's own site, stored as links; `permission = 'pending'` until the
  resort agrees. Never stock (Unsplash) or agency photos.
- Season and surf level come from public sources, not the operator's marketing.
- Prices scraped from sites are leads to verify, never facts.
- Say "expeditions", "resorts" and "charters"; never "trips".
- Audience is international surfers aged 20–35, progression to advanced. Don't feature families.
- Don't mention the 2% Blue Marine Foundation donation in marketing copy.
- Crawl politely: respect robots.txt, low concurrency, no mass scraping.

## Working here

- Branch from `main`, open a pull request; don't push to `main` directly.
- Run the relevant tests before pushing (app: `bun run test`; crawl Worker: `npm test` in its folder).
- Cost matters: Apify runs and Claude calls are paid. Prefer code to model calls for anything mechanical,
  and keep hard caps (`APIFY_MAX_USD_PER_RUN`, `PIPELINE_DAILY_BUDGET_GBP`) in place.
