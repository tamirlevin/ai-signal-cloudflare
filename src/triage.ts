import type { Profile, ShadowCandidate, TriageScoredItem } from "./contracts";

export const TRIAGE_RERANKER_MODEL = "@cf/baai/bge-reranker-base";
export const TRIAGE_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const MAX_TRIAGE_TEXTS = 128;
const MAX_TRIAGE_CHARS = 600;

export type TriageScores = { relevance: number | null; raw: number | null; novelty: number | null; winningInterest: string | null };

type AiRunner = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

export function triageShadowEnabled(env: Env): boolean {
  return env.TRIAGE_SHADOW_ENABLED === "true";
}

export type ProfileInterest = { label: string; weight: number; query: string };

/**
 * One short retrieval query per positive-weight interest, so equal weights are
 * never silently dropped and each interest is measured on its own. Watching
 * topics run as their own weight-1 queries instead of an identical tail on
 * every interest, which previously collapsed per-interest discrimination.
 * Weights gate which queries run; they never scale scores.
 */
export function buildProfileQueries(profile: Profile): ProfileInterest[] {
  const interests = [...profile.weights]
    .filter((weight) => weight.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .map((weight) => ({ label: weight.label, weight: weight.value, query: `${weight.label}.` }));
  const topics = [...new Set([...profile.pinnedCategories, ...profile.watching])].sort((left, right) => left.localeCompare(right));
  return [...interests, ...topics.map((topic) => ({ label: `Watching: ${topic}`, weight: 1, query: `${topic}.` }))];
}

export function triageText(title: string, summary: string): string {
  return `${title} — ${summary}`.slice(0, MAX_TRIAGE_CHARS);
}

function rawScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/**
 * The reranker compresses absolute scores near zero, so only ordering carries
 * signal. Min-max normalize one run's raw scores into [0,1] at full precision;
 * a pool with no spread carries no information and normalizes to 0.5.
 */
export function normalizeScores(raw: Array<number | null>): Array<number | null> {
  const present = raw.filter((value): value is number => value !== null);
  if (!present.length) return raw.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max === min) return raw.map((value) => (value === null ? null : 0.5));
  return raw.map((value) => (value === null ? null : (value - min) / (max - min)));
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseScores(raw: unknown): Map<number, number | null> {
  const scores = new Map<number, number | null>();
  const response = record(raw) && Array.isArray(raw.response) ? raw.response : [];
  for (const entry of response) {
    if (!record(entry) || typeof entry.id !== "number") continue;
    scores.set(entry.id, rawScore(entry.score));
  }
  return scores;
}

/**
 * Advisory relevance + novelty scores over the full fresh pool, including rows
 * the keyword gates rejected. One reranker call per profile interest plus one
 * embedding call; any failure yields no scores rather than failing the run.
 * Relevance means relevant to any interest: the combined raw is the max over
 * per-interest scores at full precision, with the winning query recorded so
 * the log shows which interests actually fire. Never gates selection or
 * publication.
 */
export async function scoreTriage(
  ai: AiRunner,
  profile: Profile,
  items: Array<Pick<ShadowCandidate, "url" | "title" | "summary">>,
  priorTexts: string[]
): Promise<Map<string, TriageScores>> {
  const scores = new Map<string, TriageScores>();
  const selected = items.slice(0, MAX_TRIAGE_TEXTS);
  if (!selected.length) return scores;
  try {
    const interests = buildProfileQueries(profile);
    const contexts = selected.map((item) => ({ text: triageText(item.title, item.summary) }));
    const perInterest = await Promise.all(interests.map((interest) =>
      ai.run(TRIAGE_RERANKER_MODEL, { query: interest.query, contexts }).then(responseScores)
    ));
    const combined = selected.map((_, index) => {
      let best: number | null = null;
      let winner: string | null = null;
      perInterest.forEach((response, interestIndex) => {
        const value = response.get(index);
        if (value === null || value === undefined) return;
        if (best === null || value > best) {
          best = value;
          winner = interests[interestIndex]!.label;
        }
      });
      return { raw: best, winner };
    });
    const raws = combined.map((entry) => entry.raw);
    const normalized = normalizeScores(raws);
    const texts = selected.map((item) => triageText(item.title, item.summary));
    const prior = priorTexts.slice(0, MAX_TRIAGE_TEXTS).map((text) => text.slice(0, MAX_TRIAGE_CHARS));
    const embedded = await ai.run(TRIAGE_EMBEDDING_MODEL, { text: [...texts, ...prior] });
    const rows = record(embedded) && Array.isArray(embedded.data)
      ? embedded.data.filter((row): row is number[] => Array.isArray(row))
      : [];
    const vectors = rows.slice(0, texts.length);
    const priorVectors = rows.slice(texts.length, texts.length + prior.length);
    selected.forEach((item, index) => {
      const vector = vectors[index];
      let novelty: number | null = null;
      if (vector) {
        let maxSimilarity = -1;
        for (let other = 0; other < vectors.length; other += 1) {
          if (other === index || !vectors[other]) continue;
          maxSimilarity = Math.max(maxSimilarity, cosine(vector, vectors[other]!));
        }
        for (const previous of priorVectors) maxSimilarity = Math.max(maxSimilarity, cosine(vector, previous));
        if (maxSimilarity >= 0) novelty = 1 - maxSimilarity;
      }
      scores.set(item.url, { relevance: normalized[index] ?? null, raw: raws[index] ?? null, winningInterest: combined[index]!.winner, novelty });
    });
  } catch (error) {
    console.warn(JSON.stringify({ message: "ai-signal triage shadow scoring skipped", error: error instanceof Error ? error.message : String(error) }));
  }
  return scores;
}

/**
 * Dense ranks by relevance within one run (1 = best; unscored rank null),
 * joined with funnel outcomes for the experiment log.
 */
export function rankTriageScores(items: Array<{
  url: string; title: string; relevance: number | null; rawRelevance: number | null; novelty: number | null;
  winningInterest: string | null;
  outcome: TriageScoredItem["outcome"]; sourceIds: TriageScoredItem["sourceIds"];
}>): TriageScoredItem[] {
  const ordered = [...items].sort((left, right) => (right.relevance ?? -1) - (left.relevance ?? -1));
  let rank = 0;
  let previous: number | null = null;
  const ranks = new Map<string, number | null>();
  for (const item of ordered) {
    if (item.relevance === null) {
      ranks.set(item.url, null);
      continue;
    }
    if (previous === null || item.relevance !== previous) {
      rank += 1;
      previous = item.relevance;
    }
    ranks.set(item.url, rank);
  }
  return items.map((item) => ({
    url: item.url,
    title: item.title,
    relevance: item.relevance,
    rawRelevance: item.rawRelevance,
    winningInterest: item.winningInterest,
    rank: ranks.get(item.url) ?? null,
    novelty: item.novelty,
    outcome: item.outcome,
    sourceIds: item.sourceIds
  }));
}

/** Attaches advisory triage summaries to a report's selected items. No-op unless scored. */
export function attachTriageScores(
  report: { wouldAdd: ShadowCandidate[]; selectedForBlend?: ShadowCandidate[] },
  scores: Map<string, TriageScores>
): void {
  if (!scores.size) return;
  for (const item of [...report.wouldAdd, ...(report.selectedForBlend ?? [])]) {
    const triage = scores.get(item.url);
    if (triage) item.triage = { relevance: triage.relevance, novelty: triage.novelty };
  }
}
