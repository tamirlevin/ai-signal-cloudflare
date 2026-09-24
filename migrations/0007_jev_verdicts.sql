CREATE TABLE IF NOT EXISTS jev_verdicts (
  story_url TEXT PRIMARY KEY,
  story_title TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  reranker_relevance REAL,
  reranker_rank INTEGER,
  reranker_interest TEXT,
  jev_interest TEXT,
  jev_interest_confidence REAL,
  jev_novel REAL,
  jev_substantive REAL,
  jev_recommendation TEXT NOT NULL CHECK (jev_recommendation IN ('publish', 'reject')),
  jev_confident INTEGER NOT NULL DEFAULT 0,
  gate_outcome TEXT NOT NULL,
  verdict INTEGER NOT NULL CHECK (verdict IN (1, -1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
