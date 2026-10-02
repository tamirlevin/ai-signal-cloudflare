import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JevScoredItem, SupplementalShadowReport } from "../src/contracts";
import worker from "../src/index";
import { recordJevLabelEvents } from "../src/repository";
import {
  buildDroppedBatch,
  buildJudgmentRows,
  buildPairedBatch,
  enrichEventsWithPicks,
  firstVotes,
  jevPickSet,
  jevQuestionFingerprint,
  judgePicks,
  MAX_DROPPED_BATCH,
  PAIRED_BATCH_SIZE,
  reviewPool,
  summarizeJevLabels,
  unscoredSelectedCount,
  type Cell,
  type JevDecision,
  type JevLabelKind,
  type LabelEvent
} from "../src/jev-ledger";

type Spec = { url: string; outcome: JevScoredItem["outcome"]; wants: number | null; raw?: number | null; unscored?: boolean };

function scored(spec: Spec): JevScoredItem {
  if (spec.unscored) {
    return { url: spec.url, title: `Story ${spec.url}`, summary: "", publishedAt: "", sourceIds: ["tldr-ai"], interest: null, interestConfidence: null, novel: null, substantive: null, readerWants: null, outcome: spec.outcome };
  }
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
    overlaps: [], wouldAdd: [], jevScores: specs.map(scored),
    triageScores: specs.filter((spec) => spec.raw !== undefined).map((spec) => ({ url: spec.url, title: spec.url, relevance: 0.5, rawRelevance: spec.raw ?? null, winningInterest: "New systems", rank: 1, novelty: 0.5, outcome: spec.outcome, sourceIds: [] }))
  };
}

/**
 * Twelve eligible stories. The gate selects sel-0..5 (K = 6). Jev's top 6 by reader_wants
 * is exc-0 .95, sel-0 .9, exc-1 .85, sel-1 .8, sel-2 .7, exc-2 .6, so the cut is .5:
 * both-in sel-0..2, gate-only sel-3..5, jev-only exc-0..2, both-out exc-3..5. The reranker
 * differs from Jev on two stories: it picks sel-3 and skips exc-2. One more row has no
 * usable evidence, and one selected row has no Jev answer.
 */
function pool(): Spec[] {
  const selected = [0.9, 0.8, 0.7, 0.3, 0.2, 0.1].map((wants, index) => ({ url: `https://e.test/sel-${index}`, outcome: "selected" as const, wants, raw: index === 3 ? 0.99 : wants }));
  const excluded = [0.95, 0.85, 0.6, 0.4, 0.05, 0.02].map((wants, index) => ({ url: `https://e.test/exc-${index}`, outcome: "weakProfileFit" as const, wants, raw: index === 2 ? 0 : wants }));
  return [...selected, ...excluded, { url: "https://e.test/noevidence", outcome: "noUsableEvidence", wants: 0.99 }];
}

function unscoredSelectedSpec(): Spec {
  return { url: "https://e.test/unscored", outcome: "selected", wants: null, unscored: true };
}

const NOW = Date.parse("2026-09-29T12:00:00Z");

describe("judge picks", () => {
  it("takes the top K by each score, K = the gate's selection size, and places each story in a cell with its distance from the Jev cut", () => {
    const candidates = reviewPool(report(pool()));
    const { k, picks } = jevPickSet(candidates);
    expect(k).toBe(6);
    expect([...picks].sort()).toEqual(["https://e.test/exc-0", "https://e.test/exc-1", "https://e.test/exc-2", "https://e.test/sel-0", "https://e.test/sel-1", "https://e.test/sel-2"]);
    const all = judgePicks(candidates);
    expect(all.get("https://e.test/sel-0")).toMatchObject({ cell: "both-in", gate: true, jev: true, k: 6 });
    expect(all.get("https://e.test/sel-3")).toMatchObject({ cell: "gate-only", gate: true, jev: false, reranker: true });
    expect(all.get("https://e.test/exc-2")).toMatchObject({ cell: "jev-only", gate: false, jev: true, reranker: false });
    expect(all.get("https://e.test/exc-4")).toMatchObject({ cell: "both-out" });
    // The cut is the midpoint of the 6th (.6) and 7th (.4) scores.
    expect(all.get("https://e.test/exc-0")!.margin).toBeCloseTo(0.45, 10);
    expect(all.get("https://e.test/exc-2")!.margin).toBeCloseTo(0.1, 10);
    expect(all.get("https://e.test/sel-3")!.margin).toBeCloseTo(0.2, 10);
  });

  it("counts rules-selected stories Jev never scored instead of hiding them", () => {
    expect(unscoredSelectedCount(report([...pool(), unscoredSelectedSpec()]))).toBe(1);
    expect(reviewPool(report([...pool(), unscoredSelectedSpec()]))).toHaveLength(12);
  });
});

function event(partial: Partial<LabelEvent> & { storyUrl: string; kind: JevLabelKind; decision: JevDecision; wants?: number | null }): LabelEvent {
  const { wants = 0.5, ...rest } = partial;
  return {
    questionHash: "hash-1", questionSetVersion: "reader-want-v1", runId: "run-1", issueDate: "2026-09-29", rankPosition: null,
    cellPopulation: null, cellSampled: null, poolSize: 12, jevK: 6, createdAt: "2026-09-29T01:00:00Z",
    snapshotJson: JSON.stringify({ candidate: { url: partial.storyUrl, title: `T ${partial.storyUrl}`, summary: "", publishedAt: "", sourceIds: [], assessment: { gateOutcome: "selected", interest: null, interestConfidence: null, novel: null, substantive: null, readerWants: wants, reranker: null } } }),
    ...rest
  };
}

type PickSpec = { cell: Cell; margin?: number | null; reranker?: boolean | null; wants?: number | null; raw?: number | null };

/** A label whose snapshot carries the judge picks recorded at label time. */
function vote(storyUrl: string, decision: JevDecision, spec: PickSpec, extra: Partial<LabelEvent> = {}): LabelEvent {
  const gate = spec.cell === "both-in" || spec.cell === "gate-only";
  const jev = spec.cell === "both-in" || spec.cell === "jev-only";
  const wants = spec.wants ?? 0.5;
  return event({
    storyUrl, kind: "disagree-gate-only", decision, wants,
    snapshotJson: JSON.stringify({ candidate: { url: storyUrl, title: `T ${storyUrl}`, summary: "", publishedAt: "", sourceIds: [], assessment: {
      gateOutcome: gate ? "selected" : "weakProfileFit", interest: null, interestConfidence: null, novel: null, substantive: null, readerWants: wants,
      reranker: { relevance: 0.5, rawRelevance: spec.raw ?? null, winningInterest: null, rank: null, novelty: null },
      picks: { gate, jev, reranker: spec.reranker === undefined ? false : spec.reranker, cell: spec.cell, margin: spec.margin ?? null, k: 6 }
    } } }),
    ...extra
  });
}

describe("paired batch", () => {
  const kindCounts = (items: Array<{ kind: string }>) => items.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.kind]: (counts[entry.kind] ?? 0) + 1 }), {});

  it("fills spare places round-robin and records each story's picks on the batch item", () => {
    const batch = buildPairedBatch("run-a", report(pool()), [], NOW);
    expect(batch).toMatchObject({ poolSize: 12, jevK: 6, unscoredSelected: 0 });
    expect(batch.items).toHaveLength(12);
    expect(kindCounts(batch.items)).toEqual({ "disagree-gate-only": 3, "disagree-jev-only": 3, "anchor-both-in": 3, "anchor-both-out": 3 });
    expect(new Set(batch.items.map((entry) => entry.url)).size).toBe(12);
    expect(batch.items.map((entry) => entry.url)).not.toContain("https://e.test/noevidence");
    for (const entry of batch.items) expect(entry.assessment.picks).toBeDefined();
  });

  const wide = () => {
    const selected = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/s${index}`, outcome: "selected" as const, wants: 0.1 + index / 100 }));
    const excluded = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/x${index}`, outcome: "weakProfileFit" as const, wants: 0.8 + index / 100 }));
    return report([...selected, ...excluded]);
  };

  it("draws clear disagreements before near-ties, at random within each, neither side favoured", () => {
    // Rules select s0..s7 (K = 8). Jev's top 8 is x0..x7, so every selected story is gate-only and every excluded one jev-only.
    // s0..s3 and x0..x3 sit far from the cut; s4..s7 and x4..x7 sit within a few hundredths of it.
    const selected = [0.1, 0.11, 0.12, 0.13, 0.55, 0.54, 0.53, 0.52].map((wants, index) => ({ url: `https://e.test/s${index}`, outcome: "selected" as const, wants }));
    const excluded = [0.95, 0.94, 0.93, 0.92, 0.61, 0.6, 0.59, 0.58].map((wants, index) => ({ url: `https://e.test/x${index}`, outcome: "weakProfileFit" as const, wants }));
    const batch = buildPairedBatch("run-a", report([...selected, ...excluded]), [], NOW);
    expect(kindCounts(batch.items)).toEqual({ "disagree-gate-only": 6, "disagree-jev-only": 6 });
    const urls = batch.items.map((entry) => entry.url);
    for (const name of ["s0", "s1", "s2", "s3", "x0", "x1", "x2", "x3"]) expect(urls).toContain(`https://e.test/${name}`);
    // The four spare places go to near-ties, two per side, because the clear ones ran out.
    expect(batch.items.filter((entry) => (entry.assessment.picks!.margin ?? 1) < 0.08)).toHaveLength(4);
    for (const entry of batch.items.filter((item) => item.url.includes("/s") || item.url.includes("/x"))) expect(entry.assessment.picks!.margin).not.toBeNull();
  });

  it("draws a random subset of the clear disagreements, not the ones where Jev looks best", () => {
    const wide = () => {
      const selected = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/s${index}`, outcome: "selected" as const, wants: 0.1 + index / 100 }));
      const excluded = Array.from({ length: 12 }, (_, index) => ({ url: `https://e.test/x${index}`, outcome: "weakProfileFit" as const, wants: 0.8 + index / 100 }));
      return report([...selected, ...excluded]);
    };
    const sets = ["run-a", "run-b", "run-c", "run-d"].map((runId) => buildPairedBatch(runId, wide(), [], NOW).items.filter((entry) => entry.kind === "disagree-gate-only").map((entry) => entry.url).sort().join());
    expect(new Set(sets).size).toBeGreaterThan(1);
  });

  it("is stable across reloads and varies its anchors with the run", () => {
    const urls = (runId: string) => buildPairedBatch(runId, report(pool()), [], NOW).items.map((entry) => entry.url);
    expect(urls("run-a")).toEqual(urls("run-a"));
    expect(urls("run-a")).not.toEqual(urls("run-b"));
  });

  it("never re-draws a story already voted in the paired frame, and re-shows at most two old votes as repeats", () => {
    const history = [
      event({ storyUrl: "https://e.test/sel-3", kind: "disagree-gate-only", decision: "reject", runId: "run-old", createdAt: "2026-09-20T00:00:00Z" }),
      event({ storyUrl: "https://e.test/sel-4", kind: "disagree-gate-only", decision: "reject", runId: "run-old", createdAt: "2026-09-20T00:00:00Z" }),
      event({ storyUrl: "https://e.test/exc-3", kind: "anchor-both-out", decision: "reject", runId: "run-old", createdAt: "2026-09-20T00:00:00Z" })
    ];
    const batch = buildPairedBatch("run-new", report(pool()), history, NOW);
    const repeats = batch.items.filter((entry) => entry.kind === "repeat");
    expect(repeats).toHaveLength(2);
    const ordinary = batch.items.filter((entry) => entry.kind !== "repeat").map((entry) => entry.url);
    for (const name of ["sel-3", "sel-4", "exc-3"]) expect(ordinary).not.toContain(`https://e.test/${name}`);
    expect(batch.items).toHaveLength(11);
    expect(batch.items.length).toBeLessThanOrEqual(PAIRED_BATCH_SIZE);
  });

  it("does not let a dropped-pool vote remove a story from the paired sample: the two frames are counted apart", () => {
    const votedInDropped = [event({ storyUrl: "https://e.test/exc-0", kind: "dropped-pool", decision: "reject", runId: "run-old" })];
    const paired = buildPairedBatch("run-new", report(pool()), votedInDropped, NOW);
    expect(paired.items.map((entry) => entry.url)).toContain("https://e.test/exc-0");
    expect(firstVotes(votedInDropped, "paired").size).toBe(0);
    expect(firstVotes(votedInDropped, "dropped").has("https://e.test/exc-0")).toBe(true);
  });

  it("holds repeats back until the first look is three days old", () => {
    const fresh = [event({ storyUrl: "https://e.test/sel-3", kind: "disagree-gate-only", decision: "reject", runId: "run-old", createdAt: "2026-09-28T06:00:00Z" })];
    expect(buildPairedBatch("run-new", report(pool()), fresh, NOW).items.filter((entry) => entry.kind === "repeat")).toHaveLength(0);
    const aged = [event({ storyUrl: "https://e.test/sel-3", kind: "disagree-gate-only", decision: "reject", runId: "run-old", createdAt: "2026-09-26T06:00:00Z" })];
    expect(buildPairedBatch("run-new", report(pool()), aged, NOW).items.filter((entry) => entry.kind === "repeat")).toHaveLength(1);
  });

  it("does not repeat a story voted in this same run, or one already repeated", () => {
    const history = [
      event({ storyUrl: "https://e.test/sel-3", kind: "disagree-gate-only", decision: "reject", runId: "run-new", createdAt: "2026-09-20T00:00:00Z" }),
      event({ storyUrl: "https://e.test/sel-4", kind: "disagree-gate-only", decision: "reject", runId: "run-old", createdAt: "2026-09-20T00:00:00Z" }),
      event({ storyUrl: "https://e.test/sel-4", kind: "repeat", decision: "reject", runId: "run-mid" })
    ];
    expect(buildPairedBatch("run-new", report(pool()), history, NOW).items.filter((entry) => entry.kind === "repeat")).toHaveLength(0);
  });
});

describe("dropped-pool batch", () => {
  it("is a census of unjudged rules-dropped stories and says when it is complete", () => {
    const history = [event({ storyUrl: "https://e.test/exc-0", kind: "dropped-pool", decision: "publish", runId: "run-old" })];
    const batch = buildDroppedBatch("run-a", report(pool()), history);
    expect(batch.complete).toBe(true);
    expect(batch.items.every((entry) => entry.kind === "dropped-pool" && entry.assessment.gateOutcome !== "selected")).toBe(true);
    expect(batch.items.map((entry) => entry.url).sort()).toEqual(["https://e.test/exc-1", "https://e.test/exc-2", "https://e.test/exc-3", "https://e.test/exc-4", "https://e.test/exc-5"]);
    for (const entry of batch.items) expect(entry).toMatchObject({ cellPopulation: 5, cellSampled: 5 });
  });

  it("caps the batch and says it is a sample, not a census", () => {
    const many = Array.from({ length: MAX_DROPPED_BATCH + 5 }, (_, index) => ({ url: `https://e.test/d${index}`, outcome: "weakProfileFit" as const, wants: 0.3 }));
    const batch = buildDroppedBatch("run-a", report([{ url: "https://e.test/s", outcome: "selected", wants: 0.9 }, ...many]), []);
    expect(batch.items).toHaveLength(MAX_DROPPED_BATCH);
    expect(batch.complete).toBe(false);
  });

  it("is not thinned by votes made in the paired sample, so the census keeps the stories Jev favoured", () => {
    const history = [event({ storyUrl: "https://e.test/exc-0", kind: "disagree-jev-only", decision: "publish", runId: "run-old" })];
    const batch = buildDroppedBatch("run-a", report(pool()), history);
    expect(batch.items.map((entry) => entry.url)).toContain("https://e.test/exc-0");
    expect(batch.items).toHaveLength(6);
  });
});

describe("enriching labels made before picks were recorded", () => {
  it("restores the picks from the run's retained report", () => {
    const old = event({ storyUrl: "https://e.test/exc-1", kind: "dropped-pool", decision: "reject", runId: "run-1", wants: 0.85 });
    const [enriched] = enrichEventsWithPicks([old], new Map([["run-1", report(pool())]]));
    // A dropped-pool label is reported with the dropped pool, split by the cell its picks give it.
    expect(summarizeJevLabels([enriched!]).droppedByCell.jevOnly).toMatchObject({ n: 1, reject: 1 });
    expect(summarizeJevLabels([old]).droppedByCell.jevOnly.n).toBe(0);
  });

  it("leaves a label alone when its run has been pruned", () => {
    const old = event({ storyUrl: "https://e.test/exc-1", kind: "dropped-pool", decision: "reject", runId: "run-gone" });
    expect(enrichEventsWithPicks([old], new Map())[0]).toBe(old);
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
    const rep = report([{ url: "https://e.test/a", outcome: "selected", wants: 0.9, raw: 0.1 }, { url: "https://e.test/b", outcome: "weakProfileFit", wants: 0.2 }]);
    const rows = buildJudgmentRows({ runId: "run-1", report: rep, questionHash: "abc", publishedUrls: new Set(["https://e.test/a"]), seenAt: "2026-09-29T00:16:00Z" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ storyUrl: "https://e.test/a", questionHash: "abc", readerWants: 0.9, rerankerRaw: 0.1, selected: true, published: true, profileVersion: 7, sourcePackVersion: 7, firstRunId: "run-1", issueDate: "2026-09-29" });
    expect(rows[1]).toMatchObject({ storyUrl: "https://e.test/b", selected: false, published: false, rerankerRaw: null });
  });
});

describe("analysis", () => {
  const events: LabelEvent[] = [
    vote("e1", "publish", { cell: "gate-only", margin: 0.3, reranker: true, wants: 0.4, raw: 0.9 }),
    vote("e2", "reject", { cell: "gate-only", margin: 0.3, reranker: true, wants: 0.35, raw: 0.8 }),
    vote("e3", "unsure", { cell: "gate-only", margin: 0.05, wants: 0.45, raw: 0.5 }),
    vote("e4", "publish", { cell: "jev-only", margin: 0.4, reranker: false, wants: 0.9, raw: 0.4 }),
    vote("e5", "reject", { cell: "jev-only", margin: 0.2, reranker: false, wants: 0.7, raw: 0.3 }),
    vote("e8", "publish", { cell: "both-in", margin: 0.4, reranker: true, wants: 0.95, raw: 1 }, { kind: "anchor-both-in" }),
    vote("e9", "reject", { cell: "both-out", margin: 0.4, reranker: false, wants: 0.1, raw: 0.1 }, { kind: "anchor-both-out" }),
    // Dropped-pool votes are a different frame: they never enter the head-to-head or the judge comparison.
    vote("e6", "publish", { cell: "jev-only", margin: 0.06, reranker: true, wants: 0.6, raw: 0.7 }, { kind: "dropped-pool" }),
    vote("e7", "reject", { cell: "both-out", margin: 0.4, wants: 0.1, raw: 0.1 }, { kind: "dropped-pool" }),
    // Repeats of two earlier stories: one same, one flipped from publish to reject.
    event({ storyUrl: "e2", kind: "repeat", decision: "reject", runId: "run-2" }),
    event({ storyUrl: "e1", kind: "repeat", decision: "reject", runId: "run-2" })
  ];

  it("counts paired-sample votes by recorded cell and keeps dropped-pool votes out, separating clear disagreements from near-ties", () => {
    const { headToHead } = summarizeJevLabels(events);
    // gate-only [publish, reject, unsure], jev-only [publish, reject]. Jev right on the jev-only publish and the gate-only reject.
    expect(headToHead.all).toMatchObject({ decided: 4, jevRight: 2, gateRight: 2, jevRightShare: 0.5 });
    expect(headToHead.all.gateOnly).toMatchObject({ n: 3, publish: 1, reject: 1, unsure: 1, publishShare: 0.5 });
    expect(headToHead.all.jevOnly).toMatchObject({ n: 2, publish: 1, reject: 1 });
    // Unsure read as "would not add": the gate-only unsure is a story Jev was right to drop.
    expect(headToHead.all).toMatchObject({ decidedUnsureAsReject: 5 });
    expect(headToHead.all.jevRightShareUnsureAsReject).toBeCloseTo(3 / 5, 10);
    // Clear = distance from the cut at least 0.08: only e3 (0.05) falls out.
    expect(headToHead.clear).toMatchObject({ decided: 4, jevRight: 2, gateRight: 2 });
    expect(headToHead.clearMargin).toBe(0.08);
  });

  it("reads a Jev-only unsure as a story the rules were right to leave out when unsure means would-not-add", () => {
    const unsure = summarizeJevLabels([vote("u1", "unsure", { cell: "jev-only", margin: 0.3 }), vote("u2", "publish", { cell: "jev-only", margin: 0.3 })]);
    expect(unsure.headToHead.all).toMatchObject({ decided: 1, jevRight: 1, decidedUnsureAsReject: 2 });
    expect(unsure.headToHead.all.jevRightShareUnsureAsReject).toBe(0.5);
  });

  it("compares the three judges on identical paired-sample stories with a sign test on the discordant ones", () => {
    const { judges } = summarizeJevLabels(events);
    // Decided paired-sample stories with picks: e1 e2 e4 e5 e8 e9. Right = the pick matched publish, the non-pick reject.
    expect(judges).toMatchObject({ n: 6, rerankerN: 6, jevRight: 4, gateRight: 4, rerankerRight: 4 });
    expect(judges.jevVsReranker).toMatchObject({ discordant: 4, firstOnlyRight: 2, secondOnlyRight: 2, bothRight: 2, bothWrong: 0 });
    expect(judges.jevVsReranker.pValue).toBe(1);
    expect(judges.jevVsGate).toMatchObject({ discordant: 4, firstOnlyRight: 2, secondOnlyRight: 2, bothRight: 2 });
  });

  it("does not score a story the reranker never saw as a reranker rejection", () => {
    const partial = summarizeJevLabels([
      vote("p1", "publish", { cell: "jev-only", margin: 0.3, reranker: null }),
      vote("p2", "publish", { cell: "jev-only", margin: 0.3, reranker: null }),
      vote("p3", "reject", { cell: "gate-only", margin: 0.3, reranker: false })
    ]);
    // If a missing score counted as "not picked", the reranker would be wrong on both publishes; instead they are left out.
    expect(partial.judges).toMatchObject({ n: 3, rerankerN: 1, rerankerRight: 1, jevRight: 3 });
    expect(partial.judges.jevVsReranker.discordant + partial.judges.jevVsReranker.bothRight + partial.judges.jevVsReranker.bothWrong).toBe(1);
  });

  it("uses the paired kind for labels made before picks were recorded, so both analyses count the same stories", () => {
    const old = [
      event({ storyUrl: "o1", kind: "disagree-gate-only", decision: "publish" }),
      event({ storyUrl: "o2", kind: "disagree-jev-only", decision: "publish" })
    ];
    const result = summarizeJevLabels(old);
    expect(result.headToHead.all.decided).toBe(2);
    expect(result.judges).toMatchObject({ n: 2, rerankerN: 0 });
    expect(result.headToHead.clear.decided).toBe(0);
  });

  it("gives a small p-value only when one judge is alone right far more often", () => {
    const lopsided = [
      ...Array.from({ length: 9 }, (_, index) => vote(`w${index}`, "publish", { cell: "jev-only", margin: 0.3, reranker: false })),
      vote("l", "reject", { cell: "jev-only", margin: 0.3, reranker: false })
    ];
    const { jevVsReranker } = summarizeJevLabels(lopsided).judges;
    expect(jevVsReranker).toMatchObject({ discordant: 10, firstOnlyRight: 9, secondOnlyRight: 1 });
    expect(jevVsReranker.pValue).toBeCloseTo(2 * (1 + 10) / 1024, 10);
  });

  it("counts a story once per frame, and stories seen in either frame as labelled", () => {
    const result = summarizeJevLabels(events);
    expect(result.labelledStories).toBe(9);
    expect(result.consistency).toMatchObject({ pairs: 2, sameDecision: 1, sameAsPublish: 1, rate: 0.5, publishAgreementRate: 0.5 });
    const both = summarizeJevLabels([vote("same", "publish", { cell: "jev-only", margin: 0.3 }), vote("same", "reject", { cell: "jev-only", margin: 0.3 }, { kind: "dropped-pool" })]);
    expect(both.headToHead.all.jevOnly).toMatchObject({ n: 1, publish: 1 });
    expect(both.droppedPool).toMatchObject({ n: 1, reject: 1 });
  });

  it("sizes what the rules drop from the dropped pool alone, split by whether Jev would have picked it", () => {
    const { droppedPool, droppedByCell, anchors } = summarizeJevLabels(events);
    expect(droppedPool).toMatchObject({ n: 2, publish: 1, reject: 1, publishShare: 0.5, days: 1, rescuedPerDay: 1 });
    expect(droppedByCell.jevOnly).toMatchObject({ n: 1, publish: 1 });
    expect(droppedByCell.bothOut).toMatchObject({ n: 1, reject: 1 });
    expect(anchors.bothIn).toMatchObject({ n: 1, publish: 1 });
    expect(anchors.bothOut).toMatchObject({ n: 1, reject: 1 });
  });

  it("scores the reranker on its raw score, not the per-run normalised one", () => {
    const { ranking } = summarizeJevLabels(events);
    expect(ranking.n).toBe(6);
    // Publish raws (.9 .4 1) against reject raws (.8 .3 .1) win 8 of 9 pairs. The snapshot's normalised
    // relevance is a constant .5, so an AUC taken from it would be .5, not this.
    expect(ranking.rerankerAuc).toBeCloseTo(8 / 9, 10);
    // Publish wants (.4 .9 .95) against reject wants (.35 .7 .1) also win 8 of 9.
    expect(ranking.readerWantsAuc).toBeCloseTo(8 / 9, 10);
  });

  it("correlates the owner's publish-set ranks with reader_wants", () => {
    const ranked = [
      vote("r1", "publish", { cell: "jev-only", wants: 0.9 }, { runId: "run-r" }),
      vote("r2", "publish", { cell: "jev-only", wants: 0.6 }, { runId: "run-r" }),
      vote("r3", "publish", { cell: "both-in", wants: 0.3 }, { runId: "run-r" }),
      ...[1, 2, 3].map((position) => event({ storyUrl: `r${position}`, kind: "rank", decision: "publish", rankPosition: position, runId: "run-r" }))
    ];
    expect(summarizeJevLabels(ranked).ranking.meanRankCorrelation).toBeCloseTo(1, 10);
    const reversed = summarizeJevLabels(ranked.map((entry) => entry.kind === "rank" ? { ...entry, rankPosition: 4 - entry.rankPosition! } : entry));
    expect(reversed.ranking.meanRankCorrelation).toBeCloseTo(-1, 10);
  });

  it("reports the proposed bar as not enough data until the sample is large enough, then judges it", () => {
    expect(summarizeJevLabels(events).bar.map((item) => item.status)).toEqual(["insufficient", "insufficient", "insufficient"]);
    const many: LabelEvent[] = [];
    for (let index = 0; index < 40; index += 1) many.push(vote(`c${index}`, index < 30 ? "publish" : "reject", { cell: "jev-only", margin: 0.3, reranker: index >= 25 }));
    for (let index = 0; index < 10; index += 1) many.push(event({ storyUrl: `c${index}`, kind: "repeat", decision: index < 8 ? "publish" : "reject", runId: "run-2" }));
    const bar = Object.fromEntries(summarizeJevLabels(many).bar.map((item) => [item.id, item.status]));
    // 30 of 40 clear jev-only stories published (Jev right 75%); repeats match 8 of 10; Jev alone right on 25 stories, the reranker on none.
    expect(bar).toEqual({ "own-consistency": "pass", "beats-rules": "pass", "beats-reranker": "pass" });
  });

  it("does not let Jev pass by merely tying the free reranker", () => {
    const tie = [
      ...Array.from({ length: 10 }, (_, index) => vote(`t${index}`, "publish", { cell: "jev-only", margin: 0.3, reranker: false })),
      ...Array.from({ length: 10 }, (_, index) => vote(`f${index}`, "reject", { cell: "jev-only", margin: 0.3, reranker: false }))
    ];
    const summary = summarizeJevLabels(tie);
    expect(summary.judges.jevVsReranker).toMatchObject({ discordant: 20, firstOnlyRight: 10, secondOnlyRight: 10 });
    expect(summary.bar.find((item) => item.id === "beats-reranker")!.status).toBe("fail");
  });

  it("is empty-safe", () => {
    const empty = summarizeJevLabels([]);
    expect(empty.labelledStories).toBe(0);
    expect(empty.headToHead.all.jevRightShare).toBeNull();
    expect(empty.consistency.rate).toBeNull();
    expect(empty.ranking.readerWantsAuc).toBeNull();
    expect(empty.judges.jevVsReranker.pValue).toBeNull();
  });
});

// ---------- storage and endpoints ----------

type Row = Record<string, unknown>;

function fakeDb(rep: SupplementalShadowReport) {
  const runRow = { id: "run-1", trigger: "cron", status: "healthy", base_issue_url: null, base_issue_date: null, report_json: JSON.stringify(rep), error_code: null, error_message: null, started_at: "2026-09-29T00:15:00Z", finished_at: "2026-09-29T00:15:20Z", duration_ms: 20000 };
  const events: Row[] = [];
  const columns = ["story_url", "question_hash", "question_set_version", "run_id", "issue_date", "kind", "decision", "rank_position", "cell_population", "cell_sampled", "pool_size", "jev_k", "profile_version", "source_pack_id", "source_pack_version", "snapshot_json", "created_at"];
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      if (sql.includes("INSERT INTO jev_label_events")) {
        const duplicate = sql.includes("WHERE NOT EXISTS") && events.some((row) => row.run_id === values[3] && row.story_url === values[0] && row.kind === values[5]);
        if (!duplicate) events.push({ id: events.length + 1, ...Object.fromEntries(columns.map((column, index) => [column, values[index]])) });
      }
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
    TRIAGE_SHADOW_ENABLED: "false" as const, JEV_SHADOW_ENABLED: "false" as const, CLEF_SHADOW_ENABLED: "false" as const, RSS_URL: "https://news.smol.ai/rss.xml" as const
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

describe("label storage", () => {
  it("skips a vote already stored for the same run, story and kind, so two open tabs cannot double-count", async () => {
    const { db, events } = fakeDb(report(pool()));
    const one = { storyUrl: "https://e.test/a", questionHash: "h", questionSetVersion: "v", runId: "run-1", issueDate: "2026-09-29", kind: "disagree-gate-only" as const, decision: "publish" as const, rankPosition: null, cellPopulation: 1, cellSampled: 1, poolSize: 12, jevK: 6, profileVersion: 7, sourcePackId: "core-ai", sourcePackVersion: 7, snapshotJson: "{}" };
    await recordJevLabelEvents(db, [one]);
    await recordJevLabelEvents(db, [one]);
    expect(events).toHaveLength(1);
    // Rank events are an ordering, not a vote, and may be re-saved.
    await recordJevLabelEvents(db, [{ ...one, kind: "rank" }]);
    await recordJevLabelEvents(db, [{ ...one, kind: "rank" }]);
    expect(events.filter((row) => row.kind === "rank")).toHaveLength(2);
  });
});

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

  it("serves an open batch with no scores, picks or sample groups, then saves, reveals, ranks and analyses it", async () => {
    const { db, events } = fakeDb(report([...pool(), unscoredSelectedSpec()]));
    const environment = env(db);
    const open = await call(environment, "GET", "/api/jev-review-batch?mode=paired");
    expect(open.status).toBe(200);
    // K counts rules-selected stories Jev scored; the unscored one is reported, not counted.
    expect(open.body).toMatchObject({ state: "open", runId: "run-1", jevK: 6, poolSize: 12, unscoredSelected: 1 });
    expect(open.body.items).toHaveLength(12);
    for (const entry of open.body.items) {
      for (const hidden of ["assessment", "kind", "cellPopulation", "picks"]) expect(entry).not.toHaveProperty(hidden);
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
    expect(JSON.parse(String(events[0]!.snapshot_json)).candidate.assessment.picks).toMatchObject({ k: 6 });
    expect((await call(environment, "POST", "/api/jev-labels", { mode: "paired", run_id: "run-1", labels })).status).toBe(409);

    const reopened = await call(environment, "GET", "/api/jev-review-batch?mode=paired&run_id=run-1");
    expect(reopened.body.state).toBe("saved");
    expect(reopened.body.items).toHaveLength(12);
    expect(reopened.body.items[0]).toHaveProperty("kind");
    expect(reopened.body.items[0].assessment.picks).toBeDefined();

    const rankable = saved.body.rankable as Array<{ url: string }>;
    const badRanks = rankable.map((entry, index) => ({ story_url: entry.url, rank_position: index === 0 ? 3 : index + 1 }));
    expect((await call(environment, "POST", "/api/jev-labels/ranks", { run_id: "run-1", ranks: badRanks })).status).toBe(400);
    const goodRanks = rankable.map((entry, index) => ({ story_url: entry.url, rank_position: index + 1 }));
    expect((await call(environment, "POST", "/api/jev-labels/ranks", { run_id: "run-1", ranks: goodRanks })).body).toMatchObject({ ok: true, ranked: 5 });
    expect(events.filter((row) => row.kind === "rank")).toHaveLength(5);

    const analysis = await call(environment, "GET", "/api/jev-analysis");
    expect(analysis.body.ledger).toMatchObject({ judgments: 3, withReaderWants: 3 });
    expect(analysis.body.analysis).toMatchObject({ labelledStories: 12 });
    expect(analysis.body.analysis.bar).toHaveLength(3);
  });

  it("counts dropped-pool labels apart from the paired sample and still offers those stories to the paired sample", async () => {
    const { db, events } = fakeDb(report(pool()));
    const environment = env(db);
    const dropped = await call(environment, "GET", "/api/jev-review-batch?mode=dropped");
    expect(dropped.body.items).toHaveLength(6);
    expect(dropped.body.complete).toBe(true);
    for (const entry of dropped.body.items) expect(entry).not.toHaveProperty("assessment");
    const labels = dropped.body.items.map((entry: { url: string }) => ({ story_url: entry.url, decision: "reject" }));
    expect((await call(environment, "POST", "/api/jev-labels", { mode: "dropped", run_id: "run-1", labels })).status).toBe(200);
    expect(events.every((row) => row.kind === "dropped-pool")).toBe(true);
    const analysis = await call(environment, "GET", "/api/jev-analysis");
    // The three dropped stories Jev would have picked are reported in the dropped-pool figures, not the head-to-head.
    expect(analysis.body.analysis.headToHead.all.jevOnly.n).toBe(0);
    expect(analysis.body.analysis.droppedByCell).toMatchObject({ jevOnly: { n: 3, reject: 3 }, bothOut: { n: 3 } });
    const paired = await call(environment, "GET", "/api/jev-review-batch?mode=paired");
    expect(paired.body.state).toBe("open");
    expect(paired.body.items.some((entry: { url: string }) => entry.url.includes("/exc-"))).toBe(true);
  });

  it("restores picks for labels made before they were recorded, from the run's retained report", async () => {
    const { db, events } = fakeDb(report(pool()));
    const old = event({ storyUrl: "https://e.test/exc-1", kind: "dropped-pool", decision: "publish", wants: 0.85 });
    events.push({ id: 1, story_url: old.storyUrl, question_hash: old.questionHash, question_set_version: old.questionSetVersion, run_id: "run-1", issue_date: old.issueDate, kind: old.kind, decision: old.decision, rank_position: null, cell_population: null, cell_sampled: null, pool_size: 12, jev_k: 6, snapshot_json: old.snapshotJson, created_at: old.createdAt });
    const analysis = await call(env(db), "GET", "/api/jev-analysis");
    expect(analysis.body.analysis.droppedByCell.jevOnly).toMatchObject({ n: 1, publish: 1 });
  });
});

describe("admin page", () => {
  it("never hands an async loader straight to addEventListener, where the click event becomes its first argument", () => {
    const source = readFileSync("public/app.js", "utf8");
    expect(source).not.toMatch(/addEventListener\("click", (?:load|save|run)Jev[A-Za-z]*\)/);
  });
});
