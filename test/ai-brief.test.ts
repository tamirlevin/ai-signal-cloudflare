import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, type Profile } from "../src/contracts";
import { collectSupplementalSources, parseAiBriefRun } from "../src/supplemental";

const now = new Date("2026-09-24T12:00:00Z");
const profile: Profile = DEFAULT_PROFILE;

const ORIGIN = "https://ai-weekly-brief.tamirlevin300024.chatgpt.site";

function item(title: string, url: string, publishedAt = "2026-09-23T10:00:00Z", summary = "A practical agent development with measurable results.") {
  return { title, url, canonicalUrl: url, publishedAt, summary };
}

function run(runId: string, ...items: unknown[]): string {
  return JSON.stringify({ runId, issueDate: runId.replace("daily:", ""), items });
}

function runList(...runs: Array<{ runId: string; issueDate: string }>): string {
  return JSON.stringify({ runs });
}

describe("AI Brief collector", () => {
  it("accepts in-window stories with direct evidence and skips social, stale, and titleless items", () => {
    const { candidates, fetched } = parseAiBriefRun(run("daily:2026-09-23",
      item("Agent runtime launches with scoped credentials", "https://example.com/agent-release"),
      { ...item("Social-only rumor", "https://example.com/unused"), url: "https://x.com/poster/status/123", canonicalUrl: "https://x.com/poster/status/123" },
      item("Stale brief story", "https://example.com/stale", "2026-09-20T10:00:00Z"),
      { url: "https://example.com/untitled", publishedAt: "2026-09-23T10:00:00Z", summary: "No title." }
    ), now, profile);
    expect(fetched).toBe(4);
    expect(candidates.map((entry) => entry.title)).toEqual(["Agent runtime launches with scoped credentials"]);
    expect(candidates[0]).toMatchObject({ url: "https://example.com/agent-release", publishedAt: "2026-09-23T10:00:00.000Z", leadSourceId: "ai-brief" });
    expect(candidates[0]?.sourceAttributions[0]).toMatchObject({ sourceId: "ai-brief", kind: "discovery", sourceUrl: `${ORIGIN}/api/runs/daily%3A2026-09-23` });
  });

  it("prefers the canonical URL and rejects malformed runs", () => {
    const { candidates } = parseAiBriefRun(run("daily:2026-09-23",
      { title: "Wrapped link story", url: "https://tldr.tech/wrap", canonicalUrl: "https://example.com/direct", publishedAt: "2026-09-23T10:00:00Z", summary: "Summary." }
    ), now, profile);
    expect(candidates[0]?.url).toBe("https://example.com/direct");
    expect(() => parseAiBriefRun("not json", now, profile)).toThrow("AI Brief returned no JSON run");
    expect(parseAiBriefRun(JSON.stringify({ runId: "daily:2026-09-23", items: [] }), now, profile)).toEqual({ candidates: [], fetched: 0 });
  });

  it("fetches the run list then at most three fresh runs, and degrades when quiet", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("api/runs?cadence=daily")) {
        return new Response(runList(
          { runId: "daily:2026-09-24", issueDate: "2026-09-24" },
          { runId: "daily:2026-09-23", issueDate: "2026-09-23" },
          { runId: "daily:2026-09-22", issueDate: "2026-09-22" },
          { runId: "daily:2026-09-21", issueDate: "2026-09-21" },
          { runId: "daily:2026-09-18", issueDate: "2026-09-18" }
        ));
      }
      if (url.includes("/api/runs/")) return new Response(run(decodeURIComponent(url.split("/api/runs/")[1]!), item("Brief story", "https://example.com/brief-story")));
      return new Response("<rss><channel></channel></rss>");
    });
    const results = await collectSupplementalSources({ profile, now, fetcher });
    const health = results.find((result) => result.health.id === "ai-brief")?.health;
    expect(health).toMatchObject({ status: "healthy", requests: 4, fetchedItems: 3, acceptedCandidates: 3, yieldStatus: "active" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/api/runs/"))).toHaveLength(3);
    const quiet = await collectSupplementalSources({
      profile, now,
      fetcher: (async (input: string | URL | Request) => String(input).endsWith("api/runs?cadence=daily")
        ? new Response(runList({ runId: "daily:2026-09-24", issueDate: "2026-09-24" }))
        : String(input).includes("/api/runs/")
          ? new Response(run("daily:2026-09-24"))
          : new Response("<rss><channel></channel></rss>")) as typeof fetch
    });
    expect(quiet.find((result) => result.health.id === "ai-brief")?.health).toMatchObject({ status: "degraded", yieldStatus: "quiet" });
  });

  it("labels the runs stage when the list request fails", async () => {
    const results = await collectSupplementalSources({ profile, now, fetcher: async () => new Response("unavailable", { status: 503 }) });
    expect(results.find((result) => result.health.id === "ai-brief")?.health).toMatchObject({ status: "failed", yieldStatus: "unknown" });
  });
});
