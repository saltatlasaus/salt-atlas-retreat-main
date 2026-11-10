-- Destination page drafts, one per prospect: the full kit JSON (saltatlas-website
-- tools/destinations/kit/SCHEMA.md) written by the gap-fill session, pulled and built on a computer
-- with internet by tools/pull_pages.py (downloads photos to WebP, runs the site build).
-- status: draft (being written) | ready (pull it) | built (pulled into the site) | live | rejected
CREATE TABLE IF NOT EXISTS page_drafts (
  prospect_id TEXT PRIMARY KEY REFERENCES prospects (id),
  slug TEXT NOT NULL UNIQUE,
  kit_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'built', 'live', 'rejected')),
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
