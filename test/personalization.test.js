import { describe, expect, it } from "vitest";
import { baseProfileForEdition, rankingExplanation, rankingReason } from "../public/personalization.js";

describe("reader profile selection", () => {
  const shared = { version: 5, storyBudget: 14 };
  const generated = { version: 2, storyBudget: 7 };

  it("uses the active global profile for the latest reader", () => {
    expect(baseProfileForEdition(shared, generated, false)).toEqual(shared);
  });

  it("retains the generated profile for a historical edition", () => {
    expect(baseProfileForEdition(shared, generated, true)).toEqual(generated);
  });

  it("explains ranking with reader-facing profile language instead of a raw score", () => {
    const profile = {
      exceptionalStoryOverride: true,
      safeguards: { watchPermissions: true, watchGeography: true },
      pinnedCategories: ["Model–harness co-design"],
      weights: [
        { id: "codex", label: "Codex & agent craft", value: 4 },
        { id: "harness", label: "Model–harness co-design", value: 2 }
      ]
    };
    expect(rankingReason({ category: "codex" }, profile)).toEqual({ label: "Codex & agent craft · Lead", tone: "priority" });
    expect(rankingReason({ category: "harness" }, profile)).toEqual({ label: "Pinned · Model–harness co-design", tone: "pinned" });
    expect(rankingReason({ category: "codex", title: "Agent approval controls", summary: "The agent requires human approval before executing a shell command.", watchPermission: true }, profile)).toEqual({ label: "Watching · agent permission design", tone: "watched" });
    expect(rankingReason({ category: "harness", title: "Harness engineering", summary: "Practical gains are coming from memory, approvals, evals, and tools.", watchPermission: true }, profile)).toEqual({ label: "Pinned · Model–harness co-design", tone: "pinned" });
    expect(rankingReason({ category: "codex", exceptional: true }, profile)).toEqual({ label: "Exceptional signal", tone: "exceptional" });
  });

  it("returns an honest factor breakdown without inventing a display score", () => {
    const profile = {
      exceptionalStoryOverride: true,
      safeguards: { watchPermissions: true, watchGeography: true },
      pinnedCategories: ["Model–harness co-design"],
      weights: [
        { id: "codex", label: "Codex & agent craft", value: 4 },
        { id: "harness", label: "Model–harness co-design", value: 2 }
      ]
    };
    const explanation = rankingExplanation({ category: "codex", base: 92, exceptional: true }, profile);
    expect(explanation).not.toHaveProperty("score");
    expect(explanation.factors).toEqual([
      { label: "Editorial override", value: "Exceptional-story rule", state: "Applied", tone: "exceptional" },
      { label: "Category", value: "Codex & agent craft", state: "Lead", tone: "priority" },
      { label: "Editorial strength", value: "Strong editorial signal", state: "Underlying", tone: "neutral" }
    ]);
    expect(rankingExplanation({ category: "harness", base: 68 }, profile).factors).toContainEqual(
      { label: "Editorial marker", value: "Pinned · Model–harness co-design", state: "Label only", tone: "pinned" }
    );
  });
});
