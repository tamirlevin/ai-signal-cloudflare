import { describe, expect, it, vi } from "vitest";
import { generateLatestEdition } from "../src/generation";

const issueUrl = "https://news.smol.ai/issues/republish-test";
const firstSource = "https://example.com/agent-permissions";
const secondSource = "https://example.com/agent-memory";

const rss = `<rss><channel><item>
  <title>AI News</title>
  <link>${issueUrl}</link>
  <pubDate>Sun, 30 Aug 2026 01:00:00 GMT</pubDate>
  <content:encoded><![CDATA[
    <h2>Agent systems</h2>
    <p><a href="${firstSource}">Agent permissions</a> Codex agents add explicit permission scopes and replayable approvals.</p>
    <p><a href="${secondSource}">Agent memory</a> A new agent memory system adds durable team handoffs.</p>
  ]]></content:encoded>
</item></channel></rss>`;

const modelEdition = {
  schemaVersion: 1,
  issue: { publicationDate: "28 August 2026", coverage: "Agents, permissions and durable memory", url: issueUrl, quiet: true },
  presentation: {
    hotTitle: "Priority agent changes",
    hotIntro: "The most consequential agent developments.",
    allTitle: "Complete agent signal",
    allIntro: "The complete source-bound candidate list.",
    synthesisTitle: "Agents become governed systems",
    synthesisIntro: "Permissions and memory are becoming operational controls.",
    sourceReadMinutes: 6,
    briefReadMinutes: 3
  },
  synthesis: {
    lead: "Agent systems are adding explicit operational controls.",
    bigPicture: "Permission boundaries and durable memory are maturing together across practical agent deployments.",
    sources: [{ label: "Agent permissions", url: firstSource }, { label: "Agent memory", url: secondSource }],
    sections: [
      { title: "Permissions become explicit", kicker: "Approval boundaries move into the runtime", body: "Agent permission scopes make operational boundaries easier to inspect.", sources: [{ label: "Agent permissions", url: firstSource }] },
      { title: "Memory supports handoffs", kicker: "Durable context becomes a team control", body: "Persistent memory lets teams hand work between agents without rebuilding context.", sources: [{ label: "Agent memory", url: secondSource }] }
    ]
  }
};

const existingEdition = {
  ...modelEdition,
  presentation: { ...modelEdition.presentation, hotTitle: "Existing priority", allTitle: "Existing complete", synthesisTitle: "Existing synthesis" },
  synthesis: {
    ...modelEdition.synthesis,
    lead: "The existing edition preserves the prior collector result.",
    bigPicture: "The prior issue remains available until a validated replacement is ready."
  },
  hotTopics: [{ title: "Existing topic", summary: "Existing topic summary.", category: "agents", base: 1, sources: [{ label: "Agent permissions", url: firstSource }] }],
  signals: [{ title: "Existing signal", summary: "Existing signal summary.", category: "agents", base: 1, source: "Agent permissions", url: firstSource, categoryLabel: "Agents in practice" }]
};

type RecordedStatement = { sql: string; values: unknown[] };

function fakeDatabase(runStatements: RecordedStatement[], hasExistingEdition: boolean, republishAlreadyClaimed = false): D1Database {
  let claimId: string | undefined = republishAlreadyClaimed ? "already-used" : undefined;
  let replacedEditionJson: string | undefined;
  const prepare = (sql: string) => {
    const statement = {
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.startsWith("SELECT edition_json FROM editions")) {
          return hasExistingEdition ? { edition_json: JSON.stringify(existingEdition) } as T : null;
        }
        if (sql.startsWith("SELECT id, issue_url") && replacedEditionJson) {
          return { id: "existing-edition", issue_url: issueUrl, issue_date: "2026-08-28", edition_json: replacedEditionJson, published_at: "2026-08-28T02:00:00.000Z" } as T;
        }
        return null as T | null;
      },
      async run() {
        runStatements.push({ sql, values: this.values });
        if (sql.startsWith("INSERT OR IGNORE INTO manual_republish_days")) {
          if (claimId) return { success: true, meta: { changes: 0 }, results: [] };
          claimId = String(this.values[1]);
          return { success: true, meta: { changes: 1 }, results: [] };
        }
        if (sql.startsWith("UPDATE editions SET")) {
          replacedEditionJson = String(this.values[1]);
        }
        return { success: true, meta: { changes: 1 }, results: [] };
      }
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: RecordedStatement[]) {
      runStatements.push(...statements.map(({ sql, values }) => ({ sql, values })));
      return [
        { success: true, meta: { changes: 1 }, results: [] },
        { success: true, meta: { changes: 0 }, results: [] }
      ];
    }
  } as unknown as D1Database;
}

function fakeEnv(db: D1Database, modelCalls: string[]): Env {
  return {
    DB: db,
    AI: { async run(model: string) { modelCalls.push(model); return { choices: [{ message: { content: JSON.stringify(modelEdition) } }] }; } },
    ASSETS: { fetch: vi.fn() },
    ENVIRONMENT: "production",
    AI_MODEL: "@cf/openai/gpt-oss-120b",
    AI_FALLBACK_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI_QUALITY_FALLBACK_MODEL: "@cf/moonshotai/kimi-k2.6",
    AI_GATEWAY_ID: "",
    SUPPLEMENTAL_SHADOW_ENABLED: "false",
    RSS_URL: "https://news.smol.ai/rss.xml"
  } as unknown as Env;
}

describe("generation republish behavior", () => {
  it("publishes a 72-hour fallback edition from TLDR when AInews returns 402", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("news.smol.ai")) return new Response("unavailable", { status: 402 });
      if (url === "https://tldr.tech/api/rss/ai") return new Response(`<rss><channel><item><title>TLDR AI</title><link>https://tldr.tech/ai/2026-08-30</link><pubDate>Sun, 30 Aug 2026 01:00:00 GMT</pubDate></item></channel></rss>`);
      if (url === "https://tldr.tech/ai/2026-08-30") return new Response(`<article><a href="${firstSource}"><h3>Codex adds explicit agent permission scopes</h3></a></article><article><a href="${secondSource}"><h3>Enterprise memory enables durable handoffs</h3></a></article>`);
      return new Response("<rss><channel></channel></rss>");
    }));
    try {
      const calls: string[] = [];
      const statements: RecordedStatement[] = [];
      const result = await generateLatestEdition(fakeEnv(fakeDatabase(statements, false), calls), "cron");
      expect(result.status).toBe("success");
      if (result.status !== "success") throw new Error("Expected a published fallback edition");
      expect(result.edition.collection).toMatchObject({ mode: "daily-pool", maxFreshnessHours: 72, sourcesContributing: ["TLDR AI"] });
      expect(result.edition.issue.coverage).toBe("Qualified signals published in the previous 72 hours");
      expect(result.edition.signals).toHaveLength(2);
      expect(result.edition.signals.every((item) => item.date === "30 August 2026")).toBe(true);
      expect(calls).toHaveLength(2);
      expect(statements.some((statement) => statement.sql.includes("manual_republish_days"))).toBe(false);
      const report = statements.find((statement) => statement.sql.startsWith("INSERT INTO supplemental_shadow_runs"));
      expect(JSON.stringify(report?.values)).toContain("RSS returned 402");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps normal manual refresh idempotent but replaces an issue when forced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    const fetcher = vi.fn(async () => new Response(rss, { status: 200, headers: { "Content-Type": "application/rss+xml" } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const normalCalls: string[] = [];
      const normalStatements: RecordedStatement[] = [];
      const normalResult = await generateLatestEdition(fakeEnv(fakeDatabase(normalStatements, true), normalCalls), "manual");
      expect(normalResult).toEqual({ status: "skipped", reason: "already-published" });
      expect(normalCalls).toHaveLength(0);

      const forcedCalls: string[] = [];
      const forcedStatements: RecordedStatement[] = [];
      const forcedResult = await generateLatestEdition(fakeEnv(fakeDatabase(forcedStatements, true), forcedCalls), "manual", { forceRepublish: true });
      expect(forcedResult.status).toBe("success");
      expect(forcedCalls).toEqual(["@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
      expect(forcedStatements.some((statement) => statement.sql.startsWith("UPDATE editions SET"))).toBe(true);
      expect(forcedStatements.some((statement) => statement.sql.startsWith("UPDATE manual_republish_days"))).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(5);

      const limitedCalls: string[] = [];
      const limitedStatements: RecordedStatement[] = [];
      const limitedResult = await generateLatestEdition(fakeEnv(fakeDatabase(limitedStatements, true, true), limitedCalls), "manual", { forceRepublish: true });
      expect(limitedResult).toEqual({ status: "skipped", reason: "manual-republish-limit" });
      expect(limitedCalls).toHaveLength(0);
      expect(limitedStatements.some((statement) => statement.sql.startsWith("INSERT INTO runs"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
