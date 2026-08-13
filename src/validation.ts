import type { Edition, Profile, Source } from "./contracts";

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
    if (permittedUrls && !permittedUrls.has(url)) throw new ValidationError(`${path}[${index}].url was not supplied by AInews`);
    return { label: text(source.label, `${path}[${index}].label`), url };
  });
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
    const common = { title: text(item.title, `${path}.title`), summary: text(item.summary, `${path}.summary`), category, base: integer(item.base, `${path}.base`, 0, 100), exceptional: flag(item, "exceptional", path), watchPermission: flag(item, "watchPermission", path), watchGeography: flag(item, "watchGeography", path) };
    if (isSignal) {
      const url = https(item.url, `${path}.url`);
      if (permittedUrls && !permittedUrls.has(url)) throw new ValidationError(`${path}.url was not supplied by AInews`);
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
    presentation: { hotTitle: text(presentation.hotTitle, "edition.presentation.hotTitle"), hotIntro: text(presentation.hotIntro, "edition.presentation.hotIntro"), allTitle: text(presentation.allTitle, "edition.presentation.allTitle"), allIntro: text(presentation.allIntro, "edition.presentation.allIntro"), synthesisTitle: text(presentation.synthesisTitle, "edition.presentation.synthesisTitle"), synthesisIntro: text(presentation.synthesisIntro, "edition.presentation.synthesisIntro"), sourceReadMinutes, briefReadMinutes },
    synthesis: { lead: text(synthesis.lead, "edition.synthesis.lead"), bigPicture: text(synthesis.bigPicture, "edition.synthesis.bigPicture"), sources: sources(synthesis.sources, "edition.synthesis.sources", permittedUrls), sections },
    hotTopics: hotTopics as Edition["hotTopics"],
    signals: signals as Edition["signals"]
  };
}

type SignalLike = Record<string, unknown>;
