import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLatestEdition } from "../src/generation";
import type { DailyCollection, Edition, SupplementalShadowReport } from "../src/contracts";

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
    async batch(statements: any[] = []) {
      for (const stmt of statements) {
        runStatements.push({ sql: stmt.sql, values: stmt.values });
      }
      return [
        { success: true, meta: { changes: 1 }, results: [] },
        { success: true, meta: { changes: 0 }, results: [] }
      ];
    }
  } as unknown as D1Database;
}

const ISSUE_URL = "https://tldr.tech/ai/2026-08-30";

function tldrFeed(): string {
  return `<rss><channel><item><title>TLDR AI</title><link>${ISSUE_URL}</link><pubDate>Sun, 30 Aug 2026 01:00:00 GMT</pubDate></item></channel></rss>`;
}

function tldrHtml(stories: Array<{ url: string; title: string; summary: string }>): string {
  return stories
    .map(
      (s) => `<article><a href="${s.url}"><h3>${s.title}</h3></a><div class="newsletter-html">${s.summary}</div></article>`
    )
    .join("");
}

const storyUrls = [
  "https://example.com/story-1",
  "https://example.com/story-2",
  "https://example.com/story-3",
  "https://example.com/story-4",
  "https://example.com/story-5",
  "https://example.com/story-6"
] as const;

const stories = [
  { url: storyUrls[0], title: "Codex adds agent permission scopes", summary: "Codex introduces explicit agent permission scopes and replayable approvals for developer tools." },
  { url: storyUrls[1], title: "Codex memory enables durable handoffs", summary: "A new agent memory system in Codex supports durable team handoffs across sessions." },
  { url: storyUrls[2], title: "Codex terminal integration ships", summary: "Codex adds terminal integration so coding agents can run commands in sandboxed environments." },
  { url: storyUrls[3], title: "Codex adds code review automation", summary: "Codex developer tooling adds automated code review for pull requests in software engineering workflows." },
  { url: storyUrls[4], title: "Codex cursor integration for coding agents", summary: "Cursor integrates Codex as a coding agent for terminal-based software engineering tasks." },
  { url: storyUrls[5], title: "Codex developer tool permissions model", summary: "Codex ships a permissions model for developer tools and terminal access control in coding agents." }
];

/** Stories 1-3 rank higher (codex + fresh), stories 4-6 rank lower (frontier + older). */
function sourceFetch(url: string | URL | Request): Promise<Response> {
  const u = String(url);
  if (u === "https://tldr.tech/api/rss/ai") {
    return Promise.resolve(new Response(tldrFeed()));
  }
  if (u === ISSUE_URL) {
    return Promise.resolve(new Response(tldrHtml(stories)));
  }
  return Promise.resolve(new Response("<rss><channel></channel></rss>"));
}

const generationEdition: Edition = {
  schemaVersion: 1,
  issue: {
    publicationDate: "31 August 2026",
    coverage: "AI signals",
    url: "https://signal.tamirlevin.dev/?edition=2026-08-31",
    quiet: false
  },
  presentation: {
    hotTitle: "Today's priority AI signals",
    hotIntro: "The collector-ranked developments most aligned with this profile.",
    allTitle: "All qualified developments",
    allIntro: "Every source-bound signal that passed the freshness and relevance checks.",
    synthesisTitle: "Patterns across today's AI activity",
    synthesisIntro: "A conservative source-led view generated without model-authored framing.",
    sourceReadMinutes: 6,
    briefReadMinutes: 3
  },
  synthesis: {
    lead: "Agent systems are adding explicit operational controls.",
    bigPicture: "Permission boundaries and durable memory are maturing together across practical agent deployments.",
    sources: [
      { label: "Codex adds agent permission scopes", url: storyUrls[0] },
      { label: "Codex memory enables durable handoffs", url: storyUrls[1] }
    ],
    sections: [
      {
        title: "Permissions become explicit",
        kicker: "Approval boundaries move into the runtime",
        body: "Agent permission scopes and replayable approvals make operational boundaries easier to inspect.",
        sources: [{ label: "Codex adds agent permission scopes", url: storyUrls[0] }]
      }
    ]
  },
  hotTopics: [],
  signals: []
};

function makeAiMock(config: {
  clefScores: Map<string, number>;
  clefShouldThrow?: boolean;
  generationEdition: Edition;
  qaShouldThrow?: boolean;
}) {
  const calls: Array<{ model: string; input: unknown }> = [];
  const ai = {
    async run(model: string, input: unknown) {
      calls.push({ model, input });
      if (model === "@cf/cloudflare/clef") {
        if (config.clefShouldThrow) throw new Error("provider down");
        const url = (input as { state?: { url?: string } })?.state?.url;
        const wants = config.clefScores.get(url ?? "") ?? 0.5;
        return { answers: { reader_wants: { type: "noul", noul: wants } } };
      }
      if (model === "@cf/openai/gpt-oss-120b") {
        return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(config.generationEdition) } }] };
      }
      if (model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast") {
        if (config.qaShouldThrow) throw new Error("qa down");
        return {
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ presentation: config.generationEdition.presentation, synthesis: config.generationEdition.synthesis, warnings: [] }) } }]
        };
      }
      throw new Error(`unexpected model: ${model}`);
    }
  };
  return { ai, calls };
}

function makeEnv(overrides: Partial<Env> = {}, runStatements: RecordedStatement[] = []): Env {
  return {
    DB: fakeDatabase(runStatements),
    AI: { run: vi.fn() },
    ASSETS: { fetch: vi.fn() },
    ENVIRONMENT: "production",
    AI_MODEL: "@cf/openai/gpt-oss-120b",
    AI_FALLBACK_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI_QUALITY_FALLBACK_MODEL: "@cf/moonshotai/kimi-k2.6",
    AI_GATEWAY_ID: "",
    SUPPLEMENTAL_SHADOW_ENABLED: "true",
    TRIAGE_SHADOW_ENABLED: "false",
    RSS_URL: "https://news.smol.ai/rss.xml",
    ...overrides
  } as unknown as Env;
}

function shadowReportFromStatements(runStatements: RecordedStatement[]): Pick<SupplementalShadowReport, "judgeGate" | "wouldAdd"> | null {
  const insert = runStatements.find((s) => s.sql.startsWith("INSERT INTO supplemental_shadow_runs"));
  if (!insert) return null;
  const reportJson = insert.values[5];
  if (typeof reportJson !== "string" || !reportJson) return null;
  const report = JSON.parse(reportJson) as SupplementalShadowReport;
  return { judgeGate: report.judgeGate, wouldAdd: report.wouldAdd };
}

function runRecordFromStatements(runStatements: RecordedStatement[]): { status?: string; model?: string } | null {
  const insert = runStatements.find((s) => s.sql.startsWith("INSERT INTO runs"));
  if (!insert) return null;
  const status = insert.values[4];
  const model = insert.values[5];
  return {
    status: typeof status === "string" ? status : undefined,
    model: typeof model === "string" ? model : undefined
  };
}

function dailyCollection(edition: Edition): DailyCollection {
  const collection = edition.collection;
  if (!collection || collection.mode !== "daily-pool") throw new Error("Expected a daily-pool collection");
  return collection;
}

describe("judge gate end-to-end in generateLatestEdition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("removes below-threshold candidates outside the protected top 3, capped at 3 removals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(sourceFetch));
    const runStatements: RecordedStatement[] = [];
    const env = makeEnv({ CLEF_GATE_ENABLED: "true" }, runStatements);
    const clefScores = new Map<string, number>();
    // All six candidates score below threshold: positions 0-2 are protected and kept,
    // positions 3-5 are removed (exactly the cap of 3).
    for (const url of storyUrls) clefScores.set(url, 0.1);
    const { ai, calls } = makeAiMock({ clefScores, generationEdition });
    (env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run = ai.run.bind(ai);

    const result = await generateLatestEdition(env, "manual");

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected successful generation");

    // Clef scored all 6 candidates.
    const clefCalls = calls.filter((c) => c.model === "@cf/cloudflare/clef");
    expect(clefCalls).toHaveLength(6);

    // Exactly 3 removals (the cap), all below-threshold stories outside the protected top 3.
    const report = shadowReportFromStatements(runStatements);
    expect(report?.judgeGate).toMatchObject({ removed: 3, checked: 6, failed: 0 });
    const removedUrls = (report?.judgeGate?.items ?? []).map((i) => i.url).sort();
    expect(removedUrls).toHaveLength(3);

    // The edition publishes only the protected top 3.
    const edition = result.edition;
    expect(edition.signals).toHaveLength(3);
    expect(dailyCollection(edition).judgeFiltered).toBe(3);

    // No candidate in the published edition was removed by the gate.
    const removedSet = new Set(removedUrls);
    for (const signal of edition.signals) {
      expect(removedSet.has(signal.url)).toBe(false);
    }

    const run = runRecordFromStatements(runStatements);
    expect(run?.status).toBe("success");
    expect(run?.model).toBe("@cf/openai/gpt-oss-120b");
  });

  it("keeps all candidates when none score below threshold (zero-removal day)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(sourceFetch));
    const runStatements: RecordedStatement[] = [];
    const env = makeEnv({ CLEF_GATE_ENABLED: "true" }, runStatements);
    const clefScores = new Map<string, number>();
    for (const url of storyUrls) clefScores.set(url, 0.9);
    const { ai, calls } = makeAiMock({ clefScores, generationEdition });
    (env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run = ai.run.bind(ai);

    const result = await generateLatestEdition(env, "manual");

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected successful generation");

    const clefCalls = calls.filter((c) => c.model === "@cf/cloudflare/clef");
    expect(clefCalls).toHaveLength(6);

    // Zero removals: gate ran and scored all 6, but nothing was below threshold.
    const report = shadowReportFromStatements(runStatements);
    expect(report?.judgeGate).toMatchObject({ removed: 0, checked: 6, failed: 0 });
    expect(report?.judgeGate?.items).toEqual([]);
    expect(report?.judgeGate?.skipped).not.toBe(true);

    // All 6 stories published.
    const edition = result.edition;
    expect(edition.signals.map((s) => s.url).sort()).toEqual([...storyUrls].sort());
    expect(dailyCollection(edition).judgeFiltered).toBeUndefined();
  });

  it("records a zero-removal gate outcome so a quiet day is distinguishable from the gate being off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(sourceFetch));
    const runStatements: RecordedStatement[] = [];
    const env = makeEnv({ CLEF_GATE_ENABLED: "true" }, runStatements);
    const clefScores = new Map<string, number>();
    for (const url of storyUrls) clefScores.set(url, 0.9);
    const { ai, calls } = makeAiMock({ clefScores, generationEdition });
    (env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run = ai.run.bind(ai);

    const result = await generateLatestEdition(env, "manual");

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected successful generation");

    const report = shadowReportFromStatements(runStatements);
    expect(report?.judgeGate).toMatchObject({ removed: 0, checked: 6, failed: 0 });
    expect(report?.judgeGate?.skipped).not.toBe(true);

    const edition = result.edition;
    expect(edition.signals.map((s) => s.url).sort()).toEqual([...storyUrls].sort());
  });

  it("fails open when the Clef provider errors, publishing the deterministic edition unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(sourceFetch));
    const runStatements: RecordedStatement[] = [];
    const env = makeEnv({ CLEF_GATE_ENABLED: "true" }, runStatements);
    const { ai, calls } = makeAiMock({ clefScores: new Map(), clefShouldThrow: true, generationEdition });
    (env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run = ai.run.bind(ai);

    const result = await generateLatestEdition(env, "manual");

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected successful generation");

    // Clef was attempted but failed open — no gate applied.
    const clefCalls = calls.filter((c) => c.model === "@cf/cloudflare/clef");
    expect(clefCalls).toHaveLength(6);

    const report = shadowReportFromStatements(runStatements);
    expect(report?.judgeGate).toMatchObject({ removed: 0, checked: 6, failed: 6 });
    expect(report?.judgeGate?.items).toEqual([]);

    // All 6 stories published — the gate did not remove anything.
    const edition = result.edition;
    expect(edition.signals.map((s) => s.url).sort()).toEqual([...storyUrls].sort());
  });

  it("does not run the gate when CLEF_GATE_ENABLED is false or absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(sourceFetch));
    const runStatements: RecordedStatement[] = [];
    const env = makeEnv({}, runStatements); // CLEF_GATE_ENABLED not set
    const { ai, calls } = makeAiMock({ clefScores: new Map(), generationEdition });
    (env.AI as { run: (model: string, input: unknown) => Promise<unknown> }).run = ai.run.bind(ai);

    const result = await generateLatestEdition(env, "manual");

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected successful generation");

    // No Clef calls at all.
    const clefCalls = calls.filter((c) => c.model === "@cf/cloudflare/clef");
    expect(clefCalls).toHaveLength(0);

    // No judgeGate on the shadow report.
    const report = shadowReportFromStatements(runStatements);
    expect(report?.judgeGate).toBeUndefined();

    // All 6 stories published.
    const edition = result.edition;
    expect(edition.signals.map((s) => s.url).sort()).toEqual([...storyUrls].sort());
  });
});
