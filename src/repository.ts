import type { Edition, Profile, RunStatus, StoredEdition, SupplementalShadowReport, SupplementalShadowRun } from "./contracts";
import { DEFAULT_PROFILE } from "./contracts";
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

export async function latestRunStatus(db: D1Database): Promise<RunStatus | null> {
  const row = await db.prepare("SELECT trigger, status, issue_date, error_code, error_message, started_at, finished_at, duration_ms FROM runs ORDER BY started_at DESC LIMIT 1").first<{
    trigger: RunStatus["trigger"];
    status: RunStatus["status"];
    issue_date: string | null;
    error_code: string | null;
    error_message: string | null;
    started_at: string;
    finished_at: string;
    duration_ms: number;
  }>();
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
  run: { trigger: "cron" | "manual" | "local-scheduled"; status: "success" | "failed" | "skipped"; issueUrl?: string; issueDate?: string; model?: string; editionId?: string; errorCode?: string; errorMessage?: string; startedAt: string; durationMs: number }
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await db.prepare("INSERT INTO runs (id, trigger, issue_url, issue_date, status, model, edition_id, error_code, error_message, started_at, finished_at, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
    .bind(crypto.randomUUID(), run.trigger, run.issueUrl ?? null, run.issueDate ?? null, run.status, run.model ?? null, run.editionId ?? null, run.errorCode ?? null, run.errorMessage?.slice(0, 500) ?? null, run.startedAt, finishedAt, run.durationMs)
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
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO supplemental_shadow_runs (id, trigger, status, base_issue_url, base_issue_date, report_json, error_code, error_message, started_at, finished_at, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)")
      .bind(
        crypto.randomUUID(),
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
}

export async function latestSupplementalShadowRun(db: D1Database): Promise<SupplementalShadowRun | null> {
  const row = await db.prepare("SELECT id, trigger, status, base_issue_url, base_issue_date, report_json, error_code, error_message, started_at, finished_at, duration_ms FROM supplemental_shadow_runs ORDER BY started_at DESC LIMIT 1").first<{
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
  }>();
  if (!row) return null;
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

export function errorCode(error: unknown): string {
  if (error instanceof ValidationError) return "VALIDATION_FAILED";
  if (error instanceof SyntaxError) return "MODEL_JSON_INVALID";
  if (error instanceof Error && /(?:3007|3046|request timeout|timed out)/i.test(error.message)) return "MODEL_TIMEOUT";
  return "GENERATION_FAILED";
}
