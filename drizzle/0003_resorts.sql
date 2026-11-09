-- Canonical resort row for the prompt pipeline.
-- The browser studio store remains a local demo until stage pages read this table.

CREATE TABLE IF NOT EXISTS resorts (
  resort_key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  stage TEXT NOT NULL,
  scrape_run_id TEXT,
  source TEXT NOT NULL DEFAULT 'pipeline',
  updated_at TEXT NOT NULL
);
