import { generateLatestEdition } from "./generation";
import { getActiveProfile, getEdition, latestEdition, latestRunStatus, listEditions, updateProfile } from "./repository";
import { ValidationError } from "./validation";

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

async function api(request: Request, env: Env, url: URL): Promise<Response | null> {
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
  if (request.method === "GET" && url.pathname === "/api/editions") return json({ editions: await listEditions(env.DB) });
  if (request.method === "GET" && url.pathname === "/api/editions/latest") {
    const edition = await latestEdition(env.DB);
    return edition ? json({ edition }) : error("no edition has been published yet", 404);
  }
  const editionMatch = url.pathname.match(/^\/api\/editions\/(\d{4}-\d{2}-\d{2})$/);
  if (request.method === "GET" && editionMatch?.[1]) {
    const edition = await getEdition(env.DB, editionMatch[1]);
    return edition ? json({ edition }) : error("edition not found", 404);
  }
  if (request.method === "GET" && url.pathname === "/api/profile") return json({ profile: await getActiveProfile(env.DB) });
  if (request.method === "POST" && url.pathname === "/api/refresh") {
    if (!(await isAdmin(request, env))) return error("unauthorized", 401);
    const result = await generateLatestEdition(env, "manual");
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__scheduled" && env.ENVIRONMENT === "production") return error("not found", 404);
    try {
      if (url.pathname === "/__scheduled" && env.ENVIRONMENT !== "production") {
        if (!(await isAdmin(request, env))) return error("unauthorized", 401);
        return json(await generateLatestEdition(env, "local-scheduled"));
      }
      const response = await api(request, env, url);
      return response ?? secure(await env.ASSETS.fetch(request));
    } catch (caught) {
      const status = caught instanceof ValidationError ? 400 : 500;
      console.error(JSON.stringify({ message: "ai-signal request failed", path: url.pathname, error: caught instanceof Error ? caught.message : String(caught) }));
      return error(status === 400 ? caught instanceof Error ? caught.message : "invalid request" : "internal server error", status);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await generateLatestEdition(env, "cron");
  }
} satisfies ExportedHandler<Env>;
