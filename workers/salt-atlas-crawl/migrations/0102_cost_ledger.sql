-- Running cost counter (already applied to live D1). One row per task: Claude usage (API-equivalent),
-- Apify runs, anything else. Total: SELECT sum(gbp) FROM cost_ledger;
CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logged_at TEXT NOT NULL DEFAULT (datetime('now')),
  task TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claude_tokens', 'apify', 'cloudflare', 'other')),
  usd REAL NOT NULL,
  gbp REAL NOT NULL,
  detail TEXT
);
