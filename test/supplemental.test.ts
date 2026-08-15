import { describe, expect, it } from "vitest";
import type { CandidateStory, RssIssue, SupplementalCandidate, SupplementalSourceId } from "../src/contracts";
import { DEFAULT_PROFILE } from "../src/contracts";
import {
  buildSupplementalShadowReport,
  canonicalizeSupplementalUrl,
  deduplicateSupplemental,
  parseAlphaArticle,
  parseAlphaSitemap,
  parseCloudflareFeed,
  parseTldrFeed,
  parseTldrIssue,
  titleSimilarity,
  type SourceResult
} from "../src/supplemental";

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

  it("limits AlphaSignal discovery to the preceding 24 hours and prefers a specific evidence link", () => {
    const sitemap = `<urlset>
      <url><loc>https://alphasignal.ai/news/new-codex-agent-runtime</loc><lastmod>2026-08-15T00:30:00Z</lastmod></url>
      <url><loc>https://alphasignal.ai/news/old-model-release</loc><lastmod>2026-08-13T23:59:00Z</lastmod></url>
    </urlset>`;
    const recent = parseAlphaSitemap(sitemap, new Date("2026-08-15T02:00:00Z"));
    expect(recent).toHaveLength(1);
    expect(recent[0]?.title).toContain("Codex Agent Runtime");

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
});

describe("cross-source deduplication and shadow selection", () => {
  it("merges canonical URL, fuzzy-title and product-version duplicates with combined attribution", () => {
    const exact = supplemental("tldr-ai", "Codex runtime launches", "https://openai.com/codex?utm_source=tldr");
    const fuzzy = supplemental("alphasignal", "OpenAI launches the new Codex runtime", "https://openai.com/index/codex-runtime");
    const version = supplemental("cloudflare-agents", "Codex 6.2 arrives for agent teams", "https://blog.cloudflare.com/codex-62");
    const versionAgain = supplemental("tldr-ai", "Testing Codex 6.2 in production", "https://tldr.tech/codex-62");
    const merged = deduplicateSupplemental([exact, { ...exact, sourceAttributions: fuzzy.sourceAttributions }, version, versionAgain]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.sourceAttributions.map((item) => item.sourceId).sort()).toEqual(["alphasignal", "tldr-ai"]);
    expect(merged[1]?.sourceAttributions).toHaveLength(2);
    expect(titleSimilarity(exact.title, fuzzy.title)).toBeGreaterThanOrEqual(0.62);
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
    expect(report.limits).toEqual({ modelCandidates: 18, publishedStories: 14, tldr: 3, alphaSignal: 2, cloudflare: 1 });
    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0]?.preferredUrl).toBe("https://blog.google/gemini-3-7");
    expect(report.wouldAdd).toHaveLength(6);
    expect(report.wouldAdd.filter((item) => item.sourceIds.includes("tldr-ai"))).toHaveLength(3);
    expect(report.wouldAdd.filter((item) => item.sourceIds.includes("alphasignal"))).toHaveLength(2);
    expect(report.wouldAdd.filter((item) => item.sourceIds.includes("cloudflare-agents"))).toHaveLength(1);
    expect(base).toHaveLength(1);
    expect(base[0]?.title).toBe("Google launches Gemini 3.7 for agent workflows");
  });
});
