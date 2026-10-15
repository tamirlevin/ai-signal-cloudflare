import type { Edition, ModelAttemptAudit, Profile, RunStatus, ScheduledHeartbeat, StoredEdition, SupplementalShadowReport, SupplementalShadowRun } from "./contracts";
import { DEFAULT_PROFILE } from "./contracts";
import { ModelJsonError, ModelOutputTruncatedError } from "./editorial";
import { normalizeEditionStories } from "./story-normalization";
import { synthesisNeedsRepair, ValidationError, validateEdition, validateProfile } from "./validation";

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
    /** Supply when the id must be known before the run is recorded, so scores can carry it. */
    id?: string;
    trigger: SupplementalShadowRun["trigger"];
    status: SupplementalShadowRun["status"];
    startedAt: string;
    durationMs: number;
    report?: SupplementalShadowReport;
    errorCode?: string;
    errorMessage?: string;
  },
  environment: Env["ENVIRONMENT"] = "production"
): Promise<string> {
  const finishedAt = new Date().toISOString();
  const id = run.id ?? crypto.randomUUID();
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
    // Staging needs a longer evidence window for blind judge comparisons.
    db.prepare("DELETE FROM supplemental_shadow_runs WHERE id IN (SELECT id FROM supplemental_shadow_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?1)")
      .bind(environment === "staging" ? 60 : 15)
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

export type ClefJudgmentRow = {
  storyUrl: string;
  questionHash: string;
  model: string;
  questionSetVersion: string;
  runId: string | null;
  scoredAt: string;
  interest: string | null;
  interestConfidence: number | null;
  novel: number | null;
  substantive: number | null;
  readerWants: number | null;
};

export function errorCode(error: unknown): string {
  if (error instanceof ValidationError) return "VALIDATION_FAILED";
  if (error instanceof ModelOutputTruncatedError) return "MODEL_OUTPUT_TRUNCATED";
  if (error instanceof SyntaxError || error instanceof ModelJsonError) return "MODEL_JSON_INVALID";
  if (error instanceof Error && /(?:3007|3046|request timeout|timed out)/i.test(error.message)) return "MODEL_TIMEOUT";
  return "GENERATION_FAILED";
}

/** Records Clef scores. The first score per story, question fingerprint and model is kept. */
export async function recordClefJudgments(db: D1Database, rows: ClefJudgmentRow[]): Promise<void> {
  if (!rows.length) return;
  const statement = "INSERT INTO clef_judgments (story_url, question_hash, model, question_set_version, run_id, scored_at, interest, interest_confidence, novel, substantive, reader_wants) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(story_url, question_hash, model) DO NOTHING";
  await db.batch(rows.map((row) => db.prepare(statement).bind(
    row.storyUrl, row.questionHash, row.model, row.questionSetVersion, row.runId, row.scoredAt, row.interest, row.interestConfidence, row.novel, row.substantive, row.readerWants
  )));
}

/** Which of these stories already have a Clef score for this question fingerprint and model. */
export async function scoredClefUrls(db: D1Database, questionHash: string, model: string, urls: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let index = 0; index < urls.length; index += 50) {
    const chunk = urls.slice(index, index + 50);
    const marks = chunk.map((_, position) => `?${position + 3}`).join(", ");
    const result = await db.prepare(`SELECT story_url FROM clef_judgments WHERE question_hash = ?1 AND model = ?2 AND story_url IN (${marks})`)
      .bind(questionHash, model, ...chunk).all<{ story_url: string }>();
    for (const row of result.results) found.add(row.story_url);
  }
  return found;
}

/** Stored Clef reader_wants for these stories, one row per story and question fingerprint. */
export async function listClefScores(db: D1Database, model: string, urls: string[]): Promise<Array<{ storyUrl: string; questionHash: string; readerWants: number | null }>> {
  const rows: Array<{ storyUrl: string; questionHash: string; readerWants: number | null }> = [];
  for (let index = 0; index < urls.length; index += 90) {
    const chunk = urls.slice(index, index + 90);
    const marks = chunk.map((_, position) => `?${position + 2}`).join(", ");
    const result = await db.prepare(`SELECT story_url, question_hash, reader_wants FROM clef_judgments WHERE model = ?1 AND story_url IN (${marks})`)
      .bind(model, ...chunk).all<{ story_url: string; question_hash: string; reader_wants: number | null }>();
    for (const row of result.results) rows.push({ storyUrl: row.story_url, questionHash: row.question_hash, readerWants: row.reader_wants });
  }
  return rows;
}

/** Ledger stories with no Clef score yet under this fingerprint, labelled stories first. */
export async function unscoredClefStories(db: D1Database, questionHash: string, model: string, limit: number): Promise<{ stories: Array<{ storyUrl: string; title: string; summary: string }>; remaining: number }> {
  const missing = "FROM jev_judgments j WHERE j.question_hash = ?1 AND NOT EXISTS (SELECT 1 FROM clef_judgments c WHERE c.story_url = j.story_url AND c.question_hash = j.question_hash AND c.model = ?2)";
  const rows = await db.prepare(`SELECT j.story_url, j.title, j.summary ${missing} ORDER BY (SELECT COUNT(*) FROM jev_label_events e WHERE e.story_url = j.story_url) DESC, j.first_seen_at LIMIT ?3`)
    .bind(questionHash, model, limit).all<{ story_url: string; title: string; summary: string }>();
  const total = await db.prepare(`SELECT COUNT(*) AS n ${missing}`).bind(questionHash, model).first<{ n: number }>();
  return { stories: rows.results.map((row) => ({ storyUrl: row.story_url, title: row.title, summary: row.summary })), remaining: total?.n ?? 0 };
}
