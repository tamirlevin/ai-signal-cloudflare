import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { backfillClef, CLEF_MODELS, clefQuestions, clefShadowEnabled, clefShadowModel, runClefShadow, scoreClef } from "../src/clef";
import { DEFAULT_PROFILE } from "../src/contracts";
import { buildJevQuestions } from "../src/jev";
import { jevQuestionFingerprint } from "../src/jev-ledger";
import worker from "../src/index";
import { recordClefJudgments, scoredClefUrls, unscoredClefStories, type ClefJudgmentRow } from "../src/repository";

type Bound = Array<string | number | null>;

function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string) => ({
    values: [] as Bound,
    bind(...values: Bound) {
      this.values = values;
      return this;
    },
    async run() {
      db.prepare(sql).run(...this.values);
      return { success: true, meta: {}, results: [] };
    },
    async all() {
      return { success: true, meta: {}, results: db.prepare(sql).all(...this.values) };
    },
    async first() {
      return db.prepare(sql).get(...this.values) ?? null;
    }
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      for (const item of statements) await item.run();
      return [];
    }
  } as unknown as D1Database;
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0010_jev_ledger.sql", "utf8"));
  db.exec(readFileSync("migrations/0011_clef_judgments.sql", "utf8"));
  return db;
}

const questions = buildJevQuestions(DEFAULT_PROFILE, []);

function addLedger(db: DatabaseSync, url: string, hash: string, seen = "2026-10-01T00:00:00Z") {
  db.prepare("INSERT INTO jev_judgments (story_url, question_hash, question_set_version, title, summary, first_run_id, issue_date, first_seen_at, last_seen_at, gate_outcome) VALUES (?1, ?2, 'reader-want-v1', ?3, ?4, 'run-1', '2026-10-01', ?5, ?5, 'selected')")
    .run(url, hash, `Title ${url}`, `Summary ${url}`, seen);
}

function addLabel(db: DatabaseSync, url: string, hash: string) {
  db.prepare("INSERT INTO jev_label_events (story_url, question_hash, question_set_version, run_id, issue_date, kind, decision, snapshot_json, created_at) VALUES (?1, ?2, 'reader-want-v1', 'run-1', '2026-10-01', 'dropped-pool', 'publish', '{}', '2026-10-02T00:00:00Z')").run(url, hash);
}

function clefAnswer(wants: number) {
  return {
    model: "clef",
    answers: {
      interest: { type: "choice", choice: "New systems", confidence: 0.8 },
      novel: { type: "noul", noul: 0.5 },
      substantive: { type: "noul", noul: 0.9 },
      reader_wants: { type: "noul", noul: wants }
    },
    usage: { input_tokens: 1800, output_tokens: 200 }
  };
}

const items = [
  { url: "https://example.com/a", title: "Story A", summary: "About A" },
  { url: "https://example.com/b", title: "Story B", summary: "About B" }
];

function row(url: string, model = "clef", hash = "h"): ClefJudgmentRow {
  return { storyUrl: url, questionHash: hash, model, questionSetVersion: "reader-want-v1", runId: "run-1", scoredAt: "2026-10-02T00:00:00Z", interest: "New systems", interestConfidence: 0.8, novel: 0.5, substantive: 0.9, readerWants: 0.7 };
}

describe("clef shadow configuration", () => {
  it("is enabled only by the explicit flag and defaults to the large model", () => {
    expect(clefShadowEnabled({ CLEF_SHADOW_ENABLED: "true" } as Env)).toBe(true);
    expect(clefShadowEnabled({ CLEF_SHADOW_ENABLED: "false" } as Env)).toBe(false);
    expect(clefShadowEnabled({} as Env)).toBe(false);
    expect(clefShadowModel({} as Env)).toBe("clef");
    expect(clefShadowModel({ CLEF_SHADOW_MODEL: "clef-flash" } as unknown as Env)).toBe("clef-flash");
    expect(clefShadowModel({ CLEF_SHADOW_MODEL: "something-else" } as unknown as Env)).toBe("clef");
  });
});

describe("clef scoring", () => {
  it("stringifies structured instructions but leaves strings, criteria and the original set alone", () => {
    const original = buildJevQuestions(DEFAULT_PROFILE, ["Earlier story"]);
    const copy = JSON.parse(JSON.stringify(original));
    const sent = clefQuestions(original);
    expect(Object.values(sent).every((question) => typeof question.instructions === "string")).toBe(true);
    expect(sent.novel?.instructions).toContain("Earlier story");
    expect(sent.reader_wants).toBe(original.reader_wants);
    expect(sent.novel?.criteria).toEqual(original.novel?.criteria);
    expect(original).toEqual(copy);
  });

  it("sends the Jev-shaped request to the Workers AI model id and parses the same answers", async () => {
    const ai = { run: vi.fn(async () => clefAnswer(0.64)) };
    const result = await scoreClef(ai, "clef-flash", items, questions);
    expect(ai.run).toHaveBeenCalledTimes(2);
    const [modelId, input] = ai.run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(modelId).toBe(CLEF_MODELS["clef-flash"]);
    expect(input).toMatchObject({ model: "clef-flash", state: { title: "Story A", summary: "About A", url: "https://example.com/a" }, questions: clefQuestions(questions) });
    expect(result).toMatchObject({ attempted: 2, failed: 0 });
    expect(result.scores.get("https://example.com/a")).toEqual({ interest: "New systems", interestConfidence: 0.8, novel: 0.5, substantive: 0.9, readerWants: 0.64 });
  });

  it("counts provider errors and unrecognized answers as failures without throwing", async () => {
    let call = 0;
    const ai = { run: vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("3040: Out of capacity");
      return { answers: {} };
    }) };
    const result = await scoreClef(ai, "clef", items, questions);
    expect(result.scores.size).toBe(0);
    expect(result).toMatchObject({ attempted: 2, failed: 2 });
    expect(result.firstError).toContain("Out of capacity");
  });
});

describe("clef storage", () => {
  it("keeps the first score and reports which stories are already scored", async () => {
    const db = database();
    await recordClefJudgments(d1(db), [row("https://example.com/a")]);
    await recordClefJudgments(d1(db), [{ ...row("https://example.com/a"), readerWants: 0.1 }, row("https://example.com/b")]);
    const stored = db.prepare("SELECT story_url, reader_wants FROM clef_judgments ORDER BY story_url").all() as Array<{ story_url: string; reader_wants: number }>;
    expect(stored).toEqual([{ story_url: "https://example.com/a", reader_wants: 0.7 }, { story_url: "https://example.com/b", reader_wants: 0.7 }]);
    const found = await scoredClefUrls(d1(db), "h", "clef", ["https://example.com/a", "https://example.com/c"]);
    expect([...found]).toEqual(["https://example.com/a"]);
    expect((await scoredClefUrls(d1(db), "h", "clef-flash", ["https://example.com/a"])).size).toBe(0);
    expect((await scoredClefUrls(d1(db), "other", "clef", ["https://example.com/a"])).size).toBe(0);
  });

  it("looks up more than one chunk of urls", async () => {
    const db = database();
    const urls = Array.from({ length: 120 }, (_, index) => `https://example.com/${index}`);
    await recordClefJudgments(d1(db), urls.map((url) => row(url)));
    expect((await scoredClefUrls(d1(db), "h", "clef", urls)).size).toBe(120);
  });

  it("lists unscored ledger stories with labelled ones first and counts the rest", async () => {
    const db = database();
    addLedger(db, "https://example.com/old", "h", "2026-09-30T00:00:00Z");
    addLedger(db, "https://example.com/new", "h", "2026-10-02T00:00:00Z");
    addLedger(db, "https://example.com/labelled", "h", "2026-10-01T00:00:00Z");
    addLedger(db, "https://example.com/other-questions", "different", "2026-10-01T00:00:00Z");
    addLabel(db, "https://example.com/labelled", "h");
    await recordClefJudgments(d1(db), [row("https://example.com/old")]);
    const result = await unscoredClefStories(d1(db), "h", "clef", 1);
    expect(result.stories.map((story) => story.storyUrl)).toEqual(["https://example.com/labelled"]);
    expect(result.remaining).toBe(2);
  });
});

describe("clef shadow run", () => {
  it("scores only stories that are not yet scored and records the run id", async () => {
    const db = database();
    const hash = await jevQuestionFingerprint(questions);
    await recordClefJudgments(d1(db), [row("https://example.com/a", "clef", hash)]);
    const ai = { run: vi.fn(async () => clefAnswer(0.6)) };
    await runClefShadow({ DB: d1(db), AI: ai } as unknown as Env, { items, questions, runId: "run-9" });
    expect(ai.run).toHaveBeenCalledTimes(1);
    const stored = db.prepare("SELECT story_url, run_id, reader_wants FROM clef_judgments ORDER BY story_url").all();
    expect(stored).toEqual([
      { story_url: "https://example.com/a", run_id: "run-1", reader_wants: 0.7 },
      { story_url: "https://example.com/b", run_id: "run-9", reader_wants: 0.6 }
    ]);
  });

  it("never throws when the model or the database fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = database();
    const failing = { run: vi.fn(async () => { throw new Error("provider down"); }) };
    await expect(runClefShadow({ DB: d1(db), AI: failing } as unknown as Env, { items, questions, runId: "run-9" })).resolves.toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM clef_judgments").get()).toEqual({ n: 0 });
    const broken = { prepare() { throw new Error("db down"); } } as unknown as D1Database;
    await expect(runClefShadow({ DB: broken, AI: failing } as unknown as Env, { items, questions, runId: null })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("clef backfill", () => {
  it("scores ledger stories under the current question fingerprint and reports what remains", async () => {
    const db = database();
    const hash = await jevQuestionFingerprint(buildJevQuestions(DEFAULT_PROFILE, []));
    addLedger(db, "https://example.com/a", hash);
    addLedger(db, "https://example.com/b", hash);
    addLedger(db, "https://example.com/c", hash);
    addLedger(db, "https://example.com/stale", "from-an-older-profile");
    const ai = { run: vi.fn(async () => clefAnswer(0.55)) };
    const first = await backfillClef({ DB: d1(db), AI: ai, CLEF_SHADOW_MODEL: "clef-flash" } as unknown as Env, DEFAULT_PROFILE, 2);
    expect(first).toMatchObject({ model: "clef-flash", questionHash: hash, selected: 2, scored: 2, failed: 0, remaining: 1 });
    const second = await backfillClef({ DB: d1(db), AI: ai, CLEF_SHADOW_MODEL: "clef-flash" } as unknown as Env, DEFAULT_PROFILE, 5);
    expect(second).toMatchObject({ selected: 1, scored: 1, remaining: 0 });
    const third = await backfillClef({ DB: d1(db), AI: ai, CLEF_SHADOW_MODEL: "clef-flash" } as unknown as Env, DEFAULT_PROFILE, 5);
    expect(third).toMatchObject({ selected: 0, scored: 0, remaining: 0 });
    expect(ai.run).toHaveBeenCalledTimes(3);
  });
});

describe("clef backfill route", () => {
  const env = (environment: string) => ({
    ADMIN_TOKEN: "secret", DB: {} as D1Database, AI: {} as Ai, ASSETS: {} as Fetcher, ENVIRONMENT: environment,
    AI_MODEL: "x", AI_FALLBACK_MODEL: "x", AI_QUALITY_FALLBACK_MODEL: "x", AI_GATEWAY_ID: "", SUPPLEMENTAL_SHADOW_ENABLED: "true",
    TRIAGE_SHADOW_ENABLED: "false", JEV_SHADOW_ENABLED: "false", CLEF_SHADOW_ENABLED: "false", RSS_URL: "https://news.smol.ai/rss.xml"
  }) as unknown as Env;
  const context = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

  it("is hidden in production and needs the owner token and POST elsewhere", async () => {
    expect((await worker.fetch(new Request("https://app.test/__clef-backfill", { method: "POST" }), env("production"), context)).status).toBe(404);
    expect((await worker.fetch(new Request("https://app.test/__clef-backfill"), env("staging"), context)).status).toBe(405);
    expect((await worker.fetch(new Request("https://app.test/__clef-backfill", { method: "POST" }), env("staging"), context)).status).toBe(401);
  });
});
