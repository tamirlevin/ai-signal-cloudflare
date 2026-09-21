import type { Profile, ShadowCandidate } from "./contracts";

export const TRIAGE_RERANKER_MODEL = "@cf/baai/bge-reranker-base";
export const TRIAGE_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const MAX_TRIAGE_TEXTS = 32;
const MAX_TRIAGE_CHARS = 600;

export type TriageScores = { relevance: number | null; novelty: number | null };

type AiRunner = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

export function triageShadowEnabled(env: Env): boolean {
  return env.TRIAGE_SHADOW_ENABLED === "true";
}

/** The profile as a retrieval query: top interests first, kept short because
 *  reranker discrimination degrades with long queries. Watching topics stay. */
export function buildProfileQuery(profile: Profile): string {
  const interests = [...profile.weights]
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .filter((weight) => weight.value > 0)
    .slice(0, 4)
    .map((weight) => weight.label)
    .join("; ");
  const watching = [...profile.pinnedCategories, ...profile.watching].join("; ");
  return `${interests}. Watching: ${watching}.`;
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
 * signal. Min-max normalize one run's raw scores into [0,1]; a pool with no
 * spread carries no information and normalizes to 0.5.
 */
export function normalizeScores(raw: Array<number | null>): Array<number | null> {
  const present = raw.filter((value): value is number => value !== null);
  if (!present.length) return raw.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max === min) return raw.map((value) => (value === null ? null : 0.5));
  return raw.map((value) => (value === null ? null : Math.round(((value - min) / (max - min)) * 1000) / 1000));
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

/**
 * Advisory relevance + novelty scores for the selected shortlist. One reranker
 * call and one embedding call for the whole pool; any failure yields no scores
 * rather than failing the run. Never gates selection or publication.
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
    const query = buildProfileQuery(profile);
    const contexts = selected.map((item) => ({ text: triageText(item.title, item.summary) }));
    const ranked = await ai.run(TRIAGE_RERANKER_MODEL, { query, contexts });
    const response = record(ranked) && Array.isArray(ranked.response) ? ranked.response : [];
    const raw = new Map<number, number | null>();
    for (const entry of response) {
      if (!record(entry) || typeof entry.id !== "number") continue;
      raw.set(entry.id, rawScore(entry.score));
    }
    const normalized = normalizeScores(selected.map((_, index) => raw.get(index) ?? null));
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
        if (maxSimilarity >= 0) novelty = Math.round((1 - maxSimilarity) * 1000) / 1000;
      }
      scores.set(item.url, { relevance: normalized[index] ?? null, novelty });
    });
  } catch (error) {
    console.warn(JSON.stringify({ message: "ai-signal triage shadow scoring skipped", error: error instanceof Error ? error.message : String(error) }));
  }
  return scores;
}

/** Attaches advisory triage scores to a report's selected items. No-op unless enabled. */
export function attachTriageScores(
  report: { wouldAdd: ShadowCandidate[]; selectedForBlend?: ShadowCandidate[] },
  scores: Map<string, TriageScores>
): void {
  if (!scores.size) return;
  for (const item of [...report.wouldAdd, ...(report.selectedForBlend ?? [])]) {
    const triage = scores.get(item.url);
    if (triage) item.triage = triage;
  }
}
