-- Photos copied from resorts' own websites into R2 (photos/<key>) by the Worker's 11:05 UTC cron,
-- served at <PUBLIC_URL>/photo/<key>. One row per original URL. Applied to live D1.
CREATE TABLE IF NOT EXISTS photo_mirror (
  url TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  prospect_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  bytes INTEGER,
  content_type TEXT,
  error TEXT,
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_photo_mirror_prospect ON photo_mirror (prospect_id, status);
