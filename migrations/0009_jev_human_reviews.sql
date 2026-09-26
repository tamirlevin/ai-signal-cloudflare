CREATE TABLE IF NOT EXISTS jev_human_reviews (
  shadow_run_id TEXT NOT NULL,
  story_url TEXT NOT NULL,
  story_title TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  sample_stratum TEXT NOT NULL CHECK (sample_stratum IN (
    'pipeline-selected_jev-publish',
    'pipeline-selected_jev-reject',
    'pipeline-excluded_jev-publish',
    'pipeline-excluded_jev-reject'
  )),
  decision TEXT NOT NULL CHECK (decision IN ('publish', 'reject', 'unsure')),
  rank_position INTEGER,
  question_set_version TEXT NOT NULL,
  profile_version INTEGER,
  source_pack_id TEXT,
  source_pack_version INTEGER,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shadow_run_id, story_url),
  CHECK (rank_position IS NULL OR rank_position > 0),
  CHECK ((decision = 'publish' AND rank_position IS NOT NULL) OR (decision <> 'publish' AND rank_position IS NULL))
);
