-- Read-only readout of the owner's Jev labels against the three judges. SELECT only.
-- Run against staging, for example:
--   npx wrangler d1 execute ai-signal-staging --env staging --remote --file scripts/label-readout.sql
-- These are the queries behind the 2 October 2026 readout in PROJECT_HISTORY.md. They are not the
-- in-app "How Jev is doing" panel; check numbers against it. Add a Clef readout only after the
-- comparison bar in PROJECT_HISTORY.md is met, and do not read Clef results before then.
--
-- How to read them: in the gate-only cells the rules picked the story and Jev would not; in the
-- jev-only cells the reverse. "publish" means the owner would publish it. The rules are right on
-- gate-only/publish and jev-only/reject; Jev is right on jev-only/publish and gate-only/reject.
-- The reranker picks a story when its rank is within jev_k (the rules' selection size for that run).

-- 1. Labels by cell and decision (unsure is excluded from every judge comparison and reported).
SELECT kind, decision, COUNT(*) AS events, COUNT(DISTINCT story_url) AS stories,
       COUNT(DISTINCT substr(created_at, 1, 10)) AS label_days
FROM jev_label_events
GROUP BY kind, decision
ORDER BY kind, decision;

-- 2. Reranker picks inside the paired cells (decided labels only).
WITH l AS (
  SELECT story_url, kind, decision, jev_k, run_id
  FROM jev_label_events
  WHERE kind IN ('disagree-gate-only', 'disagree-jev-only', 'anchor-both-in', 'anchor-both-out')
    AND decision IN ('publish', 'reject')
), t AS (
  SELECT l.*, (
    SELECT json_extract(x.value, '$.rank')
    FROM supplemental_shadow_runs r, json_each(r.report_json, '$.triageScores') x
    WHERE r.id = l.run_id AND json_extract(x.value, '$.url') = l.story_url LIMIT 1
  ) AS reranker_rank
  FROM l
)
SELECT kind, decision, COUNT(*) AS n, SUM(reranker_rank IS NULL) AS reranker_missing,
       SUM(reranker_rank IS NOT NULL AND reranker_rank <= jev_k) AS reranker_picks_it,
       SUM(reranker_rank IS NOT NULL AND reranker_rank > jev_k) AS reranker_skips_it
FROM t
GROUP BY kind, decision
ORDER BY kind, decision;

-- 3. Dropped pool: would Jev's own top-K (by reader_wants within the run) have picked the story?
WITH l AS (
  SELECT story_url, decision, jev_k, run_id
  FROM jev_label_events
  WHERE kind = 'dropped-pool' AND decision IN ('publish', 'reject')
), s AS (
  SELECT l.*, (
    SELECT json_extract(x.value, '$.readerWants')
    FROM supplemental_shadow_runs r, json_each(r.report_json, '$.jevScores') x
    WHERE r.id = l.run_id AND json_extract(x.value, '$.url') = l.story_url LIMIT 1
  ) AS reader_wants, (
    SELECT COUNT(*)
    FROM supplemental_shadow_runs r, json_each(r.report_json, '$.jevScores') y
    WHERE r.id = l.run_id AND json_extract(y.value, '$.readerWants') > (
      SELECT json_extract(x.value, '$.readerWants')
      FROM json_each(r.report_json, '$.jevScores') x
      WHERE json_extract(x.value, '$.url') = l.story_url LIMIT 1
    )
  ) AS scored_higher
  FROM l
)
SELECT decision, COUNT(*) AS n, SUM(reader_wants IS NULL) AS jev_missing,
       SUM(reader_wants IS NOT NULL AND scored_higher < jev_k) AS jev_would_pick,
       ROUND(AVG(reader_wants), 2) AS avg_reader_wants
FROM s
GROUP BY decision;

-- 4. The same dropped-pool stories against the reranker.
WITH l AS (
  SELECT story_url, decision, jev_k, run_id
  FROM jev_label_events
  WHERE kind = 'dropped-pool' AND decision IN ('publish', 'reject')
), t AS (
  SELECT l.*, (
    SELECT json_extract(x.value, '$.rank')
    FROM supplemental_shadow_runs r, json_each(r.report_json, '$.triageScores') x
    WHERE r.id = l.run_id AND json_extract(x.value, '$.url') = l.story_url LIMIT 1
  ) AS reranker_rank
  FROM l
)
SELECT decision, COUNT(*) AS n, SUM(reranker_rank IS NULL) AS reranker_missing,
       SUM(reranker_rank IS NOT NULL AND reranker_rank <= jev_k) AS reranker_would_pick
FROM t
GROUP BY decision;
