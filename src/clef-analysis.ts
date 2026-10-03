import type { SupplementalShadowReport } from "./contracts";
import { firstVotes, judgePicks, reviewPool, signTest, type Cell, type JudgePicks, type LabelEvent, type ReviewCandidate } from "./jev-ledger";

/**
 * The Clef-versus-Jev comparison, with the owner's "don't peek" rule enforced in code: until both
 * labelled frames hold enough decided stories, only counts are produced. No Clef score is read,
 * ranked or compared before the gate opens, so the result cannot be tuned while it is looked at.
 *
 * The bar is the one recorded in PROJECT_HISTORY.md on 2 October 2026, fixed before any Clef score
 * was read. Same stories only: the owner's publish/reject labels (unsure excluded), scored by both
 * judges under one question fingerprint. A judge picks a story when it is in that judge's top K for
 * the story's run, K being how many the rules selected, exactly as for Jev in the main panel.
 *   1. Dropped pool: separation = share of publishable stories a judge would pick minus the share of
 *      rejected stories it would pick.
 *   2. Paired sample: among stories where Clef's and Jev's picks differ, who matches the owner, by an
 *      exact two-sided sign test.
 * Clef is "at least as good" when its separation is within 0.10 of Jev's or higher and it is not
 * significantly worse in (2). It is "better" only when it is also ahead with p below 0.10 on at least
 * 20 differing stories; a tie is not better. Anything else is "not shown". Nothing here changes an
 * edition: both judges stay shadow-only.
 */
export const CLEF_GATE_PER_FRAME = 40;
export const CLEF_SEPARATION_TOLERANCE = 0.1;
export const CLEF_SIGNIFICANCE = 0.1;
export const CLEF_BETTER_MIN_DISCORDANT = 20;

export type ClefScoreRow = { storyUrl: string; questionHash: string; readerWants: number | null };

export type Separation = { publish: number; reject: number; publishPicked: number; rejectPicked: number; separation: number | null };
export type ClefVerdict = "better" | "at-least-as-good" | "not-shown";

export type ClefResult = {
  dropped: { jev: Separation; clef: Separation };
  paired: { stories: number; discordant: number; clefOnlyRight: number; jevOnlyRight: number; pValue: number | null };
  verdict: ClefVerdict;
};

export type ClefComparison = {
  gate: {
    needed: number;
    open: boolean;
    /** Decided paired-sample stories in a rules-versus-Jev disagreement cell, with Clef scores for their whole run. */
    paired: { decided: number };
    /** Decided dropped-pool stories with Clef scores for their whole run. */
    dropped: { decided: number };
    /** Decided votes left out: no retained run report to rebuild the pool from, or Clef missing for part of that run's pool. */
    excluded: { unavailable: number; incompleteCoverage: number };
    /** The question fingerprint this sample is counted under; null when the comparison is not pinned to one. */
    questionHash: string | null;
    /** Decided votes made under a different question set, set aside so the sample is one question set. */
    setAside: number;
  };
  /** Null until the gate opens. Nothing derived from a Clef score is computed before then. */
  result: ClefResult | null;
};

type RunInfo = { pool: ReviewCandidate[]; picks: Map<string, JudgePicks>; complete: boolean };
type Comparable = { storyUrl: string; runId: string; publish: boolean; picks: JudgePicks };

function separation(items: Array<{ publish: boolean; picked: boolean }>): Separation {
  const publish = items.filter((item) => item.publish);
  const reject = items.filter((item) => !item.publish);
  const publishPicked = publish.filter((item) => item.picked).length;
  const rejectPicked = reject.filter((item) => item.picked).length;
  return {
    publish: publish.length,
    reject: reject.length,
    publishPicked,
    rejectPicked,
    separation: publish.length && reject.length ? publishPicked / publish.length - rejectPicked / reject.length : null
  };
}

const DISAGREEMENT_CELLS: ReadonlySet<Cell> = new Set<Cell>(["gate-only", "jev-only"]);

export function summarizeClefComparison(
  allEvents: LabelEvent[],
  reports: Map<string, SupplementalShadowReport>,
  clefRows: ClefScoreRow[],
  options: { needed?: number; questionHash?: string } = {}
): ClefComparison {
  const needed = options.needed ?? CLEF_GATE_PER_FRAME;
  // The sample is one question set: when pinned, labels made under another fingerprint (for example before a
  // profile change) are set aside and counted, so changing the profile restarts the sample visibly.
  const pinned = options.questionHash ?? null;
  const events = pinned === null ? allEvents : allEvents.filter((event) => event.questionHash === pinned);
  const setAside = pinned === null ? 0 : [...firstVotes(allEvents, "paired").values(), ...firstVotes(allEvents, "dropped").values()]
    .filter((vote) => vote.decision !== "unsure" && vote.questionHash !== pinned).length;
  const clefIndex = new Map(clefRows.map((row) => [`${row.questionHash}\n${row.storyUrl}`, row.readerWants]));
  const hashByRun = new Map(events.filter((event) => event.kind !== "rank").map((event) => [event.runId, event.questionHash]));
  const runCache = new Map<string, RunInfo | null>();

  // Only existence of a Clef row is checked here, never its score, so the gate cannot depend on what Clef said.
  const runInfo = (runId: string): RunInfo | null => {
    if (runCache.has(runId)) return runCache.get(runId)!;
    const report = reports.get(runId);
    let info: RunInfo | null = null;
    if (report) {
      const pool = reviewPool(report);
      const hash = hashByRun.get(runId) ?? "";
      info = { pool, picks: judgePicks(pool), complete: pool.length > 0 && pool.every((item) => clefIndex.has(`${hash}\n${item.url}`)) };
    }
    runCache.set(runId, info);
    return info;
  };

  const excluded = { unavailable: 0, incompleteCoverage: 0 };
  const comparable = (frame: "paired" | "dropped"): Comparable[] => {
    const result: Comparable[] = [];
    for (const vote of firstVotes(events, frame).values()) {
      if (vote.decision === "unsure") continue;
      const run = runInfo(vote.runId);
      const picks = run?.picks.get(vote.storyUrl);
      if (!run || !picks) { excluded.unavailable += 1; continue; }
      if (!run.complete) { excluded.incompleteCoverage += 1; continue; }
      result.push({ storyUrl: vote.storyUrl, runId: vote.runId, publish: vote.decision === "publish", picks });
    }
    return result;
  };

  const paired = comparable("paired");
  const dropped = comparable("dropped");
  const pairedDisagreements = paired.filter((vote) => DISAGREEMENT_CELLS.has(vote.picks.cell)).length;
  const open = pairedDisagreements >= needed && dropped.length >= needed;
  const gate = { needed, open, paired: { decided: pairedDisagreements }, dropped: { decided: dropped.length }, excluded, questionHash: pinned, setAside };
  if (!open) return { gate, result: null };

  const clefPickCache = new Map<string, Set<string>>();
  const clefPicks = (runId: string): Set<string> => {
    const cached = clefPickCache.get(runId);
    if (cached) return cached;
    const run = runInfo(runId)!;
    const hash = hashByRun.get(runId) ?? "";
    const k = run.picks.values().next().value?.k ?? 0;
    const ranked = run.pool
      .map((item) => ({ url: item.url, score: clefIndex.get(`${hash}\n${item.url}`) ?? null }))
      .filter((entry): entry is { url: string; score: number } => entry.score !== null)
      .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
    const picks = new Set(ranked.slice(0, k).map((entry) => entry.url));
    clefPickCache.set(runId, picks);
    return picks;
  };

  const withClef = (votes: Comparable[]) => votes.map((vote) => ({ publish: vote.publish, jev: vote.picks.jev, clef: clefPicks(vote.runId).has(vote.storyUrl) }));
  const droppedRows = withClef(dropped);
  const pairedRows = withClef(paired);
  const jevSeparation = separation(droppedRows.map((row) => ({ publish: row.publish, picked: row.jev })));
  const clefSeparation = separation(droppedRows.map((row) => ({ publish: row.publish, picked: row.clef })));

  const differing = pairedRows.filter((row) => row.jev !== row.clef);
  const clefOnlyRight = differing.filter((row) => row.clef === row.publish).length;
  const jevOnlyRight = differing.length - clefOnlyRight;
  const pValue = signTest(clefOnlyRight, jevOnlyRight);

  const separationOk = jevSeparation.separation !== null && clefSeparation.separation !== null && clefSeparation.separation >= jevSeparation.separation - CLEF_SEPARATION_TOLERANCE;
  const significantlyWorse = jevOnlyRight > clefOnlyRight && pValue !== null && pValue < CLEF_SIGNIFICANCE;
  const atLeastAsGood = separationOk && !significantlyWorse;
  const better = atLeastAsGood && clefOnlyRight > jevOnlyRight && pValue !== null && pValue < CLEF_SIGNIFICANCE && differing.length >= CLEF_BETTER_MIN_DISCORDANT;

  return {
    gate,
    result: {
      dropped: { jev: jevSeparation, clef: clefSeparation },
      paired: { stories: pairedRows.length, discordant: differing.length, clefOnlyRight, jevOnlyRight, pValue },
      verdict: better ? "better" : atLeastAsGood ? "at-least-as-good" : "not-shown"
    }
  };
}
