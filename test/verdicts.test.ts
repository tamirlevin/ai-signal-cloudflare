import { describe, expect, it } from "vitest";
import type { SupplementalShadowReport } from "../src/contracts";
import worker from "../src/index";
import { listJevVerdicts, recordJevVerdict } from "../src/repository";
import { findJevDisagreements, jevRecommendation, jevVerdictStats, type JevVerdictRow } from "../src/verdicts";

function report(): SupplementalShadowReport {
  return {
    schemaVersion: 1,
    mode: "daily-pool",
    generatedAt: "2026-09-24T10:00:00.000Z",
    baseIssue: { url: "https://signal.tamirlevin.dev/?edition=2026-09-24", issueDate: "2026-09-24", publicationDate: "24 September 2026" },
    limits: { modelCandidates: 18, publishedStories: 14 },
    sources: [],
    totals: { aiNewsCandidates: 0, supplementalCandidates: 0, supplementalAfterDeduplication: 0, overlapsWithAiNews: 0, novelQualifiedCandidates: 0, wouldAdd: 0 },
    overlaps: [],
    wouldAdd: [],
    triageScores: [
      { url: "https://example.com/kept", title: "Kept", relevance: 0.9, rawRelevance: 0.5, winningInterest: "New systems", rank: 1, novelty: 0.5, outcome: "selected", sourceIds: [] },
      { url: "https://example.com/dropped", title: "Dropped", relevance: 0.8, rawRelevance: 0.4, winningInterest: "New systems", rank: 2, novelty: 0.5, outcome: "weakProfileFit", sourceIds: [] },
      { url: "https://example.com/quiet", title: "Quiet", relevance: 0.1, rawRelevance: 0.01, winningInterest: "New systems", rank: 9, novelty: 0.5, outcome: "weakProfileFit", sourceIds: [] }
    ],
    jevScores: [
      { url: "https://example.com/kept", title: "Kept", interest: "New systems", interestConfidence: 0.9, novel: 0.9, substantive: 0.9, readerWants: 0.9, outcome: "selected" },
      { url: "https://example.com/dropped", title: "Dropped", interest: "New systems", interestConfidence: 0.9, novel: 0.9, substantive: 0.9, readerWants: 0.9, outcome: "weakProfileFit" },
      { url: "https://example.com/quiet", title: "Quiet", interest: "none", interestConfidence: 0.9, novel: 0.1, substantive: 0.1, readerWants: 0.1, outcome: "weakProfileFit" }
    ]
  };
}

describe("jev recommendation", () => {
  it("publishes only on substantive, novel, fitted, wanted answers and fails closed unscored", () => {
    expect(jevRecommendation({ substantive: 0.9, novel: 0.9, interest: "New systems", readerWants: 0.9 })).toEqual({ recommendation: "publish", confident: true });
    expect(jevRecommendation({ substantive: 0.6, novel: 0.6, interest: "New systems", readerWants: 0.6 }).recommendation).toBe("publish");
    expect(jevRecommendation({ substantive: 0.9, novel: 0.9, interest: "New systems", readerWants: 0.1 })).toEqual({ recommendation: "reject", confident: true });
    expect(jevRecommendation({ substantive: 0.9, novel: 0.9, interest: "none", readerWants: 0.9 })).toEqual({ recommendation: "reject", confident: true });
    expect(jevRecommendation({ substantive: 0.1, novel: 0.9, interest: "New systems", readerWants: 0.9 })).toEqual({ recommendation: "reject", confident: true });
    expect(jevRecommendation({ substantive: 0.4, novel: 0.4, interest: "New systems", readerWants: 0.4 })).toEqual({ recommendation: "reject", confident: false });
    expect(jevRecommendation({ substantive: null, novel: null, interest: null, readerWants: null })).toEqual({ recommendation: "reject", confident: false });
    expect(jevRecommendation({ substantive: null, novel: null, interest: "none", readerWants: null })).toEqual({ recommendation: "reject", confident: true });
  });
});

describe("disagreement picker", () => {
  it("finds published-but-panned and rejected-but-praised rows only", () => {
    const found = findJevDisagreements(report());
    expect(found.map((entry) => entry.url)).toEqual(["https://example.com/dropped"]);
    expect(found[0]).toMatchObject({ jevRecommendation: "publish", jevConfident: true, gateOutcome: "weakProfileFit", rerankerRank: 2 });
  });
  it("excludes decided urls and caps confident-first", () => {
    const found = findJevDisagreements(report(), new Set(["https://example.com/dropped"]));
    expect(found).toEqual([]);
  });
});

describe("verdict stats", () => {
  const row = (verdict: 1 | -1, jevRecommendation: "publish" | "reject", jevConfident: boolean): JevVerdictRow => ({
    storyUrl: `https://example.com/${verdict}-${jevRecommendation}`, storyTitle: "T", issueDate: "2026-09-24",
    rerankerRelevance: null, rerankerRank: null, rerankerInterest: null,
    jevInterest: null, jevInterestConfidence: null, jevNovel: null, jevSubstantive: null, jevReaderWants: null,
    jevRecommendation, jevConfident, gateOutcome: "selected", verdict,
    createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z"
  });
  it("counts sided share and confident-reject misses", () => {
    const stats = jevVerdictStats([row(1, "publish", true), row(-1, "reject", false), row(1, "reject", true), row(-1, "publish", false)]);
    expect(stats).toMatchObject({ total: 4, sidedWithJev: 0.5, confidentRejectMisses: 1, publishVerdicts: 2, rejectVerdicts: 2 });
    expect(jevVerdictStats([])).toMatchObject({ total: 0, sidedWithJev: 0, confidentRejectMisses: 0 });
  });
});

function fakeDb(initial: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = { jev_verdicts: [], ...initial };
  const statements: string[] = [];
  const bound = (sql: string, values: unknown[]) => ({
    bind: (...v: unknown[]) => bound(sql, v),
    run: async () => {
      statements.push(sql);
      if (sql.includes("INSERT INTO jev_verdicts")) {
        const cols = ["story_url", "story_title", "issue_date", "reranker_relevance", "reranker_rank", "reranker_interest", "jev_interest", "jev_interest_confidence", "jev_novel", "jev_substantive", "jev_reader_wants", "jev_recommendation", "jev_confident", "gate_outcome", "verdict", "created_at", "updated_at"];
        const record = Object.fromEntries(cols.map((col, index) => [col, values[index]]));
        const table = tables.jev_verdicts!;
        const at = table.findIndex((entry) => entry.story_url === record.story_url);
        if (at >= 0) table[at] = { ...table[at], ...record };
        else table.push(record);
      }
      return { meta: {} };
    },
    all: async () => {
      if (sql.includes("FROM jev_verdicts")) return { results: [...tables.jev_verdicts!] };
      return { results: [] };
    },
    first: async () => null
  });
  return {
    db: { batch: async () => [], prepare: (sql: string) => bound(sql, []) } as unknown as D1Database,
    tables
  };
}

describe("verdict storage", () => {
  it("upserts by story url and lists newest first", async () => {
    const { db, tables } = fakeDb();
    await recordJevVerdict(db, {
      storyUrl: "https://example.com/a", storyTitle: "A", issueDate: "2026-09-24",
      rerankerRelevance: 0.9, rerankerRank: 1, rerankerInterest: "New systems",
      jevInterest: "New systems", jevInterestConfidence: 0.8, jevNovel: 0.9, jevSubstantive: 0.9, jevReaderWants: 0.9,
      jevRecommendation: "publish", jevConfident: true, gateOutcome: "weakProfileFit", verdict: 1
    });
    await recordJevVerdict(db, {
      storyUrl: "https://example.com/a", storyTitle: "A", issueDate: "2026-09-24",
      rerankerRelevance: 0.9, rerankerRank: 1, rerankerInterest: "New systems",
      jevInterest: "New systems", jevInterestConfidence: 0.8, jevNovel: 0.9, jevSubstantive: 0.9, jevReaderWants: 0.9,
      jevRecommendation: "publish", jevConfident: true, gateOutcome: "weakProfileFit", verdict: -1
    });
    expect(tables.jev_verdicts).toHaveLength(1);
    expect(await listJevVerdicts(db)).toMatchObject([{ storyUrl: "https://example.com/a", verdict: -1, jevConfident: true }]);
  });
});

const fakeContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

function fakeEnv(db: D1Database, report: SupplementalShadowReport | null) {
  return {
    ADMIN_TOKEN: "secret",
    DB: db,
    AI: {} as Ai,
    ASSETS: { fetch: async () => new Response("x") } as unknown as Fetcher,
    ENVIRONMENT: "production" as const,
    AI_MODEL: "@cf/openai/gpt-oss-120b" as const,
    AI_FALLBACK_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const,
    AI_QUALITY_FALLBACK_MODEL: "@cf/moonshotai/kimi-k2.6" as const,
    AI_GATEWAY_ID: "" as const,
    SUPPLEMENTAL_SHADOW_ENABLED: "true" as const,
    TRIAGE_SHADOW_ENABLED: "false" as const,
    JEV_SHADOW_ENABLED: "false" as const,
    RSS_URL: "https://news.smol.ai/rss.xml" as const,
    __report: report
  };
}

function apiDb(report: SupplementalShadowReport | null) {
  const { db, tables } = fakeDb();
  const base = db.prepare.bind(db);
  const wrapped = {
    batch: async () => [],
    prepare: (sql: string) => {
      if (sql.includes("FROM supplemental_shadow_runs")) {
        return {
          bind: (..._v: unknown[]) => ({ run: async () => ({}), all: async () => ({ results: [] }), first: async () => null }),
          run: async () => ({}),
          all: async () => ({ results: [] }),
          first: async () => report ? { report_json: JSON.stringify(report) } : null
        };
      }
      return base(sql);
    }
  } as unknown as D1Database;
  return { db: wrapped, tables };
}

describe("verdict endpoints", () => {
  it("requires the owner token", async () => {
    const { db } = apiDb(report());
    const env = { ...fakeEnv(db, report()), ADMIN_TOKEN: undefined };
    for (const [method, path, body] of [["GET", "/api/jev-disagreements"], ["POST", "/api/jev-verdicts", {}], ["GET", "/api/jev-verdicts/stats"]] as const) {
      const response = await worker.fetch(
        new Request(`https://app.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
        env as unknown as Env, fakeContext);
      expect(response.status).toBe(401);
    }
  });

  it("lists open disagreements, records a verdict from the latest snapshot, and reports stats", async () => {
    const rep = report();
    const { db } = apiDb(rep);
    const env = fakeEnv(db, rep);
    const headers = { Authorization: "Bearer secret" };
    const open = await (await worker.fetch(new Request("https://app.test/api/jev-disagreements", { headers }), env as unknown as Env, fakeContext)).json() as { disagreements: Array<{ url: string }> };
    expect(open.disagreements.map((entry) => entry.url)).toEqual(["https://example.com/dropped"]);
    const posted = await (await worker.fetch(new Request("https://app.test/api/jev-verdicts", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ story_url: "https://example.com/dropped", verdict: 1 })
    }), env as unknown as Env, fakeContext)).json() as { stats: { total: number; sidedWithJev: number } };
    expect(posted.stats).toMatchObject({ total: 1, sidedWithJev: 1 });
    const reopened = await (await worker.fetch(new Request("https://app.test/api/jev-disagreements", { headers }), env as unknown as Env, fakeContext)).json() as { disagreements: unknown[] };
    expect(reopened.disagreements).toEqual([]);
    const bad = await worker.fetch(new Request("https://app.test/api/jev-verdicts", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ story_url: "https://example.com/quiet", verdict: 1 })
    }), env as unknown as Env, fakeContext);
    expect(bad.status).toBe(404);
  });
});
