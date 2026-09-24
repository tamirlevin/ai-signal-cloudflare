import type { CandidateMerge, CandidateStory, Edition, HotTopic, Profile, Signal, Source } from "./contracts";

export type StoryNormalization = {
  edition: Edition;
  duplicateSignalsRemoved: number;
  invalidCandidateSignalsRemoved: number;
  titlesRewritten: number;
  /** Every pre-publication merge/drop decision with its surviving target, in order. */
  merged: CandidateMerge[];
  /** Candidate ids rejected for missing candidates or sourceless candidates. */
  invalidCandidateIds: number[];
};

function normalizedText(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function conciseLead(summary: string, fallback: string): string {
  const colon = summary.match(/^(.{6,140}?):\s+/)?.[1];
  const sentence = summary.split(/[.!?](?:\s|$)/, 1)[0];
  const lead = (colon ?? sentence ?? fallback).trim() || fallback;
  return lead.split(/\s+/).slice(0, 12).join(" ").replace(/[,:;]+$/, "");
}

function repeatedTitleCounts(items: Array<{ title: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = normalizedText(item.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function storyKeys(item: { title: string; summary: string; url?: string; candidateId?: number }): string[] {
  const title = normalizedText(item.title);
  const lead = normalizedText(conciseLead(item.summary, item.title));
  const summary = normalizedText(item.summary);
  return [
    ...(item.candidateId === undefined ? [] : [`candidate:${item.candidateId}`]),
    ...(item.url ? [`url:${item.url}`] : []),
    ...(title.length >= 8 ? [`title:${title}`] : []),
    ...(lead.length >= 8 ? [`lead:${lead}`] : []),
    ...(summary.length >= 16 ? [`summary:${summary}`] : [])
  ];
}

function mergeSources(left: Source[], right: Source[]): Source[] {
  const result: Source[] = [];
  const seen = new Set<string>();
  for (const source of [...left, ...right]) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
    if (result.length === 6) break;
  }
  return result;
}

function deduplicateSignals(signals: Signal[]): { signals: Signal[]; removed: number; merged: CandidateMerge[] } {
  const result: Signal[] = [];
  const indexByKey = new Map<string, number>();
  const merged: CandidateMerge[] = [];
  let removed = 0;
  for (const signal of signals) {
    const keys = storyKeys(signal);
    const hit = keys.map((key) => ({ key, index: indexByKey.get(key) })).find((entry) => entry.index !== undefined);
    if (hit?.index === undefined) {
      const index = result.length;
      result.push(signal);
      for (const key of keys) indexByKey.set(key, index);
      continue;
    }
    removed += 1;
    const existing = result[hit.index];
    const kind = hit.key.startsWith("candidate:") ? "duplicate-candidate" : hit.key.startsWith("url:") ? "duplicate-url" : hit.key.startsWith("title:") ? "duplicate-title" : "duplicate-text";
    if (signal.candidateId !== undefined) merged.push({ id: signal.candidateId, intoId: existing?.candidateId ?? null, reason: kind as CandidateMerge["reason"], key: hit.key });
    if (existing && signal.base > existing.base) {
      result[hit.index] = signal;
      for (const key of keys) indexByKey.set(key, hit.index);
    }
  }
  return { signals: result, removed, merged };
}

function deduplicateHotTopics(topics: HotTopic[]): HotTopic[] {
  const result: HotTopic[] = [];
  const indexByKey = new Map<string, number>();
  for (const topic of topics) {
    const keys = storyKeys(topic);
    const duplicateIndex = keys.map((key) => indexByKey.get(key)).find((index) => index !== undefined);
    if (duplicateIndex === undefined) {
      const index = result.length;
      result.push(topic);
      for (const key of keys) indexByKey.set(key, index);
      continue;
    }
    const existing = result[duplicateIndex];
    if (!existing) continue;
    const preferred = topic.base > existing.base ? topic : existing;
    result[duplicateIndex] = { ...preferred, sources: mergeSources(existing.sources, topic.sources) };
  }
  return result;
}

export function normalizeEditionStories(generated: Edition, profile: Profile, candidates?: CandidateStory[]): StoryNormalization {
  if (!Array.isArray(generated.signals)) return { edition: generated, duplicateSignalsRemoved: 0, invalidCandidateSignalsRemoved: 0, titlesRewritten: 0, merged: [], invalidCandidateIds: [] };
  const candidateMap = candidates ? new Map(candidates.map((candidate) => [candidate.id, candidate])) : undefined;
  const titleCounts = repeatedTitleCounts(generated.signals);
  const categoryLabels = new Map(profile.weights.map((weight) => [weight.id, weight.label]));
  const preparedSignals: Signal[] = [];
  let invalidCandidateSignalsRemoved = 0;
  const invalidCandidateIds: number[] = [];
  let titlesRewritten = 0;

  for (const signal of generated.signals) {
    const repeatedTitle = (titleCounts.get(normalizedText(signal.title)) ?? 0) > 1;
    if (candidateMap) {
      const candidate = signal.candidateId === undefined ? undefined : candidateMap.get(signal.candidateId);
      if (!candidate?.sources.length) {
        invalidCandidateSignalsRemoved += 1;
        if (signal.candidateId !== undefined) invalidCandidateIds.push(signal.candidateId);
        continue;
      }
      const source = candidate.sources.find((item) => item.url === signal.url) ?? candidate.sources[0]!;
      if (signal.title !== candidate.title) titlesRewritten += 1;
      preparedSignals.push({ ...signal, title: candidate.title, url: source.url, source: source.label, categoryLabel: categoryLabels.get(signal.category) ?? signal.categoryLabel });
      continue;
    }
    const title = repeatedTitle ? conciseLead(signal.summary, signal.title) : signal.title;
    if (title !== signal.title) titlesRewritten += 1;
    preparedSignals.push({ ...signal, title });
  }

  const deduplicated = deduplicateSignals(preparedSignals);
  const topicTitleCounts = repeatedTitleCounts(Array.isArray(generated.hotTopics) ? generated.hotTopics : []);
  const preparedTopics = Array.isArray(generated.hotTopics) ? generated.hotTopics.map((topic) => {
    const title = (topicTitleCounts.get(normalizedText(topic.title)) ?? 0) > 1 ? conciseLead(topic.summary, topic.title) : topic.title;
    if (title !== topic.title) titlesRewritten += 1;
    return { ...topic, title };
  }) : generated.hotTopics;
  const signals = deduplicated.signals;
  const presentation = Number.isInteger(generated.presentation?.sourceReadMinutes) && Number.isInteger(generated.presentation?.briefReadMinutes)
    ? { ...generated.presentation, sourceReadMinutes: Math.max(generated.presentation.sourceReadMinutes, generated.presentation.briefReadMinutes) }
    : generated.presentation;
  return {
    edition: {
      ...generated,
      issue: { ...generated.issue, quiet: signals.length < profile.storyBudget ? true : generated.issue.quiet },
      presentation,
      hotTopics: Array.isArray(preparedTopics) ? deduplicateHotTopics(preparedTopics) : preparedTopics,
      signals
    },
    duplicateSignalsRemoved: deduplicated.removed,
    invalidCandidateSignalsRemoved,
    titlesRewritten,
    merged: deduplicated.merged,
    invalidCandidateIds
  };
}

/**
 * Selected candidate ids with no published card and no recorded merge/drop
 * decision. Any entry here is a silent loss: dedup merges and invalid
 * rejections are accounted in the normalization record, so leftovers mean a
 * story vanished between selection and publication.
 */
export function unaccountedCandidates(candidates: CandidateStory[], normalization: Pick<StoryNormalization, "edition" | "merged"> & Partial<Pick<StoryNormalization, "invalidCandidateIds">>): number[] {
  const published = new Set(normalization.edition.signals.map((signal) => signal.candidateId).filter((id): id is number => id !== undefined));
  const decided = new Set([...normalization.merged.map((entry) => entry.id), ...(normalization.invalidCandidateIds ?? [])]);
  return candidates.map((candidate) => candidate.id).filter((id) => !published.has(id) && !decided.has(id));
}
