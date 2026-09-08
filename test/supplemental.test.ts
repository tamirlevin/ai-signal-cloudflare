import { describe, expect, it } from "vitest";
import type { RssIssue, SupplementalCandidate, SupplementalSourceId } from "../src/contracts";
import { DEFAULT_PROFILE } from "../src/contracts";
import {
  buildDailyCandidateInventory,
  buildDailySourceReport,
  canonicalizeSupplementalUrl,
  collectSupplementalSources,
  deduplicateSupplemental,
  freshnessBoost,
  parseAlphaArticle,
  parseAlphaSitemap,
  parseCloudflareFeed,
  parseTldrFeed,
  parseTldrIssue,
  titleSimilarity,
  type SourceResult
} from "../src/supplemental";
import { DEFAULT_SOURCE_PACK_ID, SOURCE_PACKS } from "../src/source-packs";

const now = new Date("2026-08-15T02:00:00.000Z");

function sourceName(sourceId: SupplementalSourceId): string {
  if (sourceId === "ainews") return "AInews";
  if (sourceId === "tldr-ai") return "TLDR AI";
  if (sourceId === "alphasignal") return "AlphaSignal";
  return "Cloudflare Agents";
}

function candidate(sourceId: SupplementalSourceId, title: string, url: string, score = 8, publishedAt = "2026-08-15T01:00:00.000Z"): SupplementalCandidate {
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
    sourceAttributions: [{
      sourceId,
      sourceName: sourceName(sourceId),
      kind: sourceId === "cloudflare-agents" ? "primary" : "discovery",
      sourceUrl: `https://${sourceId}.example/issue`
    }]
  };
}

function sourceResult(sourceId: SupplementalSourceId, candidates: SupplementalCandidate[]): SourceResult {
  return {
    candidates,
    health: { id: sourceId, name: sourceName(sourceId), status: "healthy", requests: 1, fetchedItems: candidates.length, acceptedCandidates: candidates.length, errors: [] }
  };
}

function dailyIssue(): RssIssue {
  return {
    url: "https://signal.tamirlevin.dev/?edition=2026-08-15",
    issueDate: "2026-08-15",
    publicationDate: "15 August 2026",
    publishedAt: now.toISOString(),
    body: "",
    anchors: []
  };
}

describe("source packs", () => {
  it("defines one equal-source pack with a 72-hour collection horizon", () => {
    expect(DEFAULT_PROFILE.sourcePackId).toBe(DEFAULT_SOURCE_PACK_ID);
    expect(SOURCE_PACKS[DEFAULT_SOURCE_PACK_ID]).toMatchObject({ id: "core-ai", version: 4 });
    expect(SOURCE_PACKS[DEFAULT_SOURCE_PACK_ID].sources.map((source) => source.id)).toEqual(["ainews", "tldr-ai", "alphasignal", "ai-secret", "cloudflare-agents"]);
    expect(SOURCE_PACKS[DEFAULT_SOURCE_PACK_ID].sources.filter((source) => source.lookbackHours).every((source) => source.lookbackHours === 72)).toBe(true);
  });
});

describe("source parsing", () => {
  it.each([
    ["Product Manager, Applied AI at TLDR ($200k base + $60k bonus, Fully Remote)", "TLDR is hiring its first PM to help build the agent-first operating layer used across the company.", "https://jobs.ashbyhq.com/tldr.tech/897f4391-66ab-44ca-a8eb-65dd9809200d"],
    ["Build practical AI products", "A new opportunity.", "https://jobs.ashbyhq.com/team/role?utm_source=tldr"],
    ["Build practical AI products", "We're hiring an engineer. Join our team.", "https://example.com/opportunity"],
    ["Build practical AI products", "TLDR is hiring its first PM.", "https://example.com/opportunity"],
    ["New agent platform", "Sponsored: Try this platform today.", "https://example.com/platform"],
    ["Engineer", "A new opportunity.", "https://boards.greenhouse.io/team/role"],
    ["Engineer", "A new opportunity.", "https://example.com/careers/engineer"]
  ])("excludes TLDR promotion: %s (%s)", (title, summary, url) => {
    const html = `<article><a href="${url}"><h3>${title}</h3></a><div class="newsletter-html">${summary}</div></article>`;
    expect(parseTldrIssue(html, { url: "https://tldr.tech/ai/2026-09-07", publishedAt: now.toISOString() }, DEFAULT_PROFILE)).toEqual([]);
  });

  it.each([
    ["AI changes software jobs", "Research examines how hiring patterns are changing.", "https://example.com/news/jobs"],
    ["OpenAI is hiring more researchers", "The company is expanding its research team.", "https://example.com/news/hiring"],
    ["Agents automate batch jobs", "A platform adds new background execution tools.", "https://example.com/platform"],
    ["Ashby adds AI integrations", "The recruiting platform launches new connectors.", "https://www.ashbyhq.com/blog/ai-integrations"]
  ])("retains editorial news: %s", (title, summary, url) => {
    const html = `<article><a href="${url}"><h3>${title}</h3></a><div class="newsletter-html">${summary}</div></article>`;
    expect(parseTldrIssue(html, { url: "https://tldr.tech/ai/2026-09-07", publishedAt: now.toISOString() }, DEFAULT_PROFILE)).toHaveLength(1);
  });

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
    const issue = `<section><article><a href="https://openai.com/index/codex-memory/?utm_source=tldr"><h3>Codex adds persistent agent memory (4 minute read)</h3></a><div class="newsletter-html">The new memory API uses explicit permission scopes.</div></article>
      <article><a href="https://sponsor.example/deal"><h3>Sponsored: Save on GPUs</h3></a><div class="newsletter-html">Advertisement</div></article></section>`;
    const stories = parseTldrIssue(issue, { url: "https://tldr.tech/ai/2026-08-15", publishedAt: now.toISOString() }, DEFAULT_PROFILE);
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ title: "Codex adds persistent agent memory", url: "https://openai.com/index/codex-memory" });
  });

  it("collects AlphaSignal fallback inputs through 72 hours and extracts a direct evidence link", () => {
    const sitemap = `<urlset>
      <url><loc>https://alphasignal.ai/news/new-codex-agent-runtime</loc><lastmod>2026-08-15T00:30:00Z</lastmod></url>
      <url><loc>https://alphasignal.ai/news/inside-window-model-release</loc><lastmod>2026-08-12T14:00:00Z</lastmod></url>
      <url><loc>https://alphasignal.ai/news/too-old-model-release</loc><lastmod>2026-08-12T01:59:00Z</lastmod></url>
    </urlset>`;
    const recent = parseAlphaSitemap(sitemap, now);
    expect(recent).toHaveLength(2);
    const article = `<html><head><meta name="description" content="A new agent runtime with replayable traces."></head><body>
      <h1>OpenAI releases a replayable Codex agent runtime</h1>
      <a href="https://openai.com/index/replayable-codex-runtime/?utm_campaign=alpha">OpenAI Codex runtime release</a>
      <a href="https://x.com/openai">Social profile</a>
      <a href="https://x.com/openai/status/123456789">OpenAI replayable Codex runtime announcement</a>
    </body></html>`;
    expect(parseAlphaArticle(article, recent[0]!.url).preferredUrl).toBe("https://openai.com/index/replayable-codex-runtime");
  });

  it("keeps only recent Cloudflare posts and reserves primary status for Cloudflare", () => {
    const feed = `<rss><channel>
      <item><title>Workers AI adds agent tool contracts</title><link>https://blog.cloudflare.com/agent-tool-contracts</link><pubDate>Wed, 12 Aug 2026 14:00:00 GMT</pubDate><description>Structured tool contracts improve agent integrations.</description></item>
      <item><title>External announcement</title><link>https://example.com/announcement</link><pubDate>Fri, 14 Aug 2026 01:00:00 GMT</pubDate><description>External.</description></item>
      <item><title>Old Agents post</title><link>https://blog.cloudflare.com/old-agents</link><pubDate>Sat, 1 Aug 2026 01:00:00 GMT</pubDate><description>Old.</description></item>
    </channel></rss>`;
    const candidates = parseCloudflareFeed(feed, now, DEFAULT_PROFILE);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.sourceAttributions[0]?.kind).toBe("primary");
    expect(candidates[1]?.sourceAttributions[0]?.kind).toBe("discovery");
  });
});

describe("daily equal-source pool", () => {
  it.each([9, 10, 11])("expands only below ten qualified distinct candidates (%i)", (count) => {
    const fresh = Array.from({ length: count }, (_, i) => candidate("tldr-ai", `Development ${i}`, `https://example.com/fresh-${i}`));
    const older = candidate("alphasignal", "Fallback development", "https://example.com/fallback", 8, "2026-08-12T02:00:00Z");
    const inventory = buildDailyCandidateInventory({ sourceResults: [sourceResult("tldr-ai", fresh), sourceResult("alphasignal", [older])], profile: DEFAULT_PROFILE, now });
    expect(inventory.collection.maxFreshnessHours).toBe(count < 10 ? 72 : 48);
    expect(inventory.eligibleCandidates).toBe(count < 10 ? count + 1 : count);
    expect(inventory.candidates.some((item) => item.sources[0]?.url === older.url)).toBe(count < 10);
    expect(freshnessBoost(older.publishedAt, now)).toBe(0);
  });

  it("counts after deduplication and qualification, rejects invalid dates, and never pads", () => {
    const fresh = candidate("tldr-ai", "Fresh development", "https://example.com/fresh");
    const fallback = candidate("tldr-ai", "Older development", "https://example.com/older", 8, "2026-08-12T02:00:00Z");
    const weak = { ...fallback, title: "Weak material", url: "https://example.com/weak", score: -4 };
    const candidates = [
      ...Array.from({ length: 12 }, () => ({ ...fresh })), fallback, weak,
      { ...fallback, url: "https://x.com/example/status/2" },
      { ...fallback, url: "https://example.com/future", publishedAt: "2026-08-16T00:00:00Z" },
      { ...fallback, url: "https://example.com/invalid", publishedAt: "invalid" },
      { ...fallback, url: "https://example.com/expired", publishedAt: "2026-08-12T01:59:59.999Z" }
    ];
    const inventory = buildDailyCandidateInventory({ sourceResults: [sourceResult("tldr-ai", candidates)], profile: DEFAULT_PROFILE, now });
    expect(inventory.collection.maxFreshnessHours).toBe(72);
    expect(inventory.candidates.map((item) => item.sources[0]?.url).sort()).toEqual([fresh.url, fallback.url].sort());
    expect(inventory.expiredCandidates).toBe(3);
  });

  it("includes the exact 48-hour boundary without expansion when ten qualify", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate("tldr-ai", `Boundary ${i}`, `https://example.com/boundary-${i}`, 8, "2026-08-13T02:00:00Z"));
    const inventory = buildDailyCandidateInventory({ sourceResults: [sourceResult("tldr-ai", candidates)], profile: DEFAULT_PROFILE, now });
    expect(inventory.collection.maxFreshnessHours).toBe(48);
    expect(inventory.eligibleCandidates).toBe(10);
  });

  it("deduplicates cross-source coverage without a source-order tie-break", () => {
    const tldr = candidate("tldr-ai", "OpenAI launches the new Codex runtime", "https://openai.com/codex?utm_source=tldr", 8);
    const alpha = candidate("alphasignal", "Codex runtime launches", "https://openai.com/codex", 10);
    const merged = deduplicateSupplemental([tldr, alpha]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: alpha.title, leadSourceId: "alphasignal" });
    expect(merged[0]?.sourceAttributions.map((item) => item.sourceId).sort()).toEqual(["alphasignal", "tldr-ai"]);
    expect(titleSimilarity(tldr.title, alpha.title)).toBeGreaterThanOrEqual(0.62);
  });

  it("enforces the 72-hour ceiling, prefers the first 36 hours, and never publishes X-only cards", () => {
    const results = [sourceResult("ainews", [
      candidate("ainews", "Fresh Codex workflow", "https://openai.com/fresh", 8, "2026-08-13T14:01:00Z"),
      candidate("ainews", "Stale Codex workflow", "https://openai.com/stale", 30, "2026-08-12T01:59:00Z"),
      candidate("ainews", "X-only agent noise", "https://x.com/example/status/1", 30, "2026-08-15T01:00:00Z")
    ])];
    const inventory = buildDailyCandidateInventory({ sourceResults: results, profile: DEFAULT_PROFILE, now });
    expect(inventory.candidates.map((item) => item.title)).toEqual(["Fresh Codex workflow"]);
    expect(inventory.expiredCandidates).toBe(1);
    expect(freshnessBoost("2026-08-13T14:01:00Z", now)).toBe(6);
    expect(freshnessBoost("2026-08-13T02:01:00Z", now)).toBe(0);
  });

  it("uses corroboration as a boost and keeps similarly ranked sources diverse", () => {
    const overlapA = candidate("tldr-ai", "Codex runtime 6.2 launches for agent teams", "https://openai.com/codex-62", 10);
    const overlapB = candidate("alphasignal", "Codex runtime 6.2 launches for agent teams", "https://openai.com/codex-62?utm_source=alpha", 10);
    const tldrSecond = candidate("tldr-ai", "Agents gain durable review queues", "https://example.com/review-queues", 9);
    const inventory = buildDailyCandidateInventory({
      sourceResults: [sourceResult("tldr-ai", [overlapA, tldrSecond]), sourceResult("alphasignal", [overlapB])],
      profile: DEFAULT_PROFILE,
      now
    });
    expect(inventory.candidates[0]?.provenance?.coverage).toMatchObject({ editorialSourceCount: 2, boost: 4 });
    expect(inventory.candidates[0]?.provenance?.selection.reason).toBe("cross-source");
    expect(inventory.collection).toMatchObject({ mode: "daily-pool", preferredFreshnessHours: 36, maxFreshnessHours: 72, selectedCandidates: 2 });
  });

  it("has no per-source quota and does not pad with weak material", () => {
    const titles = ["Codex gains replayable handoffs", "Browser agents adopt scoped credentials", "Enterprise memory becomes auditable", "Agent evaluations enter pull requests", "Tool contracts gain approval gates", "Workflow traces become durable"];
    const strong = titles.map((title, index) => candidate("tldr-ai", title, `https://example.com/strong-${index}`, 12 - index / 10));
    const weak = candidate("alphasignal", "Routine GPU pricing", "https://example.com/weak", -4);
    const inventory = buildDailyCandidateInventory({ sourceResults: [sourceResult("tldr-ai", strong), sourceResult("alphasignal", [weak])], profile: DEFAULT_PROFILE, now });
    expect(inventory.candidates).toHaveLength(6);
    expect(inventory.candidates.every((item) => item.provenance?.lead.id === "tldr-ai")).toBe(true);
  });

  it("returns an empty pool when every source fails", async () => {
    const fetcher = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const sourceResults = await collectSupplementalSources({ profile: DEFAULT_PROFILE, now, fetcher });
    const inventory = buildDailyCandidateInventory({ sourceResults, profile: DEFAULT_PROFILE, now });
    expect(sourceResults).toHaveLength(5);
    expect(sourceResults.every((result) => result.health.status === "failed")).toBe(true);
    expect(inventory.candidates).toEqual([]);
  });

  it("records source health and the selected daily pool without source caps", () => {
    const sourceResults = [
      sourceResult("ainews", []),
      sourceResult("tldr-ai", [candidate("tldr-ai", "Codex gains replayable edit sessions", "https://example.com/tldr")]),
      sourceResult("alphasignal", [candidate("alphasignal", "Enterprise agents acquire auditable memory", "https://example.com/alpha")]),
      sourceResult("cloudflare-agents", [])
    ];
    const inventory = buildDailyCandidateInventory({ sourceResults, profile: DEFAULT_PROFILE, now });
    const report = buildDailySourceReport({ issue: dailyIssue(), sourceResults, inventory, generatedAt: now.toISOString(), profile: DEFAULT_PROFILE });
    expect(report).toMatchObject({
      mode: "daily-pool",
      sourcePack: { id: "core-ai", version: 4 },
      limits: { modelCandidates: 18, publishedStories: 14 },
      freshness: { preferredHours: 36, maxHours: 72, eligibleCandidates: 2 },
      totals: { selectedForBlend: 2 }
    });
    expect(report.selectedForBlend).toHaveLength(2);
  });
});
