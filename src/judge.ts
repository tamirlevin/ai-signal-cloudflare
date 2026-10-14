import type { Profile } from "./contracts";

/**
 * The judge's question set and answer parsing. One judge answers every question for a
 * story in a single forward pass, so the questions are built once per run and the
 * answers are parsed from one response.
 *
 * This module is judge-neutral. It originally served TypeSafe's Jev; the transport
 * that left Cloudflare was removed when Jev was dropped from the experiment, and what
 * remains is the question and answer contract shared with Clef on Workers AI.
 */

/** Bump when the meaning, criteria, or intended use of any question changes. */
export const JUDGE_QUESTION_SET_VERSION = "reader-want-v1";

export type JudgeQuestionType = "noul" | "choice" | "score";

export type JudgeQuestion = {
  type: JudgeQuestionType;
  instructions: string | Record<string, unknown> | unknown[];
  criteria?: Record<string, string> | string[];
};

export type JudgeAnswers = Record<string, JudgeQuestion>;

/** Maximum stories scored per run. */
export const MAX_JUDGE_TEXTS = 128;
const MAX_JUDGE_PRIOR_TITLES = 20;

export type JudgeScores = {
  interest: string | null;
  interestConfidence: number | null;
  novel: number | null;
  substantive: number | null;
  /** Probability the reader would want this story. */
  readerWants: number | null;
};

/**
 * One Choice over every positive-weight interest plus watching topics (with an
 * explicit none option), one novelty Noul scoped to pre-today editions, and
 * one substantive-vs-promotional Noul. Weights gate which options appear;
 * they never scale scores.
 */
export function buildJudgeQuestions(profile: Profile, priorTitles: string[]): JudgeAnswers {
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
        previously_published: priorTitles.slice(0, MAX_JUDGE_PRIOR_TITLES)
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

/** Deterministic JSON with sorted keys, so a question set fingerprints stably. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fingerprint of what a question set asks. The daily list of previously published
 * titles is excluded because it changes every day without changing the question. A
 * reworded question, or a changed interest list, gives a new fingerprint even if the
 * version string was not bumped, so a question change restarts a comparison visibly.
 */
export async function judgeQuestionFingerprint(questions: Record<string, unknown>): Promise<string> {
  const copy = JSON.parse(JSON.stringify(questions)) as Record<string, { instructions?: unknown }>;
  for (const question of Object.values(copy)) {
    const instructions = question?.instructions;
    if (instructions !== null && typeof instructions === "object" && !Array.isArray(instructions)) {
      delete (instructions as Record<string, unknown>).previously_published;
    }
  }
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(copy))));
  return Array.from(bytes.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parses the shared System One answer shape into the judge's scores. */
export function parseJudgeAnswers(raw: unknown): JudgeScores {
  const empty: JudgeScores = { interest: null, interestConfidence: null, novel: null, substantive: null, readerWants: null };
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
