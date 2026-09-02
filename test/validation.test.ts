import { describe, expect, it } from "vitest";
import type { CandidateStory, Edition } from "../src/contracts";
import { DEFAULT_PROFILE } from "../src/contracts";
import { anchorsToMarkdown, parseLatestRss } from "../src/rss";
import { validateEdition, validatePresentationDiversity, validateSynthesisDiversity, ValidationError } from "../src/validation";
import { compactIssueForModel, compactIssueInventory, deterministicEditorialEdition, editorialMessages, extractGeneratedEdition, generationInput, isPermissionDesignSignal, issueFromCandidateInventory, materializeCandidateStories } from "../src/editorial";
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
  it("distinguishes permission design from a generic mention of approvals", () => {
    expect(isPermissionDesignSignal("Practical gains are coming from harness engineering, memory, approvals, evals, and tools.")).toBe(false);
    expect(isPermissionDesignSignal("The agent requires human approval before executing a shell command.")).toBe(true);
    expect(isPermissionDesignSignal("The release adds explicit tool permission scopes and revocation controls.")).toBe(true);
  });
  it("rejects a generated source that the collector did not supply", () => {
    expect(() => validateEdition(edition(), DEFAULT_PROFILE, new Set(["https://example.com/other"]))).toThrow(ValidationError);
  });
  it("validates and retains blended collection provenance", () => {
    const value = edition();
    value.collection = { mode: "blended", baseSource: "AInews", editorialDiscovery: ["AlphaSignal", "TLDR AI"], primaryEvidenceFeeds: ["Cloudflare Agents"], selectedSupplemental: 1, supplementalCap: 2 };
    value.signals[0]!.provenance = {
      clusterId: "story-example",
      lead: { id: "alphasignal", name: "AlphaSignal", layer: "editorial" },
      editorialCorroboration: [{ id: "ainews", name: "AInews", layer: "editorial" }],
      evidence: [{ label: "Official", url: "https://example.com/story", kind: "primary" }],
      selection: { score: 84, reason: "cross-source" }
    };
    const validated = validateEdition(value, DEFAULT_PROFILE, new Set(["https://example.com/story"]));
    expect(validated.collection).toEqual(value.collection);
    expect(validated.signals[0]?.provenance).toEqual(value.signals[0]?.provenance);
  });
  it("validates the equal-source daily collection contract", () => {
    const value = edition();
    value.collection = {
      mode: "daily-pool",
      sourcesChecked: ["AInews", "TLDR AI", "AlphaSignal", "Cloudflare Agents"],
      sourcesContributing: ["AlphaSignal"],
      preferredFreshnessHours: 36,
      maxFreshnessHours: 48,
      eligibleCandidates: 5,
      selectedCandidates: 5,
      sourcePackId: "core-ai",
      sourcePackVersion: 2
    };
    expect(validateEdition(value, DEFAULT_PROFILE).collection).toEqual(value.collection);
  });
  it("validates source-pack identity and collector-derived coverage metadata", () => {
    const value = edition();
    value.collection = { mode: "blended", baseSource: "AInews", editorialDiscovery: ["AlphaSignal", "TLDR AI"], primaryEvidenceFeeds: ["Cloudflare Agents"], selectedSupplemental: 1, supplementalCap: 2, sourcePackId: "core-ai", sourcePackVersion: 1 };
    value.signals[0]!.provenance = {
      clusterId: "story-example",
      lead: { id: "alphasignal", name: "AlphaSignal", layer: "editorial" },
      editorialCorroboration: [{ id: "ainews", name: "AInews", layer: "editorial" }, { id: "tldr-ai", name: "TLDR AI", layer: "editorial" }],
      evidence: [{ label: "Official", url: "https://example.com/story", kind: "primary" }],
      coverage: { editorialSourceIds: ["alphasignal", "ainews", "tldr-ai"], editorialSourceCount: 3, primaryEvidenceCount: 1, boost: 8 },
      selection: { score: 92, reason: "cross-source" }
    };
    const validated = validateEdition(value, DEFAULT_PROFILE, new Set(["https://example.com/story"]));
    expect(validated.collection?.sourcePackId).toBe("core-ai");
    expect(validated.signals[0]?.provenance?.coverage).toEqual(value.signals[0]?.provenance?.coverage);
  });
  it("rejects coverage metadata that disagrees with provenance", () => {
    const value = edition();
    value.signals[0]!.provenance = {
      clusterId: "story-example",
      lead: { id: "alphasignal", name: "AlphaSignal", layer: "editorial" },
      editorialCorroboration: [{ id: "ainews", name: "AInews", layer: "editorial" }],
      evidence: [{ label: "Official", url: "https://example.com/story", kind: "primary" }],
      coverage: { editorialSourceIds: ["alphasignal"], editorialSourceCount: 1, primaryEvidenceCount: 0, boost: 0 },
      selection: { score: 84, reason: "cross-source" }
    };
    expect(() => validateEdition(value, DEFAULT_PROFILE, new Set(["https://example.com/story"]))).toThrow(/coverage\.editorialSourceIds does not match provenance sources/);
  });
  it("rejects a primary evidence count that disagrees with provenance", () => {
    const value = edition();
    value.signals[0]!.provenance = {
      clusterId: "story-example",
      lead: { id: "alphasignal", name: "AlphaSignal", layer: "editorial" },
      editorialCorroboration: [{ id: "ainews", name: "AInews", layer: "editorial" }],
      evidence: [{ label: "Official", url: "https://example.com/story", kind: "primary" }],
      coverage: { editorialSourceIds: ["alphasignal", "ainews"], editorialSourceCount: 2, primaryEvidenceCount: 0, boost: 4 },
      selection: { score: 84, reason: "cross-source" }
    };
    expect(() => validateEdition(value, DEFAULT_PROFILE, new Set(["https://example.com/story"]))).toThrow(/coverage\.primaryEvidenceCount does not match provenance evidence/);
  });
  it("rejects repeated underlying story URLs", () => {
    const value = edition();
    value.signals.push({ title: "Different framing", summary: "Summary", source: "Source", url: "https://example.com/story", category: "agents", categoryLabel: "Agents in practice", base: 80 });
    expect(() => validateEdition(value, DEFAULT_PROFILE, new Set(["https://example.com/story"]))).toThrow("duplicate story URL");
  });
  it("rejects repeated synthesis framing even when the underlying sources differ", () => {
    const value = edition();
    value.synthesis.sections[0] = { title: "Harnesses and long-running autonomy", kicker: "Harnesses and long-running autonomy", body: "Cursor made cloud agents more resilient for long-running work.", sources: [{ label: "Cursor", url: "https://example.com/cursor" }] };
    value.synthesis.sections[1] = { title: "Harnesses and long-running autonomy", kicker: "Harnesses and long-running autonomy", body: "DeepSeek released a composable harness for autonomous systems.", sources: [{ label: "DeepSeek", url: "https://example.com/deepseek" }] };
    expect(() => validateSynthesisDiversity(value.synthesis)).toThrow("title repeats section 0");
  });
  it("rejects synthesis sections that repeat the same source cluster", () => {
    const value = edition();
    value.synthesis.sections[0] = { title: "Cloud agents get sturdier", kicker: "Cursor focuses on recovery", body: "Cursor made cloud agents more resilient for long-running work.", sources: [{ label: "Cursor", url: "https://example.com/cursor" }] };
    value.synthesis.sections[1] = { title: "Managed runtimes mature", kicker: "Schedulers become product surfaces", body: "Managed runtimes are exposing schedules and memory as governed controls.", sources: [{ label: "Cursor", url: "https://example.com/cursor" }] };
    expect(() => validateSynthesisDiversity(value.synthesis)).toThrow("sources repeat section 0");
  });
  it("rejects a big picture that simply repeats the synthesis lead", () => {
    const value = edition();
    value.synthesis.lead = "Agent runtimes are becoming governed product surfaces with explicit memory schedules permissions and recovery controls.";
    value.synthesis.bigPicture = value.synthesis.lead;
    expect(() => validateSynthesisDiversity(value.synthesis)).toThrow("bigPicture repeats the synthesis lead");
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
  it("reads Workers AI Responses output text", () => {
    const value = edition();
    expect(extractGeneratedEdition({ output_text: JSON.stringify(value), status: "completed" }).issue.url).toBe(value.issue.url);
  });
  it("reports safe completion diagnostics when a reasoning model emits no final text", () => {
    expect(() => extractGeneratedEdition({
      choices: [{ finish_reason: "length", message: { content: null } }],
      usage: { completion_tokens: 3200, completion_tokens_details: { reasoning_tokens: 3198 } }
    })).toThrow(/finish_reason=length; content=null; completion_tokens=3200; reasoning_tokens=3198/);
  });
  it("compacts a large issue into a broad profile-aware candidate inventory", () => {
    const anchors = Array.from({ length: 60 }, (_, index) => ({ label: `Story ${index}`, url: `https://example.com/story-${index}` }));
    const body = anchors.map((source, index) => `${index === 59 ? "Codex agent harness permissions and practical workflow" : index % 2 ? "Routine infrastructure and training update" : "A newly released integration platform"} [${source.label}](${source.url}) ${"detail ".repeat(80)}`).join("\n");
    const issue = { url: "https://news.smol.ai/issues/test", issueDate: "2026-08-12", publicationDate: "12 August 2026", publishedAt: "2026-08-12T00:00:00.000Z", body, anchors };
    const compact = compactIssueForModel(issue, DEFAULT_PROFILE);
    expect(compact.body.length).toBeLessThan(issue.body.length);
    expect(compact.anchors.length).toBeLessThanOrEqual(24);
    expect(compact.anchors.some((source) => source.url.endsWith("story-59"))).toBe(true);
    expect(compact.body).toContain("Candidate 1");
    expect(compact.body.split("\n", 3).join(" ")).toContain("Codex agent harness permissions");
  });
  it("uses model-specific token budgets and structured output", () => {
    const issue = { url: "https://news.smol.ai/issues/test", issueDate: "2026-08-12", publicationDate: "12 August 2026", publishedAt: "2026-08-12T00:00:00.000Z", body: "Issue", anchors: [{ label: "Story", url: "https://example.com/story" }] };
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, false)).not.toHaveProperty("response_format");
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, false)).toHaveProperty("reasoning_effort", "low");
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, true)).toHaveProperty("response_format");
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, true)).toHaveProperty("max_completion_tokens", 6000);
    expect(generationInput(issue, DEFAULT_PROFILE, undefined, true, "@cf/openai/gpt-oss-120b")).not.toHaveProperty("chat_template_kwargs");
    const llama = generationInput(issue, DEFAULT_PROFILE, undefined, true, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(llama).toHaveProperty("response_format");
    expect(llama).toHaveProperty("max_tokens", 3200);
    expect(llama).not.toHaveProperty("max_completion_tokens");
    expect(llama).not.toHaveProperty("reasoning_effort");
  });
  it("builds valid, source-bound deterministic framing across distinct categories", () => {
    const issue = { url: "https://signal.tamirlevin.dev/?edition=2026-08-12", issueDate: "2026-08-12", publicationDate: "12 August 2026", publishedAt: "2026-08-12T00:00:00.000Z", body: "", anchors: [] };
    const candidates: CandidateStory[] = [
      { id: 1, title: "Agents gain scoped permissions", summary: "A new agent runtime introduces scoped permission controls.", category: "agents", categoryLabel: "Agents in practice", score: 90, exceptional: false, watchPermission: true, watchGeography: false, sources: [{ label: "Agent source", url: "https://example.com/agents" }] },
      { id: 2, title: "AI pricing shifts", summary: "A provider changes enterprise pricing for production workloads.", category: "business", categoryLabel: "AI business & economics", score: 80, exceptional: false, watchPermission: false, watchGeography: false, sources: [{ label: "Business source", url: "https://example.com/business" }] },
      { id: 3, title: "Platforms add connectors", summary: "A platform releases new connectors for tool-using systems.", category: "integration", categoryLabel: "Integration & platforms", score: 70, exceptional: false, watchPermission: false, watchGeography: false, sources: [{ label: "Platform source", url: "https://example.com/platform" }] }
    ];
    const generated = deterministicEditorialEdition(issue, candidates, DEFAULT_PROFILE);
    const permitted = new Set(candidates.flatMap((candidate) => candidate.sources.map((source) => source.url)));
    const validated = validateEdition(generated, DEFAULT_PROFILE, permitted);
    expect(() => validatePresentationDiversity(validated.presentation)).not.toThrow();
    expect(() => validateSynthesisDiversity(validated.synthesis)).not.toThrow();
    expect(validated.synthesis.sections).toHaveLength(3);
    expect(new Set(validated.synthesis.sections.flatMap((section) => section.sources.map((source) => source.url))).size).toBe(3);
  });
  it("rejects placeholder presentation copy", () => {
    const value = edition();
    value.presentation.synthesisTitle = "(none)";
    expect(() => validatePresentationDiversity(value.presentation)).toThrow("must not be a placeholder");
  });
  it("rejects duplicate view titles", () => {
    const value = edition();
    value.presentation.hotTitle = value.presentation.synthesisTitle;
    expect(() => validatePresentationDiversity(value.presentation)).toThrow("view titles must be distinct");
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
      publishedAt: "2026-08-12T00:00:00.000Z",
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
    const issue = { url: "https://news.smol.ai/issues/test", issueDate: "2026-08-12", publicationDate: "12 August 2026", publishedAt: "2026-08-12T00:00:00.000Z", body: "Issue", anchors: [{ label: "Story", url: "https://example.com/story" }] };
    const prompt = editorialMessages(issue, DEFAULT_PROFILE).find((message) => message.role === "user")!.content;
    expect(prompt).toContain("collector—not you—will create Hot Topics and individual signal cards");
    expect(prompt).toContain("Do not return hotTopics or signals");
    expect(prompt).toContain("return that number rather than padding");
    expect(prompt).toContain("Every section must have a unique concrete title");
    expect(prompt).toContain("Do not describe agreement between newsletters as verification or proof");
  });
  it("labels editorial corroboration as discovery context in model input", () => {
    const issue = { url: "https://news.smol.ai/issues/test", issueDate: "2026-08-12", publicationDate: "12 August 2026", publishedAt: "2026-08-12T00:00:00.000Z", body: "Issue", anchors: [] };
    const modelIssue = issueFromCandidateInventory(issue, [{
      id: 1,
      title: "Codex agent runtime",
      summary: "A new governed runtime.",
      category: "codex",
      categoryLabel: "Codex & agent craft",
      score: 20,
      exceptional: false,
      watchPermission: true,
      watchGeography: false,
      sources: [{ label: "OpenAI", url: "https://openai.com/codex" }],
      provenance: {
        clusterId: "story-codex",
        lead: { id: "tldr-ai", name: "TLDR AI", layer: "editorial" },
        editorialCorroboration: [{ id: "ainews", name: "AInews", layer: "editorial" }],
        evidence: [{ label: "OpenAI", url: "https://openai.com/codex", kind: "primary" }],
        selection: { score: 90, reason: "cross-source" }
      }
    }]);
    expect(modelIssue.body).toContain("Editorial corroboration (discovery context, not proof): AInews");
    expect(modelIssue.body).toContain("Evidence links: primary: OpenAI");
  });
});
