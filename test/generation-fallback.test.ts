import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLatestEdition } from "../src/generation";

type RecordedStatement = { sql: string; values: unknown[] };

function fakeDatabase(runStatements: RecordedStatement[]): D1Database {
  const prepare = (sql: string) => {
    const statement = {
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        return null as T | null;
      },
      async run() {
        runStatements.push({ sql: this.sql, values: this.values });
        return { success: true, meta: { changes: 1 }, results: [] };
      }
    };
    return statement;
  };
  return {
    prepare,
    async batch() {
      return [
        { success: true, meta: { changes: 1 }, results: [] },
        { success: true, meta: { changes: 0 }, results: [] }
      ];
    }
  } as unknown as D1Database;
}

const rss = `<rss><channel><item>
  <title>AI News</title>
  <link>https://news.smol.ai/issues/fallback-test</link>
  <pubDate>Sun, 30 Aug 2026 01:00:00 GMT</pubDate>
  <content:encoded><![CDATA[
    <h2>Agent systems</h2>
    <p><a href="https://example.com/agent-permissions">Agent permissions</a> Codex agents add explicit permission scopes and replayable approvals.</p>
    <p><a href="https://example.com/agent-memory">Agent memory</a> A new agent memory system adds durable team handoffs.</p>
  ]]></content:encoded>
</item></channel></rss>`;

const generatedEdition = {
  schemaVersion: 1,
  issue: {
    publicationDate: "28 August 2026",
    coverage: "Agents, permissions and durable memory",
    url: "https://news.smol.ai/issues/fallback-test",
    quiet: true
  },
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
    sources: [
      { label: "Agent permissions", url: "https://example.com/agent-permissions" },
      { label: "Agent memory", url: "https://example.com/agent-memory" }
    ],
    sections: [
      {
        title: "Permissions become explicit",
        kicker: "Approval boundaries move into the runtime",
        body: "Agent permission scopes and replayable approvals make operational boundaries easier to inspect.",
        sources: [{ label: "Agent permissions", url: "https://example.com/agent-permissions" }]
      },
      {
        title: "Memory supports handoffs",
        kicker: "Durable context becomes a team control",
        body: "Persistent memory lets teams hand work between agents without rebuilding context from scratch.",
        sources: [{ label: "Agent memory", url: "https://example.com/agent-memory" }]
      }
    ]
  }
};

describe("generation model fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("switches once after malformed primary JSON and records the successful fallback model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    const modelCalls: string[] = [];
    const modelInputs: ChatCompletionsMessagesInput[] = [];
    const runStatements: RecordedStatement[] = [];
    const fetcher = vi.fn(async () => new Response(rss, { status: 200, headers: { "Content-Type": "application/rss+xml" } }));
    vi.stubGlobal("fetch", fetcher);

    const env = {
      DB: fakeDatabase(runStatements),
      AI: {
        async run(model: string, input: ChatCompletionsMessagesInput) {
          modelCalls.push(model);
          modelInputs.push(input);
          return modelCalls.length < 3
            ? { choices: [{ finish_reason: "length", message: { content: "{not valid json" } }] }
            : { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(generatedEdition) } }] };
        }
      },
      ASSETS: { fetch: vi.fn() },
      ENVIRONMENT: "production",
      AI_MODEL: "@cf/openai/gpt-oss-120b",
      AI_FALLBACK_MODEL: "@cf/zai-org/glm-4.7-flash",
      AI_GATEWAY_ID: "",
      SUPPLEMENTAL_SHADOW_ENABLED: "true",
      RSS_URL: "https://news.smol.ai/rss.xml"
    } as unknown as Env;

    try {
      const result = await generateLatestEdition(env, "manual");

      expect(result.status).toBe("success");
      expect(modelCalls).toEqual(["@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"]);
      expect(modelInputs[0]).toHaveProperty("response_format");
      expect(modelInputs[1]?.messages.at(-1)?.content).toContain("previous output was rejected");
      expect(modelInputs[2]).not.toHaveProperty("response_format");
      expect(modelInputs[2]).toHaveProperty("reasoning_effort", "low");
      expect(fetcher).toHaveBeenCalledTimes(5);
      const successfulRun = runStatements.find((statement) => statement.sql.startsWith("INSERT INTO runs"));
      expect(successfulRun?.values[4]).toBe("success");
      expect(successfulRun?.values[5]).toBe("@cf/zai-org/glm-4.7-flash");
    } finally {
      vi.useRealTimers();
    }
  });
});
