import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { summarizeClefComparison, type ClefScoreRow } from "../src/clef-analysis";
import type { JevScoredItem, SupplementalShadowReport } from "../src/contracts";
import { DEFAULT_PROFILE } from "../src/contracts";
import worker from "../src/index";
import { buildJevQuestions } from "../src/jev";
import { jevQuestionFingerprint, type JevDecision, type JevLabelKind, type LabelEvent } from "../src/jev-ledger";

/**
 * One run is twelve stories. The rules select s0..s3 (K = 4). Jev's top 4 by reader_wants is
 * e0 .95, s0 .9, e1 .85, s1 .8, so s0 and s1 are both-in, s2 and s3 gate-only, e0 and e1 jev-only and
 * e2..e7 both-out. The owner would publish s0, s2, e0 and e2 and reject the rest.
 */
const STORIES = ["s0", "s1", "s2", "s3", "e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7"] as const;
type Name = (typeof STORIES)[number];
const JEV: Record<Name, number> = { s0: 0.9, s1: 0.8, s2: 0.2, s3: 0.1, e0: 0.95, e1: 0.85, e2: 0.3, e3: 0.25, e4: 0.05, e5: 0.04, e6: 0.03, e7: 0.02 };
const LOW = { s0: 0.1, s1: 0.1, s2: 0.1, s3: 0.1, e0: 0.1, e1: 0.1, e2: 0.1, e3: 0.1, e4: 0.1, e5: 0.1, e6: 0.1, e7: 0.1 } satisfies Record<Name, number>;
/** Clef picks e0, e2, s1, s3: right on e1 and e2 where Jev is wrong, wrong on s0 and s3 where Jev is right. */
const CLEF_MIXED: Record<Name, number> = { ...LOW, e0: 0.95, e2: 0.9, s1: 0.85, s3: 0.8 };
/** Clef picks e0, s0, s2, s1: right on both of the stories Jev gets wrong in the paired sample. */
const CLEF_BETTER: Record<Name, number> = { ...LOW, e0: 0.95, s0: 0.9, s2: 0.85, s1: 0.8 };
/** Clef picks four stories the owner would reject. */
const CLEF_WORSE: Record<Name, number> = { ...LOW, e1: 0.95, e3: 0.9, e4: 0.85, e5: 0.8 };

const PUBLISH = new Set<Name>(["s0", "s2", "e0", "e2"]);
const PAIRED_VOTES: Name[] = ["s0", "s2", "s3", "e0", "e1", "e2"];
const DROPPED_VOTES: Name[] = ["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7"];

const url = (run: string, name: Name): string => `https://e.test/${run}/${name}`;

function item(run: string, name: Name): JevScoredItem {
  return {
    url: url(run, name), title: `Story ${name}`, summary: `Summary ${name}`, publishedAt: "2026-10-02T00:00:00Z", sourceIds: ["tldr-ai"],
    interest: "New systems", interestConfidence: 0.8, novel: 0.7, substantive: 0.8, readerWants: JEV[name], outcome: name.startsWith("s") ? "selected" : "weakProfileFit"
  };
}

function report(run: string): SupplementalShadowReport {
  return {
    schemaVersion: 1, mode: "daily-pool", generatedAt: "2026-10-02T00:15:00.000Z", profileVersion: 3,
    jevQuestionSetVersion: "reader-want-v1", jevQuestions: { reader_wants: { type: "noul", instructions: "Would you want it?" } },
    baseIssue: { url: "https://signal.tamirlevin.dev/?edition=2026-10-02", issueDate: "2026-10-02", publicationDate: "2 October 2026" },
    sourcePack: { id: "core-ai", version: 9 }, limits: { modelCandidates: 18, publishedStories: 14 },
    sources: [{ id: "tldr-ai", name: "TLDR AI", status: "healthy", requests: 1, fetchedItems: 1, acceptedCandidates: 1, errors: [] }],
    totals: { aiNewsCandidates: 0, supplementalCandidates: 0, supplementalAfterDeduplication: 0, overlapsWithAiNews: 0, novelQualifiedCandidates: 0, wouldAdd: 0 },
    overlaps: [], wouldAdd: [], jevScores: STORIES.map((name) => item(run, name))
  };
}

function vote(run: string, name: Name, kind: JevLabelKind, decision: JevDecision): LabelEvent {
  return { storyUrl: url(run, name), questionHash: "h", questionSetVersion: "reader-want-v1", runId: run, issueDate: "2026-10-02", kind, decision, rankPosition: null, cellPopulation: null, cellSampled: null, poolSize: 12, jevK: 4, snapshotJson: "{}", createdAt: "2026-10-02T01:00:00Z" };
}

function scenario(runs: string[], clef: Record<Name, number>) {
  const events: LabelEvent[] = [];
  const reports = new Map<string, SupplementalShadowReport>();
  const rows: ClefScoreRow[] = [];
  for (const run of runs) {
    reports.set(run, report(run));
    for (const name of STORIES) rows.push({ storyUrl: url(run, name), questionHash: "h", readerWants: clef[name] });
    for (const name of PAIRED_VOTES) events.push(vote(run, name, "disagree-gate-only", PUBLISH.has(name) ? "publish" : "reject"));
    for (const name of DROPPED_VOTES) events.push(vote(run, name, "dropped-pool", PUBLISH.has(name) ? "publish" : "reject"));
  }
  return { events, reports, rows };
}

const runs = (count: number): string[] => Array.from({ length: count }, (_, index) => `run-${index + 1}`);

describe("Clef comparison gate", () => {
  it("shows only counts, and nothing that depends on a Clef score, until both frames hold enough decided stories", () => {
    const mixed = scenario(runs(3), CLEF_MIXED);
    const worse = scenario(runs(3), CLEF_WORSE);
    const locked = summarizeClefComparison(mixed.events, mixed.reports, mixed.rows);
    expect(locked.result).toBeNull();
    expect(locked.gate).toMatchObject({ needed: 40, open: false, paired: { decided: 12 }, dropped: { decided: 24 } });
    // Whatever Clef scored, the locked output is identical: it cannot be tuned by looking at it.
    expect(summarizeClefComparison(worse.events, worse.reports, worse.rows)).toEqual(locked);
  });

  it("stays locked while either frame is short, then opens at the bar", () => {
    const data = scenario(runs(3), CLEF_MIXED);
    expect(summarizeClefComparison(data.events, data.reports, data.rows, { needed: 12 }).gate.open).toBe(true);
    expect(summarizeClefComparison(data.events, data.reports, data.rows, { needed: 13 }).gate.open).toBe(false);
    const thinDropped = scenario(runs(3), CLEF_MIXED);
    const kept = thinDropped.events.filter((event) => event.kind !== "dropped-pool");
    expect(summarizeClefComparison(kept, thinDropped.reports, thinDropped.rows, { needed: 1 })).toMatchObject({ gate: { open: false, paired: { decided: 12 }, dropped: { decided: 0 } } });
    const opens = scenario(runs(10), CLEF_MIXED);
    expect(summarizeClefComparison(opens.events, opens.reports, opens.rows)).toMatchObject({ gate: { open: true, paired: { decided: 40 }, dropped: { decided: 80 } } });
  });

  it("counts a story once per frame, only decided votes, and only paired stories where the rules and Jev disagree", () => {
    const data = scenario(runs(1), CLEF_MIXED);
    data.events.push(vote("run-1", "s1", "anchor-both-in", "unsure"), vote("run-1", "e3", "dropped-pool", "publish"));
    const { gate } = summarizeClefComparison(data.events, data.reports, data.rows, { needed: 1 });
    // Paired disagreement cells: s2, s3 (gate-only) and e0, e1 (jev-only). The anchors s0 and e2 do not count, nor does the unsure.
    expect(gate.paired.decided).toBe(4);
    // The repeated dropped-pool vote on e3 is ignored: the first vote stands.
    expect(gate.dropped.decided).toBe(8);
  });

  it("leaves out votes whose run report was pruned, or whose pool Clef did not fully score, and says so", () => {
    const data = scenario(runs(3), CLEF_MIXED);
    data.reports.delete("run-2");
    const gone = summarizeClefComparison(data.events, data.reports, data.rows, { needed: 1 });
    expect(gone.gate.excluded).toEqual({ unavailable: 14, incompleteCoverage: 0 });
    expect(gone.gate.paired.decided).toBe(8);

    const partial = scenario(runs(3), CLEF_MIXED);
    const missing = url("run-3", "e7");
    const half = summarizeClefComparison(partial.events, partial.reports, partial.rows.filter((row) => row.storyUrl !== missing), { needed: 1 });
    expect(half.gate.excluded).toEqual({ unavailable: 0, incompleteCoverage: 14 });
    expect(half.gate.dropped.decided).toBe(16);

    const otherQuestions = summarizeClefComparison(partial.events, partial.reports, partial.rows.map((row) => ({ ...row, questionHash: "other" })), { needed: 1 });
    expect(otherQuestions.gate.excluded.incompleteCoverage).toBe(42);
    expect(otherQuestions.gate.open).toBe(false);
  });
});

describe("Clef comparison sample", () => {
  it("counts only labels made under the pinned question set and says how many it set aside", () => {
    const data = scenario(runs(3), CLEF_MIXED);
    const same = summarizeClefComparison(data.events, data.reports, data.rows, { needed: 1, questionHash: "h" });
    expect(same.gate).toMatchObject({ questionHash: "h", setAside: 0, paired: { decided: 12 }, dropped: { decided: 24 } });
    // A different question set restarts the sample: nothing counts, and every decided label is accounted for.
    const restarted = summarizeClefComparison(data.events, data.reports, data.rows, { needed: 1, questionHash: "v5" });
    expect(restarted.gate).toMatchObject({ questionHash: "v5", setAside: 42, paired: { decided: 0 }, dropped: { decided: 0 }, open: false });
    expect(restarted.result).toBeNull();
  });

  it("keeps the later runs' labels when only the earlier run was made under another question set", () => {
    const data = scenario(runs(3), CLEF_MIXED);
    const events = data.events.map((event) => event.runId === "run-1" ? { ...event, questionHash: "old" } : event);
    const rows = data.rows.map((row) => row.storyUrl.includes("/run-1/") ? { ...row, questionHash: "old" } : row);
    const { gate } = summarizeClefComparison(events, data.reports, rows, { needed: 1, questionHash: "h" });
    expect(gate).toMatchObject({ setAside: 14, paired: { decided: 8 }, dropped: { decided: 16 } });
  });

  it("does not restrict anything when no question set is pinned", () => {
    const data = scenario(runs(2), CLEF_MIXED);
    expect(summarizeClefComparison(data.events, data.reports, data.rows, { needed: 1 }).gate).toMatchObject({ questionHash: null, setAside: 0, paired: { decided: 8 } });
  });
});

describe("Clef comparison result", () => {
  it("measures each judge's separation in the dropped pool and who is right where Clef and Jev differ", () => {
    const data = scenario(runs(1), CLEF_MIXED);
    const { result } = summarizeClefComparison(data.events, data.reports, data.rows, { needed: 4 });
    // Dropped pool: the owner would publish e0 and e2 and reject the other six.
    expect(result!.dropped.jev).toMatchObject({ publish: 2, reject: 6, publishPicked: 1, rejectPicked: 1 });
    expect(result!.dropped.jev.separation).toBeCloseTo(0.5 - 1 / 6, 10);
    expect(result!.dropped.clef).toMatchObject({ publish: 2, reject: 6, publishPicked: 2, rejectPicked: 0, separation: 1 });
    // Paired: Clef alone is right on e1 and e2, Jev alone is right on s0 and s3; s2 is wrong for both.
    expect(result!.paired).toMatchObject({ stories: 6, discordant: 4, clefOnlyRight: 2, jevOnlyRight: 2, pValue: 1 });
    expect(result!.verdict).toBe("at-least-as-good");
  });

  it("treats a judge identical to Jev as at least as good, never better: a tie is not better", () => {
    const data = scenario(runs(12), JEV);
    const { result } = summarizeClefComparison(data.events, data.reports, data.rows);
    expect(result!.paired).toMatchObject({ discordant: 0, pValue: null });
    expect(result!.dropped.clef.separation).toBeCloseTo(result!.dropped.jev.separation!, 10);
    expect(result!.verdict).toBe("at-least-as-good");
  });

  it("calls Clef better only when it is also clearly ahead on at least 20 differing stories", () => {
    const wins = scenario(runs(12), CLEF_BETTER);
    const better = summarizeClefComparison(wins.events, wins.reports, wins.rows).result!;
    // s2 and e1 in every run: Jev is wrong on both, Clef right on both. 24 differing stories.
    expect(better.paired).toMatchObject({ discordant: 24, clefOnlyRight: 24, jevOnlyRight: 0 });
    expect(better.paired.pValue).toBeLessThan(0.001);
    expect(better.verdict).toBe("better");

    // The same lead on 16 differing stories is not enough to claim better.
    const short = scenario(runs(8), CLEF_BETTER);
    const shortResult = summarizeClefComparison(short.events, short.reports, short.rows, { needed: 32 }).result!;
    expect(shortResult.paired.discordant).toBe(16);
    expect(shortResult.verdict).toBe("at-least-as-good");
  });

  it("is not shown when Clef separates the dropped pool much worse than Jev, or is significantly worse where they differ", () => {
    const worse = scenario(runs(12), CLEF_WORSE);
    const result = summarizeClefComparison(worse.events, worse.reports, worse.rows).result!;
    expect(result.dropped.clef.separation).toBeLessThan(result.dropped.jev.separation! - 0.1);
    expect(result.verdict).toBe("not-shown");
  });
});

describe("Clef comparison endpoint", () => {
  type Bound = Array<string | number | null>;
  const d1 = (db: DatabaseSync): D1Database => {
    const statement = (sql: string) => ({
      values: [] as Bound,
      bind(...values: Bound) { this.values = values; return this; },
      async run() { db.prepare(sql).run(...this.values); return { success: true, meta: {}, results: [] }; },
      async all() { return { success: true, meta: {}, results: db.prepare(sql).all(...this.values) }; },
      async first() { return db.prepare(sql).get(...this.values) ?? null; }
    });
    return { prepare: (sql: string) => statement(sql), async batch(statements: Array<{ run: () => Promise<unknown> }>) { for (const entry of statements) await entry.run(); return []; } } as unknown as D1Database;
  };
  const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  const environment = (db: DatabaseSync) => ({
    ADMIN_TOKEN: "secret", DB: d1(db), AI: {} as Ai, ASSETS: {} as Fetcher, ENVIRONMENT: "staging",
    AI_MODEL: "x", AI_FALLBACK_MODEL: "x", AI_QUALITY_FALLBACK_MODEL: "x", AI_GATEWAY_ID: "", SUPPLEMENTAL_SHADOW_ENABLED: "true",
    TRIAGE_SHADOW_ENABLED: "false", JEV_SHADOW_ENABLED: "false", CLEF_SHADOW_ENABLED: "false", RSS_URL: "https://news.smol.ai/rss.xml"
  }) as unknown as Env;
  const database = async (migrations: (name: string) => boolean): Promise<{ db: DatabaseSync; hash: string }> => {
    const db = new DatabaseSync(":memory:");
    for (const name of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) if (migrations(name)) db.exec(readFileSync(`migrations/${name}`, "utf8"));
    db.prepare("INSERT INTO supplemental_shadow_runs (id, trigger, status, report_json, started_at, finished_at, duration_ms) VALUES ('run-1', 'cron', 'healthy', ?1, '2026-10-02T00:15:00Z', '2026-10-02T00:15:20Z', 20000)").run(JSON.stringify(report("run-1")));
    // No profile row in this schema, so the Worker falls back to the default profile; labels carry its fingerprint.
    const hash = await jevQuestionFingerprint(buildJevQuestions(DEFAULT_PROFILE, []));
    const insert = db.prepare("INSERT INTO jev_label_events (story_url, question_hash, question_set_version, run_id, issue_date, kind, decision, snapshot_json, created_at) VALUES (?1, ?2, 'reader-want-v1', 'run-1', '2026-10-02', 'disagree-gate-only', ?3, '{}', '2026-10-02T01:00:00Z')");
    for (const name of PAIRED_VOTES) insert.run(url("run-1", name), hash, PUBLISH.has(name) ? "publish" : "reject");
    // One label from before a profile change, under another question set.
    insert.run(url("run-1", "s1"), "old-question-set", "publish");
    return { db, hash };
  };
  const analysis = async (db: DatabaseSync) => {
    const response = await worker.fetch(new Request("https://app.test/api/jev-analysis", { headers: { Authorization: "Bearer secret" } }), environment(db), context);
    return { status: response.status, text: await response.text() };
  };

  it("serves counts only while locked, and never puts a Clef score in the response", async () => {
    const { db, hash } = await database((name) => name <= "0011_clef_judgments.sql" || !name.startsWith("00"));
    for (const name of STORIES) {
      db.prepare("INSERT INTO clef_judgments (story_url, question_hash, model, question_set_version, scored_at, reader_wants) VALUES (?1, ?2, 'clef', 'reader-want-v1', '2026-10-02T00:16:00Z', ?3)").run(url("run-1", name), hash, 0.123456 + STORIES.indexOf(name) / 1000);
    }
    const { status, text } = await analysis(db);
    expect(status).toBe(200);
    const body = JSON.parse(text) as { clef: { gate: Record<string, unknown>; result: unknown }; analysis: { labelledStories: number } };
    expect(body.analysis.labelledStories).toBe(7);
    expect(body.clef.result).toBeNull();
    // Counted under the current question set; the label made under the old one is set aside, not mixed in.
    expect(body.clef.gate).toMatchObject({ needed: 40, open: false, paired: { decided: 4 }, dropped: { decided: 0 }, setAside: 1, questionHash: hash });
    expect(text).not.toContain("0.123");
  });

  it("keeps the main analysis working when the Clef comparison cannot be built", async () => {
    // A database from before migration 0011 has no clef_judgments table.
    const { db } = await database((name) => name < "0011");
    const { status, text } = await analysis(db);
    expect(status).toBe(200);
    const body = JSON.parse(text) as { clef: unknown; analysis: { labelledStories: number } };
    expect(body.clef).toBeNull();
    expect(body.analysis.labelledStories).toBe(7);
  });
});

describe("Clef comparison on the admin page", () => {
  it("reads the locked state from the API and shows counts, not scores", () => {
    const source = readFileSync("public/app.js", "utf8");
    expect(source).toContain("clefComparisonHtml(data.clef)");
    expect(source).toContain("Clef's scores are not read or shown until");
    expect(source).toContain("set aside");
  });
});
