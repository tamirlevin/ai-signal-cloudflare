import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, type Profile } from "../src/contracts";
import { deterministicEditorialEdition } from "../src/editorial";
import { buildDailyCandidateInventory, collectSupplementalSources, parseAiSecretFeed, type SourceResult } from "../src/supplemental";
import { validateEdition } from "../src/validation";

const now = new Date("2026-09-09T00:00:00Z");
const profile: Profile = { ...DEFAULT_PROFILE, weights: DEFAULT_PROFILE.weights.map((weight) => ({ ...weight, value: weight.id === "codex" ? 3 : weight.id === "research" ? 2 : weight.value })) };
const news = `<p><strong>NEW LAUNCH</strong></p><h3>The Profession Just Died</h3>
  <figure><a href="https://sponsor.example/banner"><img src="banner.png"></a></figure>
  <p><strong>&#x1F440; What&apos;s happening:</strong> A company released a <a href="https://example.com/forecast?ref=aisecret.us&amp;keep=yes">forecasting platform</a> for retail teams.</p>
  <p><strong>How this hits reality:</strong> Unsupported claim. <a href="https://example.com/unrelated">Other link</a></p>`;
const sponsor = `<p><strong>TOGETHER WITH <mark>FRAMER</mark></strong></p><h3>Build with coding agents</h3><p>What's happening: <a href="https://sponsor.example/ad">Codex platform</a> launches today.</p><ul><li><a href="https://sponsor.example/ad2">Agent tool</a> for teams.</li></ul>`;
const quick = `<p><strong><mark>DAILY TL;DR</mark></strong></p><ul>
  <li><a href="https://example.com/voice">Company</a> released a voice transcription platform.</li>
  <li><a href="https://x.com/example/status/123">Social-only agent launch</a></li>
  <li><a href="https://jobs.ashbyhq.com/team/role">Apply now</a> to build Codex integrations.</li>
  <li><a href="https://aisecret.us/other">Newsletter homepage</a></li></ul>`;
const footer = `<p>READ MORE</p><ul><li><a href="https://other-newsletter.example">Subscribe to our AI platform newsletter</a></li></ul>`;
function item(html: string, publishedAt = "2026-09-08T10:00:00Z", slug = "edition"): string {
  return `<item><title>Daily Rundown</title><link>https://aisecret.us/${slug}/</link><pubDate>${publishedAt}</pubDate><content:encoded><![CDATA[${html}]]></content:encoded></item>`;
}
const feed = (...items: string[]) => `<rss><channel>${items.join("")}</channel></rss>`;

describe("AI Secret collector", () => {
  it("uses factual openings and their own links, excluding sponsors, commentary, images and footer", () => {
    const xml = feed(item([news, sponsor, quick, footer].join("<hr>")));
    const candidates = parseAiSecretFeed(xml, now, profile);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ title: "A company released a forecasting platform for retail teams", url: "https://example.com/forecast?keep=yes", publishedAt: "2026-09-08T10:00:00.000Z", leadSourceId: "ai-secret" });
    expect(candidates[1]?.title).toBe("Company released a voice transcription platform");
    expect(JSON.stringify(candidates)).not.toMatch(/Profession|Unsupported|sponsor\.example|unrelated|ashby|other-newsletter|x\.com/);
    expect(candidates[0]?.sourceAttributions[0]).toMatchObject({ sourceId: "ai-secret", kind: "discovery", sourceUrl: "https://aisecret.us/edition" });
  });

  it("does not replace missing factual links with commentary or image links", () => {
    const html = news.replace(/<a href="https:\/\/example.com\/forecast[^>]+>(.*?)<\/a>/, "$1");
    expect(parseAiSecretFeed(feed(item(html)), now, profile)).toEqual([]);
    expect(parseAiSecretFeed(feed(item("<h3>An essay</h3><p><a href='https://example.com/essay'>Some opinion</a></p>")), now, profile)).toEqual([]);
  });

  it("reads all eligible editions, includes the 72-hour boundary and rejects old, invalid and future dates", () => {
    const xml = feed(item(news, "2026-09-06T00:00:00Z", "boundary"), item(news, "2026-09-09T00:00:00.001Z", "future"), item(news, "invalid", "invalid"), item(news, "2026-09-05T23:59:59.999Z", "expired"), item(quick));
    expect(parseAiSecretFeed(xml, now, profile)).toHaveLength(2);
    expect(parseAiSecretFeed(xml, now, profile)[0]?.url).toBe("https://example.com/voice");
  });

  it("bounds parsing to six recent editions and 24 items per edition", () => {
    const many = `<p>DAILY TL;DR</p><ul>${Array.from({ length: 30 }, (_, n) => `<li><a href="https://example.com/${n}">Company ${n}</a> released a platform.</li>`).join("")}</ul>`;
    const xml = feed(...Array.from({ length: 8 }, (_, n) => item(many, "2026-09-08T10:00:00Z", `edition-${n}`)));
    expect(parseAiSecretFeed(xml, now, profile)).toHaveLength(144);
  });

  it("records AI Secret as the fourth editorial voice, without increasing the corroboration boost ceiling", () => {
    const candidates = parseAiSecretFeed(feed(item(news)), now, profile);
    const original = candidates[0]!;
    original.sourceAttributions.push(...(["ainews", "tldr-ai", "alphasignal"] as const).map((sourceId) => ({ sourceId, sourceName: sourceId, kind: "discovery" as const, sourceUrl: `https://${sourceId}.example/issue` })));
    const sourceResults: SourceResult[] = [{ candidates, health: { id: "ai-secret", name: "AI Secret", status: "healthy", requests: 1, fetchedItems: 1, acceptedCandidates: 1, errors: [] } }];
    const inventory = buildDailyCandidateInventory({ sourceResults, profile, now });
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]?.provenance?.coverage).toMatchObject({ editorialSourceCount: 4, boost: 8 });
    const edition = deterministicEditorialEdition({ url: "https://signal.tamirlevin.dev/?edition=2026-09-09", issueDate: "2026-09-09", publicationDate: "9 September 2026", publishedAt: now.toISOString(), body: "", anchors: [] }, inventory.candidates, profile);
    expect(() => validateEdition(edition, profile, new Set([original.url]))).not.toThrow();
  });

  it.each([402, 503])("fails open when AI Secret returns %i and another source has candidates", async (status) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("aisecret.us")) return new Response("unavailable", { status });
      if (String(input).includes("blog.cloudflare.com")) return new Response(`<rss><channel><item><title>New agent integration platform</title><link>https://blog.cloudflare.com/new-agents</link><pubDate>2026-09-08T00:00:00Z</pubDate><description>A company released a new agent platform integration.</description></item></channel></rss>`);
      return new Response("<rss><channel></channel></rss>");
    });
    const sourceResults = await collectSupplementalSources({ profile, now, fetcher });
    expect(sourceResults.find((result) => result.health.id === "ai-secret")?.health).toMatchObject({ status: "failed", requests: 1 });
    expect(buildDailyCandidateInventory({ sourceResults, profile, now }).candidates).toHaveLength(1);
  });

  it("uses one feed request with no article enrichment and reports quiet/layout drift as degraded", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(String(input).includes("aisecret.us") ? feed(item(news)) : "<rss><channel></channel></rss>"));
    const results = await collectSupplementalSources({ profile, now, fetcher });
    expect(results.find((result) => result.health.id === "ai-secret")?.health).toMatchObject({ status: "healthy", requests: 1, acceptedCandidates: 1 });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("aisecret.us"))).toHaveLength(1);
    const quiet = await collectSupplementalSources({ profile, now, fetcher: async () => new Response("<rss><channel></channel></rss>") });
    expect(quiet.find((result) => result.health.id === "ai-secret")?.health.status).toBe("degraded");
  });

  it("rejects an oversized chunked feed even without a content-length header", async () => {
    const results = await collectSupplementalSources({ profile, now, fetcher: async (input) => new Response(String(input).includes("aisecret.us") ? "é".repeat(1_000_001) : "<rss><channel></channel></rss>") });
    expect(results.find((result) => result.health.id === "ai-secret")?.health).toMatchObject({ status: "failed", errors: ["aisecret.us response is too large"] });
  });
});
