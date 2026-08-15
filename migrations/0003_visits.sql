CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  visitor_key TEXT NOT NULL,
  visit_day TEXT NOT NULL,
  path TEXT NOT NULL,
  visited_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(visitor_key, visit_day)
);

CREATE INDEX IF NOT EXISTS visits_visited_at_idx ON visits (visited_at DESC);
