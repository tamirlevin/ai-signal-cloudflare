import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, type ShadowCandidate } from "../src/contracts";
import { attachTriageScores, buildProfileQueries, normalizeScores, rankTriageScores, scoreTriage, TRIAGE_EMBEDDING_MODEL, TRIAGE_RERANKER_MODEL, triageShadowEnabled } from "../src/triage";

const items = [
  { url: "https://example.com/agents", title: "Agent runtime launches", summary: "A practical agent platform with scoped credentials." },
  { url: "https://example.com/gossip", title: "Unrelated celebrity news", summary: "Nothing to do with AI tooling." }
];

const interests = buildProfileQueries(DEFAULT_PROFILE);

function fakeAi() {
  return {
    run: vi.fn(async (model: string, input: Record<string, unknown>) => {
      if (model === TRIAGE_RERANKER_MODEL) {
        expect(input.contexts).toHaveLength(2);
        return { response: [{ id: 0, score: 0.9 }, { id: 1, score: -1.2 }] };
      }
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

  it("builds one short query per positive-weight interest plus separate watching queries", () => {
    const labels = interests.map((interest) => interest.label);
    expect(labels).toContain("Codex & agent craft");
    expect(labels).toContain("New systems");
    expect(interests.every((interest) => interest.weight > 0)).toBe(true);
    const craft = interests.find((interest) => interest.label === "Codex & agent craft")!;
    expect(craft.query).toBe("Codex & agent craft.");
    expect(interests.filter((interest) => !interest.label.startsWith("Watching: ")).every((interest) => !interest.query.includes("Watching:"))).toBe(true);
    const watching = interests.filter((interest) => interest.label.startsWith("Watching: "));
    expect(watching).toHaveLength(3);
    expect(watching.map((interest) => interest.label)).toContain("Watching: Agent permission design");
    expect(watching.every((interest) => interest.weight === 1)).toBe(true);
  });

  it("combines per-interest scores and embeds once for novelty", async () => {
    const ai = fakeAi();
    const scores = await scoreTriage(ai, DEFAULT_PROFILE, items, ["Agent runtime launches — A practical agent platform."]);
    expect(ai.run).toHaveBeenCalledTimes(interests.length + 1);
    // Identical per-interest raws combine to the same value, then normalize per-run.
    // The first interest wins every tie deterministically.
    expect(scores.get("https://example.com/agents")).toMatchObject({ relevance: 1, raw: 0.9, winningInterest: "Codex & agent craft" });
    expect(scores.get("https://example.com/gossip")).toMatchObject({ relevance: 0, raw: -1.2, winningInterest: "Codex & agent craft" });
    expect(scores.get("https://example.com/agents")!.novelty!).toBeLessThan(0.2);
    expect(scores.get("https://example.com/gossip")!.novelty!).toBeGreaterThanOrEqual(0.9);
  });

  it("takes the max over per-interest scores at full precision so one strong interest is not diluted", async () => {
    const ai = {
      run: vi.fn(async (model: string, input: Record<string, unknown>) => {
        if (model === TRIAGE_RERANKER_MODEL) {
          const score = (input.query as string).startsWith("Frontier") ? 0.8123456789 : -0.5;
          return { response: [{ id: 0, score }, { id: 1, score: -0.5 }] };
        }
        if (model === TRIAGE_EMBEDDING_MODEL) return { data: [[1, 0], [0, 1], [1, 0.1]] };
        throw new Error(`unexpected model ${model}`);
      })
    };
    const scores = await scoreTriage(ai, DEFAULT_PROFILE, items, []);
    // A weight-1 interest still wins outright; no rounding touches the measurement.
    expect(scores.get("https://example.com/agents")).toMatchObject({ raw: 0.8123456789, winningInterest: "Frontier signals" });
  });

  it("fails open to no scores when a model call rejects", async () => {
    const ai = { run: vi.fn(async () => { throw new Error("boom"); }) };
    const scores = await scoreTriage(ai, DEFAULT_PROFILE, items, []);
    expect(scores.size).toBe(0);
  });

  it("normalizes one run's scores relatively, with no spread carrying no signal", () => {
    expect(normalizeScores([0.9, -1.2, null])).toEqual([1, 0, null]);
    expect(normalizeScores([0.5, 0.5])).toEqual([0.5, 0.5]);
    expect(normalizeScores([null])).toEqual([null]);
  });

  it("ranks scored items densely and leaves unscored unranked", () => {
    const ranked = rankTriageScores([
      { url: "a", title: "A", relevance: 0.5, rawRelevance: 0.1, novelty: 0.2, winningInterest: "New systems", outcome: "selected", sourceIds: [] },
      { url: "b", title: "B", relevance: 0.9, rawRelevance: 0.4, novelty: 0.1, winningInterest: "Codex & agent craft", outcome: "rankedOut", sourceIds: [] },
      { url: "c", title: "C", relevance: null, rawRelevance: null, novelty: null, winningInterest: null, outcome: "weakProfileFit", sourceIds: [] }
    ]);
    expect(ranked.find((entry) => entry.url === "b")).toMatchObject({ rank: 1, winningInterest: "Codex & agent craft" });
    expect(ranked.find((entry) => entry.url === "a")).toMatchObject({ rank: 2, winningInterest: "New systems" });
    expect(ranked.find((entry) => entry.url === "c")).toMatchObject({ rank: null, winningInterest: null });
  });

  it("attaches summaries to matching report items only", () => {
    const selected: ShadowCandidate[] = [{ ...items[0]!, publishedAt: "", category: "", categoryLabel: "", score: 0, sourceIds: [], sourceNames: [] }];
    const report = { wouldAdd: selected, selectedForBlend: [] as ShadowCandidate[] };
    attachTriageScores(report, new Map([["https://example.com/agents", { relevance: 1, raw: 0.9, novelty: 0.1, winningInterest: "Codex & agent craft" }]]));
    expect(report.wouldAdd[0]).toMatchObject({ triage: { relevance: 1, novelty: 0.1 } });
    attachTriageScores(report, new Map());
    expect(report.wouldAdd[0]).toMatchObject({ triage: { relevance: 1, novelty: 0.1 } });
  });
});
