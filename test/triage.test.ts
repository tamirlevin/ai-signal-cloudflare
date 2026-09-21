import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, type ShadowCandidate } from "../src/contracts";
import { attachTriageScores, buildProfileQuery, normalizeScores, scoreTriage, TRIAGE_EMBEDDING_MODEL, TRIAGE_RERANKER_MODEL, triageShadowEnabled } from "../src/triage";

const items = [
  { url: "https://example.com/agents", title: "Agent runtime launches", summary: "A practical agent platform with scoped credentials." },
  { url: "https://example.com/gossip", title: "Unrelated celebrity news", summary: "Nothing to do with AI tooling." }
];

function fakeAi() {
  return {
    run: vi.fn(async (model: string) => {
      if (model === TRIAGE_RERANKER_MODEL) return { response: [{ id: 0, score: 0.9 }, { id: 1, score: -1.2 }] };
      if (model === TRIAGE_EMBEDDING_MODEL) return { data: [[1, 0], [0, 1], [1, 0.1]] };
      throw new Error(`unexpected model ${model}`);
    })
  };
}

describe("triage shadow scoring", () => {
  it("is enabled only by the explicit flag", () => {
    expect(triageShadowEnabled({ TRIAGE_SHADOW_ENABLED: "true" } as Env)).toBe(true);
    expect(triageShadowEnabled({ TRIAGE_SHADOW_ENABLED: "false" } as Env)).toBe(false);
    expect(triageShadowEnabled({} as Env)).toBe(false);
  });

  it("builds the profile query from weights and watch topics", () => {
    const query = buildProfileQuery(DEFAULT_PROFILE);
    expect(query).toContain("Codex & agent craft");
    expect(query).toContain("Agent permission design");
  });

  it("scores relevance and novelty in two batched calls", async () => {
    const ai = fakeAi();
    const scores = await scoreTriage(ai, DEFAULT_PROFILE, items, ["Agent runtime launches — A practical agent platform."]);
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(ai.run).toHaveBeenCalledWith(TRIAGE_RERANKER_MODEL, expect.objectContaining({ contexts: expect.any(Array) }));
    // Raw 0.9 vs -1.2 normalizes per-run to 1.0 vs 0.0.
    expect(scores.get("https://example.com/agents")).toMatchObject({ relevance: 1 });
    expect(scores.get("https://example.com/gossip")).toMatchObject({ relevance: 0 });
    // Near-duplicate of prior text scores low novelty; orthogonal text scores high.
    expect(scores.get("https://example.com/agents")!.novelty!).toBeLessThan(0.2);
    expect(scores.get("https://example.com/gossip")!.novelty!).toBeGreaterThanOrEqual(0.9);
  });

  it("normalizes one run's scores relatively, with no spread carrying no signal", () => {
    expect(normalizeScores([0.9, -1.2, null])).toEqual([1, 0, null]);
    expect(normalizeScores([0.5, 0.5])).toEqual([0.5, 0.5]);
    expect(normalizeScores([null])).toEqual([null]);
  });

  it("fails open to no scores when a model call rejects", async () => {
    const ai = { run: vi.fn(async () => { throw new Error("boom"); }) };
    const scores = await scoreTriage(ai, DEFAULT_PROFILE, items, []);
    expect(scores.size).toBe(0);
  });

  it("attaches scores to matching report items only", () => {
    const selected: ShadowCandidate[] = [{ ...items[0]!, publishedAt: "", category: "", categoryLabel: "", score: 0, sourceIds: [], sourceNames: [] }];
    const report = { wouldAdd: selected, selectedForBlend: [] as ShadowCandidate[] };
    attachTriageScores(report, new Map([["https://example.com/agents", { relevance: 1, novelty: 0.1 }]]));
    expect(report.wouldAdd[0]).toMatchObject({ triage: { relevance: 1, novelty: 0.1 } });
    attachTriageScores(report, new Map());
    expect(report.wouldAdd[0]).toMatchObject({ triage: { relevance: 1, novelty: 0.1 } });
  });
});
