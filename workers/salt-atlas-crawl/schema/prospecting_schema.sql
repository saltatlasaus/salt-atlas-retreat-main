-- Snapshot of the prospecting tables in D1 "salt-atlas-scrape" BEFORE migration 0100, as of 10 Nov 2026.
-- Reference only (and used by the tests to build a local copy). Do not apply to the live database:
-- these tables already exist there. The app's own tables (scrape_runs, pipeline_*) are not included.

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  regions TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  prospects_found INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE prospects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  region TEXT,
  type TEXT CHECK (type IN ('resort','lodge','villa','charter')),
  website TEXT,
  direct_booking_method TEXT,
  direct_booking_url TEXT,
  booking_value_estimate REAL,
  booking_value_currency TEXT DEFAULT 'GBP',
  booking_value_basis TEXT,
  booking_value_source TEXT,
  score_booking_value INTEGER,
  score_surf_quality INTEGER,
  score_brand_fit INTEGER,
  score_group_potential INTEGER,
  score_ease_of_contact INTEGER,
  fit_score REAL GENERATED ALWAYS AS (round(0.35*score_booking_value + 0.25*score_surf_quality + 0.15*score_brand_fit + 0.15*score_group_potential + 0.10*score_ease_of_contact, 1)) VIRTUAL,
  why_salt_atlas TEXT,
  review_flags TEXT,
  gaps TEXT,
  status TEXT DEFAULT 'new' CHECK (status IN ('new','verified','contacted','partner','live','rejected')),
  run_id TEXT REFERENCES runs(run_id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  name_key TEXT,
  booking_value_source_tag TEXT
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL REFERENCES prospects(id),
  kind TEXT CHECK (kind IN ('email','whatsapp','phone','person','instagram','facebook')),
  value TEXT NOT NULL,
  title TEXT,
  evidence TEXT,
  source_url TEXT NOT NULL,
  source_tag TEXT DEFAULT 'operator'
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL REFERENCES prospects(id),
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  rating REAL,
  scale INTEGER,
  review_count INTEGER,
  is_primary INTEGER DEFAULT 0,
  checked TEXT DEFAULT (date('now'))
);

CREATE TABLE commercial_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL REFERENCES prospects(id),
  signal TEXT NOT NULL,
  detail TEXT,
  source_url TEXT
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL REFERENCES prospects(id),
  url TEXT NOT NULL,
  tag TEXT CHECK (tag IN ('operator','competitor','public','review','social')),
  feeds TEXT,
  crawl_status TEXT DEFAULT 'pending' CHECK (crawl_status IN ('pending','crawled','failed','skip')),
  retry_count INTEGER DEFAULT 0,
  batch TEXT,
  r2_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (prospect_id, url)
);

CREATE TABLE exclusions (
  id TEXT PRIMARY KEY,
  name TEXT,
  reason TEXT CHECK (reason IN ('already_live','exclusive_to_competitor','agency','surf_not_central','duplicate','contacted','rejected')),
  source_url TEXT,
  run_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  domain TEXT,
  name_key TEXT
);

CREATE TABLE region_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,
  regions TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','exhausted','paused')),
  low_yield_runs INTEGER DEFAULT 0,
  last_run TEXT
);

CREATE TABLE run_log (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, event TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL REFERENCES prospects(id),
  source_id INTEGER REFERENCES sources(id),
  page_url TEXT NOT NULL,
  image_url TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  alt TEXT,
  section TEXT CHECK (section IN ('hero','waves','rooms','amenities','gallery','getting_there','other')),
  selected INTEGER DEFAULT 0,
  permission TEXT DEFAULT 'pending' CHECK (permission IN ('pending','granted','refused')),
  r2_key TEXT,
  batch TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (prospect_id, image_url)
);
CREATE INDEX idx_images_prospect ON images(prospect_id, section, width);

CREATE VIEW v_page_images AS
SELECT prospect_id, section, image_url, width, alt, permission
FROM images WHERE (width IS NULL OR width >= 1200) AND image_url NOT LIKE '%logo%' AND image_url NOT LIKE '%icon%'
ORDER BY prospect_id, section, width DESC;
