import { backfillClef, clefShadowModel } from "./clef";
import { summarizeClefComparison } from "./clef-analysis";
import { generateLatestEdition } from "./generation";
import { runJev, runJevDirect } from "./jev";
import { getActiveProfile, getEdition, getSupplementalShadowRun, jevLedgerStats, latestEdition, latestJevReviewShadowRun, latestRunStatus, latestScheduledRunStatus, latestSupplementalShadowRun, listEditions, listJevLabelEvents, listClefScores, listJevLabelEventsForRun, listJevVerdicts, recordJevLabelEvents, recordJevVerdict, scheduledHeartbeat, updateProfile } from "./repository";
import type { LabelEvent } from "./jev-ledger";
import type { SupplementalShadowReport } from "./contracts";
import { findJevDisagreements, jevVerdictStats } from "./verdicts";
import { buildDroppedBatch, buildPairedBatch, enrichEventsWithPicks, jevQuestionFingerprint, reviewPool, summarizeJevLabels, type JevDecision, type ReviewBatch, type ReviewMode } from "./jev-ledger";
import { runSupplementalShadow } from "./supplemental";
import { ValidationError } from "./validation";
import { listVisits, recordVisit, requestLocation, visitorIdentity, visitorSetCookie } from "./visits";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store"
};

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body: unknown, status = 200): Response {
  return secure(Response.json(body, { status, headers: { "Content-Type": "application/json; charset=utf-8" } }));
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

const TRACKED_DOCUMENT_PATHS = new Set(["/", "/history", "/history/"]);

function shouldTrackDocument(request: Request, url: URL): boolean {
  if (request.method !== "GET" || !TRACKED_DOCUMENT_PATHS.has(url.pathname)) return false;
  const accept = request.headers.get("Accept");
  return !accept || accept.includes("text/html");
}

function addResponseCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function trackDocumentVisit(request: Request, response: Response, env: Env, url: URL, ctx: ExecutionContext): Response {
  if (!shouldTrackDocument(request, url)) return response;
  const identity = visitorIdentity(request);
  ctx.waitUntil(recordVisit(env.DB, { visitorKey: identity.key, path: url.pathname, location: requestLocation(request) }).catch((caught) => {
    console.error(JSON.stringify({ message: "ai-signal visit recording failed", error: caught instanceof Error ? caught.message : String(caught) }));
  }));
  return identity.setCookie ? addResponseCookie(response, visitorSetCookie(identity.key)) : response;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  // `wrangler types` only generates configured bindings. Secrets are runtime bindings,
  // so this narrow augmentation keeps generated config types authoritative.
  const adminToken = (env as Env & { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
  if (!token || !adminToken) return false;
  const encoder = new TextEncoder();
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(adminToken))
  ]);
  const left = new Uint8Array(provided);
  const right = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > 32_768) throw new ValidationError("request body is too large");
  const body = await request.text();
  if (body.length > 32_768) throw new ValidationError("request body is too large");
  try { return JSON.parse(body); } catch { throw new ValidationError("request body must be valid JSON"); }
}

function supplementalShadowEnabled(env: Env): boolean {
  return env.SUPPLEMENTAL_SHADOW_ENABLED === "true";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function reviewMode(value: string | null): ReviewMode | null {
  return value === "paired" || value === "dropped" ? value : null;
}

function eventBelongsToMode(kind: string, mode: ReviewMode): boolean {
  return mode === "dropped" ? kind === "dropped-pool" : kind !== "dropped-pool";
}

function makeBatch(mode: ReviewMode, runId: string, report: SupplementalShadowReport, history: LabelEvent[]): ReviewBatch {
  return mode === "dropped" ? buildDroppedBatch(runId, report, history) : buildPairedBatch(runId, report, history);
}

/** Newest non-rank event per story within a set of events. */
function latestByStory(events: LabelEvent[]): LabelEvent[] {
  const latest = new Map<string, LabelEvent>();
  for (const event of events) if (event.kind !== "rank") latest.set(event.storyUrl, event);
  return [...latest.values()];
}

function savedItem(event: LabelEvent): Record<string, unknown> {
  let candidate: Record<string, unknown> = { url: event.storyUrl, title: event.storyUrl };
  try { candidate = (JSON.parse(event.snapshotJson) as { candidate: Record<string, unknown> }).candidate ?? candidate; } catch { /* keep the fallback */ }
  return { ...candidate, kind: event.kind, cellPopulation: event.cellPopulation, cellSampled: event.cellSampled };
}

async function api(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/")) return null;
  if (!sameOrigin(request)) return error("cross-origin requests are not allowed", 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  if (request.method === "GET" && url.pathname === "/api/health") {
    const latest = await latestEdition(env.DB);
    return json({ ok: true, latestPublished: Boolean(latest), environment: env.ENVIRONMENT });
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    const [lastRun, lastScheduledRun] = await Promise.all([latestRunStatus(env.DB), latestScheduledRunStatus(env.DB)]);
    return json({ lastRun, scheduledHeartbeat: scheduledHeartbeat(lastScheduledRun), scheduledDailyAtUtc: "22:15" });
  }
  if (request.method === "GET" && url.pathname === "/api/shadow/latest") {
    const shadow = await latestSupplementalShadowRun(env.DB);
    return shadow ? json({ shadow }) : error("no supplemental shadow run has completed yet", 404);
  }
  if (request.method === "GET" && url.pathname === "/api/editions") return json({ editions: await listEditions(env.DB) });
  if (request.method === "GET" && url.pathname === "/api/editions/latest") {
    const edition = await latestEdition(env.DB);
    return edition ? json({ edition }) : error("no edition has been published yet", 404);
  }
  if (request.method === "GET" && url.pathname === "/api/visits") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    return json(await listVisits(env.DB, Number.isFinite(requestedLimit) ? requestedLimit : 50));
  }
  const editionMatch = url.pathname.match(/^\/api\/editions\/(\d{4}-\d{2}-\d{2})$/);
  if (request.method === "GET" && editionMatch?.[1]) {
    const edition = await getEdition(env.DB, editionMatch[1]);
    return edition ? json({ edition }) : error("edition not found", 404);
  }
  if (request.method === "GET" && url.pathname === "/api/profile") return json({ profile: await getActiveProfile(env.DB) });
  if (request.method === "POST" && url.pathname === "/api/refresh") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const republish = ["1", "true"].includes((url.searchParams.get("republish") ?? "").toLowerCase());
    const result = await generateLatestEdition(env, "manual", { forceRepublish: republish });
    if (supplementalShadowEnabled(env) && result.status === "skipped" && result.reason === "already-published") {
      ctx.waitUntil(runSupplementalShadow(env, "manual").then(() => undefined));
    }
    return json(result, result.status === "failed" ? 502 : 200);
  }
  if (request.method === "PUT" && url.pathname === "/api/profile") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const body = await readJson(request);
    return json({ profile: await updateProfile(env.DB, body) });
  }
  if (request.method === "GET" && url.pathname === "/api/jev-disagreements") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const shadow = await latestSupplementalShadowRun(env.DB);
    if (!shadow?.report) return error("no supplemental shadow run has completed yet", 404);
    const decided = new Set((await listJevVerdicts(env.DB)).map((row) => row.storyUrl));
    return json({ generatedAt: shadow.report.generatedAt, disagreements: findJevDisagreements(shadow.report, decided) });
  }
  if (request.method === "GET" && url.pathname === "/api/jev-review-batch") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const mode = reviewMode(url.searchParams.get("mode"));
    if (!mode) return error("mode must be paired or dropped", 400);
    const runId = url.searchParams.get("run_id");
    const shadow = runId ? await getSupplementalShadowRun(env.DB, runId) : await latestJevReviewShadowRun(env.DB);
    if (!shadow?.report) return error("no Jev-scored shadow run is available for review yet", 404);
    const report = shadow.report;
    if (!report.jevQuestionSetVersion || !report.jevQuestions) return error("that shadow run has no versioned Jev question snapshot", 409);
    const context = {
      runId: shadow.id,
      issueDate: report.baseIssue.issueDate,
      generatedAt: report.generatedAt,
      profileVersion: report.profileVersion ?? null,
      sourcePack: report.sourcePack ?? null,
      questionSetVersion: report.jevQuestionSetVersion,
      questions: report.jevQuestions,
      mode
    };
    const saved = (await listJevLabelEventsForRun(env.DB, shadow.id)).filter((event) => eventBelongsToMode(event.kind, mode));
    if (saved.length) {
      const latest = latestByStory(saved);
      const ranks = new Map(saved.filter((event) => event.kind === "rank" && event.rankPosition !== null).map((event) => [event.storyUrl, event.rankPosition]));
      return json({ ...context, state: "saved", items: latest.map((event) => ({ ...savedItem(event), decision: event.decision, rankPosition: ranks.get(event.storyUrl) ?? null })) });
    }
    const batch = makeBatch(mode, shadow.id, report, await listJevLabelEvents(env.DB));
    const sourceNames = new Map((report.sources ?? []).map((source) => [source.id, source.name]));
    return json({
      ...context,
      state: "open",
      poolSize: batch.poolSize,
      jevK: batch.jevK,
      unscoredSelected: batch.unscoredSelected,
      complete: batch.complete,
      // Scores, gate outcome, sample group and cell sizes stay server-side until the batch is saved:
      // labels are the ground truth, so nothing about what any judge said may reach them first.
      items: batch.items.map((item) => ({
        url: item.url,
        title: item.title,
        summary: item.summary,
        publishedAt: item.publishedAt,
        sourceIds: item.sourceIds,
        sourceNames: item.sourceIds.map((id) => sourceNames.get(id as never) ?? id)
      }))
    });
  }
  if (request.method === "POST" && url.pathname === "/api/jev-labels") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const body = asRecord(await readJson(request));
    const mode = reviewMode(typeof body?.mode === "string" ? body.mode : null);
    const runId = typeof body?.run_id === "string" ? body.run_id : "";
    const labels = Array.isArray(body?.labels) ? body.labels : null;
    if (!mode || !runId || !labels) return error("body must contain mode, run_id and labels", 400);
    const shadow = await getSupplementalShadowRun(env.DB, runId);
    if (!shadow?.report) return error("that shadow run has expired or does not exist", 404);
    const report = shadow.report;
    if (!report.jevQuestionSetVersion || !report.jevQuestions) return error("that shadow run has no versioned Jev question snapshot", 409);
    const existing = await listJevLabelEventsForRun(env.DB, shadow.id);
    if (existing.some((event) => eventBelongsToMode(event.kind, mode))) return error("this batch is already saved; labels are append-only", 409);
    const history = await listJevLabelEvents(env.DB);
    const batch = makeBatch(mode, shadow.id, report, history);
    if (labels.length !== batch.items.length) return error("label every story in the batch before saving", 400);
    const byUrl = new Map(batch.items.map((item) => [item.url, item]));
    const decisions = new Map<string, JevDecision>();
    for (const raw of labels) {
      const label = asRecord(raw);
      const storyUrl = typeof label?.story_url === "string" ? label.story_url : "";
      const decision = label?.decision;
      if (!byUrl.has(storyUrl) || decisions.has(storyUrl)) return error("the batch changed or a story repeats; reload and label again", 400);
      if (decision !== "publish" && decision !== "reject" && decision !== "unsure") return error("each decision must be publish, reject or unsure", 400);
      decisions.set(storyUrl, decision);
    }
    const questionHash = await jevQuestionFingerprint(report.jevQuestions);
    const sourceNames = new Map((report.sources ?? []).map((source) => [source.id, source.name]));
    await recordJevLabelEvents(env.DB, batch.items.map((item) => ({
      storyUrl: item.url,
      questionHash,
      questionSetVersion: report.jevQuestionSetVersion!,
      runId: shadow.id,
      issueDate: report.baseIssue.issueDate,
      kind: item.kind,
      decision: decisions.get(item.url)!,
      rankPosition: null,
      cellPopulation: item.cellPopulation,
      cellSampled: item.cellSampled,
      poolSize: batch.poolSize,
      jevK: batch.jevK,
      profileVersion: report.profileVersion ?? null,
      sourcePackId: report.sourcePack?.id ?? null,
      sourcePackVersion: report.sourcePack?.version ?? null,
      snapshotJson: JSON.stringify({
        candidate: { url: item.url, title: item.title, summary: item.summary, publishedAt: item.publishedAt, sourceIds: item.sourceIds, sourceNames: item.sourceIds.map((id) => sourceNames.get(id as never) ?? id), assessment: item.assessment },
        questions: report.jevQuestions
      })
    })));
    const rankable = batch.items.filter((item) => item.kind !== "repeat" && item.kind !== "dropped-pool" && decisions.get(item.url) === "publish").map((item) => ({ url: item.url, title: item.title }));
    return json({ ok: true, saved: batch.items.length, runId: shadow.id, rankable });
  }
  if (request.method === "POST" && url.pathname === "/api/jev-labels/ranks") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const body = asRecord(await readJson(request));
    const runId = typeof body?.run_id === "string" ? body.run_id : "";
    const ranks = Array.isArray(body?.ranks) ? body.ranks : null;
    if (!runId || !ranks) return error("body must contain run_id and ranks", 400);
    const events = await listJevLabelEventsForRun(env.DB, runId);
    const votes = latestByStory(events.filter((event) => event.kind !== "rank"));
    const rankable = new Map(votes.filter((event) => event.kind !== "repeat" && event.kind !== "dropped-pool" && event.decision === "publish").map((event) => [event.storyUrl, event]));
    if (!rankable.size) return error("this run has no publish choices to rank", 409);
    const parsed = new Map<string, number>();
    for (const raw of ranks) {
      const entry = asRecord(raw);
      const storyUrl = typeof entry?.story_url === "string" ? entry.story_url : "";
      const position = entry?.rank_position;
      if (!rankable.has(storyUrl) || parsed.has(storyUrl)) return error("ranks must cover each publish choice exactly once", 400);
      if (typeof position !== "number" || !Number.isInteger(position) || position < 1) return error("each rank must be a positive whole number", 400);
      parsed.set(storyUrl, position);
    }
    if (parsed.size !== rankable.size) return error("rank every publish choice", 400);
    const ordered = [...parsed.values()].sort((left, right) => left - right);
    if (ordered.some((position, index) => position !== index + 1)) return error("ranks must be unique and consecutive from 1", 400);
    await recordJevLabelEvents(env.DB, [...parsed.entries()].map(([storyUrl, position]) => {
      const vote = rankable.get(storyUrl)!;
      return { storyUrl, questionHash: vote.questionHash, questionSetVersion: vote.questionSetVersion, runId, issueDate: vote.issueDate, kind: "rank" as const, decision: "publish" as const, rankPosition: position, cellPopulation: null, cellSampled: null, poolSize: vote.poolSize, jevK: vote.jevK, profileVersion: null, sourcePackId: null, sourcePackVersion: null, snapshotJson: "{}" };
    }));
    return json({ ok: true, ranked: parsed.size, runId });
  }
  if (request.method === "GET" && url.pathname === "/api/jev-analysis") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const [rawEvents, ledger] = await Promise.all([listJevLabelEvents(env.DB), jevLedgerStats(env.DB)]);
    // Each labelled run's retained report: older labels get their judge picks back from it, and the Clef
    // comparison rebuilds each run's pool from it. A pruned run is simply absent.
    const reports = new Map<string, SupplementalShadowReport>();
    for (const runId of new Set(rawEvents.filter((event) => event.kind !== "rank").map((event) => event.runId))) {
      const shadow = await getSupplementalShadowRun(env.DB, runId);
      if (shadow?.report) reports.set(runId, shadow.report);
    }
    // Isolated: a problem here must never take the main analysis down. The result stays locked, counts only,
    // until both frames hold enough decided stories (see clef-analysis.ts).
    let clef = null;
    try {
      const urls = [...new Set([...reports.values()].flatMap((report) => reviewPool(report).map((item) => item.url)))];
      clef = summarizeClefComparison(rawEvents, reports, await listClefScores(env.DB, clefShadowModel(env), urls));
    } catch (caught) {
      console.warn(JSON.stringify({ message: "ai-signal clef comparison unavailable", error: caught instanceof Error ? caught.message : String(caught) }));
    }
    return json({ analysis: summarizeJevLabels(enrichEventsWithPicks(rawEvents, reports)), ledger, clef });
  }
  if (request.method === "POST" && url.pathname === "/api/jev-verdicts") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const raw = await readJson(request);
    const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const storyUrl = typeof body?.story_url === "string" ? body.story_url : "";
    const verdict = body?.verdict === 1 || body?.verdict === -1 ? body.verdict : 0;
    if (!storyUrl || !verdict) return error("body must be { story_url: string, verdict: 1 | -1 }", 400);
    const existing = (await listJevVerdicts(env.DB)).find((row) => row.storyUrl === storyUrl);
    if (existing) {
      await recordJevVerdict(env.DB, { ...existing, verdict });
      return json({ ok: true, stats: jevVerdictStats(await listJevVerdicts(env.DB)) });
    }
    const shadow = await latestSupplementalShadowRun(env.DB);
    if (!shadow?.report) return error("no supplemental shadow run has completed yet", 404);
    const entry = findJevDisagreements(shadow.report).find((row) => row.url === storyUrl);
    if (!entry) return error("story is not a current Jev/gate disagreement", 404);
    await recordJevVerdict(env.DB, {
      storyUrl: entry.url,
      storyTitle: entry.title,
      issueDate: entry.issueDate,
      rerankerRelevance: entry.rerankerRelevance,
      rerankerRank: entry.rerankerRank,
      rerankerInterest: entry.rerankerInterest,
      jevInterest: entry.jevInterest,
      jevInterestConfidence: entry.jevInterestConfidence,
      jevNovel: entry.jevNovel,
      jevSubstantive: entry.jevSubstantive,
      jevReaderWants: entry.jevReaderWants,
      jevRecommendation: entry.jevRecommendation,
      jevConfident: entry.jevConfident,
      gateOutcome: entry.gateOutcome,
      verdict
    });
    return json({ ok: true, stats: jevVerdictStats(await listJevVerdicts(env.DB)) });
  }
  if (request.method === "GET" && url.pathname === "/api/jev-verdicts/stats") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    return json({ stats: jevVerdictStats(await listJevVerdicts(env.DB)) });
  }
  return error("not found", 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname === "/__scheduled" || url.pathname === "/__shadow" || url.pathname === "/__jev-probe" || url.pathname === "/__clef-backfill") && env.ENVIRONMENT === "production") return error("not found", 404);
    try {
      if (url.pathname === "/__clef-backfill" && env.ENVIRONMENT !== "production") {
        if (request.method !== "POST") return error("method not allowed", 405);
        if (!(await isAdmin(request, env))) return error("unauthorized", 401);
        const requested = Number(url.searchParams.get("limit") ?? 40);
        const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 60) : 40;
        return json(await backfillClef(env, await getActiveProfile(env.DB), limit));
      }
      if (url.pathname === "/__scheduled" && env.ENVIRONMENT !== "production") {
        if (!(await isAdmin(request, env))) return error("unauthorized", 401);
        return json(await generateLatestEdition(env, "local-scheduled"));
      }
      if (url.pathname === "/__shadow" && env.ENVIRONMENT !== "production") {
        return json(await runSupplementalShadow(env, "local-scheduled"));
      }
      if (url.pathname === "/__jev-probe" && env.ENVIRONMENT !== "production") {
        if (request.method !== "POST") return error("method not allowed", 405);
        const started = Date.now();
        const input = await request.json();
        const apiKey = (env as Env & { TYPESAFE_API_KEY?: string }).TYPESAFE_API_KEY;
        const via = apiKey ? "direct" : "workers-ai";
        const response = apiKey
          ? await runJevDirect(input as { state: unknown; questions: Record<string, { type: "noul" | "choice" | "score"; instructions: string }> }, apiKey)
          : await runJev(env.AI, input as { state: unknown; questions: Record<string, { type: "noul" | "choice" | "score"; instructions: string }> });
        return json({ via, response, durationMs: Date.now() - started });
      }
      const response = await api(request, env, url, ctx);
      if (response) return response;
      return trackDocumentVisit(request, secure(await env.ASSETS.fetch(request)), env, url, ctx);
    } catch (caught) {
      const status = caught instanceof ValidationError ? 400 : 500;
      console.error(JSON.stringify({ message: "ai-signal request failed", path: url.pathname, error: caught instanceof Error ? caught.message : String(caught) }));
      return error(status === 400 ? caught instanceof Error ? caught.message : "invalid request" : "internal server error", status);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await generateLatestEdition(env, "cron");
    if (supplementalShadowEnabled(env) && result.status === "skipped") await runSupplementalShadow(env, "cron");
  }
} satisfies ExportedHandler<Env>;
