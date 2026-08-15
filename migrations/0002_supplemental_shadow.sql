CREATE TABLE IF NOT EXISTS supplemental_shadow_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'local-scheduled')),
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed')),
  base_issue_url TEXT,
  base_issue_date TEXT,
  report_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS supplemental_shadow_runs_started_at_idx
ON supplemental_shadow_runs (started_at DESC);
