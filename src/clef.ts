import type { JudgeGateRemoval, Profile } from "./contracts";
import {
  buildJudgeQuestions,
  JUDGE_QUESTION_SET_VERSION,
  judgeQuestionFingerprint,
  MAX_JUDGE_TEXTS,
  parseJudgeAnswers,
  type JudgeAnswers,
  type JudgeQuestion,
  type JudgeScores
} from "./judge";
import { recordClefJudgments, scoredClefUrls, unscoredClefStories, type ClefJudgmentRow } from "./repository";

/**
 * Shadow scoring with Cloudflare's Clef decision models on Workers AI. Clef follows the
 * System One request and answer shape shared with the retired Jev client, so the question
 * set is reused unchanged. Advisory only: nothing here changes an edition.
 */
export const CLEF_MODELS = { clef: "@cf/cloudflare/clef", "clef-flash": "@cf/cloudflare/clef-flash" } as const;
export type ClefModel = keyof typeof CLEF_MODELS;
const CLEF_CONCURRENCY = 4;

type AiRunner = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
type ScoreItem = { url: string; title: string; summary: string };

export function clefShadowEnabled(env: Env): boolean {
  return (env as Env & { CLEF_SHADOW_ENABLED?: string }).CLEF_SHADOW_ENABLED === "true";
}

/** Defaults to the larger model; an unrecognized value falls back rather than failing a run. */
export function clefShadowModel(env: Env): ClefModel {
  const value = (env as Env & { CLEF_SHADOW_MODEL?: string }).CLEF_SHADOW_MODEL?.trim();
  return value === "clef-flash" ? "clef-flash" : "clef";
}

export type ClefScoreResult = { scores: Map<string, JudgeScores>; attempted: number; failed: number; firstError?: string };

function hasAnswer(scores: JudgeScores): boolean {
  return scores.interest !== null || scores.novel !== null || scores.substantive !== null || scores.readerWants !== null;
}

/**
 * Clef documents `instructions` as a string, while the question set passes an object for
 * the novelty question. Stringify non-string instructions so one structured question
 * cannot make the whole request invalid. The question fingerprint is computed from the
 * original set, not this one.
 */
export function clefQuestions(questions: JudgeAnswers): JudgeAnswers {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, typeof question.instructions === "string" ? question : { ...question, instructions: JSON.stringify(question.instructions) }]));
}

/** One call per story with bounded concurrency. Failures are counted, never thrown. */
export async function scoreClef(ai: AiRunner, model: ClefModel, items: ScoreItem[], questions: JudgeAnswers): Promise<ClefScoreResult> {
  const scores = new Map<string, JudgeScores>();
  const selected = items.slice(0, MAX_JUDGE_TEXTS);
  const request = clefQuestions(questions);
  let failed = 0;
  let firstError: string | undefined;
  const runOne = async (item: ScoreItem): Promise<void> => {
    try {
      const raw = await ai.run(CLEF_MODELS[model], { model, state: { title: item.title, summary: item.summary, url: item.url }, questions: request });
      const parsed = parseJudgeAnswers(raw);
      if (!hasAnswer(parsed)) throw new Error("Clef returned no recognized answers");
      scores.set(item.url, parsed);
    } catch (error) {
      failed += 1;
      firstError ??= (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
  };
  for (let index = 0; index < selected.length; index += CLEF_CONCURRENCY) {
    await Promise.all(selected.slice(index, index + CLEF_CONCURRENCY).map(runOne));
  }
  return { scores, attempted: selected.length, failed, ...(firstError ? { firstError } : {}) };
}

function toRows(scores: Map<string, JudgeScores>, input: { questionHash: string; model: ClefModel; runId: string | null; scoredAt: string }): ClefJudgmentRow[] {
  return [...scores].map(([storyUrl, score]) => ({
    storyUrl, questionHash: input.questionHash, model: input.model, questionSetVersion: JUDGE_QUESTION_SET_VERSION, runId: input.runId, scoredAt: input.scoredAt,
    interest: score.interest, interestConfidence: score.interestConfidence, novel: score.novel, substantive: score.substantive, readerWants: score.readerWants
  }));
}

/**
 * Scores the shadow run's pool with Clef, skipping stories already scored under the same
 * question fingerprint and model. Returns the scores just recorded so the caller can put them
 * in the run's own report, and undefined when nothing new was scored or anything failed.
 * Best-effort: any error is logged and never fails the run.
 */
export async function runClefShadow(env: Env, input: { items: ScoreItem[]; questions: JudgeAnswers; runId: string | null }): Promise<Map<string, JudgeScores> | undefined> {
  try {
    const model = clefShadowModel(env);
    const questionHash = await judgeQuestionFingerprint(input.questions);
    const pool = input.items.slice(0, MAX_JUDGE_TEXTS);
    const done = await scoredClefUrls(env.DB, questionHash, model, pool.map((item) => item.url));
    const pending = pool.filter((item) => !done.has(item.url));
    if (!pending.length) return undefined;
    const result = await scoreClef(env.AI, model, pending, input.questions);
    await recordClefJudgments(env.DB, toRows(result.scores, { questionHash, model, runId: input.runId, scoredAt: new Date().toISOString() }));
    console.log(JSON.stringify({ message: "ai-signal clef shadow completed", model, pool: pool.length, alreadyScored: done.size, attempted: result.attempted, scored: result.scores.size, failed: result.failed, firstError: result.firstError }));
    return result.scores;
  } catch (error) {
    console.warn(JSON.stringify({ message: "ai-signal clef shadow skipped", error: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }
}

/**
 * The bounded judge gate. Unlike the shadow path, this changes the published edition, so it is
 * deliberately narrow: it can only *remove* a candidate that the judge rates as not worth the
 * reader's attention, it never adds or reorders, it never touches the top of the deterministic
 * ranking, and it removes at most `JUDGE_GATE_MAX_REMOVALS` per run. A quiet day simply gets
 * quieter, which is already the rule; the gate can never pad.
 */
export const JUDGE_GATE_READER_WANTS_MAX = 0.25;
export const JUDGE_GATE_MAX_REMOVALS = 3;
export const JUDGE_GATE_PROTECTED_TOP = 3;

export function judgeGateEnabled(env: Env): boolean {
  return (env as Env & { CLEF_GATE_ENABLED?: string }).CLEF_GATE_ENABLED === "true";
}

/**
 * Picks the candidates the gate removes, in deterministic rank order. A candidate is eligible
 * only outside the protected top (`JUDGE_GATE_PROTECTED_TOP`) and with a `reader_wants` score at
 * or below `JUDGE_GATE_READER_WANTS_MAX`; an unscored candidate is always kept. Removal stops at
 * `JUDGE_GATE_MAX_REMOVALS`, so the gate is bounded no matter how the judge scores the pool.
 */
export function selectJudgeGateRemovals<T extends { id: number; title: string; sources: Array<{ url: string }> }>(
  candidates: T[],
  scores: Map<string, JudgeScores>
): JudgeGateRemoval[] {
  const removals: JudgeGateRemoval[] = [];
  candidates.forEach((candidate, index) => {
    if (index < JUDGE_GATE_PROTECTED_TOP || removals.length >= JUDGE_GATE_MAX_REMOVALS) return;
    const url = candidate.sources[0]?.url ?? "";
    const score = scores.get(url);
    if (!score || score.readerWants === null || score.readerWants > JUDGE_GATE_READER_WANTS_MAX) return;
    removals.push({ id: candidate.id, url, title: candidate.title, readerWants: score.readerWants, substantive: score.substantive, novel: score.novel, reason: "reader-wants-below-threshold" });
  });
  return removals;
}

/**
 * Scores the selected candidate set with Clef on the critical path and returns the scores for
 * gating. Scores bounded to the selected set (never the whole pool), recorded to `clef_judgments`
 * for continuity, and best-effort: any provider or database error is logged and the gate is a
 * no-op rather than a failed run.
 */
export async function runClefGate(env: Env, input: { items: ScoreItem[]; questions: JudgeAnswers }): Promise<{ scores: Map<string, JudgeScores>; attempted: number; failed: number } | undefined> {
  try {
    const model = clefShadowModel(env);
    const questionHash = await judgeQuestionFingerprint(input.questions);
    const result = await scoreClef(env.AI, model, input.items, input.questions);
    await recordClefJudgments(env.DB, toRows(result.scores, { questionHash, model, runId: null, scoredAt: new Date().toISOString() }));
    console.log(JSON.stringify({ message: "ai-signal judge gate scored candidates", model, attempted: result.attempted, scored: result.scores.size, failed: result.failed, firstError: result.firstError }));
    return { scores: result.scores, attempted: result.attempted, failed: result.failed };
  } catch (error) {
    console.warn(JSON.stringify({ message: "ai-signal judge gate skipped", error: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }
}

/**
 * Staging-only backfill: scores judge-ledger stories that have no Clef row yet, labelled ones
 * first, so existing owner labels can be read against Clef. Refuses when the current question
 * fingerprint matches no ledger rows, because the questions would differ.
 */
export async function backfillClef(env: Env, profile: Profile, limit: number): Promise<{ model: ClefModel; questionHash: string; selected: number; scored: number; failed: number; firstError?: string; remaining: number }> {
  const model = clefShadowModel(env);
  const questions = buildJudgeQuestions(profile, []);
  const questionHash = await judgeQuestionFingerprint(questions);
  const { stories, remaining } = await unscoredClefStories(env.DB, questionHash, model, limit);
  const result = stories.length ? await scoreClef(env.AI, model, stories.map((story) => ({ url: story.storyUrl, title: story.title, summary: story.summary })), questions) : { scores: new Map<string, JudgeScores>(), attempted: 0, failed: 0 } as ClefScoreResult;
  await recordClefJudgments(env.DB, toRows(result.scores, { questionHash, model, runId: null, scoredAt: new Date().toISOString() }));
  return { model, questionHash, selected: stories.length, scored: result.scores.size, failed: result.failed, ...(result.firstError ? { firstError: result.firstError } : {}), remaining: Math.max(0, remaining - result.scores.size) };
}
