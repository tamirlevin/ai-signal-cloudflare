import type { Edition, Profile, Source, StoryEvidence, StoryProvenance, StorySourceAttribution } from "./contracts";

const HTTPS = /^https:\/\/[^\s]+$/i;
const ID = /^[a-z][A-Za-z0-9]*$/;

export class ValidationError extends Error {}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new ValidationError(`${path} has an invalid length`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || /<\/?[a-z][^>]*>/i.test(value)) throw new ValidationError(`${path} must be non-empty plain text`);
  return value.trim();
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new ValidationError(`${path} must be an integer between ${min} and ${max}`);
  return value as number;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`${path} must be boolean`);
  return value;
}

function https(value: unknown, path: string): string {
  const url = text(value, path);
  if (!HTTPS.test(url)) throw new ValidationError(`${path} must be an absolute HTTPS URL`);
  try { new URL(url); } catch { throw new ValidationError(`${path} must be an absolute HTTPS URL`); }
  return url;
}

function sources(value: unknown, path: string, permittedUrls?: Set<string>): Source[] {
  return list(value, path, 1).map((raw, index) => {
    const source = object(raw, `${path}[${index}]`);
    const url = https(source.url, `${path}[${index}].url`);
    if (permittedUrls && !permittedUrls.has(url)) throw new ValidationError(`${path}[${index}].url was not supplied by the collector`);
    return { label: text(source.label, `${path}[${index}].label`), url };
  });
}

function storySource(value: unknown, path: string): StorySourceAttribution {
  const source = object(value, path);
  const id = text(source.id, `${path}.id`);
  if (!new Set(["ainews", "tldr-ai", "alphasignal", "cloudflare-agents"]).has(id)) throw new ValidationError(`${path}.id is not a recognized source`);
  const layer = text(source.layer, `${path}.layer`);
  if (layer !== "editorial" && layer !== "primary") throw new ValidationError(`${path}.layer is invalid`);
  return { id: id as StorySourceAttribution["id"], name: text(source.name, `${path}.name`), layer };
}

function storyProvenance(value: unknown, path: string, permittedUrls?: Set<string>): StoryProvenance {
  const provenance = object(value, path);
  const evidence = list(provenance.evidence, `${path}.evidence`, 1, 6).map((raw, index): StoryEvidence => {
    const item = object(raw, `${path}.evidence[${index}]`);
    const url = https(item.url, `${path}.evidence[${index}].url`);
    if (permittedUrls && !permittedUrls.has(url)) throw new ValidationError(`${path}.evidence[${index}].url was not supplied by the collector`);
    const kind = text(item.kind, `${path}.evidence[${index}].kind`);
    if (kind !== "direct" && kind !== "primary") throw new ValidationError(`${path}.evidence[${index}].kind is invalid`);
    return { label: text(item.label, `${path}.evidence[${index}].label`), url, kind };
  });
  const selection = object(provenance.selection, `${path}.selection`);
  const reason = text(selection.reason, `${path}.selection.reason`);
  if (!new Set(["ainews-base", "cross-source", "strong-fit-supplemental"]).has(reason)) throw new ValidationError(`${path}.selection.reason is invalid`);
  return {
    clusterId: text(provenance.clusterId, `${path}.clusterId`),
    lead: storySource(provenance.lead, `${path}.lead`),
    editorialCorroboration: list(provenance.editorialCorroboration, `${path}.editorialCorroboration`, 0, 3).map((raw, index) => {
      const source = storySource(raw, `${path}.editorialCorroboration[${index}]`);
      if (source.layer !== "editorial") throw new ValidationError(`${path}.editorialCorroboration[${index}] must be editorial`);
      return source;
    }),
    evidence,
    selection: { score: integer(selection.score, `${path}.selection.score`, 0, 999), reason: reason as StoryProvenance["selection"]["reason"] }
  };
}

function collectionMetadata(value: unknown): NonNullable<Edition["collection"]> {
  const collection = object(value, "edition.collection");
  const mode = text(collection.mode, "edition.collection.mode");
  if (mode !== "ainews-only" && mode !== "blended") throw new ValidationError("edition.collection.mode is invalid");
  if (text(collection.baseSource, "edition.collection.baseSource") !== "AInews") throw new ValidationError("edition.collection.baseSource must be AInews");
  const supplementalCap = integer(collection.supplementalCap, "edition.collection.supplementalCap", 0, 14);
  const selectedSupplemental = integer(collection.selectedSupplemental, "edition.collection.selectedSupplemental", 0, supplementalCap);
  return {
    mode,
    baseSource: "AInews",
    editorialDiscovery: list(collection.editorialDiscovery, "edition.collection.editorialDiscovery", 0, 4).map((item, index) => text(item, `edition.collection.editorialDiscovery[${index}]`)),
    primaryEvidenceFeeds: list(collection.primaryEvidenceFeeds, "edition.collection.primaryEvidenceFeeds", 0, 4).map((item, index) => text(item, `edition.collection.primaryEvidenceFeeds[${index}]`)),
    selectedSupplemental,
    supplementalCap
  };
}

function normalizedPhrase(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

const SYNTHESIS_STOP_WORDS = new Set([
  "about", "after", "also", "another", "are", "been", "being", "but", "for", "from", "has", "have", "into", "its", "more", "new", "not", "now", "over", "than", "that", "the", "their", "then", "there", "these", "they", "this", "through", "under", "was", "were", "which", "while", "with"
]);

function distinctiveWords(value: string): Set<string> {
  return new Set(normalizedPhrase(value).split(" ").filter((word) => word.length > 2 && !SYNTHESIS_STOP_WORDS.has(word)));
}

function overlapCoefficient(left: string, right: string): number {
  const leftWords = distinctiveWords(left);
  const rightWords = distinctiveWords(right);
  const denominator = Math.min(leftWords.size, rightWords.size);
  if (!denominator) return 0;
  let intersection = 0;
  for (const word of leftWords) if (rightWords.has(word)) intersection += 1;
  return intersection / denominator;
}

function repeatedPhrase(left: string, right: string, minimumWords: number, threshold: number): boolean {
  const normalizedLeft = normalizedPhrase(left);
  const normalizedRight = normalizedPhrase(right);
  if (normalizedLeft === normalizedRight) return true;
  const smallest = Math.min(distinctiveWords(left).size, distinctiveWords(right).size);
  return smallest >= minimumWords && overlapCoefficient(left, right) >= threshold;
}

function firstSentence(value: string): string {
  return value.split(/[.!?](?:\s|$)/, 1)[0]?.trim() ?? value.trim();
}

/** Keeps new view labels useful without making historical editions unreadable. */
export function validatePresentationDiversity(presentation: Edition["presentation"]): void {
  const fields: Array<[string, string]> = [
    ["hotTitle", presentation.hotTitle],
    ["hotIntro", presentation.hotIntro],
    ["allTitle", presentation.allTitle],
    ["allIntro", presentation.allIntro],
    ["synthesisTitle", presentation.synthesisTitle],
    ["synthesisIntro", presentation.synthesisIntro]
  ];
  for (const [field, value] of fields) {
    if (/^\(?(?:none|null|n\/a|not applicable|tbd)\)?$/i.test(value.trim())) {
      throw new ValidationError(`edition.presentation.${field} must not be a placeholder`);
    }
  }
  const viewTitles = [presentation.hotTitle, presentation.allTitle, presentation.synthesisTitle].map(normalizedPhrase);
  if (new Set(viewTitles).size !== viewTitles.length) throw new ValidationError("edition.presentation view titles must be distinct");
}

/** Prevents structurally valid model output from publishing the same synthesis angle repeatedly. */
export function validateSynthesisDiversity(synthesis: Edition["synthesis"]): void {
  if (repeatedPhrase(synthesis.lead, synthesis.bigPicture, 8, 0.82)) {
    throw new ValidationError("edition.synthesis.bigPicture repeats the synthesis lead");
  }
  const sections = synthesis.sections;
  for (let right = 1; right < sections.length; right += 1) {
    const current = sections[right]!;
    for (let left = 0; left < right; left += 1) {
      const previous = sections[left]!;
      if (repeatedPhrase(previous.title, current.title, 3, 0.8)) {
        throw new ValidationError(`edition.synthesis.sections[${right}].title repeats section ${left}`);
      }
      if (repeatedPhrase(previous.kicker, current.kicker, 4, 0.82)) {
        throw new ValidationError(`edition.synthesis.sections[${right}].kicker repeats section ${left}`);
      }
      if (repeatedPhrase(firstSentence(previous.body), firstSentence(current.body), 8, 0.86)) {
        throw new ValidationError(`edition.synthesis.sections[${right}].body repeats the opening of section ${left}`);
      }
      const previousUrls = new Set(previous.sources.map((source) => source.url));
      const currentUrls = new Set(current.sources.map((source) => source.url));
      if (previousUrls.size === currentUrls.size && [...previousUrls].every((url) => currentUrls.has(url))) {
        throw new ValidationError(`edition.synthesis.sections[${right}].sources repeat section ${left}`);
      }
    }
  }
}

export function synthesisNeedsRepair(edition: Edition): boolean {
  try {
    validatePresentationDiversity(edition.presentation);
    validateSynthesisDiversity(edition.synthesis);
    return false;
  } catch (error) {
    if (error instanceof ValidationError) return true;
    throw error;
  }
}

function flag(value: Record<string, unknown>, key: "exceptional" | "watchPermission" | "watchGeography", path: string): boolean | undefined {
  return value[key] === undefined ? undefined : bool(value[key], `${path}.${key}`);
}

export function validateProfile(raw: unknown, expectedVersion?: number): Profile {
  const profile = object(raw, "profile");
  const version = integer(profile.version, "profile.version", 1, 999999);
  if (expectedVersion !== undefined && version !== expectedVersion) throw new ValidationError("profile.version must be the next profile version");
  const range = list(profile.storyBudgetRange, "profile.storyBudgetRange", 2, 2);
  const low = integer(range[0], "profile.storyBudgetRange[0]", 5, 14);
  const high = integer(range[1], "profile.storyBudgetRange[1]", 5, 14);
  if (low > high) throw new ValidationError("profile.storyBudgetRange is reversed");
  const storyBudget = integer(profile.storyBudget, "profile.storyBudget", low, high);
  const safeguards = object(profile.safeguards, "profile.safeguards");
  const seen = new Set<string>();
  const weights = list(profile.weights, "profile.weights", 1).map((rawWeight, index) => {
    const weight = object(rawWeight, `profile.weights[${index}]`);
    const id = text(weight.id, `profile.weights[${index}].id`);
    if (!ID.test(id) || seen.has(id)) throw new ValidationError(`profile.weights[${index}].id is invalid or duplicated`);
    seen.add(id);
    return { id, label: text(weight.label, `profile.weights[${index}].label`), value: integer(weight.value, `profile.weights[${index}].value`, 0, 4) };
  });
  return {
    version,
    storyBudget,
    storyBudgetRange: [low, high],
    exceptionalStoryOverride: bool(profile.exceptionalStoryOverride, "profile.exceptionalStoryOverride"),
    safeguards: { watchPermissions: bool(safeguards.watchPermissions, "profile.safeguards.watchPermissions"), watchGeography: bool(safeguards.watchGeography, "profile.safeguards.watchGeography") },
    weights,
    pinnedCategories: list(profile.pinnedCategories, "profile.pinnedCategories").map((item, index) => text(item, `profile.pinnedCategories[${index}]`)),
    watching: list(profile.watching, "profile.watching").map((item, index) => text(item, `profile.watching[${index}]`))
  };
}

export function validateEdition(raw: unknown, profile: Profile, permittedUrls?: Set<string>): Edition {
  const edition = object(raw, "edition");
  if (edition.schemaVersion !== 1) throw new ValidationError("edition.schemaVersion must equal 1");
  const issue = object(edition.issue, "edition.issue");
  const issueUrl = https(issue.url, "edition.issue.url");
  const presentation = object(edition.presentation, "edition.presentation");
  const sourceReadMinutes = integer(presentation.sourceReadMinutes, "edition.presentation.sourceReadMinutes", 1, 999);
  const briefReadMinutes = integer(presentation.briefReadMinutes, "edition.presentation.briefReadMinutes", 1, sourceReadMinutes);
  const presentationCopy = {
    hotTitle: text(presentation.hotTitle, "edition.presentation.hotTitle"),
    hotIntro: text(presentation.hotIntro, "edition.presentation.hotIntro"),
    allTitle: text(presentation.allTitle, "edition.presentation.allTitle"),
    allIntro: text(presentation.allIntro, "edition.presentation.allIntro"),
    synthesisTitle: text(presentation.synthesisTitle, "edition.presentation.synthesisTitle"),
    synthesisIntro: text(presentation.synthesisIntro, "edition.presentation.synthesisIntro"),
    sourceReadMinutes,
    briefReadMinutes
  };
  const categoryIds = new Set(profile.weights.map((weight) => weight.id));
  const synthesis = object(edition.synthesis, "edition.synthesis");
  const sections = list(synthesis.sections, "edition.synthesis.sections", 2, 4).map((rawSection, index) => {
    const section = object(rawSection, `edition.synthesis.sections[${index}]`);
    return { title: text(section.title, `edition.synthesis.sections[${index}].title`), kicker: text(section.kicker, `edition.synthesis.sections[${index}].kicker`), body: text(section.body, `edition.synthesis.sections[${index}].body`), sources: sources(section.sources, `edition.synthesis.sections[${index}].sources`, permittedUrls) };
  });
  const ranked = (rawItem: unknown, path: string, isSignal: boolean): SignalLike => {
    const item = object(rawItem, path);
    const category = text(item.category, `${path}.category`);
    if (!categoryIds.has(category)) throw new ValidationError(`${path}.category is not in the active profile`);
    const common = { title: text(item.title, `${path}.title`), summary: text(item.summary, `${path}.summary`), category, base: integer(item.base, `${path}.base`, 0, 100), exceptional: flag(item, "exceptional", path), watchPermission: flag(item, "watchPermission", path), watchGeography: flag(item, "watchGeography", path), ...(item.provenance === undefined ? {} : { provenance: storyProvenance(item.provenance, `${path}.provenance`, permittedUrls) }) };
    if (isSignal) {
      const url = https(item.url, `${path}.url`);
      if (permittedUrls && !permittedUrls.has(url)) throw new ValidationError(`${path}.url was not supplied by the collector`);
      return { ...common, ...(item.candidateId === undefined ? {} : { candidateId: integer(item.candidateId, `${path}.candidateId`, 1, 999) }), source: text(item.source, `${path}.source`), ...(item.date === undefined ? {} : { date: text(item.date, `${path}.date`) }), url, categoryLabel: text(item.categoryLabel, `${path}.categoryLabel`) };
    }
    return { ...common, sources: sources(item.sources, `${path}.sources`, permittedUrls) };
  };
  const hotTopics = list(edition.hotTopics, "edition.hotTopics", 1, 5).map((item, index) => ranked(item, `edition.hotTopics[${index}]`, false));
  const signals = list(edition.signals, "edition.signals", 1, 14).map((item, index) => ranked(item, `edition.signals[${index}]`, true));
  const seen = new Set<string>();
  for (const signal of signals) {
    const item = signal as { title: string; url: string };
    const key = item.url;
    if (seen.has(key)) throw new ValidationError("edition.signals contains a duplicate story URL");
    seen.add(key);
  }
  const quiet = bool(issue.quiet, "edition.issue.quiet");
  if (!quiet && signals.length < profile.storyBudget) throw new ValidationError("edition.signals is below storyBudget for a non-quiet issue");
  return {
    schemaVersion: 1,
    issue: { publicationDate: text(issue.publicationDate, "edition.issue.publicationDate"), coverage: text(issue.coverage, "edition.issue.coverage"), url: issueUrl, quiet },
    ...(edition.collection === undefined ? {} : { collection: collectionMetadata(edition.collection) }),
    presentation: presentationCopy,
    synthesis: { lead: text(synthesis.lead, "edition.synthesis.lead"), bigPicture: text(synthesis.bigPicture, "edition.synthesis.bigPicture"), sources: sources(synthesis.sources, "edition.synthesis.sources", permittedUrls), sections },
    hotTopics: hotTopics as Edition["hotTopics"],
    signals: signals as Edition["signals"]
  };
}

type SignalLike = Record<string, unknown>;
