import type { Profile } from "./contracts";

/**
 * Thin client for TypeSafe's Jev structured-evaluation model on Workers AI.
 * Phase 1 is schema discovery only: one call shape in, raw answers out.
 * The shadow-judge comparison (Phase 3) builds on this module.
 */
export const JEV_MODEL = "typesafe/jev";
export const JEV_DIRECT_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DIRECT_MODEL = "jev-latest";
/** Bump when the meaning, criteria, or intended use of any Jev question changes. */
export const JEV_QUESTION_SET_VERSION = "reader-want-v1";

export type JevQuestionType = "noul" | "choice" | "score";

export type JevQuestion = {
  type: JevQuestionType;
  instructions: string | Record<string, unknown> | unknown[];
  criteria?: Record<string, string> | string[];
};

export type JevProbeInput = {
  state: unknown;
  questions: Record<string, JevQuestion>;
};

type AiRunner = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

export async function runJev(ai: AiRunner, input: JevProbeInput): Promise<unknown> {
  return ai.run(JEV_MODEL, input as Record<string, unknown>);
}

/**
 * Direct TypeSafe API call for the staging probe. The Workers AI route needs
 * separate Cloudflare-side third-party billing; the direct route uses the
 * TYPESAFE_API_KEY secret instead. Throws on non-2xx with status + body.
 */
export async function runJevDirect(input: JevProbeInput, apiKey: string): Promise<unknown> {
  const response = await fetch(JEV_DIRECT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: input.state, model: JEV_DIRECT_MODEL, questions: input.questions })
  });
  if (!response.ok) throw new Error(`Jev direct API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

export const MAX_JEV_TEXTS = 128;
const MAX_JEV_PRIOR_TITLES = 20;
const JEV_CONCURRENCY = 8;

export type JevShadowScores = {
  interest: string | null;
  interestConfidence: number | null;
  novel: number | null;
  substantive: number | null;
  /** Probability the reader would want this story. Taste shifts over time, so
   *  this is recorded per row and never folded into the other answers. */
  readerWants: number | null;
};

export function jevShadowEnabled(env: Env): boolean {
  return (env as Env & { JEV_SHADOW_ENABLED?: string }).JEV_SHADOW_ENABLED === "true";
}

/**
 * One Choice over every positive-weight interest plus watching topics (with an
 * explicit none option), one novelty Noul scoped to pre-today editions, and
 * one substantive-vs-promotional Noul. Weights gate which options appear;
 * they never scale scores.
 */
export function buildJevQuestions(profile: Profile, priorTitles: string[]): Record<string, JevQuestion> {
  const interests = [...profile.weights]
    .filter((weight) => weight.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .map((weight) => weight.label);
  const watching = [...new Set([...profile.pinnedCategories, ...profile.watching])].sort((left, right) => left.localeCompare(right));
  const options: Record<string, string> = {};
  for (const label of interests) options[label] = `Stories about ${label}`;
  for (const topic of watching.filter((topic) => !interests.includes(topic))) {
    options[`Watching: ${topic}`] = `Stories about ${topic}`;
  }
  options.none = "Does not fit any listed interest";
  return {
    interest: {
      type: "choice",
      instructions: `Which reader interest does this story fit best? The reader tracks ${interests.join("; ")}.`,
      criteria: options
    },
    novel: {
      type: "noul",
      instructions: {
        question: "Is this materially new compared with the previously published stories below?",
        previously_published: priorTitles.slice(0, MAX_JEV_PRIOR_TITLES)
      },
      criteria: { true: "Reports something not previously established", false: "Restates or recaps known developments" }
    },
    substantive: {
      type: "noul",
      instructions: "Is this substantive news rather than promotional or marketing content?",
      criteria: { true: "Factual development with verifiable detail", false: "Promotional, vague, or marketing-led" }
    },
    reader_wants: {
      type: "noul",
      instructions: `Would a reader tracking ${interests.join("; ")} want to spend attention on this story? Judge want, not fit: a story can match a topic without deserving attention.`,
      criteria: { true: "Worth this reader's attention", false: "Not worth this reader's attention" }
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJevAnswers(raw: unknown): JevShadowScores {
  const empty: JevShadowScores = { interest: null, interestConfidence: null, novel: null, substantive: null, readerWants: null };
  if (!record(raw)) return empty;
  const answers = record(raw.answers) ? raw.answers : {};
  const interest = record(answers.interest) ? answers.interest : {};
  const novel = record(answers.novel) ? answers.novel : {};
  const substantive = record(answers.substantive) ? answers.substantive : {};
  const readerWants = record(answers.reader_wants) ? answers.reader_wants : {};
  return {
    interest: typeof interest.choice === "string" ? interest.choice : null,
    interestConfidence: finite(interest.confidence),
    novel: finite(novel.noul),
    substantive: finite(substantive.noul),
    readerWants: finite(readerWants.noul)
  };
}

/**
 * Advisory Jev scores over the full fresh pool, shadowing the reranker judge.
 * One direct-API call per story with bounded concurrency; per-item failures
 * yield nulls rather than failing the run. Skipped entirely without an API key.
 */
export async function scoreJevShadow(
  apiKey: string,
  profile: Profile,
  items: Array<{ url: string; title: string; summary: string }>,
  priorTitles: string[],
  fetchImpl: typeof fetch = fetch,
  questionSet: Record<string, JevQuestion> = buildJevQuestions(profile, priorTitles)
): Promise<Map<string, JevShadowScores>> {
  const scores = new Map<string, JevShadowScores>();
  const selected = items.slice(0, MAX_JEV_TEXTS);
  if (!selected.length || !apiKey) return scores;
  const questions = questionSet;
  const runOne = async (item: { url: string; title: string; summary: string }): Promise<void> => {
    try {
      const response = await fetchImpl(JEV_DIRECT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          state: { title: item.title, summary: item.summary, url: item.url },
          model: JEV_DIRECT_MODEL,
          questions
        })
      });
      if (!response.ok) return;
      scores.set(item.url, parseJevAnswers(await response.json()));
    } catch {
      return;
    }
  };
  for (let index = 0; index < selected.length; index += JEV_CONCURRENCY) {
    await Promise.all(selected.slice(index, index + JEV_CONCURRENCY).map(runOne));
  }
  return scores;
}
