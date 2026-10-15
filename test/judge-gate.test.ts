import { describe, expect, it, vi } from "vitest";
import { CLEF_MODELS, JUDGE_GATE_MAX_REMOVALS, JUDGE_GATE_PROTECTED_TOP, JUDGE_GATE_READER_WANTS_MAX, judgeGateEnabled, runClefGate, selectJudgeGateRemovals } from "../src/clef";
import { DEFAULT_PROFILE, type SupplementalCandidate, type SupplementalSourceHealth } from "../src/contracts";
import { buildJudgeQuestions, type JudgeScores } from "../src/judge";
import { applyJudgeRemovals, buildDailyCandidateInventory, type DailyCandidateInventory, type SourceResult } from "../src/supplemental";

const now = new Date("2026-09-01T12:00:00.000Z");

function editorials(url: string): SupplementalCandidate["sourceAttributions"] {
  return [
    { sourceId: "tldr-ai", sourceName: "TLDR AI", kind: "discovery", sourceUrl: `https://tldr.tech/ai/2026-08-30` },
    { sourceId: "alphasignal", sourceName: "AlphaSignal", kind: "discovery", sourceUrl: `https://alphasignal.ai/${encodeURIComponent(url)}` }
  ];
}

function candidate(index: number): SupplementalCandidate {
  const url = `https://example.com/story-${index}`;
  return {
    title: `Story ${index}`,
    summary: `Summary for story ${index}`,
    url,
    publishedAt: new Date(now.getTime() - 3_600_000).toISOString(),
    category: "agents",
    categoryLabel: "Agents in practice",
    score: 6,
    exceptional: false,
    leadSourceId: "tldr-ai",
    sourceAttributions: editorials(url)
  };
}

/** Eight equal, cross-source candidates: two editorial references make each one qualify. */
function inventoryWith(count: number): DailyCandidateInventory {
  const health: SupplementalSourceHealth = { id: "tldr-ai", name: "TLDR AI", status: "healthy", yieldStatus: "active", requests: 1, fetchedItems: count, acceptedCandidates: count, errors: [] };
  const sourceResults: SourceResult[] = [{ candidates: Array.from({ length: count }, (_, index) => candidate(index + 1)), health }];
  return buildDailyCandidateInventory({ sourceResults, profile: DEFAULT_PROFILE, now });
}

function scoresFor(inventory: DailyCandidateInventory, wants: (index: number) => number | null): Map<string, JudgeScores> {
  return new Map(inventory.candidates.map((item, index) => [item.sources[0]!.url, {
    interest: "Agents in practice",
    interestConfidence: 0.8,
    novel: 0.5,
    substantive: 0.9,
    readerWants: wants(index)
  }]));
}

describe("judge gate configuration", () => {
  it("is enabled only by the explicit flag", () => {
    expect(judgeGateEnabled({ CLEF_GATE_ENABLED: "true" } as Env)).toBe(true);
    expect(judgeGateEnabled({ CLEF_GATE_ENABLED: "false" } as Env)).toBe(false);
    expect(judgeGateEnabled({} as Env)).toBe(false);
  });
});

describe("judge gate selection", () => {
  it("keeps the protected top and removes only below-threshold candidates", () => {
    const inventory = inventoryWith(6);
    const scores = scoresFor(inventory, (index) => (index >= JUDGE_GATE_PROTECTED_TOP ? 0.1 : 0.9));
    const removals = selectJudgeGateRemovals(inventory.candidates, scores);
    expect(removals.map((removal) => removal.id)).toEqual([4, 5, 6]);
    expect(removals.every((removal) => removal.reason === "reader-wants-below-threshold")).toBe(true);
  });

  it("caps removals no matter how many candidates score low", () => {
    const inventory = inventoryWith(10);
    const scores = scoresFor(inventory, () => 0.05);
    const removals = selectJudgeGateRemovals(inventory.candidates, scores);
    expect(removals).toHaveLength(JUDGE_GATE_MAX_REMOVALS);
    expect(removals.map((removal) => removal.id)).toEqual([4, 5, 6]);
  });

  it("treats the threshold as inclusive and keeps unscored or high-want candidates", () => {
    const inventory = inventoryWith(6);
    const boundary = scoresFor(inventory, (index) => (index === 3 ? JUDGE_GATE_READER_WANTS_MAX : 0.9));
    expect(selectJudgeGateRemovals(inventory.candidates, boundary).map((removal) => removal.id)).toEqual([4]);
    const above = scoresFor(inventory, (index) => (index === 3 ? JUDGE_GATE_READER_WANTS_MAX + 0.01 : 0.9));
    expect(selectJudgeGateRemovals(inventory.candidates, above)).toHaveLength(0);
    expect(selectJudgeGateRemovals(inventory.candidates, new Map())).toHaveLength(0);
  });

  it("removes nothing when nine of ten candidates are protected or the pool is tiny", () => {
    const inventory = inventoryWith(3);
    const scores = scoresFor(inventory, () => 0.0);
    expect(selectJudgeGateRemovals(inventory.candidates, scores)).toHaveLength(0);
  });
});

describe("judge gate accounting", () => {
  it("shrinks the selected list and moves funnel counts to rankedOut", () => {
    const inventory = inventoryWith(8);
    const scores = scoresFor(inventory, (index) => (index >= 3 ? 0.1 : 0.9));
    const removals = selectJudgeGateRemovals(inventory.candidates, scores);
    applyJudgeRemovals(inventory, removals);

    expect(inventory.candidates.map((item) => item.id)).toEqual([1, 2, 3, 7, 8]);
    expect(inventory.collection.selectedCandidates).toBe(5);
    expect(inventory.collection.judgeFiltered).toBe(3);
    const funnel = inventory.sourceFunnels["tldr-ai"]!;
    expect(funnel.selected).toBe(5);
    expect(funnel.filtered.rankedOut).toBe(3);
    expect(inventory.evaluated.filter((item) => item.outcome === "selected").map((item) => item.url))
      .toEqual(["https://example.com/story-1", "https://example.com/story-2", "https://example.com/story-3", "https://example.com/story-7", "https://example.com/story-8"]);
  });

  it("is a no-op when the gate removed nothing", () => {
    const inventory = inventoryWith(4);
    const before = inventory.candidates.map((item) => item.id);
    applyJudgeRemovals(inventory, []);
    expect(inventory.candidates.map((item) => item.id)).toEqual(before);
    expect(inventory.collection.judgeFiltered).toBeUndefined();
  });
});

describe("judge gate scoring", () => {
  const questions = buildJudgeQuestions(DEFAULT_PROFILE, []);
  const items = [{ url: "https://example.com/a", title: "Story A", summary: "About A" }];
  const table = () => ({ prepare: () => ({ bind: () => ({}) }), batch: async () => [] }) as unknown as D1Database;

  it("scores the candidate set with Clef and returns the map for gating", async () => {
    const ai = { run: vi.fn(async () => ({ answers: { reader_wants: { type: "noul", noul: 0.1 } } })) };
    const gate = await runClefGate({ DB: table(), AI: ai } as unknown as Env, { items, questions });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect((ai.run.mock.calls[0] as unknown as [string])[0]).toBe(CLEF_MODELS.clef);
    expect(gate?.scores.get("https://example.com/a")?.readerWants).toBe(0.1);
  });

  it("fails open to undefined when recording throws, so the gate never fails a run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ai = { run: vi.fn(async () => ({ answers: { reader_wants: { type: "noul", noul: 0.1 } } })) };
    const broken = { prepare() { throw new Error("db down"); } } as unknown as D1Database;
    await expect(runClefGate({ DB: broken, AI: ai } as unknown as Env, { items, questions })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
