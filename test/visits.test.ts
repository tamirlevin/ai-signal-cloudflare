import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { visitorIdentity, visitorSetCookie } from "../src/visits";

function fakeContext() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    passThroughOnException() {},
    props: {}
  } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
}

function fakeDb() {
  const statement = (sql: string) => {
    const bound = {
      bind: (..._values: unknown[]) => bound,
      all: async () => sql.includes("FROM visits") ? { results: [{ id: "visit-1", visitor_key: "visitor-key-123", visit_day: "2026-08-15", path: "/", visited_at: "2026-08-15T08:00:00.000Z" }] } : { results: [] },
      first: async () => sql.includes("COUNT(*)") ? { total: 1 } : null,
      run: async () => ({ meta: { changes: 1 } })
    };
    return bound;
  };
  return {
    batch: async (_statements: unknown[]) => [],
    prepare: statement
  } as unknown as D1Database;
}

function fakeEnv(adminToken?: string) {
  return {
    ...(adminToken ? { ADMIN_TOKEN: adminToken } : {}),
    DB: fakeDb(),
    AI: {} as Ai,
    ASSETS: { fetch: async () => new Response("<!doctype html><title>AI Signal</title>", { headers: { "Content-Type": "text/html" } }) } as unknown as Fetcher,
    ENVIRONMENT: "production" as const,
    AI_MODEL: "@cf/openai/gpt-oss-120b" as const,
    AI_FALLBACK_MODEL: "@cf/zai-org/glm-4.7-flash" as const,
    AI_GATEWAY_ID: "" as const,
    SUPPLEMENTAL_SHADOW_ENABLED: "true" as const,
    RSS_URL: "https://news.smol.ai/rss.xml" as const
  };
}

describe("anonymous visit ledger", () => {
  it("reuses a valid browser key and creates a secure cookie only when needed", () => {
    const existing = visitorIdentity(new Request("https://app.test/", { headers: { Cookie: "ai_signal_visitor=visitor-key-123456789012345" } }));
    expect(existing).toEqual({ key: "visitor-key-123456789012345", setCookie: false });

    const fresh = visitorIdentity(new Request("https://app.test/"));
    expect(fresh.setCookie).toBe(true);
    expect(fresh.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(visitorSetCookie(fresh.key)).toContain("Secure");
    expect(visitorSetCookie(fresh.key)).toContain("HttpOnly");
    expect(visitorSetCookie(fresh.key)).toContain("SameSite=Lax");

    expect(visitorIdentity(new Request("https://app.test/", { headers: { Cookie: "ai_signal_visitor=%E0%A4%A" } })).setCookie).toBe(true);
  });

  it("records a public HTML visit without exposing the ledger", async () => {
    const context = fakeContext();
    const response = await worker.fetch(new Request("https://app.test/", { headers: { Accept: "text/html" } }), fakeEnv(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("ai_signal_visitor=");
    expect(context.pending).toHaveLength(1);
    await Promise.all(context.pending);
  });

  it("keeps the visit ledger owner-only", async () => {
    const unauthorized = await worker.fetch(new Request("https://app.test/api/visits"), fakeEnv("secret"), fakeContext());
    expect(unauthorized.status).toBe(401);

    const authorized = await worker.fetch(new Request("https://app.test/api/visits?limit=10", { headers: { Authorization: "Bearer secret" } }), fakeEnv("secret"), fakeContext());
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({
      visits: [{ id: "visit-1", visitorKey: "visitor-key-123", visitDay: "2026-08-15", path: "/", visitedAt: "2026-08-15T08:00:00.000Z" }],
      total: 1
    });
  });
});
