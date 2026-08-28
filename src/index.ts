import { generateLatestEdition, supplementalBlendEnabled } from "./generation";
import { getActiveProfile, getEdition, latestEdition, latestRunStatus, latestSupplementalShadowRun, listEditions, updateProfile } from "./repository";
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
    return json({ lastRun: await latestRunStatus(env.DB), scheduledDailyAtUtc: "22:15" });
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
    if (supplementalShadowEnabled(env) && (!supplementalBlendEnabled(env) || (result.status === "skipped" && result.reason === "already-published"))) {
      ctx.waitUntil(runSupplementalShadow(env, "manual").then(() => undefined));
    }
    return json(result, result.status === "failed" ? 502 : 200);
  }
  if (request.method === "PUT" && url.pathname === "/api/profile") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const body = await readJson(request);
    return json({ profile: await updateProfile(env.DB, body) });
  }
  return error("not found", 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname === "/__scheduled" || url.pathname === "/__shadow") && env.ENVIRONMENT === "production") return error("not found", 404);
    try {
      if (url.pathname === "/__scheduled" && env.ENVIRONMENT !== "production") {
        if (!(await isAdmin(request, env))) return error("unauthorized", 401);
        return json(await generateLatestEdition(env, "local-scheduled"));
      }
      if (url.pathname === "/__shadow" && env.ENVIRONMENT !== "production") {
        return json(await runSupplementalShadow(env, "local-scheduled"));
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
    if (supplementalShadowEnabled(env) && (!supplementalBlendEnabled(env) || result.status === "skipped")) await runSupplementalShadow(env, "cron");
  }
} satisfies ExportedHandler<Env>;
