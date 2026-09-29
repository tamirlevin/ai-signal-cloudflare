import type { Edition, ModelAttemptAudit, Profile, RunStatus, ScheduledHeartbeat, StoredEdition, SupplementalShadowReport, SupplementalShadowRun } from "./contracts";
import { DEFAULT_PROFILE } from "./contracts";
import { ModelJsonError, ModelOutputTruncatedError } from "./editorial";
import { normalizeEditionStories } from "./story-normalization";
import { synthesisNeedsRepair, ValidationError, validateEdition, validateProfile } from "./validation";
import type { JevVerdictRow } from "./verdicts";
import type { JudgmentRow, LabelEvent } from "./jev-ledger";

type EditionRow = {
  id: string;
  issue_url: string;
  issue_date: string;
  edition_json: string;
  published_at: string;
};

function stored(row: EditionRow): StoredEdition {
  const raw = JSON.parse(row.edition_json) as Edition;
  const profile = raw.profile ? validateProfile(raw.profile) : DEFAULT_PROFILE;
  const edition = normalizeEditionStories(validateEdition(raw, profile), profile).edition;
  return { ...edition, profile, id: row.id, issueDate: row.issue_date, publishedAt: row.published_at };
}

const MELBOURNE_TIME_ZONE = "Australia/Melbourne";

/** Returns the Melbourne calendar day used to bound owner-initiated republishing. */
export function melbourneCalendarDay(at: Date = new Date()): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of new Intl.DateTimeFormat("en-AU", { timeZone: MELBOURNE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at)) {
    if (part.type === "year") year = part.value;
    if (part.type === "month") month = part.value;
    if (part.type === "day") day = part.value;
  }
  if (!year || !month || !day) throw new Error("could not determine Melbourne calendar day");
  return `${year}-${month}-${day}`;
}

export type ManualRepublishClaim = Readonly<{ localDay: string; claimId: string }>;

/** Claims the one owner-initiated republish slot for a Melbourne calendar day. */
export async function claimManualRepublish(db: D1Database, localDay: string, claimedAt: Date = new Date()): Promise<ManualRepublishClaim | null> {
  const claimId = crypto.randomUUID();
  const result = await db.prepare("INSERT OR IGNORE INTO manual_republish_days (local_day, claim_id, status, claimed_at) VALUES (?1, ?2, 'active', ?3)")
    .bind(localDay, claimId, claimedAt.toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0 ? { localDay, claimId } : null;
}

/** Marks a completed republish so the daily claim cannot be reused. */
export async function completeManualRepublish(db: D1Database, claim: ManualRepublishClaim, completedAt: Date = new Date()): Promise<void> {
  await db.prepare("UPDATE manual_republish_days SET status = 'completed', completed_at = ?1 WHERE local_day = ?2 AND claim_id = ?3 AND status = 'active'")
    .bind(completedAt.toISOString(), claim.localDay, claim.claimId)
    .run();
}

/** Releases a claim when generation fails before an edition is replaced. */
export async function releaseManualRepublish(db: D1Database, claim: ManualRepublishClaim): Promise<void> {
  await db.prepare("DELETE FROM manual_republish_days WHERE local_day = ?1 AND claim_id = ?2 AND status = 'active'")
    .bind(claim.localDay, claim.claimId)
    .run();
}

export async function getActiveProfile(db: D1Database): Promise<Profile> {
  const row = await db.prepare("SELECT profile_json FROM profiles WHERE is_active = 1 LIMIT 1").first<{ profile_json: string }>();
  if (!row) return DEFAULT_PROFILE;
  return validateProfile(JSON.parse(row.profile_json));
}

export async function getEdition(db: D1Database, issueDate: string): Promise<StoredEdition | null> {
  const row = await db.prepare("SELECT id, issue_url, issue_date, edition_json, published_at FROM editions WHERE issue_date = ?1 LIMIT 1").bind(issueDate).first<EditionRow>();
  return row ? stored(row) : null;
}

export async function hasPublishedEdition(db: D1Database, issueUrl: string, issueDate: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM editions WHERE issue_url = ?1 OR issue_date = ?2 LIMIT 1").bind(issueUrl, issueDate).first<{ id: string }>();
  return row !== null;
}

export async function publishedEditionState(db: D1Database, issueUrl: string, issueDate: string): Promise<{ exists: boolean; needsStoryRepair: boolean }> {
  const row = await db.prepare("SELECT edition_json FROM editions WHERE issue_url = ?1 OR issue_date = ?2 LIMIT 1").bind(issueUrl, issueDate).first<{ edition_json: string }>();
  if (!row) return { exists: false, needsStoryRepair: false };
  const raw = JSON.parse(row.edition_json) as Edition;
  const profile = raw.profile ? validateProfile(raw.profile) : DEFAULT_PROFILE;
  const normalized = normalizeEditionStories(validateEdition(raw, profile), profile);
  return { exists: true, needsStoryRepair: normalized.duplicateSignalsRemoved > 0 || normalized.titlesRewritten > 0 || synthesisNeedsRepair(normalized.edition) };
}

export async function latestEdition(db: D1Database): Promise<StoredEdition | null> {
  const row = await db.prepare("SELECT id, issue_url, issue_date, edition_json, published_at FROM editions ORDER BY published_at DESC LIMIT 1").first<EditionRow>();
  return row ? stored(row) : null;
}

export async function listEditions(db: D1Database): Promise<Array<Pick<StoredEdition, "id" | "issueDate" | "publishedAt" | "issue">>> {
  const result = await db.prepare("SELECT id, issue_url, issue_date, edition_json, published_at FROM editions ORDER BY published_at DESC LIMIT 15").all<EditionRow>();
  return result.results.map((row) => {
    const edition = stored(row);
    return { id: edition.id, issueDate: edition.issueDate, publishedAt: edition.publishedAt, issue: edition.issue };
  });
}

type RunRow = {
  trigger: RunStatus["trigger"];
  status: RunStatus["status"];
  issue_date: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
};

function publicRunStatus(row: RunRow | null): RunStatus | null {
  if (!row) return null;
  return {
    trigger: row.trigger,
    status: row.status,
    ...(row.issue_date ? { issueDate: row.issue_date } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_code === "VALIDATION_FAILED" && row.error_message ? { failureDetail: row.error_message } : {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms
  };
}

export async function latestRunStatus(db: D1Database): Promise<RunStatus | null> {
  const row = await db.prepare("SELECT trigger, status, issue_date, error_code, error_message, started_at, finished_at, duration_ms FROM runs ORDER BY started_at DESC LIMIT 1").first<RunRow>();
  return publicRunStatus(row);
}

export async function latestScheduledRunStatus(db: D1Database): Promise<RunStatus | null> {
  const row = await db.prepare("SELECT trigger, status, issue_date, error_code, error_message, started_at, finished_at, duration_ms FROM runs WHERE trigger = 'cron' ORDER BY finished_at DESC LIMIT 1").first<RunRow>();
  return publicRunStatus(row);
}

export const SCHEDULED_HEARTBEAT_STALE_AFTER_HOURS = 26;

export function scheduledHeartbeat(lastScheduledRun: RunStatus | null, now: Date = new Date()): ScheduledHeartbeat {
  const staleAfterHours = SCHEDULED_HEARTBEAT_STALE_AFTER_HOURS;
  if (!lastScheduledRun) return { status: "missing", staleAfterHours };
  const completedAt = Date.parse(lastScheduledRun.finishedAt);
  if (!Number.isFinite(completedAt)) return { status: "missing", staleAfterHours };
  const ageMs = Math.max(0, now.getTime() - completedAt);
  return {
    status: ageMs > staleAfterHours * 60 * 60 * 1000 ? "stale" : "healthy",
    staleAfterHours,
    lastCompletedAt: lastScheduledRun.finishedAt,
    lastOutcome: lastScheduledRun.status
  };
}

export async function insertEdition(db: D1Database, edition: Edition, issueDate: string, sourceBodyHash: string): Promise<StoredEdition> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const result = await db.batch([
    db.prepare("INSERT OR IGNORE INTO editions (id, issue_url, issue_date, publication_date, edition_json, source_body_hash, published_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, edition.issue.url, issueDate, edition.issue.publicationDate, JSON.stringify(edition), sourceBodyHash, now),
    db.prepare("DELETE FROM editions WHERE id IN (SELECT id FROM editions ORDER BY published_at DESC LIMIT -1 OFFSET 15)")
  ]);
  if ((result[0]?.meta.changes ?? 0) === 0) {
    const existing = await getEdition(db, issueDate);
    if (existing) return existing;
    throw new Error("edition insert was ignored without an existing edition");
  }
  return { ...edition, id, issueDate, publishedAt: now };
}

export async function replaceEdition(db: D1Database, edition: Edition, issueDate: string, sourceBodyHash: string): Promise<StoredEdition> {
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE editions SET publication_date = ?1, edition_json = ?2, source_body_hash = ?3, published_at = ?4 WHERE issue_url = ?5 OR issue_date = ?6")
    .bind(edition.issue.publicationDate, JSON.stringify(edition), sourceBodyHash, now, edition.issue.url, issueDate)
    .run();
  if ((result.meta.changes ?? 0) === 0) return insertEdition(db, edition, issueDate, sourceBodyHash);
  const storedEdition = await getEdition(db, issueDate);
  if (!storedEdition) throw new Error("edition replacement succeeded but could not be read");
  return storedEdition;
}

export async function updateProfile(db: D1Database, raw: unknown): Promise<Profile> {
  const current = await getActiveProfile(db);
  const next = validateProfile(raw, current.version + 1);
  await db.batch([
    db.prepare("UPDATE profiles SET is_active = 0 WHERE is_active = 1"),
    db.prepare("INSERT INTO profiles (id, version, profile_json, is_active) VALUES (?1, ?2, ?3, 1)")
      .bind(crypto.randomUUID(), next.version, JSON.stringify(next))
  ]);
  return next;
}

export async function recordRun(
  db: D1Database,
  run: { trigger: "cron" | "manual" | "local-scheduled"; status: "success" | "failed" | "skipped"; issueUrl?: string; issueDate?: string; model?: string; editionId?: string; errorCode?: string; errorMessage?: string; modelAttempts?: ModelAttemptAudit[]; startedAt: string; durationMs: number }
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await db.prepare("INSERT INTO runs (id, trigger, issue_url, issue_date, status, model, edition_id, error_code, error_message, started_at, finished_at, duration_ms, model_attempts_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)")
    .bind(crypto.randomUUID(), run.trigger, run.issueUrl ?? null, run.issueDate ?? null, run.status, run.model ?? null, run.editionId ?? null, run.errorCode ?? null, run.errorMessage?.slice(0, 500) ?? null, run.startedAt, finishedAt, run.durationMs, run.modelAttempts?.length ? JSON.stringify(run.modelAttempts).slice(0, 8000) : null)
    .run();
}

export async function recordSupplementalShadowRun(
  db: D1Database,
  run: {
    trigger: SupplementalShadowRun["trigger"];
    status: SupplementalShadowRun["status"];
    startedAt: string;
    durationMs: number;
    report?: SupplementalShadowReport;
    errorCode?: string;
    errorMessage?: string;
  }
): Promise<string> {
  const finishedAt = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO supplemental_shadow_runs (id, trigger, status, base_issue_url, base_issue_date, report_json, error_code, error_message, started_at, finished_at, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
      .bind(
        id,
        run.trigger,
        run.status,
        run.report?.baseIssue.url ?? null,
        run.report?.baseIssue.issueDate ?? null,
        run.report ? JSON.stringify(run.report) : null,
        run.errorCode ?? null,
        run.errorMessage?.slice(0, 500) ?? null,
        run.startedAt,
        finishedAt,
        run.durationMs
      ),
    db.prepare("DELETE FROM supplemental_shadow_runs WHERE id IN (SELECT id FROM supplemental_shadow_runs ORDER BY started_at DESC LIMIT -1 OFFSET 15)")
  ]);
  return id;
}

type SupplementalShadowDbRow = {
  id: string;
  trigger: SupplementalShadowRun["trigger"];
  status: SupplementalShadowRun["status"];
  base_issue_url: string | null;
  base_issue_date: string | null;
  report_json: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
};

const SUPPLEMENTAL_SHADOW_COLUMNS = "id, trigger, status, base_issue_url, base_issue_date, report_json, error_code, error_message, started_at, finished_at, duration_ms";

function supplementalShadowFromRow(row: SupplementalShadowDbRow): SupplementalShadowRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    ...(row.base_issue_url ? { baseIssueUrl: row.base_issue_url } : {}),
    ...(row.base_issue_date ? { baseIssueDate: row.base_issue_date } : {}),
    ...(row.report_json ? { report: JSON.parse(row.report_json) as SupplementalShadowReport } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms
  };
}

export async function latestSupplementalShadowRun(db: D1Database): Promise<SupplementalShadowRun | null> {
  const row = await db.prepare(`SELECT ${SUPPLEMENTAL_SHADOW_COLUMNS} FROM supplemental_shadow_runs ORDER BY started_at DESC LIMIT 1`).first<SupplementalShadowDbRow>();
  return row ? supplementalShadowFromRow(row) : null;
}

/** Loads one retained shadow snapshot by its stable run ID for an in-progress admin review. */
export async function getSupplementalShadowRun(db: D1Database, runId: string): Promise<SupplementalShadowRun | null> {
  const row = await db.prepare(`SELECT ${SUPPLEMENTAL_SHADOW_COLUMNS} FROM supplemental_shadow_runs WHERE id = ?1 LIMIT 1`).bind(runId).first<SupplementalShadowDbRow>();
  return row ? supplementalShadowFromRow(row) : null;
}

/** Returns the newest retained run that has a versioned Jev question snapshot. */
export async function latestJevReviewShadowRun(db: D1Database): Promise<SupplementalShadowRun | null> {
  const result = await db.prepare(`SELECT ${SUPPLEMENTAL_SHADOW_COLUMNS} FROM supplemental_shadow_runs WHERE report_json IS NOT NULL ORDER BY started_at DESC LIMIT 15`).all<SupplementalShadowDbRow>();
  for (const row of result.results) {
    const shadow = supplementalShadowFromRow(row);
    if (shadow.report?.jevQuestionSetVersion && shadow.report.jevQuestions) return shadow;
  }
  return null;
}

export function errorCode(error: unknown): string {
  if (error instanceof ValidationError) return "VALIDATION_FAILED";
  if (error instanceof ModelOutputTruncatedError) return "MODEL_OUTPUT_TRUNCATED";
  if (error instanceof SyntaxError || error instanceof ModelJsonError) return "MODEL_JSON_INVALID";
  if (error instanceof Error && /(?:3007|3046|request timeout|timed out)/i.test(error.message)) return "MODEL_TIMEOUT";
  return "GENERATION_FAILED";
}

type JevVerdictDbRow = {
  story_url: string;
  story_title: string;
  issue_date: string;
  reranker_relevance: number | null;
  reranker_rank: number | null;
  reranker_interest: string | null;
  jev_interest: string | null;
  jev_interest_confidence: number | null;
  jev_novel: number | null;
  jev_substantive: number | null;
  jev_reader_wants: number | null;
  jev_recommendation: "publish" | "reject";
  jev_confident: number;
  gate_outcome: string;
  verdict: 1 | -1;
  created_at: string;
  updated_at: string;
};

function toVerdictRow(row: JevVerdictDbRow): JevVerdictRow {
  return {
    storyUrl: row.story_url,
    storyTitle: row.story_title,
    issueDate: row.issue_date,
    rerankerRelevance: row.reranker_relevance,
    rerankerRank: row.reranker_rank,
    rerankerInterest: row.reranker_interest,
    jevInterest: row.jev_interest,
    jevInterestConfidence: row.jev_interest_confidence,
    jevNovel: row.jev_novel,
    jevSubstantive: row.jev_substantive,
    jevReaderWants: row.jev_reader_wants,
    jevRecommendation: row.jev_recommendation,
    jevConfident: row.jev_confident === 1,
    gateOutcome: row.gate_outcome,
    verdict: row.verdict,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Owner verdict on one Jev/gate disagreement, snapshotted so later code or
 *  pack changes cannot rewrite history. Re-verdicting overwrites. */
export async function recordJevVerdict(db: D1Database, row: Omit<JevVerdictRow, "createdAt" | "updatedAt">): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO jev_verdicts (story_url, story_title, issue_date, reranker_relevance, reranker_rank, reranker_interest, jev_interest, jev_interest_confidence, jev_novel, jev_substantive, jev_reader_wants, jev_recommendation, jev_confident, gate_outcome, verdict, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17) ON CONFLICT(story_url) DO UPDATE SET story_title = excluded.story_title, issue_date = excluded.issue_date, reranker_relevance = excluded.reranker_relevance, reranker_rank = excluded.reranker_rank, reranker_interest = excluded.reranker_interest, jev_interest = excluded.jev_interest, jev_interest_confidence = excluded.jev_interest_confidence, jev_novel = excluded.jev_novel, jev_substantive = excluded.jev_substantive, jev_reader_wants = excluded.jev_reader_wants, jev_recommendation = excluded.jev_recommendation, jev_confident = excluded.jev_confident, gate_outcome = excluded.gate_outcome, verdict = excluded.verdict, updated_at = excluded.updated_at")
    .bind(row.storyUrl, row.storyTitle, row.issueDate, row.rerankerRelevance, row.rerankerRank, row.rerankerInterest, row.jevInterest, row.jevInterestConfidence, row.jevNovel, row.jevSubstantive, row.jevReaderWants, row.jevRecommendation, row.jevConfident ? 1 : 0, row.gateOutcome, row.verdict, now, now)
    .run();
}

export async function listJevVerdicts(db: D1Database): Promise<JevVerdictRow[]> {
  const result = await db.prepare("SELECT story_url, story_title, issue_date, reranker_relevance, reranker_rank, reranker_interest, jev_interest, jev_interest_confidence, jev_novel, jev_substantive, jev_reader_wants, jev_recommendation, jev_confident, gate_outcome, verdict, created_at, updated_at FROM jev_verdicts ORDER BY updated_at DESC").all<JevVerdictDbRow>();
  return result.results.map(toVerdictRow);
}

/**
 * Records one shadow run's Jev scores in the durable ledger. The first non-null score per
 * question fingerprint is kept; later sightings only refresh the gate outcome and flags.
 */
export async function recordJevJudgments(db: D1Database, rows: JudgmentRow[]): Promise<void> {
  if (!rows.length) return;
  const statement = "INSERT INTO jev_judgments (story_url, question_hash, question_set_version, title, summary, published_at, source_ids_json, first_run_id, issue_date, first_seen_at, last_seen_at, times_seen, interest, interest_confidence, novel, substantive, reader_wants, reranker_relevance, reranker_raw, reranker_rank, reranker_interest, gate_outcome, ever_selected, ever_published, profile_version, source_pack_id, source_pack_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 1, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25) "
    + "ON CONFLICT(story_url, question_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at, times_seen = jev_judgments.times_seen + 1, gate_outcome = excluded.gate_outcome, "
    + "ever_selected = MAX(jev_judgments.ever_selected, excluded.ever_selected), ever_published = MAX(jev_judgments.ever_published, excluded.ever_published), "
    + "interest = COALESCE(jev_judgments.interest, excluded.interest), interest_confidence = COALESCE(jev_judgments.interest_confidence, excluded.interest_confidence), "
    + "novel = COALESCE(jev_judgments.novel, excluded.novel), substantive = COALESCE(jev_judgments.substantive, excluded.substantive), reader_wants = COALESCE(jev_judgments.reader_wants, excluded.reader_wants), "
    + "reranker_relevance = COALESCE(jev_judgments.reranker_relevance, excluded.reranker_relevance), reranker_raw = COALESCE(jev_judgments.reranker_raw, excluded.reranker_raw), "
    + "reranker_rank = COALESCE(jev_judgments.reranker_rank, excluded.reranker_rank), reranker_interest = COALESCE(jev_judgments.reranker_interest, excluded.reranker_interest)";
  await db.batch(rows.map((row) => db.prepare(statement).bind(
    row.storyUrl, row.questionHash, row.questionSetVersion, row.title, row.summary, row.publishedAt, row.sourceIdsJson, row.firstRunId, row.issueDate, row.seenAt,
    row.interest, row.interestConfidence, row.novel, row.substantive, row.readerWants, row.rerankerRelevance, row.rerankerRaw, row.rerankerRank, row.rerankerInterest,
    row.gateOutcome, row.selected ? 1 : 0, row.published ? 1 : 0, row.profileVersion, row.sourcePackId, row.sourcePackVersion
  )));
}

export async function jevLedgerStats(db: D1Database): Promise<{ judgments: number; stories: number; withReaderWants: number; firstSeenAt: string | null }> {
  const row = await db.prepare("SELECT COUNT(*) AS judgments, COUNT(DISTINCT story_url) AS stories, SUM(CASE WHEN reader_wants IS NOT NULL THEN 1 ELSE 0 END) AS with_wants, MIN(first_seen_at) AS first_seen FROM jev_judgments")
    .first<{ judgments: number; stories: number; with_wants: number | null; first_seen: string | null }>();
  return { judgments: row?.judgments ?? 0, stories: row?.stories ?? 0, withReaderWants: row?.with_wants ?? 0, firstSeenAt: row?.first_seen ?? null };
}

type JevLabelEventDbRow = {
  id: number;
  story_url: string;
  question_hash: string;
  question_set_version: string;
  run_id: string;
  issue_date: string;
  kind: LabelEvent["kind"];
  decision: LabelEvent["decision"];
  rank_position: number | null;
  cell_population: number | null;
  cell_sampled: number | null;
  pool_size: number | null;
  jev_k: number | null;
  snapshot_json: string;
  created_at: string;
};

const LABEL_EVENT_COLUMNS = "id, story_url, question_hash, question_set_version, run_id, issue_date, kind, decision, rank_position, cell_population, cell_sampled, pool_size, jev_k, snapshot_json, created_at";

function toLabelEvent(row: JevLabelEventDbRow): LabelEvent {
  return {
    id: row.id,
    storyUrl: row.story_url,
    questionHash: row.question_hash,
    questionSetVersion: row.question_set_version,
    runId: row.run_id,
    issueDate: row.issue_date,
    kind: row.kind,
    decision: row.decision,
    rankPosition: row.rank_position,
    cellPopulation: row.cell_population,
    cellSampled: row.cell_sampled,
    poolSize: row.pool_size,
    jevK: row.jev_k,
    snapshotJson: row.snapshot_json,
    createdAt: row.created_at
  };
}

/** Every label event, oldest first, so the first vote per story is stable. */
export async function listJevLabelEvents(db: D1Database): Promise<LabelEvent[]> {
  const result = await db.prepare(`SELECT ${LABEL_EVENT_COLUMNS} FROM jev_label_events ORDER BY id ASC`).all<JevLabelEventDbRow>();
  return result.results.map(toLabelEvent);
}

export async function listJevLabelEventsForRun(db: D1Database, runId: string): Promise<LabelEvent[]> {
  const result = await db.prepare(`SELECT ${LABEL_EVENT_COLUMNS} FROM jev_label_events WHERE run_id = ?1 ORDER BY id ASC`).bind(runId).all<JevLabelEventDbRow>();
  return result.results.map(toLabelEvent);
}

export type NewLabelEvent = Omit<LabelEvent, "id" | "createdAt"> & { profileVersion: number | null; sourcePackId: string | null; sourcePackVersion: number | null };

/** Appends label events. Events are never edited; a changed mind is a new event. */
export async function recordJevLabelEvents(db: D1Database, events: NewLabelEvent[]): Promise<void> {
  if (!events.length) return;
  const now = new Date().toISOString();
  await db.batch(events.map((event) => db.prepare("INSERT INTO jev_label_events (story_url, question_hash, question_set_version, run_id, issue_date, kind, decision, rank_position, cell_population, cell_sampled, pool_size, jev_k, profile_version, source_pack_id, source_pack_version, snapshot_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)")
    .bind(event.storyUrl, event.questionHash, event.questionSetVersion, event.runId, event.issueDate, event.kind, event.decision, event.rankPosition, event.cellPopulation, event.cellSampled, event.poolSize, event.jevK, event.profileVersion, event.sourcePackId, event.sourcePackVersion, event.snapshotJson, now)));
}
