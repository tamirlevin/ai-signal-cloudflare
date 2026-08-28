CREATE TABLE IF NOT EXISTS manual_republish_days (
  local_day TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  claimed_at TEXT NOT NULL,
  completed_at TEXT
);
