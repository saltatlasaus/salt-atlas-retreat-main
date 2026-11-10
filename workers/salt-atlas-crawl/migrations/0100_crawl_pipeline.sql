-- Salt Atlas crawl pipeline: additions to the prospecting database (D1 "salt-atlas-scrape").
-- Additive only: new columns, tables, indexes and views. No existing data is changed.
-- Named 0100_ so it never collides with the app's own migrations (0001_, 0002_, ...).

-- Per-page crawl results on the existing `sources` table
ALTER TABLE sources ADD COLUMN fail_reason TEXT;
ALTER TABLE sources ADD COLUMN crawl_run_id TEXT;
ALTER TABLE sources ADD COLUMN crawler TEXT;
ALTER TABLE sources ADD COLUMN final_url TEXT;
ALTER TABLE sources ADD COLUMN http_status INTEGER;
ALTER TABLE sources ADD COLUMN content_chars INTEGER;
ALTER TABLE sources ADD COLUMN language TEXT;
ALTER TABLE sources ADD COLUMN page_title TEXT;
ALTER TABLE sources ADD COLUMN html_r2_key TEXT;
ALTER TABLE sources ADD COLUMN parsed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_batch ON sources (batch, crawl_status);
CREATE INDEX IF NOT EXISTS idx_sources_queue ON sources (tag, crawl_status, batch);

-- Image links: identity across size variants, ranking and size hints
ALTER TABLE images ADD COLUMN canonical_key TEXT;
ALTER TABLE images ADD COLUMN width_hint INTEGER;
ALTER TABLE images ADD COLUMN discovery TEXT;
ALTER TABLE images ADD COLUMN rank_score REAL;
ALTER TABLE images ADD COLUMN third_party INTEGER DEFAULT 0;
ALTER TABLE images ADD COLUMN sniffed INTEGER DEFAULT 0;
ALTER TABLE images ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_canonical ON images (prospect_id, canonical_key);

-- Contacts found by the parser are kept apart from the scout's verified ones
ALTER TABLE contacts ADD COLUMN found_by TEXT DEFAULT 'scout';
ALTER TABLE contacts ADD COLUMN created_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_unique ON contacts (prospect_id, kind, value);

-- The brief Claude reads instead of raw pages
ALTER TABLE prospects ADD COLUMN brief_md TEXT;
ALTER TABLE prospects ADD COLUMN brief_r2_key TEXT;
ALTER TABLE prospects ADD COLUMN brief_updated_at TEXT;
ALTER TABLE prospects ADD COLUMN brief_complete INTEGER DEFAULT 0;
ALTER TABLE prospects ADD COLUMN website_status TEXT;

CREATE TABLE IF NOT EXISTS crawl_runs (
  id TEXT PRIMARY KEY,               -- "<workflow instance>:<primary|retry>"
  instance_id TEXT NOT NULL,
  batch TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('primary', 'retry')),
  apify_run_id TEXT,
  status TEXT,                       -- claimed | starting | RUNNING | SUCCEEDED | FAILED | ABORTED | TIMED-OUT | processed
  dataset_id TEXT,
  kv_store_id TEXT,
  url_count INTEGER,
  items_total INTEGER,
  items_processed INTEGER DEFAULT 0,
  pages_ok INTEGER DEFAULT 0,
  pages_failed INTEGER DEFAULT 0,
  usage_usd REAL,
  error TEXT,
  claimed_at TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_runs_batch ON crawl_runs (batch);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL REFERENCES prospects (id),
  url TEXT NOT NULL,
  title TEXT,
  chars INTEGER,
  r2_key TEXT,
  batch TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (prospect_id, url)
);

-- Views for quick checks from chat or the dashboard
DROP VIEW IF EXISTS v_page_images;
CREATE VIEW v_page_images AS
SELECT prospect_id, section, image_url, COALESCE(width, width_hint) AS width, height, alt, rank_score, permission, selected
FROM images
WHERE COALESCE(width, width_hint, 1200) >= 1200 AND COALESCE(third_party, 0) = 0
ORDER BY prospect_id, section, rank_score DESC;

CREATE VIEW IF NOT EXISTS v_crawl_status AS
SELECT batch, crawl_status, COALESCE(fail_reason, '') AS fail_reason, count(*) AS n
FROM sources WHERE tag = 'operator'
GROUP BY batch, crawl_status, fail_reason;

CREATE VIEW IF NOT EXISTS v_briefs AS
SELECT id, name, country, region, brief_complete, brief_updated_at, length(brief_md) AS brief_chars
FROM prospects WHERE brief_md IS NOT NULL
ORDER BY brief_updated_at DESC;
