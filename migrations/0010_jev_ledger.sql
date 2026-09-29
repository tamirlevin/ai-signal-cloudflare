-- Durable per-story Jev scores. Shadow reports are pruned to 15 rows; this ledger is not.
-- One row per story per question fingerprint: the first non-null score wins, later runs only
-- refresh the gate outcome, sighting counts, and selected/published flags.
CREATE TABLE IF NOT EXISTS jev_judgments (
  story_url TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  question_set_version TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  first_run_id TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  interest TEXT,
  interest_confidence REAL,
  novel REAL,
  substantive REAL,
  reader_wants REAL,
  reranker_relevance REAL,
  reranker_raw REAL,
  reranker_rank INTEGER,
  reranker_interest TEXT,
  gate_outcome TEXT NOT NULL,
  ever_selected INTEGER NOT NULL DEFAULT 0,
  ever_published INTEGER NOT NULL DEFAULT 0,
  profile_version INTEGER,
  source_pack_id TEXT,
  source_pack_version INTEGER,
  PRIMARY KEY (story_url, question_hash)
);

-- Append-only owner labels. The first non-repeat, non-rank event per story is its vote; repeats
-- measure the owner's own consistency; rank events order the publish set of one run.
CREATE TABLE IF NOT EXISTS jev_label_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_url TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  question_set_version TEXT NOT NULL,
  run_id TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'disagree-gate-only',
    'disagree-jev-only',
    'anchor-both-in',
    'anchor-both-out',
    'repeat',
    'dropped-pool',
    'rank'
  )),
  decision TEXT NOT NULL CHECK (decision IN ('publish', 'reject', 'unsure')),
  rank_position INTEGER CHECK (rank_position IS NULL OR rank_position > 0),
  cell_population INTEGER,
  cell_sampled INTEGER,
  pool_size INTEGER,
  jev_k INTEGER,
  profile_version INTEGER,
  source_pack_id TEXT,
  source_pack_version INTEGER,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jev_label_events_story ON jev_label_events (story_url);
CREATE INDEX IF NOT EXISTS jev_label_events_run ON jev_label_events (run_id);
