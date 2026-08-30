import { describe, expect, it } from "vitest";
import { freshShadowCandidates } from "../public/fresh-signals.js";

const edition = {
  issueDate: "2026-08-26",
  publishedAt: "2026-08-27T23:39:14.782Z"
};

function shadowWith(wouldAdd, overrides = {}) {
  return {
    status: "healthy",
    baseIssueDate: "2026-08-26",
    finishedAt: "2026-08-30T22:15:20.000Z",
    report: {
      generatedAt: "2026-08-30T22:15:19.000Z",
      baseIssue: { issueDate: "2026-08-26" },
      wouldAdd
    },
    ...overrides
  };
}

function candidate(index, overrides = {}) {
  return {
    title: `Signal ${index}`,
    summary: `Summary ${index}`,
    url: `https://example.com/signal-${index}`,
    publishedAt: `2026-08-30T${String(index).padStart(2, "0")}:00:00.000Z`,
    category: "agents",
    categoryLabel: "Agents in practice",
    score: 10 - index,
    sourceIds: ["tldr-ai"],
    sourceNames: ["TLDR AI"],
    ...overrides
  };
}

describe("fresh shadow candidates", () => {
  it("keeps the collector order while filtering old, invalid, and duplicate links", () => {
    const fresh = candidate(0);
    const result = freshShadowCandidates(edition, shadowWith([
      fresh,
      candidate(1, { publishedAt: "2026-08-27T20:00:00.000Z" }),
      candidate(2, { url: "http://example.com/not-https" }),
      candidate(3, { url: fresh.url }),
      candidate(4)
    ]));

    expect(result.map((item) => item.title)).toEqual(["Signal 0", "Signal 4"]);
  });

  it("requires the shadow report to be newer and anchored to the displayed edition", () => {
    expect(freshShadowCandidates(edition, shadowWith([candidate(0)], { baseIssueDate: "2026-08-25" }))).toEqual([]);
    expect(freshShadowCandidates(edition, shadowWith([candidate(0)], { finishedAt: "2026-08-27T20:00:00.000Z" }))).toEqual([]);
  });

  it("caps the small reader section at five candidates", () => {
    const result = freshShadowCandidates(edition, shadowWith(Array.from({ length: 6 }, (_, index) => candidate(index, {
      publishedAt: `2026-08-30T0${index}:00:00.000Z`
    }))));

    expect(result).toHaveLength(5);
    expect(result.map((item) => item.title)).toEqual(["Signal 0", "Signal 1", "Signal 2", "Signal 3", "Signal 4"]);
  });
});
