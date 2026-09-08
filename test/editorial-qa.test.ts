import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE, type Edition, type RssIssue } from "../src/contracts";
import { editorialNoteWarnings, reviewEditorialEdition } from "../src/editorial-qa";

const research = { label: "When to Gate Recursive Terminal-task Synthesis", url: "https://arxiv.org/abs/2608.05466" };
const deckard = { label: "Deckard", url: "https://www.seangoedecke.com/deckard" };
const note = "(Note: source URL for candidate 1 not provided in allowed list; cannot include)";
const inventory: RssIssue = {
  url: "https://signal.tamirlevin.dev/?edition=2026-09-09", issueDate: "2026-09-09",
  publicationDate: "9 September 2026", publishedAt: "2026-09-08T22:15:00.000Z",
  body: `Candidate 1: ${research.label}. Researchers propose gating recursive terminal-task synthesis. Source: ${research.url}\nCandidate 2: Deckard detects AI text locally in a browser. Source: ${deckard.url}`,
  anchors: [research, deckard]
};
const permitted = new Set(inventory.anchors.map((source) => source.url));

function draft(): Edition {
  return {
    schemaVersion: 1,
    issue: { url: inventory.url, publicationDate: inventory.publicationDate, coverage: "Previous 72 hours", quiet: true },
    presentation: { hotTitle: "Priority developments", hotIntro: "The most relevant stories.", allTitle: "All signals", allIntro: "The complete qualified pool.", synthesisTitle: "Research and detection", synthesisIntro: "How agent research meets browser tools.", sourceReadMinutes: 6, briefReadMinutes: 3 },
    synthesis: {
      lead: "Research and browser tools address different aspects of AI output.",
      bigPicture: "Gating task synthesis and identifying generated text offer two practical ways of working with increasingly capable systems.",
      sources: [research, deckard],
      sections: [{ title: "Agent research and text detection", kicker: "Two approaches to managing AI output", body: "Researchers propose gating recursive terminal-task synthesis. Separately, Deckard flags AI text locally in the browser.", sources: [research, deckard] }]
    },
    hotTopics: [{ title: research.label, summary: "Researchers propose gating task synthesis.", category: "agents", base: 80, sources: [research] }],
    signals: [research, deckard].map((source, index) => ({ candidateId: index + 1, title: source.label, summary: "A source-bound development.", category: "agents", categoryLabel: "Agents in practice", base: 80, source: source.label, url: source.url, date: "8 September 2026" })),
    collection: { mode: "daily-pool", sourcesChecked: ["AlphaSignal", "TLDR AI"], sourcesContributing: ["AlphaSignal", "TLDR AI"], preferredFreshnessHours: 36, maxFreshnessHours: 72, eligibleCandidates: 2, selectedCandidates: 2 },
    profile: DEFAULT_PROFILE
  };
}

function response(edition: Edition, warnings: string[] = []) {
  return { response: { presentation: edition.presentation, synthesis: edition.synthesis, warnings } };
}

describe("one-pass editorial QA", () => {
  afterEach(() => vi.useRealTimers());

  it("corrects the exact leaked-note case and restores the story-matched research citation", async () => {
    const original = draft();
    original.synthesis.sections[0]!.title = note;
    original.synthesis.sections[0]!.sources = [deckard];
    const snapshot = structuredClone(original);
    const ask = vi.fn(async (_input: ChatCompletionsMessagesInput) => response(draft()));
    const result = await reviewEditorialEdition(original, inventory, DEFAULT_PROFILE, permitted, ask);
    expect(result.status).toBe("corrected");
    expect(result.edition.synthesis.sections[0]!.sources).toContainEqual(research);
    expect(editorialNoteWarnings(result.edition)).toEqual([]);
    expect(original).toEqual(snapshot);
    for (const key of ["signals", "hotTopics", "issue", "collection", "profile"] as const) expect(result.edition[key]).toBe(original[key]);
    expect(ask).toHaveBeenCalledTimes(1);
    const input = ask.mock.calls[0]![0];
    expect(JSON.stringify(input)).toContain("Internal editorial note detected");
    expect(JSON.stringify(input)).toContain(research.url);
  });

  it("keeps good copy and reports unfixable card concerns without removing stories", async () => {
    const original = draft();
    const result = await reviewEditorialEdition(original, inventory, DEFAULT_PROFILE, permitted, async () => response(original, ["Possible recruitment content in card 2; inspect the source parser."]));
    expect(result.status).toBe("passed");
    expect(result.edition).toEqual(original);
    expect(result.warnings).toHaveLength(1);
  });

  it("ignores attempted changes outside presentation and synthesis", async () => {
    const original = draft();
    const raw = response(original);
    const result = await reviewEditorialEdition(original, inventory, DEFAULT_PROFILE, permitted, async () => ({ response: { ...raw.response, signals: [], hotTopics: [], issue: { url: "https://evil.example" }, collection: null, profile: null } }));
    expect(result.status).toBe("passed");
    expect(result.edition).toEqual(original);
  });

  it.each(["unknown-url", "missing-url", "internal-note", "placeholder", "invalid-json", "provider-error", "bad-warnings"])("publishes the unchanged original after %s, without retry", async (failure) => {
    const original = draft();
    const changed = draft();
    const section = changed.synthesis.sections[0]!;
    if (failure === "unknown-url") section.sources = [{ label: "Invented", url: "https://example.com/not-in-inventory" }];
    if (failure === "missing-url") section.sources = [];
    if (failure === "internal-note") section.title = note;
    if (failure === "placeholder") changed.presentation.synthesisTitle = "TBD";
    const ask = vi.fn(async () => {
      if (failure === "provider-error") throw new Error("Provider unavailable");
      if (failure === "invalid-json") return { response: "{invalid" };
      if (failure === "bad-warnings") return { response: { presentation: changed.presentation, synthesis: changed.synthesis, warnings: "not an array" } };
      return response(changed);
    });
    const result = await reviewEditorialEdition(original, inventory, DEFAULT_PROFILE, permitted, ask);
    expect(result.status).toBe("fallback");
    expect(result.edition).toBe(original);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("stops waiting after 20 seconds, retaining the draft and its detected warning", async () => {
    vi.useFakeTimers();
    const original = draft();
    original.synthesis.sections[0]!.title = note;
    const ask = vi.fn(() => new Promise<unknown>(() => {}));
    const pending = reviewEditorialEdition(original, inventory, DEFAULT_PROFILE, permitted, ask);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(result.status).toBe("fallback");
    expect(result.edition).toBe(original);
    expect(result.warnings).toContain("Editorial QA timed out");
    expect(result.warnings).toContain("Internal editorial note detected in synthesis");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat ordinary editorial use of note or candidate as a leaked instruction", () => {
    const value = draft();
    value.synthesis.sections[0]!.title = "Researchers note a promising candidate";
    expect(editorialNoteWarnings(value)).toEqual([]);
  });
});
