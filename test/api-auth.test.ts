import { describe, expect, it } from "vitest";
import worker from "../src/index";

const fakeEnv = (adminToken?: string) => ({
  ...(adminToken ? { ADMIN_TOKEN: adminToken } : {}),
  DB: {} as D1Database,
  AI: {} as Ai,
  ASSETS: {} as Fetcher,
  ENVIRONMENT: "production" as const,
  AI_MODEL: "@cf/openai/gpt-oss-120b" as const,
  AI_FALLBACK_MODEL: "@cf/zai-org/glm-4.7-flash" as const,
  AI_GATEWAY_ID: "" as const,
  SUPPLEMENTAL_SHADOW_ENABLED: "true" as const,
  SUPPLEMENTAL_BLEND_ENABLED: "true" as const,
  RSS_URL: "https://news.smol.ai/rss.xml" as const
});

const fakeContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {}
} as unknown as ExecutionContext;

describe("mutating API protection", () => {
  it("rejects a profile write without an owner token before it touches D1", async () => {
    const response = await worker.fetch(new Request("https://app.test/api/profile", { method: "PUT", body: "{}" }), fakeEnv("secret"), fakeContext);
    expect(response.status).toBe(401);
  });
  it("does not expose the local scheduled endpoint in production", async () => {
    const response = await worker.fetch(new Request("https://app.test/__scheduled"), fakeEnv(), fakeContext);
    expect(response.status).toBe(404);
  });
  it("does not expose the local shadow endpoint in production", async () => {
    const response = await worker.fetch(new Request("https://app.test/__shadow"), fakeEnv(), fakeContext);
    expect(response.status).toBe(404);
  });
});
