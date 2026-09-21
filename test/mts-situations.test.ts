import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, type Profile } from "../src/contracts";
import { buildDailyCandidateInventory, collectSupplementalSources, parseMtsSituations } from "../src/supplemental";
import { validateEdition } from "../src/validation";
import { deterministicEditorialEdition } from "../src/editorial";

const now = new Date("2026-09-20T12:00:00Z");
const profile: Profile = DEFAULT_PROFILE;

function story(name: string, sources: Array<{ name: string; url: string }>, createdAt = "2026-09-19T18:00:00Z", lifecycle = "confirmed", description = "A practical agent development with measurable results."): unknown {
  return { name, description, lifecycle, createdAt, sources };
}

const direct = { name: "Example News", url: "https://example.com/agent-release" };
const social = { name: "Poster", url: "https://twitter.com/poster/status/123" };
const wrapped = { name: "Aggregator", url: "https://news.google.com/rss/articles/CBMiX2h0dHBz" };

function briefing(...stories: unknown[]): string {
  return JSON.stringify({ count: stories.length, stories });
}

describe("MTS Situations collector", () => {
  it("accepts lifecycle-eligible stories with direct evidence and skips X-only stories", () => {
    const candidates = parseMtsSituations(briefing(
      story("Agent runtime launches with scoped credentials", [social, direct]),
      story("Social-only agent rumor", [social]),
      story("Stale MTS story", [direct], "2026-09-16T10:00:00Z"),
      story("MTS candidate story", [direct], "2026-09-19T10:00:00Z", "candidate"),
      story("MTS developing story", [wrapped], "2026-09-19T10:00:00Z", "developing")
    ), now, profile);
    expect(candidates.map((item) => item.title)).toEqual([
      "Agent runtime launches with scoped credentials",
      "MTS developing story"
    ]);
    expect(candidates[0]).toMatchObject({ url: "https://example.com/agent-release", publishedAt: "2026-09-19T18:00:00.000Z", leadSourceId: "mts-situations" });
    expect(candidates[0]?.sourceAttributions[0]).toMatchObject({ sourceId: "mts-situations", kind: "discovery", sourceUrl: "https://www.mts.now/situations" });
    // A direct article link outranks a social link; the wrapper stays eligible.
    expect(candidates[1]?.url).toBe("https://news.google.com/rss/articles/CBMiX2h0dHBz");
    expect(JSON.stringify(candidates)).not.toMatch(/twitter\.com/);
  });

  it("rejects malformed briefings and out-of-window stories", () => {
    expect(() => parseMtsSituations("not json", now, profile)).toThrow("MTS Situations returned no JSON briefing");
    expect(parseMtsSituations(JSON.stringify({ count: 0, stories: [] }), now, profile)).toEqual([]);
    expect(parseMtsSituations(briefing(story("Future story", [direct], "2026-09-21T00:00:00Z")), now, profile)).toEqual([]);
    expect(parseMtsSituations(briefing(story("", [direct])), now, profile)).toEqual([]);
  });

  it("enters the equal-source pool and validates an MTS-led card", () => {
    const candidates = parseMtsSituations(briefing(story("Agent runtime launches with scoped credentials", [direct])), now, profile);
    const inventory = buildDailyCandidateInventory({
      sourceResults: [{ candidates, health: { id: "mts-situations", name: "MTS Situations", status: "healthy", requests: 1, fetchedItems: 1, acceptedCandidates: 1, errors: [] } }],
      profile,
      now
    });
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]?.provenance?.lead.id).toBe("mts-situations");
    expect(inventory.sourceFunnels["mts-situations"]).toMatchObject({ inWindow: 1, qualified: 1, selected: 1 });
    const edition = deterministicEditorialEdition({ url: "https://signal.tamirlevin.dev/?edition=2026-09-20", issueDate: "2026-09-20", publicationDate: "20 September 2026", publishedAt: now.toISOString(), body: "", anchors: [] }, inventory.candidates, profile);
    expect(() => validateEdition(edition, profile, new Set([candidates[0]!.url]))).not.toThrow();
  });

  it("fetches one bounded JSON request and degrades when quiet", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(
      String(input).includes("api.mts.now") ? briefing(story("Agent runtime launches with scoped credentials", [direct])) : "<rss><channel></channel></rss>"
    ));
    const results = await collectSupplementalSources({ profile, now, fetcher });
    expect(results.find((result) => result.health.id === "mts-situations")?.health).toMatchObject({ status: "healthy", requests: 1, fetchedItems: 1, acceptedCandidates: 1, yieldStatus: "active" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("api.mts.now"))).toHaveLength(1);
    const quiet = await collectSupplementalSources({ profile, now, fetcher: async () => new Response(JSON.stringify({ count: 0, stories: [] })) });
    expect(quiet.find((result) => result.health.id === "mts-situations")?.health).toMatchObject({ status: "degraded", yieldStatus: "quiet" });
  });

  it("labels the feed stage when the briefing request fails", async () => {
    const results = await collectSupplementalSources({ profile, now, fetcher: async () => new Response("unavailable", { status: 503 }) });
    expect(results.find((result) => result.health.id === "mts-situations")?.health).toMatchObject({ status: "failed", yieldStatus: "unknown", errors: ["feed: api.mts.now returned 503"] });
  });
});
