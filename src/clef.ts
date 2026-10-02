import type { Profile } from "./contracts";
import { buildJevQuestions, JEV_QUESTION_SET_VERSION, MAX_JEV_TEXTS, parseJevAnswers, type JevQuestion, type JevShadowScores } from "./jev";
import { jevQuestionFingerprint } from "./jev-ledger";
import { recordClefJudgments, scoredClefUrls, unscoredClefStories, type ClefJudgmentRow } from "./repository";

/**
 * Shadow scoring with Cloudflare's Clef decision models on Workers AI. Clef follows the same
 * System One request and answer shape as Jev, so the Jev question set is reused unchanged and
 * the scores stay directly comparable. Advisory only: nothing here changes an edition.
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

export type ClefScoreResult = { scores: Map<string, JevShadowScores>; attempted: number; failed: number; firstError?: string };

function hasAnswer(scores: JevShadowScores): boolean {
  return scores.interest !== null || scores.novel !== null || scores.substantive !== null || scores.readerWants !== null;
}

/** One call per story with bounded concurrency. Failures are counted, never thrown. */
export async function scoreClef(ai: AiRunner, model: ClefModel, items: ScoreItem[], questions: Record<string, JevQuestion>): Promise<ClefScoreResult> {
  const scores = new Map<string, JevShadowScores>();
  const selected = items.slice(0, MAX_JEV_TEXTS);
  let failed = 0;
  let firstError: string | undefined;
  const runOne = async (item: ScoreItem): Promise<void> => {
    try {
      const raw = await ai.run(CLEF_MODELS[model], { model, state: { title: item.title, summary: item.summary, url: item.url }, questions });
      const parsed = parseJevAnswers(raw);
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

function toRows(scores: Map<string, JevShadowScores>, input: { questionHash: string; model: ClefModel; runId: string | null; scoredAt: string }): ClefJudgmentRow[] {
  return [...scores].map(([storyUrl, score]) => ({
    storyUrl, questionHash: input.questionHash, model: input.model, questionSetVersion: JEV_QUESTION_SET_VERSION, runId: input.runId, scoredAt: input.scoredAt,
    interest: score.interest, interestConfidence: score.interestConfidence, novel: score.novel, substantive: score.substantive, readerWants: score.readerWants
  }));
}

/**
 * Scores the shadow run's pool with Clef, skipping stories already scored under the same
 * question fingerprint and model. Best-effort: any error is logged and never fails the run.
 */
export async function runClefShadow(env: Env, input: { items: ScoreItem[]; questions: Record<string, JevQuestion>; runId: string | null }): Promise<void> {
  try {
    const model = clefShadowModel(env);
    const questionHash = await jevQuestionFingerprint(input.questions);
    const pool = input.items.slice(0, MAX_JEV_TEXTS);
    const done = await scoredClefUrls(env.DB, questionHash, model, pool.map((item) => item.url));
    const pending = pool.filter((item) => !done.has(item.url));
    const result = pending.length ? await scoreClef(env.AI, model, pending, input.questions) : { scores: new Map<string, JevShadowScores>(), attempted: 0, failed: 0 } as ClefScoreResult;
    await recordClefJudgments(env.DB, toRows(result.scores, { questionHash, model, runId: input.runId, scoredAt: new Date().toISOString() }));
    console.log(JSON.stringify({ message: "ai-signal clef shadow completed", model, pool: pool.length, alreadyScored: done.size, attempted: result.attempted, scored: result.scores.size, failed: result.failed, firstError: result.firstError }));
  } catch (error) {
    console.warn(JSON.stringify({ message: "ai-signal clef shadow skipped", error: error instanceof Error ? error.message : String(error) }));
  }
}

/**
 * Staging-only backfill: scores ledger stories that have no Clef row yet, labelled stories
 * first, so Clef can be compared with Jev on the owner's existing labels. Refuses when the
 * current question fingerprint matches no ledger rows, because the questions would differ.
 */
export async function backfillClef(env: Env, profile: Profile, limit: number): Promise<{ model: ClefModel; questionHash: string; selected: number; scored: number; failed: number; firstError?: string; remaining: number }> {
  const model = clefShadowModel(env);
  const questions = buildJevQuestions(profile, []);
  const questionHash = await jevQuestionFingerprint(questions);
  const { stories, remaining } = await unscoredClefStories(env.DB, questionHash, model, limit);
  const result = stories.length ? await scoreClef(env.AI, model, stories.map((story) => ({ url: story.storyUrl, title: story.title, summary: story.summary })), questions) : { scores: new Map<string, JevShadowScores>(), attempted: 0, failed: 0 } as ClefScoreResult;
  await recordClefJudgments(env.DB, toRows(result.scores, { questionHash, model, runId: null, scoredAt: new Date().toISOString() }));
  return { model, questionHash, selected: stories.length, scored: result.scores.size, failed: result.failed, ...(result.firstError ? { firstError: result.firstError } : {}), remaining: Math.max(0, remaining - result.scores.size) };
}
