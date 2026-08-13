CREATE TABLE IF NOT EXISTS editions (
  id TEXT PRIMARY KEY,
  issue_url TEXT NOT NULL UNIQUE,
  issue_date TEXT NOT NULL UNIQUE,
  publication_date TEXT NOT NULL,
  edition_json TEXT NOT NULL,
  source_body_hash TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS editions_published_at_idx ON editions (published_at DESC);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  profile_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_active_idx ON profiles (is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'local-scheduled')),
  issue_url TEXT,
  issue_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  model TEXT,
  edition_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  FOREIGN KEY (edition_id) REFERENCES editions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS runs_started_at_idx ON runs (started_at DESC);

INSERT OR IGNORE INTO profiles (id, version, profile_json, is_active)
VALUES (
  'profile-v2-default',
  2,
  '{"version":2,"storyBudget":7,"storyBudgetRange":[5,14],"exceptionalStoryOverride":true,"safeguards":{"watchPermissions":true,"watchGeography":true},"weights":[{"id":"agents","label":"Agents in practice","value":3},{"id":"codex","label":"Codex & agent craft","value":4},{"id":"newSystems","label":"New systems","value":3},{"id":"integration","label":"Integration & platforms","value":3},{"id":"business","label":"AI business & economics","value":3},{"id":"frontier","label":"Frontier signals","value":1},{"id":"research","label":"AI research & science","value":1},{"id":"harness","label":"Model–harness co-design","value":2},{"id":"newly","label":"Newly detected","value":3},{"id":"lowFit","label":"Policy, cyber & infrastructure","value":1},{"id":"training","label":"Pre-training, training & data","value":1}],"pinnedCategories":["Model–harness co-design"],"watching":["Agent permission design","AI cluster geography"]}',
  1
);
