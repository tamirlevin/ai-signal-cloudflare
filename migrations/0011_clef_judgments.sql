-- Durable per-story scores from Cloudflare's Clef decision models, kept apart from the Jev
-- ledger so the two judges can be compared on the same owner labels without touching it.
-- One row per story per question fingerprint per model; the first score is kept.
CREATE TABLE IF NOT EXISTS clef_judgments (
  story_url TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  question_set_version TEXT NOT NULL,
  run_id TEXT,
  scored_at TEXT NOT NULL,
  interest TEXT,
  interest_confidence REAL,
  novel REAL,
  substantive REAL,
  reader_wants REAL,
  PRIMARY KEY (story_url, question_hash, model)
);
