# Salt Atlas Resort Studio — Integration handover

## Wired now

- **Scrape** — `apify/website-content-crawler` via `src/lib/scrape-server.ts` / `src/lib/apify.ts`.
  - Paste start URLs → one bulk Actor run → per-run results + JSON/CSV export.
  - Secrets: `.dev.vars` (local Cloudflare Vite) — see `.dev.vars.example`.
- **Cloudflare storage** — Worker bindings in `wrangler.jsonc`:
  - **R2** `SCRAPE_BUCKET` → raw dataset JSON at `scrapes/{runId}/dataset.json`
  - **D1** `DB` → `scrape_runs` + `scrape_pages` (migration in `drizzle/0001_scrape_storage.sql`)
  - Adapter: `src/lib/scrape-storage-cf.ts` (falls back to in-memory if bindings missing)

### One-time Cloudflare setup

```sh
bunx wrangler login
bunx wrangler r2 bucket create salt-atlas-scrape
bunx wrangler d1 create salt-atlas-scrape
# paste the printed database_id into wrangler.jsonc → d1_databases[0].database_id
bun run db:migrate:local
bun run db:migrate:remote   # when ready for production
cp .dev.vars.example .dev.vars   # add APIFY_TOKEN
bun run dev
```

## Still mocked

- Discover / research gaps / AI edit-section (Claude)
- Publish / rollback (website repo + Cloudflare Pages deploy)

## Daily crawl Worker (separate deploy)

`workers/salt-atlas-crawl/` is a standalone Cloudflare Worker (`salt-atlas-crawl`) with its own
`wrangler.jsonc`, cron and Workflow. It reads `sources` rows the scout logs (tag `operator`,
status `pending`), runs one capped Apify crawl a day, parses every page in code (contacts,
WhatsApp only when explicit, full-size photo links, prices, capacity) and writes a short brief per
resort to `prospects.brief_md` for Claude to read. It shares the `salt-atlas-scrape` D1 database and
R2 bucket with this app but has its own migration (`0100_crawl_pipeline.sql`, already applied).

It is excluded from this app's lint, tests and build. Deploy it from its own folder:
`cd workers/salt-atlas-crawl && npm install && npx wrangler deploy`. Full runbook:
`workers/salt-atlas-crawl/README.md`.
