import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JevScoredItem, SupplementalShadowReport } from "../src/contracts";
import worker from "../src/index";
import {
  buildDroppedBatch,
  buildJudgmentRows,
  buildPairedBatch,
  jevPickSet,
  jevQuestionFingerprint,
  PAIRED_BATCH_SIZE,
  reviewPool,
  summarizeJevLabels,
  type JevDecision,
  type JevLabelKind,
  type LabelEvent
} from "../src/jev-ledger";

type Spec = { url: string; outcome: JevScoredItem["outcome"]; wants: number | null };

function scored(spec: Spec): JevScoredItem {
  return {
    url: spec.url, title: `Story ${spec.url}`, summary: `Summary ${spec.url}`, publishedAt: "2026-09-29T00:00:00Z", sourceIds: ["tldr-ai"],
    interest: "New systems", interestConfidence: 0.8, novel: 0.7, substantive: 0.8, readerWants: spec.wants, outcome: spec.outcome
  };
}

function report(specs: Spec[]): SupplementalShadowReport {
  return {
    schemaVersion: 1, mode: "daily-pool", generatedAt: "2026-09-29T00:15:00.000Z", profileVersion: 7,
    jevQuestionSetVersion: "reader-want-v1", jevQuestions: { reader_wants: { type: "noul", instructions: "Would you want it?" } },
    baseIssue: { url: "https://signal.tamirlevin.dev/?edition=2026-09-29", issueDate: "2026-09-29", publicationDate: "29 September 2026" },
    sourcePack: { id: "core-ai", version: 7 },
    limits: { modelCandidates: 18, publishedStories: 14 },
    sources: [{ id: "tldr-ai", name: "TLDR AI", status: "healthy", requests: 1, fetchedItems: 1, acceptedCandidates: 1, errors: [] }],
    totals: { aiNewsCandidates: 0, supplementalCandidates: 0, supplementalAfterDeduplication: 0, overlapsWithAiNews: 0, novelQualifiedCandidates: 0, wouldAdd: 0 },
    overlaps: [], wouldAdd: [], jevScores: specs.map(scored), triageScores: []
  };
}

/**
 * Twelve eligible stories. Gate selects sel-0..5; Jev's top-6 by reader_wants is
 * exc-0, sel-0, exc-1, sel-1, sel-2, exc-2. So: both-in sel-0..2, gate-only sel-3..5,
 * jev-only exc-0..2, both-out exc-3..5. One more row has no usable evidence.
 */
function pool(): Spec[] {
  const selected = [0.9, 0.8, 0.7, 0.3, 0.2, 0.1].map((wants, index) => ({ url: `https://e.test/sel-${index}`, outcome: "selected" as const, wants }));
  const excluded = [0.95, 0.85, 0.6, 0.4, 0.05, 0.02].map((wants, index) => ({ url: `https://e.test/exc-${index}`, outcome: "weakProfileFit" as const, wants }));
  return [...selected, ...excluded, { url: "https://e.test/noevidence", outcome: "noUsableEvidence", wants: 0.99 }];
}

function event(partial: Partial<LabelEvent> & { storyUrl: string; kind: JevLabelKind; decision: JevDecision; wants?: number | null }): LabelEvent {
  const { wants = 0.5, ...rest } = partial;
  return {
    questionHash: "hash-1", questionSetVersion: "reader-want-v1", runId: "run-1", issueDate: "2026-09-29", rankPosition: null,
    cellPopulation: null, cellSampled: null, poolSize: 12, jevK: 6, createdAt: "2026-09-29T01:00:00Z",
    snapshotJson: JSON.stringify({ candidate: { url: partial.storyUrl, title: `T ${partial.storyUrl}`, summary: "", publishedAt: "", sourceIds: [], assessment: { gateOutcome: "selected", interest: null, interestConfidence: null, novel: null, substantive: null, readerWants: wants, reranker: null } } }),
    ...rest
  };
}

describe("jev pick set", () => {
  it("is the top K by reader_wants where K is the gate's selection size, ignoring rows without usable evidence", () => {
    const { k, picks } = jevPickSet(reviewPool(report(pool())));
    expect(k).toBe(6);
    expect([...picks].sort()).toEqual(["https://e.test/exc-0", "https://e.test/exc-1", "https://e.test/exc-2", "https://e.test/sel-0", "https://e.test/sel-1", "https://e.test/sel-2"]);
  });
});

describe("paired batch", () => {
  const kindCounts = (items: Array<{ kind: string }>) => items.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.kind]: (counts[entry.kind] ?? 0) + 1 }), {});

  it("fills spare places from the cells round-robin and records eligible population per cell", () => {
    const batch = buildPairedBatch("run-a", report(pool()), []);
    expect(batch.poolSize).toBe(12);
    expect(batch.jevK).toBe(6);
    expect(batch.items).toHaveLength(12);
    expect(kindCounts(batch.items)).toEqual({ "disagree-gate-only": 3, "disagree-jev-only": 3, "anchor-both-in": 3, "anchor-both-out": 3 });
    expect(new Set(batch.items.map((entry) => entry.url)).size).toBe(12);
    expect(batch.items.map((entry) => entry.url)).not.toContain("https://e.test/noevidence");
    for (const entry of batch.items) expect(entry).toMatchObject({ cellPopulation: 3, cellSampled: 3 });
  });

  it("gives disagreements the places when anchors are scarce, with neither side favoured", () => {
    const selected = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/s${index}`, outcome: "selected" as const, wants: 0.1 + index / 100 }));
    const excluded = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/x${index}`, outcome: "weakProfileFit" as const, wants: 0.8 + index / 100 }));
    const batch = buildPairedBatch("run-a", report([...selected, ...excluded]), []);
    expect(kindCounts(batch.items)).toEqual({ "disagree-gate-only": 6, "disagree-jev-only": 6 });
    for (const entry of batch.items) expect(entry).toMatchObject({ cellPopulation: 12, cellSampled: 6 });
  });

  it("is stable across reloads and varies with the run", () => {
    const selected = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/s${index}`, outcome: "selected" as const, wants: 0.1 + index / 100 }));
    const excluded = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/x${index}`, outcome: "weakProfileFit" as const, wants: 0.8 + index / 100 }));
    const rep = report([...selected, ...excluded]);
    const urls = (runId: string) => buildPairedBatch(runId, rep, []).items.map((entry) => entry.url);
    expect(urls("run-a")).toEqual(urls("run-a"));
    expect(urls("run-a")).not.toEqual(urls("run-b"));
  });

  it("never re-draws a labelled story as an ordinary item and re-shows at most two as repeats", () => {
    const history = ["sel-3", "sel-4", "exc-3"].map((name) => event({ storyUrl: `https://e.test/${name}`, kind: "disagree-gate-only", decision: "reject", runId: "run-old" }));
    const batch = buildPairedBatch("run-new", report(pool()), history);
    const repeats = batch.items.filter((entry) => entry.kind === "repeat");
    expect(repeats).toHaveLength(2);
    for (const repeat of repeats) expect(["https://e.test/sel-3", "https://e.test/sel-4", "https://e.test/exc-3"]).toContain(repeat.url);
    const ordinary = batch.items.filter((entry) => entry.kind !== "repeat").map((entry) => entry.url);
    for (const name of ["sel-3", "sel-4", "exc-3"]) expect(ordinary).not.toContain(`https://e.test/${name}`);
    // Nine unvoted stories remain plus two repeats: a short batch beats padding with stories already judged.
    expect(batch.items).toHaveLength(11);
    expect(batch.items.length).toBeLessThanOrEqual(PAIRED_BATCH_SIZE);
  });

  it("does not repeat a story voted in this same run, or one already repeated", () => {
    const history = [
      event({ storyUrl: "https://e.test/sel-3", kind: "disagree-gate-only", decision: "reject", runId: "run-new" }),
      event({ storyUrl: "https://e.test/sel-4", kind: "disagree-gate-only", decision: "reject", runId: "run-old" }),
      event({ storyUrl: "https://e.test/sel-4", kind: "repeat", decision: "reject", runId: "run-mid" })
    ];
    const batch = buildPairedBatch("run-new", report(pool()), history);
    expect(batch.items.filter((entry) => entry.kind === "repeat")).toHaveLength(0);
  });
});

describe("dropped-pool batch", () => {
  it("is a census of unjudged rule-dropped stories without Jev-derived sample groups", () => {
    const history = [event({ storyUrl: "https://e.test/exc-0", kind: "dropped-pool", decision: "publish", runId: "run-old" })];
    const batch = buildDroppedBatch("run-a", report(pool()), history);
    expect(batch.items.every((entry) => entry.kind === "dropped-pool" && entry.assessment.gateOutcome !== "selected")).toBe(true);
    expect(batch.items.map((entry) => entry.url).sort()).toEqual(["https://e.test/exc-1", "https://e.test/exc-2", "https://e.test/exc-3", "https://e.test/exc-4", "https://e.test/exc-5"]);
    for (const entry of batch.items) expect(entry).toMatchObject({ cellPopulation: 5, cellSampled: 5 });
  });
});

describe("question fingerprint", () => {
  const base = (titles: string[], instruction = "Is this new?") => ({
    interest: { type: "choice", instructions: "Which interest?", criteria: { b: "B", a: "A" } },
    novel: { type: "noul", instructions: { question: instruction, previously_published: titles } }
  });

  it("ignores the daily list of previously published titles and key order", async () => {
    const one = await jevQuestionFingerprint(base(["Yesterday's story"]));
    const two = await jevQuestionFingerprint(base(["A different story", "Another"]));
    const reordered = await jevQuestionFingerprint({ novel: base([]).novel, interest: { criteria: { a: "A", b: "B" }, instructions: "Which interest?", type: "choice" } });
    expect(one).toBe(two);
    expect(one).toBe(reordered);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a question is reworded, even if the version string was not bumped", async () => {
    expect(await jevQuestionFingerprint(base([]))).not.toBe(await jevQuestionFingerprint(base([], "Is this materially new?")));
  });
});

describe("ledger rows", () => {
  it("records scores, gate outcome and whether the story is on today's live edition", () => {
    const rep = report([{ url: "https://e.test/a", outcome: "selected", wants: 0.9 }, { url: "https://e.test/b", outcome: "weakProfileFit", wants: 0.2 }]);
    rep.triageScores = [{ url: "https://e.test/a", title: "A", relevance: 0.7, rawRelevance: 0.1, winningInterest: "New systems", rank: 2, novelty: 0.5, outcome: "selected", sourceIds: [] }];
    const rows = buildJudgmentRows({ runId: "run-1", report: rep, questionHash: "abc", publishedUrls: new Set(["https://e.test/a"]), seenAt: "2026-09-29T00:16:00Z" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ storyUrl: "https://e.test/a", questionHash: "abc", readerWants: 0.9, rerankerRelevance: 0.7, rerankerRank: 2, selected: true, published: true, profileVersion: 7, sourcePackVersion: 7, firstRunId: "run-1", issueDate: "2026-09-29" });
    expect(rows[1]).toMatchObject({ storyUrl: "https://e.test/b", selected: false, published: false, rerankerRelevance: null });
  });
});

describe("analysis", () => {
  const events: LabelEvent[] = [
    // Gate picked, Jev would drop: population 4, two sampled, weight 2 each. One publish (gate right), one reject (Jev right).
    event({ storyUrl: "u1", kind: "disagree-gate-only", decision: "publish", wants: 0.9, cellPopulation: 4, cellSampled: 2 }),
    event({ storyUrl: "u2", kind: "disagree-gate-only", decision: "reject", wants: 0.3, cellPopulation: 4, cellSampled: 2 }),
    // Jev would include, gate dropped: population 2, both sampled, weight 1. Both publish (Jev right).
    event({ storyUrl: "u3", kind: "disagree-jev-only", decision: "publish", wants: 0.95, cellPopulation: 2, cellSampled: 2 }),
    event({ storyUrl: "u4", kind: "disagree-jev-only", decision: "publish", wants: 0.85, cellPopulation: 2, cellSampled: 2 }),
    event({ storyUrl: "u5", kind: "anchor-both-in", decision: "publish", wants: 0.8 }),
    event({ storyUrl: "u6", kind: "anchor-both-out", decision: "reject", wants: 0.1 }),
    event({ storyUrl: "u7", kind: "dropped-pool", decision: "publish", wants: 0.5 }),
    event({ storyUrl: "u8", kind: "dropped-pool", decision: "reject", wants: 0.2 }),
    event({ storyUrl: "u9", kind: "dropped-pool", decision: "unsure", wants: 0.4 }),
    // Repeats of two earlier stories: one same, one flipped from publish to reject.
    event({ storyUrl: "u2", kind: "repeat", decision: "reject", runId: "run-2" }),
    event({ storyUrl: "u1", kind: "repeat", decision: "reject", runId: "run-2" })
  ];

  it("weights disagreements by cell population and reports raw counts beside them", () => {
    const { paired } = summarizeJevLabels(events);
    expect(paired).toMatchObject({ decided: 4, jevRight: 3, gateRight: 1, jevRightShareRaw: 0.75 });
    expect(paired.jevRightShareWeighted).toBeCloseTo(4 / 6, 10);
    expect(paired.gateOnly).toMatchObject({ n: 2, publish: 1, reject: 1, publishShare: 0.5 });
    expect(paired.jevOnly).toMatchObject({ n: 2, publish: 2, publishShare: 1 });
  });

  it("counts one vote per story and measures the owner's own consistency from repeats", () => {
    const result = summarizeJevLabels(events);
    expect(result.labelledStories).toBe(9);
    expect(result.consistency).toMatchObject({ pairs: 2, sameDecision: 1, sameAsPublish: 1, rate: 0.5, publishAgreementRate: 0.5 });
  });

  it("sizes what the rules dropped and how many the owner would rescue per day", () => {
    const { droppedPool, anchors } = summarizeJevLabels(events);
    expect(droppedPool).toMatchObject({ n: 3, publish: 1, reject: 1, unsure: 1, publishShare: 0.5, days: 1, rescuedPerDay: 1 });
    expect(anchors.bothIn).toMatchObject({ n: 1, publish: 1 });
    expect(anchors.bothOut).toMatchObject({ n: 1, reject: 1 });
  });

  it("scores reader_wants against votes, ignoring unsure, and counts confident-low misses", () => {
    const { ranking } = summarizeJevLabels(events);
    expect(ranking.n).toBe(8);
    expect(ranking.readerWantsAuc).toBe(1);
    expect(ranking.rerankerAuc).toBeNull();
    const withMiss = summarizeJevLabels([...events, event({ storyUrl: "u10", kind: "disagree-gate-only", decision: "publish", wants: 0.05, cellPopulation: 1, cellSampled: 1 })]);
    expect(withMiss.ranking.confidentLowButPublished).toBe(1);
    expect(withMiss.ranking.readerWantsAuc).toBeLessThan(1);
  });

  it("correlates the owner's publish-set ranks with reader_wants", () => {
    const ranked = [
      event({ storyUrl: "r1", kind: "disagree-jev-only", decision: "publish", wants: 0.9, runId: "run-r" }),
      event({ storyUrl: "r2", kind: "disagree-jev-only", decision: "publish", wants: 0.6, runId: "run-r" }),
      event({ storyUrl: "r3", kind: "anchor-both-in", decision: "publish", wants: 0.3, runId: "run-r" }),
      ...[1, 2, 3].map((position) => event({ storyUrl: `r${position}`, kind: "rank", decision: "publish", rankPosition: position, runId: "run-r" }))
    ];
    const { ranking } = summarizeJevLabels(ranked);
    expect(ranking.rankRuns).toBe(1);
    expect(ranking.meanRankCorrelation).toBeCloseTo(1, 10);
    const reversed = summarizeJevLabels(ranked.map((entry) => entry.kind === "rank" ? { ...entry, rankPosition: 4 - entry.rankPosition! } : entry));
    expect(reversed.ranking.meanRankCorrelation).toBeCloseTo(-1, 10);
  });

  it("is empty-safe", () => {
    const empty = summarizeJevLabels([]);
    expect(empty.labelledStories).toBe(0);
    expect(empty.paired.jevRightShareWeighted).toBeNull();
    expect(empty.consistency.rate).toBeNull();
    expect(empty.ranking.readerWantsAuc).toBeNull();
  });
});

// ---------- endpoints ----------

type Row = Record<string, unknown>;

function fakeDb(rep: SupplementalShadowReport) {
  const runRow = { id: "run-1", trigger: "cron", status: "healthy", base_issue_url: null, base_issue_date: null, report_json: JSON.stringify(rep), error_code: null, error_message: null, started_at: "2026-09-29T00:15:00Z", finished_at: "2026-09-29T00:15:20Z", duration_ms: 20000 };
  const events: Row[] = [];
  const columns = ["story_url", "question_hash", "question_set_version", "run_id", "issue_date", "kind", "decision", "rank_position", "cell_population", "cell_sampled", "pool_size", "jev_k", "profile_version", "source_pack_id", "source_pack_version", "snapshot_json", "created_at"];
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      if (sql.includes("INSERT INTO jev_label_events")) events.push({ id: events.length + 1, ...Object.fromEntries(columns.map((column, index) => [column, values[index]])) });
      return {};
    },
    all: async () => {
      if (sql.includes("FROM supplemental_shadow_runs")) return { results: [runRow] };
      if (sql.includes("FROM jev_label_events WHERE run_id")) return { results: events.filter((row) => row.run_id === values[0]) };
      if (sql.includes("FROM jev_label_events")) return { results: [...events] };
      return { results: [] };
    },
    first: async () => {
      if (sql.includes("FROM supplemental_shadow_runs WHERE id")) return values[0] === "run-1" ? runRow : null;
      if (sql.includes("FROM jev_judgments")) return { judgments: 3, stories: 3, with_wants: 3, first_seen: "2026-09-29T00:16:00Z" };
      return null;
    }
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => { for (const entry of statements) await entry.run(); return []; }
  } as unknown as D1Database;
  return { db, events };
}

const fakeContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

function env(db: D1Database) {
  return {
    ADMIN_TOKEN: "secret", DB: db, AI: {} as Ai, ASSETS: { fetch: async () => new Response("x") } as unknown as Fetcher,
    ENVIRONMENT: "staging" as const, AI_MODEL: "@cf/openai/gpt-oss-120b" as const, AI_FALLBACK_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const,
    AI_QUALITY_FALLBACK_MODEL: "@cf/moonshotai/kimi-k2.6" as const, AI_GATEWAY_ID: "" as const, SUPPLEMENTAL_SHADOW_ENABLED: "true" as const,
    TRIAGE_SHADOW_ENABLED: "false" as const, JEV_SHADOW_ENABLED: "false" as const, RSS_URL: "https://news.smol.ai/rss.xml" as const
  } as unknown as Env;
}

async function call(environment: Env, method: string, path: string, body?: unknown, token = "secret") {
  const response = await worker.fetch(new Request(`https://app.test${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), environment, fakeContext);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe("review endpoints", () => {
  it("require the owner token", async () => {
    const { db } = fakeDb(report(pool()));
    for (const [method, path, body] of [["GET", "/api/jev-review-batch?mode=paired"], ["POST", "/api/jev-labels", {}], ["POST", "/api/jev-labels/ranks", {}], ["GET", "/api/jev-analysis"]] as const) {
      expect((await call(env(db), method, path, body, "")).status).toBe(401);
    }
  });

  it("rejects an unknown mode instead of treating a click event as a run id", async () => {
    const { db } = fakeDb(report(pool()));
    expect((await call(env(db), "GET", "/api/jev-review-batch?mode=%5Bobject%20PointerEvent%5D")).status).toBe(400);
  });

  it("serves an open batch without revealing sample groups, then saves, ranks and analyses it", async () => {
    const { db, events } = fakeDb(report(pool()));
    const environment = env(db);
    const open = await call(environment, "GET", "/api/jev-review-batch?mode=paired");
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ state: "open", runId: "run-1", jevK: 6, poolSize: 12 });
    expect(open.body.items).toHaveLength(12);
    for (const entry of open.body.items) {
      expect(entry).not.toHaveProperty("kind");
      expect(entry).not.toHaveProperty("cellPopulation");
    }
    const labels = open.body.items.map((entry: { url: string }, index: number) => ({ story_url: entry.url, decision: index < 5 ? "publish" : index < 10 ? "reject" : "unsure" }));

    expect((await call(environment, "POST", "/api/jev-labels", { mode: "paired", run_id: "run-1", labels: labels.slice(1) })).status).toBe(400);
    const saved = await call(environment, "POST", "/api/jev-labels", { mode: "paired", run_id: "run-1", labels });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toBe(12);
    expect(saved.body.rankable).toHaveLength(5);
    expect(events).toHaveLength(12);
    expect(events[0]).toMatchObject({ run_id: "run-1", question_set_version: "reader-want-v1", jev_k: 6, pool_size: 12 });
    expect(String(events[0]!.question_hash)).toMatch(/^[0-9a-f]{16}$/);
    expect((await call(environment, "POST", "/api/jev-labels", { mode: "paired", run_id: "run-1", labels })).status).toBe(409);

    const reopened = await call(environment, "GET", "/api/jev-review-batch?mode=paired&run_id=run-1");
    expect(reopened.body.state).toBe("saved");
    expect(reopened.body.items).toHaveLength(12);
    expect(reopened.body.items[0]).toHaveProperty("kind");

    const rankable = saved.body.rankable as Array<{ url: string }>;
    const badRanks = rankable.map((entry, index) => ({ story_url: entry.url, rank_position: index === 0 ? 3 : index + 1 }));
    expect((await call(environment, "POST", "/api/jev-labels/ranks", { run_id: "run-1", ranks: badRanks })).status).toBe(400);
    const goodRanks = rankable.map((entry, index) => ({ story_url: entry.url, rank_position: index + 1 }));
    expect((await call(environment, "POST", "/api/jev-labels/ranks", { run_id: "run-1", ranks: goodRanks })).body).toMatchObject({ ok: true, ranked: 5 });
    expect(events.filter((row) => row.kind === "rank")).toHaveLength(5);

    const analysis = await call(environment, "GET", "/api/jev-analysis");
    expect(analysis.body.ledger).toMatchObject({ judgments: 3, withReaderWants: 3 });
    expect(analysis.body.analysis).toMatchObject({ labelledStories: 12 });
  });

  it("keeps dropped-pool labels separate from the paired batch of the same run", async () => {
    const { db, events } = fakeDb(report(pool()));
    const environment = env(db);
    const dropped = await call(environment, "GET", "/api/jev-review-batch?mode=dropped");
    expect(dropped.body.items).toHaveLength(6);
    const labels = dropped.body.items.map((entry: { url: string }) => ({ story_url: entry.url, decision: "reject" }));
    expect((await call(environment, "POST", "/api/jev-labels", { mode: "dropped", run_id: "run-1", labels })).status).toBe(200);
    expect(events.every((row) => row.kind === "dropped-pool")).toBe(true);
    const paired = await call(environment, "GET", "/api/jev-review-batch?mode=paired");
    expect(paired.body.state).toBe("open");
  });
});

describe("admin page", () => {
  it("never hands an async loader straight to addEventListener, where the click event becomes its first argument", () => {
    const source = readFileSync("public/app.js", "utf8");
    expect(source).not.toMatch(/addEventListener\("click", (?:load|save|run)Jev[A-Za-z]*\)/);
  });
});
