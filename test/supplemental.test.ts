import { describe, expect, it } from "vitest";
import type { CandidateStory, RssIssue, SupplementalCandidate, SupplementalSourceId } from "../src/contracts";
import { DEFAULT_PROFILE } from "../src/contracts";
import {
  buildBlendedCandidateInventory,
  buildSupplementalShadowReport,
  canonicalizeSupplementalUrl,
  collectSupplementalSources,
  deduplicateSupplemental,
  parseAlphaArticle,
  parseAlphaSitemap,
  parseCloudflareFeed,
  parseTldrFeed,
  parseTldrIssue,
  titleSimilarity,
  type SourceResult
} from "../src/supplemental";
import { DEFAULT_SOURCE_PACK_ID, SOURCE_PACKS } from "../src/source-packs";

const publishedAt = "2026-08-15T01:00:00.000Z";

function supplemental(sourceId: SupplementalSourceId, title: string, url: string, score = 8): SupplementalCandidate {
  const sourceName = sourceId === "tldr-ai" ? "TLDR AI" : sourceId === "alphasignal" ? "AlphaSignal" : "Cloudflare Agents";
  return {
    title,
    summary: `${title} changes how practical agents are built and deployed.`,
    url,
    publishedAt,
    category: "agents",
    categoryLabel: "Agents in practice",
    score,
    exceptional: false,
    leadSourceId: sourceId,
    sourceAttributions: [{ sourceId, sourceName, kind: sourceId === "cloudflare-agents" ? "primary" : "discovery", sourceUrl: `https://${sourceId}.example/issue` }]
  };
}

function sourceResult(sourceId: SupplementalSourceId, candidates: SupplementalCandidate[]): SourceResult {
  const name = sourceId === "tldr-ai" ? "TLDR AI" : sourceId === "alphasignal" ? "AlphaSignal" : "Cloudflare Agents";
  return {
    candidates,
    health: { id: sourceId, name, status: "healthy", requests: 1, fetchedItems: candidates.length, acceptedCandidates: candidates.length, errors: [] }
  };
}

describe("source packs", () => {
  it("exposes the default bounded core AI pack", () => {
    expect(DEFAULT_PROFILE.sourcePackId).toBe(DEFAULT_SOURCE_PACK_ID);
    expect(SOURCE_PACKS[DEFAULT_SOURCE_PACK_ID]).toMatchObject({ id: "core-ai", version: 1 });
    expect(SOURCE_PACKS[DEFAULT_SOURCE_PACK_ID].sources.map((source) => source.id)).toEqual(["tldr-ai", "alphasignal", "cloudflare-agents"]);
  });
});

describe("supplemental source parsing", () => {
  it("canonicalizes HTTPS URLs without tracking parameters", () => {
    expect(canonicalizeSupplementalUrl("https://EXAMPLE.com/story/?utm_source=x&keep=yes#part")).toBe("https://example.com/story?keep=yes");
    expect(canonicalizeSupplementalUrl("http://example.com/story")).toBeUndefined();
  });

  it("reads the newest TLDR issue and excludes promotional articles", () => {
    const feed = `<rss><channel>
      <item><title>TLDR AI 2026-08-15</title><link>https://tldr.tech/ai/2026-08-15</link><pubDate>Sat, 15 Aug 2026 01:00:00 GMT</pubDate></item>
      <item><title>TLDR AI 2026-08-14</title><link>https://tldr.tech/ai/2026-08-14</link><pubDate>Fri, 14 Aug 2026 01:00:00 GMT</pubDate></item>
    </channel></rss>`;
    expect(parseTldrFeed(feed)[0]?.url).toBe("https://tldr.tech/ai/2026-08-15");

    const issue = `<section><header><h3>Headlines</h3></header>
      <article><a href="https://openai.com/index/codex-memory/?utm_source=tldr"><h3>Codex adds persistent agent memory (4 minute read)</h3></a><div class="newsletter-html">The new memory API uses explicit permission scopes.</div></article>
      <article><a href="https://sponsor.example/deal"><h3>Sponsored: Save on GPUs</h3></a><div class="newsletter-html">Advertisement</div></article>
    </section>`;
    const stories = parseTldrIssue(issue, { url: "https://tldr.tech/ai/2026-08-15", publishedAt }, DEFAULT_PROFILE);
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ title: "Codex adds persistent agent memory", url: "https://openai.com/index/codex-memory" });
    expect(stories[0]?.summary).toContain("permission scopes");
  });

  it("uses a 72-hour AlphaSignal window and falls back to the newest available item", () => {
    const sitemap = `<urlset>
      <url><loc>https://alphasignal.ai/news/new-codex-agent-runtime</loc><lastmod>2026-08-15T00:30:00Z</lastmod></url>
      <url><loc>https://alphasignal.ai/news/old-model-release</loc><lastmod>2026-08-13T23:59:00Z</lastmod></url>
      <url><loc>https://alphasignal.ai/news/too-old-model-release</loc><lastmod>2026-08-11T23:59:00Z</lastmod></url>
    </urlset>`;
    const recent = parseAlphaSitemap(sitemap, new Date("2026-08-15T02:00:00Z"));
    expect(recent).toHaveLength(2);
    expect(recent[0]?.title).toContain("Codex Agent Runtime");

    const quiet = `<urlset><url><loc>https://alphasignal.ai/news/quiet-day-fallback</loc><lastmod>2026-08-10T00:00:00Z</lastmod></url></urlset>`;
    expect(parseAlphaSitemap(quiet, new Date("2026-08-15T02:00:00Z"))).toHaveLength(1);

    const article = `<html><head><meta name="description" content="A new agent runtime with replayable traces."></head><body>
      <h1>OpenAI releases a replayable Codex agent runtime</h1>
      <a href="https://alphasignal.ai/subscribe">Subscribe</a>
      <a href="https://openai.com/index/replayable-codex-runtime/?utm_campaign=alpha">OpenAI Codex runtime release</a>
      <a href="https://x.com/openai">Social profile</a>
    </body></html>`;
    expect(parseAlphaArticle(article, recent[0]!.url)).toEqual({
      title: "OpenAI releases a replayable Codex agent runtime",
      summary: "A new agent runtime with replayable traces.",
      preferredUrl: "https://openai.com/index/replayable-codex-runtime"
    });
  });

  it("keeps only recent Cloudflare agent posts", () => {
    const feed = `<rss><channel>
      <item><title>Workers AI adds agent tool contracts</title><link>https://blog.cloudflare.com/agent-tool-contracts</link><pubDate>Fri, 14 Aug 2026 01:00:00 GMT</pubDate><description>Structured tool contracts improve agent integrations.</description></item>
      <item><title>Old Agents post</title><link>https://blog.cloudflare.com/old-agents</link><pubDate>Sat, 1 Aug 2026 01:00:00 GMT</pubDate><description>Old.</description></item>
    </channel></rss>`;
    const candidates = parseCloudflareFeed(feed, new Date("2026-08-15T02:00:00Z"), DEFAULT_PROFILE);
    expect(candidates.map((item) => item.title)).toEqual(["Workers AI adds agent tool contracts"]);
  });

  it("does not label an unexpected external Cloudflare feed link as primary", () => {
    const feed = `<rss><channel>
      <item><title>Cloudflare links to an external announcement</title><link>https://example.com/external-announcement</link><pubDate>Fri, 14 Aug 2026 01:00:00 GMT</pubDate><description>External link.</description></item>
    </channel></rss>`;
    const candidates = parseCloudflareFeed(feed, new Date("2026-08-15T02:00:00Z"), DEFAULT_PROFILE);
    expect(candidates[0]?.sourceAttributions[0]).toMatchObject({ sourceId: "cloudflare-agents", kind: "discovery" });

    const base: CandidateStory[] = [{
      id: 1,
      title: "Cloudflare links to an external announcement",
      summary: "AInews coverage.",
      category: "agents",
      categoryLabel: "Agents in practice",
      score: 8,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [{ label: "Announcement", url: "https://example.com/external-announcement" }]
    }];
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults: [sourceResult("cloudflare-agents", candidates)], profile: DEFAULT_PROFILE });
    expect(blended.candidates[0]?.provenance).toMatchObject({
      lead: { id: "ainews", layer: "editorial" },
      editorialCorroboration: [],
      coverage: { editorialSourceIds: ["ainews"], editorialSourceCount: 1, boost: 0 }
    });
  });
});

describe("cross-source deduplication and shadow selection", () => {
  it("merges canonical URL, fuzzy-title and product-version duplicates with combined attribution", () => {
    const exact = supplemental("tldr-ai", "Codex runtime launches", "https://openai.com/codex?utm_source=tldr");
    const fuzzy = supplemental("alphasignal", "OpenAI launches the new Codex runtime", "https://openai.com/index/codex-runtime");
    const version = supplemental("cloudflare-agents", "Codex 6.2 arrives for agent teams", "https://blog.cloudflare.com/codex-62");
    const versionAgain = supplemental("tldr-ai", "Testing Codex 6.2 in production", "https://tldr.tech/codex-62");
    const merged = deduplicateSupplemental([exact, fuzzy, version, versionAgain]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.sourceAttributions.map((item) => item.sourceId).sort()).toEqual(["alphasignal", "tldr-ai"]);
    expect(merged[0]).toMatchObject({ title: fuzzy.title, leadSourceId: "alphasignal" });
    expect(merged[1]?.sourceAttributions).toHaveLength(2);
    expect(titleSimilarity(exact.title, fuzzy.title)).toBeGreaterThanOrEqual(0.62);
  });

  it("keeps editorial corroboration separate from direct evidence and records the lead", () => {
    const base: CandidateStory[] = [{
      id: 1,
      title: "OpenAI launches Codex runtime 6.2 for teams",
      summary: "AInews coverage.",
      category: "agents",
      categoryLabel: "Agents in practice",
      score: 6,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [{ label: "AInews link", url: "https://x.com/openai/status/123" }]
    }];
    const tldr = supplemental("tldr-ai", "Codex runtime 6.2 launches for agent teams", "https://openai.com/index/codex-runtime-6-2", 10);
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults: [sourceResult("tldr-ai", [tldr])], profile: DEFAULT_PROFILE });
    const story = blended.candidates[0]!;

    expect(blended.overlaps).toBe(1);
    expect(story.provenance?.lead).toMatchObject({ id: "tldr-ai", layer: "editorial" });
    expect(story.provenance?.editorialCorroboration).toEqual([expect.objectContaining({ id: "ainews", layer: "editorial" })]);
    expect(story.provenance?.evidence[0]).toEqual({ label: "openai.com", url: "https://openai.com/index/codex-runtime-6-2", kind: "direct" });
    expect(story.sources[0]?.url).toBe("https://openai.com/index/codex-runtime-6-2");
  });

  it("records distinct editorial coverage and applies the capped boost", () => {
    const base: CandidateStory[] = [{
      id: 1,
      title: "Codex runtime 6.2 launches for teams",
      summary: "AInews coverage.",
      category: "agents",
      categoryLabel: "Agents in practice",
      score: 6,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [{ label: "AInews link", url: "https://openai.com/index/codex-runtime-6-2" }]
    }];
    const tldr = supplemental("tldr-ai", "Codex runtime 6.2 launches for teams", "https://openai.com/index/codex-runtime-6-2?utm_source=tldr", 10);
    const alpha = supplemental("alphasignal", "Codex runtime 6.2 launches for teams", "https://openai.com/index/codex-runtime-6-2?utm_source=alpha", 10);
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults: [sourceResult("tldr-ai", [tldr]), sourceResult("alphasignal", [alpha])], profile: DEFAULT_PROFILE });
    const coverage = blended.candidates[0]?.provenance?.coverage;

    expect(coverage).toMatchObject({
      editorialSourceIds: ["alphasignal", "ainews", "tldr-ai"],
      editorialSourceCount: 3,
      primaryEvidenceCount: 0,
      boost: 8
    });
  });

  it("preserves an AInews-provided URL byte-for-byte when it remains the preferred evidence", () => {
    const exactUrl = "https://openai.com/index/codex/?utm_source=ainews&keep=yes";
    const base: CandidateStory[] = [{ id: 1, title: "Codex workflow controls", summary: "AInews coverage.", category: "codex", categoryLabel: "Codex & agent craft", score: 12, exceptional: false, watchPermission: false, watchGeography: false, sources: [{ label: "OpenAI", url: exactUrl }] }];
    const tldr = supplemental("tldr-ai", "Codex workflow controls explained", "https://openai.com/index/codex?keep=yes", 8);
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults: [sourceResult("tldr-ai", [tldr])], profile: DEFAULT_PROFILE });
    expect(blended.candidates[0]?.sources[0]?.url).toBe(exactUrl);
  });

  it("prefers known primary evidence over a secondary AInews link", () => {
    const base: CandidateStory[] = [{
      id: 1,
      title: "Cloudflare agent sessions 4.1 arrive",
      summary: "AInews coverage.",
      category: "agents",
      categoryLabel: "Agents in practice",
      score: 8,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [{ label: "Discussion", url: "https://www.reddit.com/r/agents/comments/cloudflare" }]
    }];
    const primary = supplemental("cloudflare-agents", "Cloudflare agent sessions 4.1 arrive", "https://blog.cloudflare.com/agent-sessions-4-1", 8);
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults: [sourceResult("cloudflare-agents", [primary])], profile: DEFAULT_PROFILE });

    expect(blended.candidates[0]?.sources[0]?.url).toBe("https://blog.cloudflare.com/agent-sessions-4-1");
    expect(blended.candidates[0]?.provenance?.evidence[0]?.kind).toBe("primary");
    expect(blended.candidates[0]?.provenance?.coverage?.editorialSourceCount).toBe(1);
    expect(blended.candidates[0]?.provenance?.coverage?.primaryEvidenceCount).toBe(1);
    expect(blended.candidates[0]?.provenance?.coverage?.boost).toBe(0);
    expect(blended.candidates[0]?.provenance?.selection.score).toBe(72);
  });

  it("matches a supplemental story against every AInews source URL, not only the first", () => {
    const base: CandidateStory[] = [{
      id: 1,
      title: "Unrelated AInews discussion item",
      summary: "AInews coverage.",
      category: "agents",
      categoryLabel: "Agents in practice",
      score: 8,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [
        { label: "Discussion", url: "https://www.reddit.com/r/agents/comments/unrelated" },
        { label: "Cloudflare", url: "https://blog.cloudflare.com/agent-sessions-4-1" }
      ]
    }];
    const supplementalStory = supplemental("tldr-ai", "Cloudflare releases governed sessions v4.1", "https://blog.cloudflare.com/agent-sessions-4-1", 8);
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults: [sourceResult("tldr-ai", [supplementalStory])], profile: DEFAULT_PROFILE });

    expect(blended.overlaps).toBe(1);
    expect(blended.selectedSupplemental).toHaveLength(0);
    expect(blended.candidates).toHaveLength(1);
  });

  it("caps novel supplemental publication at two, one per lead source, without padding", () => {
    const base = Array.from({ length: 18 }, (_, index): CandidateStory => ({
      id: index + 1,
      title: `AInews base integration ${index}`,
      summary: "A practical integration for agent workflows.",
      category: "integration",
      categoryLabel: "Integration & platforms",
      score: 7 - index / 10,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [{ label: "Base", url: `https://base.example/story-${index}` }]
    }));
    const sources = [
      sourceResult("tldr-ai", [
        supplemental("tldr-ai", "Codex gains replayable team handoffs", "https://openai.com/codex-handoffs", 12),
        supplemental("tldr-ai", "Agents gain durable review queues", "https://github.com/features/review-agents", 11)
      ]),
      sourceResult("alphasignal", [supplemental("alphasignal", "Enterprise agent memory becomes auditable", "https://example.org/auditable-memory", 10)]),
      sourceResult("cloudflare-agents", [supplemental("cloudflare-agents", "Workers adds agent workflow state", "https://blog.cloudflare.com/agent-state", 9)])
    ];
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults: sources, profile: DEFAULT_PROFILE });

    expect(blended.candidates).toHaveLength(18);
    expect(blended.selectedSupplemental).toHaveLength(2);
    expect(blended.candidates.filter((candidate) => candidate.provenance?.selection.reason === "strong-fit-supplemental")).toHaveLength(2);
    expect(new Set(blended.selectedSupplemental.map((candidate) => candidate.sourceAttributions[0]?.sourceId)).size).toBe(2);

    const quiet = buildBlendedCandidateInventory({
      aiNewsCandidates: base.slice(0, 1),
      sourceResults: [sourceResult("tldr-ai", [supplemental("tldr-ai", "Routine GPU pricing", "https://vendor.example/pricing", -4)])],
      profile: DEFAULT_PROFILE
    });
    expect(quiet.candidates).toHaveLength(1);
    expect(quiet.selectedSupplemental).toHaveLength(0);

    const exceptional = { ...supplemental("tldr-ai", "An unprecedented agent capability appears", "https://example.com/exceptional", -4), category: "research", categoryLabel: "AI research & science", exceptional: true };
    const override = buildBlendedCandidateInventory({ aiNewsCandidates: [], sourceResults: [sourceResult("tldr-ai", [exceptional])], profile: DEFAULT_PROFILE });
    expect(override.selectedSupplemental).toHaveLength(1);
    expect(override.candidates[0]?.exceptional).toBe(true);
  });

  it("keeps the AInews publication inventory intact when every supplemental source fails", async () => {
    const fetcher = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const sourceResults = await collectSupplementalSources({ profile: DEFAULT_PROFILE, now: new Date("2026-08-15T02:00:00Z"), fetcher });
    const base: CandidateStory[] = [{
      id: 1,
      title: "AInews agent workflow",
      summary: "A practical agent workflow.",
      category: "agents",
      categoryLabel: "Agents in practice",
      score: 8,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [{ label: "Primary", url: "https://example.com/ainews-story" }]
    }];
    const blended = buildBlendedCandidateInventory({ aiNewsCandidates: base, sourceResults, profile: DEFAULT_PROFILE });

    expect(sourceResults).toHaveLength(3);
    expect(sourceResults.every((result) => result.health.status === "failed")).toBe(true);
    expect(blended.candidates).toHaveLength(1);
    expect(blended.candidates[0]).toMatchObject({ title: base[0]?.title, sources: base[0]?.sources });
    expect(blended.selectedSupplemental).toHaveLength(0);
  });

  it("reports overlaps while enforcing the 3/2/1 source caps and preserving the 18/14 limits", () => {
    const base: CandidateStory[] = [{
      id: 1,
      title: "Google launches Gemini 3.7 for agent workflows",
      summary: "Base AInews story.",
      category: "agents",
      categoryLabel: "Agents in practice",
      score: 9,
      exceptional: false,
      watchPermission: false,
      watchGeography: false,
      sources: [{ label: "Google", url: "https://blog.google/gemini-3-7" }]
    }];
    const tldr = [
      supplemental("tldr-ai", "Gemini 3.7 launches for agent workflows", "https://blog.google/gemini-3-7?utm_source=tldr", 10),
      supplemental("tldr-ai", "Codex gains replayable edit sessions", "https://example.com/tldr-1", 8.9),
      supplemental("tldr-ai", "Browser agents adopt scoped credentials", "https://example.com/tldr-2", 8.8),
      supplemental("tldr-ai", "Agent evaluation moves into pull requests", "https://example.com/tldr-3", 8.7),
      supplemental("tldr-ai", "Desktop assistants learn durable handoffs", "https://example.com/tldr-4", 8.6)
    ];
    const alpha = [
      supplemental("alphasignal", "Enterprise agents acquire auditable memory", "https://example.com/alpha-1", 7.9),
      supplemental("alphasignal", "New orchestration layer connects business systems", "https://example.com/alpha-2", 7.8),
      supplemental("alphasignal", "Coding agents coordinate review queues", "https://example.com/alpha-3", 7.7)
    ];
    const cloudflare = [
      supplemental("cloudflare-agents", "Cloudflare Workers adds structured agent outputs", "https://blog.cloudflare.com/cf-1", 6.9),
      supplemental("cloudflare-agents", "Cloudflare launches durable agent sessions", "https://blog.cloudflare.com/cf-2", 6.8)
    ];
    const issue: RssIssue = { url: "https://news.smol.ai/issues/26-08-15", issueDate: "2026-08-15", publicationDate: "15 August 2026", body: "body", anchors: [] };
    const report = buildSupplementalShadowReport({
      issue,
      aiNewsCandidates: base,
      sourceResults: [sourceResult("tldr-ai", tldr), sourceResult("alphasignal", alpha), sourceResult("cloudflare-agents", cloudflare)],
      generatedAt: "2026-08-15T02:00:00.000Z"
    });

    expect(report.mode).toBe("shadow");
    expect(report.sourcePack).toEqual({ id: "core-ai", version: 1 });
    expect(report.limits).toEqual({ modelCandidates: 18, publishedStories: 14, tldr: 3, alphaSignal: 2, cloudflare: 1 });
    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0]?.preferredUrl).toBe("https://blog.google/gemini-3-7");
    expect(report.wouldAdd).toHaveLength(6);
    expect(report.wouldAdd.filter((item) => item.sourceIds.includes("tldr-ai"))).toHaveLength(3);
    expect(report.wouldAdd.filter((item) => item.sourceIds.includes("alphasignal"))).toHaveLength(2);
    expect(report.wouldAdd.filter((item) => item.sourceIds.includes("cloudflare-agents"))).toHaveLength(1);
    expect(base).toHaveLength(1);
    expect(base[0]?.title).toBe("Google launches Gemini 3.7 for agent workflows");

    const blendReport = buildSupplementalShadowReport({
      issue,
      aiNewsCandidates: base,
      sourceResults: [sourceResult("tldr-ai", tldr)],
      generatedAt: "2026-08-15T02:00:00.000Z",
      mode: "blend",
      selectedForBlend: tldr.slice(1, 2)
    });
    expect(blendReport).toMatchObject({ mode: "blend", totals: { selectedForBlend: 1 }, selectedForBlend: [{ title: "Codex gains replayable edit sessions" }] });
  });
});
