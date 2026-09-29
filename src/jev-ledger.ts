import type { JevScoredItem, SupplementalShadowReport, TriageScoredItem } from "./contracts";

/**
 * Research support for judging Jev against the rule gate and the free on-platform
 * reranker. Nothing here selects or publishes a story: it builds review samples,
 * records what the owner decided, and summarises how each judge lined up with those
 * decisions.
 *
 * Each judge's counterfactual pick is rank-based: the K stories with the highest score,
 * where K is how many the rules selected. Only stories the picks disagree on can tell
 * judges apart, so the paired sample is mostly disagreements, ordered by how far each
 * story sits from the cut (a story a few hundredths either side is a coin flip, not a
 * disagreement). Each label records the picks and cell computed over its whole run at the
 * time it was made, since shadow reports are pruned. The paired sample and the dropped
 * pool are separate frames (in the dropped pool the owner knows every story was rejected),
 * each story is voted once per frame, and the two are never pooled in one estimate.
 */

export type JevLabelKind =
  | "disagree-gate-only"
  | "disagree-jev-only"
  | "anchor-both-in"
  | "anchor-both-out"
  | "repeat"
  | "dropped-pool"
  | "rank";

export type ReviewMode = "paired" | "dropped";
export type JevDecision = "publish" | "reject" | "unsure";
export type Cell = "both-in" | "gate-only" | "jev-only" | "both-out";

export const PAIRED_BATCH_SIZE = 12;
/** A disagreement whose reader_wants sits at least this far from the top-K cut counts as clear. */
export const CLEAR_MARGIN = 0.08;
const QUOTAS: Array<[Exclude<JevLabelKind, "repeat" | "dropped-pool" | "rank">, number]> = [
  ["disagree-gate-only", 4],
  ["disagree-jev-only", 4],
  ["anchor-both-in", 1],
  ["anchor-both-out", 1]
];
const MAX_REPEATS = 2;
/** Repeats need time between the two looks, or they measure memory instead of taste. */
export const REPEAT_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_DROPPED_BATCH = 40;

/** Which judges would have picked a story, as computed over its whole run at label time. */
export type JudgePicks = {
  gate: boolean;
  jev: boolean;
  /** Null when the reranker never scored the story: an unscored story is not a reranker "no". */
  reranker: boolean | null;
  cell: Cell;
  /** Distance of reader_wants from the Jev top-K cut; null when the cut is undefined. */
  margin: number | null;
  k: number;
};

export type ReviewAssessment = {
  gateOutcome: JevScoredItem["outcome"];
  interest: string | null;
  interestConfidence: number | null;
  novel: number | null;
  substantive: number | null;
  readerWants: number | null;
  reranker: Pick<TriageScoredItem, "relevance" | "rawRelevance" | "winningInterest" | "rank" | "novelty"> | null;
  picks?: JudgePicks;
};

export type ReviewCandidate = {
  url: string;
  title: string;
  summary: string;
  publishedAt: string;
  sourceIds: string[];
  assessment: ReviewAssessment;
};

export type ReviewBatchItem = ReviewCandidate & {
  kind: Exclude<JevLabelKind, "rank">;
  cellPopulation: number | null;
  cellSampled: number | null;
};

export type ReviewBatch = {
  mode: ReviewMode;
  runId: string;
  poolSize: number;
  jevK: number;
  /** Rules-selected stories Jev never scored (failed call): they cannot enter the head-to-head. */
  unscoredSelected: number;
  /** Dropped mode only: true when every eligible story is in the batch. */
  complete: boolean;
  items: ReviewBatchItem[];
};

/** A stored label event, as the batch builder and the analysis read it. */
export type LabelEvent = {
  id?: number;
  storyUrl: string;
  questionHash: string;
  questionSetVersion: string;
  runId: string;
  issueDate: string;
  kind: JevLabelKind;
  decision: JevDecision;
  rankPosition: number | null;
  cellPopulation: number | null;
  cellSampled: number | null;
  poolSize: number | null;
  jevK: number | null;
  snapshotJson: string;
  createdAt: string;
};

function seededHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function seededOrder<T extends { url: string }>(seed: string, items: T[]): T[] {
  return [...items].sort((left, right) => seededHash(`${seed}:${left.url}`) - seededHash(`${seed}:${right.url}`) || left.url.localeCompare(right.url));
}

function hasAnswer(item: JevScoredItem): boolean {
  return item.interest !== null || item.novel !== null || item.substantive !== null || item.readerWants !== null;
}

/** Evidence-eligible, Jev-scored pool as review candidates. */
export function reviewPool(report: SupplementalShadowReport): ReviewCandidate[] {
  const triageByUrl = new Map((report.triageScores ?? []).map((item) => [item.url, item]));
  return (report.jevScores ?? [])
    .filter((item) => hasAnswer(item) && item.outcome !== "noUsableEvidence")
    .map((item) => {
      const reranker = triageByUrl.get(item.url);
      return {
        url: item.url,
        title: item.title,
        summary: item.summary ?? "",
        publishedAt: item.publishedAt ?? "",
        sourceIds: (item.sourceIds ?? []) as string[],
        assessment: {
          gateOutcome: item.outcome,
          interest: item.interest,
          interestConfidence: item.interestConfidence,
          novel: item.novel,
          substantive: item.substantive,
          readerWants: item.readerWants,
          reranker: reranker ? { relevance: reranker.relevance, rawRelevance: reranker.rawRelevance, winningInterest: reranker.winningInterest, rank: reranker.rank, novelty: reranker.novelty } : null
        }
      };
    });
}

/** Rules-selected stories with no Jev answer. They vanish from the pool, so they are counted, not hidden. */
export function unscoredSelectedCount(report: SupplementalShadowReport): number {
  return (report.jevScores ?? []).filter((item) => item.outcome === "selected" && !hasAnswer(item)).length;
}

function topK(pool: ReviewCandidate[], k: number, score: (item: ReviewCandidate) => number | null): { picks: Set<string>; ranked: Array<{ url: string; score: number }> } {
  const ranked = pool
    .map((item) => ({ url: item.url, score: score(item) }))
    .filter((entry): entry is { url: string; score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  return { picks: new Set(ranked.slice(0, k).map((entry) => entry.url)), ranked };
}

/** The stories a Jev-ranked edition would carry: top K by reader_wants, K = the gate's selection size. */
export function jevPickSet(pool: ReviewCandidate[]): { k: number; picks: Set<string> } {
  const k = pool.filter((item) => item.assessment.gateOutcome === "selected").length;
  return { k, picks: topK(pool, k, (item) => item.assessment.readerWants).picks };
}

/**
 * What each judge would have picked from one run's pool, all with the same K, plus each
 * story's distance from the Jev cut. The cut is the midpoint between the K-th and
 * (K+1)-th reader_wants scores; scores are packed into a narrow band, so a small margin
 * means the two judges barely differ and the "disagreement" is tie-breaking.
 */
export function judgePicks(pool: ReviewCandidate[]): Map<string, JudgePicks> {
  const k = pool.filter((item) => item.assessment.gateOutcome === "selected").length;
  const jev = topK(pool, k, (item) => item.assessment.readerWants);
  const reranker = topK(pool, k, (item) => item.assessment.reranker?.rawRelevance ?? null);
  const cut = k > 0 && jev.ranked.length > k ? (jev.ranked[k - 1]!.score + jev.ranked[k]!.score) / 2 : null;
  const result = new Map<string, JudgePicks>();
  for (const item of pool) {
    const gate = item.assessment.gateOutcome === "selected";
    const picked = jev.picks.has(item.url);
    const wants = item.assessment.readerWants;
    result.set(item.url, {
      gate,
      jev: picked,
      reranker: item.assessment.reranker?.rawRelevance == null ? null : reranker.picks.has(item.url),
      cell: gate && picked ? "both-in" : gate ? "gate-only" : picked ? "jev-only" : "both-out",
      margin: cut !== null && wants !== null ? Math.abs(wants - cut) : null,
      k
    });
  }
  return result;
}

export type VoteFrame = "any" | "paired" | "dropped";

/**
 * First vote per story: the earliest event that is neither a repeat nor a rank. A vote
 * belongs to the frame it was made in: the paired sample, or the dropped pool, where the
 * owner knows the rules already rejected every story. The two frames anchor differently, so
 * each is counted on its own; "any" is the union, used only to know a story has been seen.
 */
export function firstVotes(events: LabelEvent[], frame: VoteFrame = "any"): Map<string, LabelEvent> {
  const votes = new Map<string, LabelEvent>();
  for (const event of events) {
    if (event.kind === "repeat" || event.kind === "rank") continue;
    if (frame === "paired" && event.kind === "dropped-pool") continue;
    if (frame === "dropped" && event.kind !== "dropped-pool") continue;
    if (!votes.has(event.storyUrl)) votes.set(event.storyUrl, event);
  }
  return votes;
}

function candidateFromSnapshot(snapshotJson: string): ReviewCandidate | null {
  try {
    const parsed = JSON.parse(snapshotJson) as { candidate?: ReviewCandidate };
    const candidate = parsed.candidate;
    if (!candidate || typeof candidate.url !== "string" || typeof candidate.title !== "string") return null;
    return {
      url: candidate.url,
      title: candidate.title,
      summary: candidate.summary ?? "",
      publishedAt: candidate.publishedAt ?? "",
      sourceIds: candidate.sourceIds ?? [],
      assessment: candidate.assessment
    };
  } catch {
    return null;
  }
}

function withPicks(pool: ReviewCandidate[]): ReviewCandidate[] {
  const picks = judgePicks(pool);
  return pool.map((item) => ({ ...item, assessment: { ...item.assessment, picks: picks.get(item.url) } }));
}

/**
 * Builds one paired review batch. A story already voted in the paired frame is never drawn
 * again as an ordinary item (one vote per story per frame); up to two labelled at least
 * three days ago are re-shown as repeats to measure the owner's own consistency. Within
 * each disagreement cell, stories whose reader_wants sits clearly away from the Jev cut
 * are drawn first, by seeded random draw; near-ties only fill what clear ones cannot.
 * Random within the clear set keeps that estimate honest: it is a sample of clear
 * disagreements, not of the ones where Jev looks best. Reloading a run gives the same batch.
 */
export function buildPairedBatch(runId: string, report: SupplementalShadowReport, history: LabelEvent[], now: number = Date.now()): ReviewBatch {
  const pool = withPicks(reviewPool(report));
  const k = pool[0]?.assessment.picks?.k ?? pool.filter((item) => item.assessment.gateOutcome === "selected").length;
  const voted = firstVotes(history, "paired");
  const cellKind = (item: ReviewCandidate): Exclude<JevLabelKind, "repeat" | "dropped-pool" | "rank"> => {
    const cell = item.assessment.picks!.cell;
    return cell === "both-in" ? "anchor-both-in" : cell === "gate-only" ? "disagree-gate-only" : cell === "jev-only" ? "disagree-jev-only" : "anchor-both-out";
  };
  const cells = new Map<string, ReviewCandidate[]>();
  for (const [kind] of QUOTAS) cells.set(kind, []);
  for (const item of pool.filter((candidate) => !voted.has(candidate.url))) cells.get(cellKind(item))!.push(item);
  for (const [kind, items] of cells) {
    const seeded = seededOrder(`${runId}:${kind}`, items);
    if (!kind.startsWith("disagree-")) {
      cells.set(kind, seeded);
      continue;
    }
    const isClear = (item: ReviewCandidate): boolean => (item.assessment.picks!.margin ?? -1) >= CLEAR_MARGIN;
    cells.set(kind, [...seeded.filter(isClear), ...seeded.filter((item) => !isClear(item))]);
  }

  const repeatedAlready = new Set(history.filter((event) => event.kind === "repeat").map((event) => event.storyUrl));
  const repeatPool = [...firstVotes(history).values()]
    .filter((vote) => vote.runId !== runId && !repeatedAlready.has(vote.storyUrl) && now - Date.parse(vote.createdAt) >= REPEAT_MIN_AGE_MS)
    .map((vote) => candidateFromSnapshot(vote.snapshotJson))
    .filter((candidate): candidate is ReviewCandidate => candidate !== null);
  const repeats = seededOrder(`${runId}:repeat`, repeatPool).slice(0, MAX_REPEATS);

  const target = PAIRED_BATCH_SIZE - repeats.length;
  const taken = new Map<string, ReviewCandidate[]>();
  for (const [kind, quota] of QUOTAS) taken.set(kind, cells.get(kind)!.slice(0, quota));
  let filled = [...taken.values()].reduce((sum, items) => sum + items.length, 0);
  // Spare places go round-robin across the four cells, one at a time, so neither
  // disagreement side is favoured and anchors only fill what disagreements cannot.
  const order = ["disagree-gate-only", "disagree-jev-only", "anchor-both-in", "anchor-both-out"] as const;
  for (let progressed = true; progressed && filled < target;) {
    progressed = false;
    for (const kind of order) {
      if (filled >= target) break;
      const have = taken.get(kind)!;
      const next = cells.get(kind)![have.length];
      if (next) {
        have.push(next);
        filled += 1;
        progressed = true;
      }
    }
  }
  const items: ReviewBatchItem[] = [];
  for (const [kind] of QUOTAS) {
    const drawn = taken.get(kind)!;
    for (const item of drawn) items.push({ ...item, kind, cellPopulation: cells.get(kind)!.length, cellSampled: drawn.length });
  }
  for (const item of repeats) items.push({ ...item, kind: "repeat", cellPopulation: null, cellSampled: null });
  return { mode: "paired", runId, poolSize: pool.length, jevK: k, unscoredSelected: unscoredSelectedCount(report), complete: false, items: seededOrder(`${runId}:order`, items).slice(0, PAIRED_BATCH_SIZE) };
}

/**
 * Census of stories the rules dropped (weak fit or ranked out) that the owner has not yet
 * judged in this frame, up to a cap. It ignores votes made in the paired sample, so a
 * rescue rate over the dropped pool is not thinned by stories Jev happened to favour. The
 * page withholds every score until the batch is saved. These votes feed the dropped-pool
 * figures only: the owner knows every story here was rejected, which is a different frame
 * from the paired sample and is not pooled with it.
 */
export function buildDroppedBatch(runId: string, report: SupplementalShadowReport, history: LabelEvent[]): ReviewBatch {
  const pool = withPicks(reviewPool(report));
  const k = pool[0]?.assessment.picks?.k ?? pool.filter((item) => item.assessment.gateOutcome === "selected").length;
  const voted = firstVotes(history, "dropped");
  const dropped = pool.filter((item) => item.assessment.gateOutcome !== "selected" && !voted.has(item.url));
  const drawn = seededOrder(`${runId}:dropped`, dropped).slice(0, MAX_DROPPED_BATCH);
  return {
    mode: "dropped",
    runId,
    poolSize: pool.length,
    jevK: k,
    unscoredSelected: unscoredSelectedCount(report),
    complete: drawn.length === dropped.length,
    items: drawn.map((item) => ({ ...item, kind: "dropped-pool" as const, cellPopulation: dropped.length, cellSampled: drawn.length }))
  };
}

/**
 * Fills in judge picks for labels made before picks were recorded, from the retained
 * shadow report of each label's run. Labels whose run has been pruned keep whatever the
 * paired kind implies and are otherwise left without picks.
 */
export function enrichEventsWithPicks(events: LabelEvent[], reports: Map<string, SupplementalShadowReport>): LabelEvent[] {
  const picksByRun = new Map<string, Map<string, JudgePicks>>();
  return events.map((event) => {
    if (event.kind === "rank") return event;
    const candidate = candidateFromSnapshot(event.snapshotJson);
    if (!candidate?.assessment || candidate.assessment.picks) return event;
    let picks = picksByRun.get(event.runId);
    if (!picks) {
      const report = reports.get(event.runId);
      picks = report ? judgePicks(reviewPool(report)) : new Map();
      picksByRun.set(event.runId, picks);
    }
    const found = picks.get(event.storyUrl);
    if (!found) return event;
    const parsed = JSON.parse(event.snapshotJson) as { candidate: ReviewCandidate };
    parsed.candidate.assessment = { ...candidate.assessment, picks: found };
    return { ...event, snapshotJson: JSON.stringify(parsed) };
  });
}

/** Stable JSON so the same questions always hash the same, whatever the key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fingerprint of what a Jev question set asks. The daily list of previously published
 * titles is excluded because it changes every day without changing the question. A
 * reworded question, or a changed interest list, gives a new fingerprint even if the
 * hand-bumped version string was forgotten.
 */
export async function jevQuestionFingerprint(questions: Record<string, unknown>): Promise<string> {
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

export type JudgmentRow = {
  storyUrl: string;
  questionHash: string;
  questionSetVersion: string;
  title: string;
  summary: string;
  publishedAt: string;
  sourceIdsJson: string;
  firstRunId: string;
  issueDate: string;
  seenAt: string;
  interest: string | null;
  interestConfidence: number | null;
  novel: number | null;
  substantive: number | null;
  readerWants: number | null;
  rerankerRelevance: number | null;
  rerankerRaw: number | null;
  rerankerRank: number | null;
  rerankerInterest: string | null;
  gateOutcome: string;
  selected: boolean;
  published: boolean;
  profileVersion: number | null;
  sourcePackId: string | null;
  sourcePackVersion: number | null;
};

/** One ledger row per scored story of a shadow run. Published means it is on today's live edition. */
export function buildJudgmentRows(input: {
  runId: string;
  report: SupplementalShadowReport;
  questionHash: string;
  publishedUrls: Set<string>;
  seenAt: string;
}): JudgmentRow[] {
  const { report } = input;
  const triageByUrl = new Map((report.triageScores ?? []).map((item) => [item.url, item]));
  return (report.jevScores ?? []).map((item) => {
    const triage = triageByUrl.get(item.url);
    return {
      storyUrl: item.url,
      questionHash: input.questionHash,
      questionSetVersion: report.jevQuestionSetVersion ?? "unknown",
      title: item.title,
      summary: item.summary ?? "",
      publishedAt: item.publishedAt ?? "",
      sourceIdsJson: JSON.stringify(item.sourceIds ?? []),
      firstRunId: input.runId,
      issueDate: report.baseIssue.issueDate,
      seenAt: input.seenAt,
      interest: item.interest,
      interestConfidence: item.interestConfidence,
      novel: item.novel,
      substantive: item.substantive,
      readerWants: item.readerWants,
      rerankerRelevance: triage?.relevance ?? null,
      rerankerRaw: triage?.rawRelevance ?? null,
      rerankerRank: triage?.rank ?? null,
      rerankerInterest: triage?.winningInterest ?? null,
      gateOutcome: item.outcome,
      selected: item.outcome === "selected",
      published: input.publishedUrls.has(item.url),
      profileVersion: report.profileVersion ?? null,
      sourcePackId: report.sourcePack?.id ?? null,
      sourcePackVersion: report.sourcePack?.version ?? null
    };
  });
}

// ---------- analysis ----------

export type RateEstimate = { n: number; publish: number; reject: number; unsure: number; publishShare: number | null; publishShareUnsureAsReject: number | null };

/** Head-to-head of Jev against the rules on stories the two picks disagree on. */
export type HeadToHead = {
  gateOnly: RateEstimate;
  jevOnly: RateEstimate;
  decided: number;
  jevRight: number;
  gateRight: number;
  jevRightShare: number | null;
  /** Same, reading "unsure" as "would not add" instead of dropping it. */
  decidedUnsureAsReject: number;
  jevRightShareUnsureAsReject: number | null;
};

export type JudgeComparison = { discordant: number; bothRight: number; bothWrong: number; firstOnlyRight: number; secondOnlyRight: number; pValue: number | null };

export type BarStatus = "insufficient" | "pass" | "fail";
export type BarCriterion = { id: string; label: string; status: BarStatus; detail: string };

export type JevAnalysis = {
  labelledStories: number;
  labelEvents: number;
  questionHashes: string[];
  /** Owner's own consistency: repeats compared with the first vote. Bounds any judge's agreement. */
  consistency: { pairs: number; sameDecision: number; sameAsPublish: number; rate: number | null; publishAgreementRate: number | null };
  /** Paired-sample votes only, by the cell recorded on each label. Dropped-pool votes are a different frame and are kept out. */
  headToHead: { all: HeadToHead; clear: HeadToHead; clearMargin: number };
  anchors: { bothIn: RateEstimate; bothOut: RateEstimate };
  /** Rules-dropped stories judged from the dropped-pool mode only: a census, so its rescue rate is not skewed by Jev. */
  droppedPool: RateEstimate & { days: number; rescuedPerDay: number | null };
  /** Dropped-pool votes, split by whether Jev would have picked the story. A lower bound on rescues. */
  droppedByCell: { jevOnly: RateEstimate; bothOut: RateEstimate };
  /** The three judges on the same labelled stories: each judge's pick matched the owner's publish/reject. */
  judges: {
    n: number;
    gateRight: number;
    /** Stories the reranker actually scored; its figures cover only these. */
    rerankerN: number;
    rerankerRight: number;
    jevRight: number;
    jevVsReranker: JudgeComparison;
    jevVsGate: JudgeComparison;
  };
  ranking: {
    n: number;
    readerWantsAuc: number | null;
    rerankerAuc: number | null;
    /** Mean Spearman between your publish-set ranks and reader_wants, over runs with 3 or more ranked. */
    rankRuns: number;
    meanRankCorrelation: number | null;
  };
  /** Proposed bar; the owner confirms or changes it before results are read. */
  bar: BarCriterion[];
};

function estimate(votes: Array<{ decision: JevDecision }>): RateEstimate {
  const publish = votes.filter((vote) => vote.decision === "publish").length;
  const reject = votes.filter((vote) => vote.decision === "reject").length;
  const unsure = votes.length - publish - reject;
  return {
    n: votes.length,
    publish,
    reject,
    unsure,
    publishShare: publish + reject ? publish / (publish + reject) : null,
    publishShareUnsureAsReject: votes.length ? publish / votes.length : null
  };
}

function auc(scored: Array<{ score: number; positive: boolean }>): number | null {
  const positives = scored.filter((item) => item.positive);
  const negatives = scored.filter((item) => !item.positive);
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) wins += positive.score > negative.score ? 1 : positive.score === negative.score ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

function ranksOf(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length).fill(0);
  let at = 0;
  while (at < order.length) {
    let end = at;
    while (end + 1 < order.length && order[end + 1]!.value === order[at]!.value) end += 1;
    const average = (at + end) / 2 + 1;
    for (let index = at; index <= end; index += 1) ranks[order[index]!.index] = average;
    at = end + 1;
  }
  return ranks;
}

function spearman(left: number[], right: number[]): number | null {
  if (left.length < 3 || left.length !== right.length) return null;
  const a = ranksOf(left);
  const b = ranksOf(right);
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < a.length; index += 1) {
    covariance += (a[index]! - meanA) * (b[index]! - meanB);
    varianceA += (a[index]! - meanA) ** 2;
    varianceB += (b[index]! - meanB) ** 2;
  }
  return varianceA && varianceB ? covariance / Math.sqrt(varianceA * varianceB) : null;
}

/** Exact two-sided sign test on discordant pairs under a fair coin. */
function signTest(first: number, second: number): number | null {
  const n = first + second;
  if (!n) return null;
  const tail = Math.min(first, second);
  let probability = 0;
  let term = 0.5 ** n;
  for (let successes = 0; successes <= tail; successes += 1) {
    probability += term;
    term = term * (n - successes) / (successes + 1);
  }
  return Math.min(1, 2 * probability);
}

function compare(rows: Array<{ first: boolean; second: boolean }>): JudgeComparison {
  const bothRight = rows.filter((row) => row.first && row.second).length;
  const bothWrong = rows.filter((row) => !row.first && !row.second).length;
  const firstOnlyRight = rows.filter((row) => row.first && !row.second).length;
  const secondOnlyRight = rows.filter((row) => !row.first && row.second).length;
  return { discordant: firstOnlyRight + secondOnlyRight, bothRight, bothWrong, firstOnlyRight, secondOnlyRight, pValue: signTest(firstOnlyRight, secondOnlyRight) };
}

type Vote = { event: LabelEvent; candidate: ReviewCandidate | null; picks: JudgePicks | null };

const KIND_CELLS: Partial<Record<JevLabelKind, Cell>> = {
  "disagree-gate-only": "gate-only",
  "disagree-jev-only": "jev-only",
  "anchor-both-in": "both-in",
  "anchor-both-out": "both-out"
};

/**
 * The picks recorded on the label, or what a paired kind implies for labels made before
 * picks were recorded (their reranker pick and margin are then unknown), so every figure
 * counts the same stories.
 */
function picksOf(event: LabelEvent, candidate: ReviewCandidate | null): JudgePicks | null {
  const recorded = candidate?.assessment?.picks;
  if (recorded) return recorded;
  const cell = KIND_CELLS[event.kind];
  if (!cell) return null;
  return { gate: cell === "both-in" || cell === "gate-only", jev: cell === "both-in" || cell === "jev-only", reranker: null, cell, margin: null, k: event.jevK ?? 0 };
}

function cellOf(vote: Vote): Cell | null {
  return vote.picks?.cell ?? null;
}

function headToHead(votes: Vote[]): HeadToHead {
  const gateOnly = votes.filter((vote) => cellOf(vote) === "gate-only");
  const jevOnly = votes.filter((vote) => cellOf(vote) === "jev-only");
  const decided = (list: Vote[]): Vote[] => list.filter((vote) => vote.event.decision !== "unsure");
  // Jev is right when it would include a story the owner would publish, or would drop one they would reject.
  const jevRightCount = (listGate: Vote[], listJev: Vote[]): number =>
    listJev.filter((vote) => vote.event.decision === "publish").length + listGate.filter((vote) => vote.event.decision !== "publish").length;
  const strictGate = decided(gateOnly);
  const strictJev = decided(jevOnly);
  const total = strictGate.length + strictJev.length;
  const lenientTotal = gateOnly.length + jevOnly.length;
  const jevRight = jevRightCount(strictGate, strictJev);
  const lenientRight = jevRightCount(gateOnly, jevOnly);
  return {
    gateOnly: estimate(gateOnly.map((vote) => vote.event)),
    jevOnly: estimate(jevOnly.map((vote) => vote.event)),
    decided: total,
    jevRight,
    gateRight: total - jevRight,
    jevRightShare: total ? jevRight / total : null,
    decidedUnsureAsReject: lenientTotal,
    jevRightShareUnsureAsReject: lenientTotal ? lenientRight / lenientTotal : null
  };
}

/** Summarises how the gate, the reranker and Jev line up with the owner's votes. Pure over stored events. */
export function summarizeJevLabels(events: LabelEvent[]): JevAnalysis {
  const firsts = firstVotes(events);
  const toVote = (event: LabelEvent): Vote => {
    const candidate = candidateFromSnapshot(event.snapshotJson);
    return { event, candidate, picks: picksOf(event, candidate) };
  };
  // The paired sample and the dropped pool anchor the owner differently (in the dropped pool every
  // story is known to have been rejected), so each frame is counted on its own and never pooled.
  const votes: Vote[] = [...firstVotes(events, "paired").values()].map(toVote);
  const droppedVotes: Vote[] = [...firstVotes(events, "dropped").values()].map(toVote);

  const repeats = events.filter((event) => event.kind === "repeat");
  let sameDecision = 0;
  let sameAsPublish = 0;
  let pairs = 0;
  for (const repeat of repeats) {
    const first = firsts.get(repeat.storyUrl);
    if (!first) continue;
    pairs += 1;
    if (first.decision === repeat.decision) sameDecision += 1;
    if ((first.decision === "publish") === (repeat.decision === "publish")) sameAsPublish += 1;
  }

  const all = headToHead(votes);
  const clear = headToHead(votes.filter((vote) => (vote.picks?.margin ?? -1) >= CLEAR_MARGIN));

  const droppedPoolVotes = droppedVotes;
  const droppedDecided = droppedPoolVotes.filter((vote) => vote.event.decision !== "unsure");
  const droppedDays = new Set(droppedPoolVotes.map((vote) => vote.event.issueDate));
  const droppedPublish = droppedDecided.filter((vote) => vote.event.decision === "publish").length;
  const rulesDropped = droppedVotes.filter((vote) => vote.picks !== null && !vote.picks.gate);

  // The three judges on identical labelled stories: right = the pick matched publish, the non-pick matched reject.
  // A judge with no score for a story (null pick) is not counted for that story, never counted as "no".
  const judged = votes.filter((vote): vote is Vote & { picks: JudgePicks } => vote.picks !== null && vote.event.decision !== "unsure");
  const right = (vote: Vote & { picks: JudgePicks }, pick: boolean | null): boolean | null => pick === null ? null : pick === (vote.event.decision === "publish");
  const rows = judged.map((vote) => ({ jev: right(vote, vote.picks.jev)!, reranker: right(vote, vote.picks.reranker), gate: right(vote, vote.picks.gate)! }));
  const rerankerRows = rows.filter((row): row is { jev: boolean; reranker: boolean; gate: boolean } => row.reranker !== null);

  const scored = votes
    .filter((vote) => vote.event.decision !== "unsure" && vote.candidate?.assessment)
    .map((vote) => ({ wants: vote.candidate!.assessment.readerWants, raw: vote.candidate!.assessment.reranker?.rawRelevance ?? null, publish: vote.event.decision === "publish" }));
  const wants = scored.filter((item): item is { wants: number; raw: number | null; publish: boolean } => item.wants !== null);
  const raws = scored.filter((item): item is { wants: number | null; raw: number; publish: boolean } => item.raw !== null);

  const rankEventsByRun = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (event.kind !== "rank" || event.rankPosition === null) continue;
    const run = rankEventsByRun.get(event.runId) ?? new Map<string, number>();
    run.set(event.storyUrl, event.rankPosition);
    rankEventsByRun.set(event.runId, run);
  }
  const correlations: number[] = [];
  for (const ranked of rankEventsByRun.values()) {
    const rowsForRun = [...ranked.entries()]
      .map(([url, rank]) => ({ rank, wants: candidateFromSnapshot(firstVotes(events, "paired").get(url)?.snapshotJson ?? firsts.get(url)?.snapshotJson ?? "")?.assessment?.readerWants ?? null }))
      .filter((row): row is { rank: number; wants: number } => row.wants !== null);
    // Rank 1 is strongest, so negate it to align with "higher reader_wants is stronger".
    const value = spearman(rowsForRun.map((row) => -row.rank), rowsForRun.map((row) => row.wants));
    if (value !== null) correlations.push(value);
  }

  const jevVsReranker = compare(rerankerRows.map((row) => ({ first: row.jev, second: row.reranker })));
  const jevVsGate = compare(rows.map((row) => ({ first: row.jev, second: row.gate })));
  const consistencyRate = pairs ? sameDecision / pairs : null;

  const bar: BarCriterion[] = [
    {
      id: "own-consistency",
      label: "You agree with yourself on at least 75% of at least 10 repeats",
      status: pairs < 10 ? "insufficient" : consistencyRate! >= 0.75 ? "pass" : "fail",
      detail: `${pairs} repeats${consistencyRate === null ? "" : `, ${Math.round(consistencyRate * 100)}% same decision`}. If this fails, no judge can be judged on your labels.`
    },
    {
      id: "beats-rules",
      label: `Jev right on at least 65% of at least 40 clear disagreements with the rules (margin ${CLEAR_MARGIN} or more)`,
      status: clear.decided < 40 ? "insufficient" : clear.jevRightShare! >= 0.65 ? "pass" : "fail",
      detail: `${clear.decided} clear decided${clear.jevRightShare === null ? "" : `, Jev right ${Math.round(clear.jevRightShare * 100)}%`} (all margins: ${all.decided} decided${all.jevRightShare === null ? "" : `, ${Math.round(all.jevRightShare * 100)}%`}).`
    },
    {
      id: "beats-reranker",
      label: "Jev right significantly more often than the free reranker (sign test p below 0.10) on at least 20 stories where they differ",
      status: jevVsReranker.discordant < 20 ? "insufficient" : jevVsReranker.firstOnlyRight > jevVsReranker.secondOnlyRight && jevVsReranker.pValue !== null && jevVsReranker.pValue < 0.1 ? "pass" : "fail",
      detail: `${jevVsReranker.discordant} discordant: Jev alone right ${jevVsReranker.firstOnlyRight}, reranker alone right ${jevVsReranker.secondOnlyRight}${jevVsReranker.pValue === null ? "" : ` (sign test p ${jevVsReranker.pValue.toFixed(2)})`}. Equal is not a pass: a paid judge that only ties a free one has not earned its place. The p-value holds within this sample, which is drawn from disagreements.`
    }
  ];

  return {
    labelledStories: firsts.size,
    labelEvents: events.length,
    questionHashes: [...new Set(events.map((event) => event.questionHash))],
    consistency: { pairs, sameDecision, sameAsPublish, rate: consistencyRate, publishAgreementRate: pairs ? sameAsPublish / pairs : null },
    headToHead: { all, clear, clearMargin: CLEAR_MARGIN },
    anchors: {
      bothIn: estimate(votes.filter((vote) => cellOf(vote) === "both-in").map((vote) => vote.event)),
      bothOut: estimate(votes.filter((vote) => cellOf(vote) === "both-out").map((vote) => vote.event))
    },
    droppedPool: { ...estimate(droppedPoolVotes.map((vote) => vote.event)), days: droppedDays.size, rescuedPerDay: droppedDays.size ? droppedPublish / droppedDays.size : null },
    droppedByCell: {
      jevOnly: estimate(rulesDropped.filter((vote) => cellOf(vote) === "jev-only").map((vote) => vote.event)),
      bothOut: estimate(rulesDropped.filter((vote) => cellOf(vote) === "both-out").map((vote) => vote.event))
    },
    judges: {
      n: rows.length,
      gateRight: rows.filter((row) => row.gate).length,
      rerankerN: rerankerRows.length,
      rerankerRight: rerankerRows.filter((row) => row.reranker).length,
      jevRight: rows.filter((row) => row.jev).length,
      jevVsReranker,
      jevVsGate
    },
    ranking: {
      n: scored.length,
      readerWantsAuc: auc(wants.map((item) => ({ score: item.wants, positive: item.publish }))),
      rerankerAuc: auc(raws.map((item) => ({ score: item.raw, positive: item.publish }))),
      rankRuns: correlations.length,
      meanRankCorrelation: correlations.length ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length : null
    },
    bar
  };
}
