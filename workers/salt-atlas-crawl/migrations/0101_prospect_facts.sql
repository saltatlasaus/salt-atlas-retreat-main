-- Verified facts per prospect, filled by Claude after the crawl (gap filling) and later by the app's
-- Reviewer. field_key uses the app's template keys (src/lib/mock-data.ts FIELD_SPECS: break, waveType,
-- season, level, rooms, capacity, price7, inclusions, meals, wellness, airport, transfer, activities,
-- photos, boards, email) plus whatsapp, phone, trip_length, not_included, deposit, schedule, status.
--
-- status follows the app's FactStatus:
--   verified            the operator's own site states it, or two independent sources agree
--   single              one non-operator source only (agency listing, third party) — use with care
--   conflict            sources disagree; note says how
--   needs_confirmation  stale (old promo), unreadable source, or must be confirmed with the resort
--   missing             looked for and not published anywhere suitable
-- source_type: operator (resort's own site), public (independent guide), agent (agency/competitor listing).

CREATE TABLE IF NOT EXISTS prospect_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id TEXT NOT NULL REFERENCES prospects (id),
  field_key TEXT NOT NULL,
  value TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'single', 'conflict', 'needs_confirmation', 'missing')),
  source_type TEXT CHECK (source_type IN ('operator', 'public', 'agent')),
  source_url TEXT,
  quote TEXT,
  note TEXT,
  found_by TEXT NOT NULL DEFAULT 'claude',
  checked_at TEXT NOT NULL DEFAULT (date('now')),
  UNIQUE (prospect_id, field_key, value)
);
CREATE INDEX IF NOT EXISTS idx_prospect_facts_prospect ON prospect_facts (prospect_id, field_key);

-- One row per prospect and template field: the best current value, for page building.
CREATE VIEW IF NOT EXISTS v_prospect_fact_sheet AS
SELECT prospect_id, field_key, group_concat(value, ' | ') AS value,
       min(CASE status WHEN 'verified' THEN 1 WHEN 'single' THEN 2 WHEN 'needs_confirmation' THEN 3 WHEN 'conflict' THEN 4 ELSE 5 END) AS best_rank,
       group_concat(DISTINCT status) AS statuses
FROM prospect_facts
GROUP BY prospect_id, field_key;
