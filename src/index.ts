import { generateLatestEdition } from "./generation";
import { runJev, runJevDirect } from "./jev";
import { getActiveProfile, getEdition, getSupplementalShadowRun, latestEdition, latestJevReviewShadowRun, latestRunStatus, latestScheduledRunStatus, latestSupplementalShadowRun, listEditions, listJevHumanReviews, listJevVerdicts, recordJevHumanReviews, recordJevVerdict, scheduledHeartbeat, updateProfile } from "./repository";
import { findJevDisagreements, jevVerdictStats } from "./verdicts";
import { buildJevReviewBatch } from "./jev-reviews";
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
    const runId = url.searchParams.get("run_id");
    const shadow = runId ? await getSupplementalShadowRun(env.DB, runId) : await latestJevReviewShadowRun(env.DB);
    if (!shadow?.report) return error("no supplemental shadow run is available for review", 404);
    if (!shadow.report.jevQuestionSetVersion || !shadow.report.jevQuestions) return error("latest Jev shadow run has no versioned question snapshot; wait for the next scored shadow run", 409);
    const sample = buildJevReviewBatch(shadow.id, shadow.report);
    const reviews = new Map((await listJevHumanReviews(env.DB, shadow.id)).map((review) => [review.storyUrl, review]));
    const sourceNames = new Map((shadow.report.sources ?? []).map((source) => [source.id, source.name]));
    return json({
      runId: shadow.id,
      issueDate: shadow.report.baseIssue.issueDate,
      generatedAt: shadow.report.generatedAt,
      profileVersion: shadow.report.profileVersion ?? null,
      sourcePack: shadow.report.sourcePack ?? null,
      questionSetVersion: shadow.report.jevQuestionSetVersion,
      questions: shadow.report.jevQuestions,
      items: sample.map((item) => {
        const saved = reviews.get(item.url);
        return {
          ...item,
          sourceNames: (item.sourceIds ?? []).map((id) => sourceNames.get(id) ?? id),
          decision: saved?.decision ?? null,
          rankPosition: saved?.rankPosition ?? null
        };
      })
    });
  }
  if (request.method === "POST" && url.pathname === "/api/jev-reviews") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const raw = await readJson(request);
    const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const runId = typeof body?.shadow_run_id === "string" ? body.shadow_run_id : "";
    const reviews = Array.isArray(body?.reviews) ? body.reviews : null;
    if (!runId || !reviews || reviews.length > 12) return error("body must contain a shadow_run_id and up to 12 reviews", 400);
    const shadow = await getSupplementalShadowRun(env.DB, runId);
    if (!shadow?.report) return error("shadow review batch has expired or does not exist", 404);
    const report = shadow.report;
    if (!report.jevQuestionSetVersion || !report.jevQuestions) return error("shadow run has no versioned Jev question snapshot", 409);
    const sample = buildJevReviewBatch(shadow.id, report);
    if (reviews.length !== sample.length) return error("review every candidate in this sample before saving", 400);
    const byUrl = new Map(sample.map((item) => [item.url, item]));
    const sourceNames = new Map((report.sources ?? []).map((source) => [source.id, source.name]));
    const seen = new Set<string>();
    const parsed: Array<{ url: string; decision: "publish" | "reject" | "unsure"; rankPosition: number | null }> = [];
    for (const rawReview of reviews) {
      const review = rawReview !== null && typeof rawReview === "object" && !Array.isArray(rawReview) ? rawReview as Record<string, unknown> : null;
      const storyUrl = typeof review?.story_url === "string" ? review.story_url : "";
      const decision = review?.decision;
      const rankPosition = review?.rank_position;
      if (!storyUrl || seen.has(storyUrl) || !byUrl.has(storyUrl)) return error("reviews must contain each sampled story once", 400);
      if (decision !== "publish" && decision !== "reject" && decision !== "unsure") return error("each decision must be publish, reject, or unsure", 400);
      if (decision === "publish" ? !Number.isInteger(rankPosition) || Number(rankPosition) < 1 : rankPosition !== null) return error("publish choices need a positive rank; reject and unsure choices need a null rank", 400);
      seen.add(storyUrl);
      parsed.push({ url: storyUrl, decision, rankPosition: decision === "publish" ? Number(rankPosition) : null });
    }
    const publishRanks = parsed.filter((review) => review.decision === "publish").map((review) => review.rankPosition!).sort((left, right) => left - right);
    if (publishRanks.some((rank, index) => rank !== index + 1)) return error("publish ranks must be unique and consecutive from 1", 400);
    await recordJevHumanReviews(env.DB, parsed.map((review) => {
      const item = byUrl.get(review.url)!;
      const sourceNameList = (item.sourceIds ?? []).map((id) => sourceNames.get(id) ?? id);
      return {
        shadowRunId: shadow.id,
        storyUrl: item.url,
        storyTitle: item.title,
        issueDate: report.baseIssue.issueDate,
        sampleStratum: item.sampleStratum,
        decision: review.decision,
        rankPosition: review.rankPosition,
        questionSetVersion: report.jevQuestionSetVersion!,
        profileVersion: report.profileVersion ?? null,
        sourcePackId: report.sourcePack?.id ?? null,
        sourcePackVersion: report.sourcePack?.version ?? null,
        snapshotJson: JSON.stringify({ candidate: { ...item, sourceNames: sourceNameList }, questions: report.jevQuestions })
      };
    }));
    return json({ ok: true, saved: parsed.length, runId: shadow.id });
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
    if ((url.pathname === "/__scheduled" || url.pathname === "/__shadow" || url.pathname === "/__jev-probe") && env.ENVIRONMENT === "production") return error("not found", 404);
    try {
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
