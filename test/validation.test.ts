import { describe, expect, it } from "vitest";
import type { Edition } from "../src/contracts";
import { DEFAULT_PROFILE } from "../src/contracts";
import { anchorsToMarkdown, parseLatestRss } from "../src/rss";
import { validateEdition, ValidationError } from "../src/validation";
import { compactIssueForModel, compactIssueInventory, editorialMessages, extractGeneratedEdition, generationInput, materializeCandidateStories } from "../src/editorial";
import { normalizeEditionStories } from "../src/story-normalization";

function edition(): Edition {
  const url = "https://example.com/story";
  return {
    schemaVersion: 1,
    issue: { publicationDate: "12 August 2026", coverage: "12 August 2026", url: "https://news.smol.ai/issues/test", quiet: true },
    presentation: { hotTitle: "One topic", hotIntro: "Short intro", allTitle: "All signals", allIntro: "All intro", synthesisTitle: "Synthesis", synthesisIntro: "Synthesis intro", sourceReadMinutes: 6, briefReadMinutes: 3 },
    synthesis: { lead: "Lead", bigPicture: "Big picture", sources: [{ label: "Story", url }], sections: [{ title: "First", kicker: "Kicker", body: "Body", sources: [{ label: "Story", url }] }, { title: "Second", kicker: "Kicker", body: "Body", sources: [{ label: "Story", url }] }] },
    hotTopics: [{ title: "Topic", summary: "Summary", category: "agents", base: 90, sources: [{ label: "Story", url }] }],
    signals: [{ title: "Signal", summary: "Summary", source: "Source", url, category: "agents", categoryLabel: "Agents in practice", base: 90 }]
  };
}

describe("editorial contracts", () => {
  it("rejects a generated source that AInews did not supply", () => {
    expect(() => validateEdition(edition(), DEFAULT_PROFILE, new Set(["https://example.com/other"]))).toThrow(ValidationError);
  });
  it("rejects repeated underlying story URLs", () => {
    const value = edition();
    value.signals.push({ title: "Different framing", summary: "Summary", source: "Source", url: "https://example.com/story", category: "agents", categoryLabel: "Agents in practice", base: 80 });
    expect(() => validateEdition(value, DEFAULT_PROFILE, new Set(["https://example.com/story"]))).toThrow("duplicate story URL");
  });
  it("keeps the stronger occurrence when normalizing duplicate model signals", () => {
    const value = edition();
    value.issue.quiet = false;
    value.signals[0]!.base = 70;
    value.signals.push({ ...value.signals[0]!, title: "Repeated framing", base: 90 });
    const normalized = normalizeEditionStories(value, { ...DEFAULT_PROFILE, storyBudget: 2 });
    expect(normalized.duplicateSignalsRemoved).toBe(1);
    expect(normalized.edition.signals).toHaveLength(1);
    expect(normalized.edition.signals[0]?.title).toBe("Repeated framing");
    expect(normalized.edition.issue.quiet).toBe(true);
  });
  it("collapses different source URLs that describe the same underlying story", () => {
    const value = edition();
    value.signals[0] = { ...value.signals[0]!, title: "Frontier Model Day", summary: "Grok 4.6 reaches the frontier: independent results put it near the leading models.", url: "https://example.com/grok-official", base: 90 };
    value.signals.push({ ...value.signals[0], source: "Evaluator", url: "https://example.com/grok-evaluation", base: 85 });
    value.signals.push({ ...value.signals[0], title: "Frontier Model Day", summary: "Qwen3.8-Max open weights are out: the new MoE model targets agent workflows.", source: "Qwen", url: "https://example.com/qwen", base: 80 });
    const normalized = normalizeEditionStories(value, { ...DEFAULT_PROFILE, storyBudget: 3 });
    expect(normalized.edition.signals).toHaveLength(2);
    expect(normalized.edition.signals.map((signal) => signal.title)).toEqual(["Grok 4.6 reaches the frontier", "Qwen3.8-Max open weights are out"]);
    expect(normalized.edition.issue.quiet).toBe(true);
  });
  it("binds each generated signal to one candidate title and representative source", () => {
    const value = edition();
    value.signals[0] = { ...value.signals[0]!, candidateId: 1, title: "Generic section heading", source: "Wrong label", url: "https://example.com/wrong", base: 80 };
    value.signals.push({ ...value.signals[0], title: "Another angle", url: "https://example.com/also-wrong", base: 70 });
    const normalized = normalizeEditionStories(value, { ...DEFAULT_PROFILE, storyBudget: 2 }, [{ id: 1, title: "GitHub introduces Agent Plugins 1.0", summary: "GitHub released a portable agent plugin format.", category: "agents", categoryLabel: "Agents in practice", score: 30, exceptional: false, watchPermission: false, watchGeography: false, sources: [{ label: "GitHub", url: "https://example.com/github-agent-plugins" }] }]);
    expect(normalized.edition.signals).toHaveLength(1);
    expect(normalized.edition.signals[0]).toMatchObject({ title: "GitHub introduces Agent Plugins 1.0", source: "GitHub", url: "https://example.com/github-agent-plugins" });
    expect(normalized.edition.issue.quiet).toBe(true);
  });
  it("keeps source reading time at least as long as the brief", () => {
    const value = edition();
    value.presentation.sourceReadMinutes = 2;
    value.presentation.briefReadMinutes = 3;
    const normalized = normalizeEditionStories(value, DEFAULT_PROFILE);
    expect(normalized.edition.presentation).toMatchObject({ sourceReadMinutes: 3, briefReadMinutes: 3 });
  });
  it("decodes RSS HTML then retains exact hrefs in model context", () => {
    const body = anchorsToMarkdown('&lt;p&gt;Read &lt;a href=&quot;https://example.com/a?x=1&amp;amp;y=2&quot;&gt;source&lt;/a&gt;&lt;/p&gt;');
    expect(body.anchors[0]?.url).toBe("https://example.com/a?x=1&y=2");
    expect(body.markdown).toContain("[source](https://example.com/a?x=1&y=2)");
  });
  it("reads only the first RSS item", () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><link>https://news.smol.ai/issues/first</link><pubDate>Wed, 12 Aug 2026 00:00:00 +0000</pubDate><content:encoded><![CDATA[<a href="https://example.com/a">A</a>]]></content:encoded></item><item><link>https://news.smol.ai/issues/second</link></item></channel></rss>`;
    expect(parseLatestRss(rss).url).toBe("https://news.smol.ai/issues/first");
  });
  it("reads OpenAI-style Workers AI choice content", () => {
    const value = edition();
    expect(extractGeneratedEdition({ choices: [{ message: { content: JSON.stringify(value) } }] }).issue.url).toBe(value.issue.url);
  });
  it("compacts a large issue into a broad profile-aware candidate inventory", () => {
    const anchors = Array.from({ length: 60 }, (_, index) => ({ label: `Story ${index}`, url: `https://example.com/story-${index}` }));
    const body = anchors.map((source, index) => `${index === 59 ? "Codex agent harness permissions and practical workflow" : index % 2 ? "Routine infrastructure and training update" : "A newly released integration platform"} [${source.label}](${source.url}) ${"detail ".repeat(80)}`).join("\n");
    const issue = { url: "https://news.smol.ai/issues/test", issueDate: "2026-08-12", publicationDate: "12 August 2026", body, anchors };
    const compact = compactIssueForModel(issue, DEFAULT_PROFILE);
    expect(compact.body.length).toBeLessThan(issue.body.length);
    expect(compact.anchors.length).toBeLessThanOrEqual(24);
    expect(compact.anchors.some((source) => source.url.endsWith("story-59"))).toBe(true);
    expect(compact.body).toContain("Candidate 1");
    expect(compact.body.split("\n", 3).join(" ")).toContain("Codex agent harness permissions");
  });
  it("uses prompt-only JSON for the fallback model", () => {
    const issue = { url: "https://news.smol.ai/issues/test", issueDate: "2026-08-12", publicationDate: "12 August 2026", body: "Issue", anchors: [{ label: "Story", url: "https://example.com/story" }] };
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, false)).not.toHaveProperty("response_format");
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, true)).toHaveProperty("response_format");
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, true)).toHaveProperty("max_completion_tokens", 3200);
  });
  it("materializes one source-bound card per distinct candidate without model help", () => {
    const anchors = [
      { label: "GitHub", url: "https://example.com/agent-plugins" },
      { label: "Evaluator", url: "https://example.com/grok-eval" },
      { label: "xAI", url: "https://example.com/grok-release" }
    ];
    const issue = {
      url: "https://news.smol.ai/issues/test",
      issueDate: "2026-08-12",
      publicationDate: "12 August 2026",
      body: `Tooling releases reflected that shift : GitHub Agent Plugins 1.0 brings Codex workflows to teams [GitHub](${anchors[0]!.url})\nFrontier Model Day : Grok 4.6 reaches the frontier on price and performance [Evaluator](${anchors[1]!.url})\nFrontier Model Day : Grok 4.6 reaches the frontier in a separate announcement [xAI](${anchors[2]!.url})`,
      anchors
    };
    const profile = { ...DEFAULT_PROFILE, storyBudget: 5 };
    const inventory = compactIssueInventory(issue, profile);
    const stories = materializeCandidateStories(inventory.candidates, profile, issue.publicationDate);
    expect(stories.signals).toHaveLength(2);
    expect(new Set(stories.signals.map((signal) => signal.url)).size).toBe(2);
    expect(stories.signals[0]).toMatchObject({ source: "GitHub", url: "https://example.com/agent-plugins" });
    expect(stories.signals[0]?.summary).toContain("GitHub Agent Plugins 1.0");
    expect(stories.hotTopics).toHaveLength(2);
  });
  it("asks the model for synthesis but not signal-card enumeration", () => {
    const issue = { url: "https://news.smol.ai/issues/test", issueDate: "2026-08-12", publicationDate: "12 August 2026", body: "Issue", anchors: [{ label: "Story", url: "https://example.com/story" }] };
    const prompt = editorialMessages(issue, DEFAULT_PROFILE).find((message) => message.role === "user")!.content;
    expect(prompt).toContain("collector—not you—will create Hot Topics and individual signal cards");
    expect(prompt).toContain("Do not return hotTopics or signals");
  });
});
