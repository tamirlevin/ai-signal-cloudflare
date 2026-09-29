import type { JevScoredItem, SupplementalShadowReport, TriageScoredItem } from "./contracts";

/**
 * Research support for judging Jev against the rule gate. Nothing here selects or
 * publishes a story: it builds review samples, records what the owner decided, and
 * summarises how each judge lined up with those decisions.
 *
 * Jev's counterfactual pick is rank-based, not a threshold rule: take the K stories
 * with the highest reader_wants, where K is how many the gate selected. Only the
 * stories the two picks disagree on can tell the judges apart, so the sample is
 * mostly disagreements, plus a few agreement anchors and repeats of earlier stories
 * that measure the owner's own consistency.
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

export const PAIRED_BATCH_SIZE = 12;
const QUOTAS: Array<[Exclude<JevLabelKind, "repeat" | "dropped-pool" | "rank">, number]> = [
  ["disagree-gate-only", 4],
  ["disagree-jev-only", 4],
  ["anchor-both-in", 1],
  ["anchor-both-out", 1]
];
const MAX_REPEATS = 2;
const MAX_DROPPED_BATCH = 20;

export type ReviewAssessment = {
  gateOutcome: JevScoredItem["outcome"];
  interest: string | null;
  interestConfidence: number | null;
  novel: number | null;
  substantive: number | null;
  readerWants: number | null;
  reranker: Pick<TriageScoredItem, "relevance" | "rawRelevance" | "winningInterest" | "rank" | "novelty"> | null;
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

/** The stories a Jev-ranked edition would carry: top K by reader_wants, K = the gate's selection size. */
export function jevPickSet(pool: ReviewCandidate[]): { k: number; picks: Set<string> } {
  const k = pool.filter((item) => item.assessment.gateOutcome === "selected").length;
  const ranked = pool
    .filter((item) => item.assessment.readerWants !== null)
    .sort((left, right) => right.assessment.readerWants! - left.assessment.readerWants! || left.url.localeCompare(right.url));
  return { k, picks: new Set(ranked.slice(0, k).map((item) => item.url)) };
}

/** First vote per story: the earliest event that is neither a repeat nor a rank. */
export function firstVotes(events: LabelEvent[]): Map<string, LabelEvent> {
  const votes = new Map<string, LabelEvent>();
  for (const event of events) {
    if (event.kind === "repeat" || event.kind === "rank") continue;
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

/**
 * Builds one paired review batch. Stories already labelled are never drawn again as
 * ordinary items (one vote per story); up to two are re-shown as repeats to measure
 * the owner's own consistency. The draw is seeded by run, so reloading is stable.
 */
export function buildPairedBatch(runId: string, report: SupplementalShadowReport, history: LabelEvent[]): ReviewBatch {
  const pool = reviewPool(report);
  const { k, picks } = jevPickSet(pool);
  const voted = firstVotes(history);
  const cellOf = (item: ReviewCandidate): Exclude<JevLabelKind, "repeat" | "dropped-pool" | "rank"> => {
    const gate = item.assessment.gateOutcome === "selected";
    const jev = picks.has(item.url);
    if (gate && jev) return "anchor-both-in";
    if (gate) return "disagree-gate-only";
    if (jev) return "disagree-jev-only";
    return "anchor-both-out";
  };
  const eligible = pool.filter((item) => !voted.has(item.url));
  const cells = new Map<string, ReviewCandidate[]>();
  for (const [kind] of QUOTAS) cells.set(kind, []);
  for (const item of eligible) cells.get(cellOf(item))!.push(item);
  for (const [kind, items] of cells) cells.set(kind, seededOrder(`${runId}:${kind}`, items));

  const repeatSlots = MAX_REPEATS;
  const repeatedAlready = new Set(history.filter((event) => event.kind === "repeat").map((event) => event.storyUrl));
  const repeatPool = [...voted.values()]
    .filter((vote) => vote.runId !== runId && !repeatedAlready.has(vote.storyUrl))
    .map((vote) => candidateFromSnapshot(vote.snapshotJson))
    .filter((candidate): candidate is ReviewCandidate => candidate !== null);
  const repeats = seededOrder(`${runId}:repeat`, repeatPool).slice(0, repeatSlots);

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
    for (const item of drawn) {
      items.push({ ...item, kind, cellPopulation: cells.get(kind)!.length, cellSampled: drawn.length });
    }
  }
  for (const item of repeats) items.push({ ...item, kind: "repeat", cellPopulation: null, cellSampled: null });
  return { mode: "paired", runId, poolSize: pool.length, jevK: k, items: seededOrder(`${runId}:order`, items).slice(0, PAIRED_BATCH_SIZE) };
}

/**
 * Census of stories the rules dropped (weak fit or ranked out) and the owner has not
 * yet judged. Labelling these without Jev's scores sizes how much any better judge
 * could recover, which bounds the whole experiment.
 */
export function buildDroppedBatch(runId: string, report: SupplementalShadowReport, history: LabelEvent[]): ReviewBatch {
  const pool = reviewPool(report);
  const { k } = jevPickSet(pool);
  const voted = firstVotes(history);
  const dropped = pool.filter((item) => item.assessment.gateOutcome !== "selected" && !voted.has(item.url));
  const drawn = seededOrder(`${runId}:dropped`, dropped).slice(0, MAX_DROPPED_BATCH);
  return {
    mode: "dropped",
    runId,
    poolSize: pool.length,
    jevK: k,
    items: drawn.map((item) => ({ ...item, kind: "dropped-pool" as const, cellPopulation: dropped.length, cellSampled: drawn.length }))
  };
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

export type RateEstimate = { n: number; publish: number; reject: number; unsure: number; publishShare: number | null };
export type JevAnalysis = {
  labelledStories: number;
  labelEvents: number;
  questionHashes: string[];
  /** Owner's own consistency: repeats compared with the first vote. Bounds any judge's agreement. */
  consistency: { pairs: number; sameDecision: number; sameAsPublish: number; rate: number | null; publishAgreementRate: number | null };
  /** The head-to-head: only stories the gate and Jev's top-K pick disagree on. */
  paired: {
    gateOnly: RateEstimate;
    jevOnly: RateEstimate;
    decided: number;
    jevRight: number;
    gateRight: number;
    /** Population-weighted share of disagreements Jev got right; null until anything is decided. */
    jevRightShareWeighted: number | null;
    jevRightShareRaw: number | null;
  };
  anchors: { bothIn: RateEstimate; bothOut: RateEstimate };
  /** Rules-dropped stories judged without Jev's scores: how much a better judge could recover. */
  droppedPool: RateEstimate & { days: number; rescuedPerDay: number | null };
  /** Area under the curve of each score against your publish/reject votes, over the reviewed sample. */
  ranking: {
    n: number;
    readerWantsAuc: number | null;
    rerankerAuc: number | null;
    /** Stories Jev scored below 0.2 that you would publish: the costly kind of miss. */
    confidentLowButPublished: number;
    /** Mean Spearman between your publish-set ranks and reader_wants, over runs with 3 or more ranked. */
    rankRuns: number;
    meanRankCorrelation: number | null;
  };
};

function estimate(votes: Array<{ decision: JevDecision }>): RateEstimate {
  const publish = votes.filter((vote) => vote.decision === "publish").length;
  const reject = votes.filter((vote) => vote.decision === "reject").length;
  const unsure = votes.length - publish - reject;
  return { n: votes.length, publish, reject, unsure, publishShare: publish + reject ? publish / (publish + reject) : null };
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

/** Summarises how the gate and Jev line up with the owner's votes. Pure over stored events. */
export function summarizeJevLabels(events: LabelEvent[]): JevAnalysis {
  const votes = firstVotes(events);
  const voteList = [...votes.values()];
  const weightOf = (vote: LabelEvent): number => vote.cellPopulation && vote.cellSampled ? vote.cellPopulation / vote.cellSampled : 1;

  const repeats = events.filter((event) => event.kind === "repeat");
  let sameDecision = 0;
  let sameAsPublish = 0;
  let pairs = 0;
  for (const repeat of repeats) {
    const first = votes.get(repeat.storyUrl);
    if (!first) continue;
    pairs += 1;
    if (first.decision === repeat.decision) sameDecision += 1;
    if ((first.decision === "publish") === (repeat.decision === "publish")) sameAsPublish += 1;
  }

  const ofKind = (kind: JevLabelKind): LabelEvent[] => voteList.filter((vote) => vote.kind === kind);
  const decidedOnly = (list: LabelEvent[]): LabelEvent[] => list.filter((vote) => vote.decision !== "unsure");
  const gateOnly = ofKind("disagree-gate-only");
  const jevOnly = ofKind("disagree-jev-only");
  const decidedGateOnly = decidedOnly(gateOnly);
  const decidedJevOnly = decidedOnly(jevOnly);
  // Jev is right when it would include a story you would publish, or would drop one you would reject.
  const jevRightVotes = [...decidedJevOnly.filter((vote) => vote.decision === "publish"), ...decidedGateOnly.filter((vote) => vote.decision === "reject")];
  const decided = [...decidedGateOnly, ...decidedJevOnly];
  const totalWeight = decided.reduce((sum, vote) => sum + weightOf(vote), 0);
  const jevWeight = jevRightVotes.reduce((sum, vote) => sum + weightOf(vote), 0);

  const dropped = ofKind("dropped-pool");
  const droppedDecided = decidedOnly(dropped);
  const droppedDays = new Set(dropped.map((vote) => vote.issueDate));
  const droppedPublish = droppedDecided.filter((vote) => vote.decision === "publish").length;

  const scored: Array<{ readerWants: number | null; relevance: number | null; publish: boolean }> = [];
  for (const vote of voteList) {
    if (vote.decision === "unsure") continue;
    const candidate = candidateFromSnapshot(vote.snapshotJson);
    if (!candidate?.assessment) continue;
    scored.push({
      readerWants: candidate.assessment.readerWants,
      relevance: candidate.assessment.reranker?.relevance ?? null,
      publish: vote.decision === "publish"
    });
  }
  const wants = scored.filter((item): item is { readerWants: number; relevance: number | null; publish: boolean } => item.readerWants !== null);
  const relevance = scored.filter((item): item is { readerWants: number | null; relevance: number; publish: boolean } => item.relevance !== null);

  const rankEventsByRun = new Map<string, Map<string, number>>();
  for (const event of events) {
    if (event.kind !== "rank" || event.rankPosition === null) continue;
    const run = rankEventsByRun.get(event.runId) ?? new Map<string, number>();
    run.set(event.storyUrl, event.rankPosition);
    rankEventsByRun.set(event.runId, run);
  }
  const correlations: number[] = [];
  for (const ranked of rankEventsByRun.values()) {
    const rows = [...ranked.entries()].map(([url, rank]) => ({ rank, wants: candidateFromSnapshot(votes.get(url)?.snapshotJson ?? "")?.assessment?.readerWants ?? null }))
      .filter((row): row is { rank: number; wants: number } => row.wants !== null);
    // Rank 1 is strongest, so negate it to align with "higher reader_wants is stronger".
    const value = spearman(rows.map((row) => -row.rank), rows.map((row) => row.wants));
    if (value !== null) correlations.push(value);
  }

  return {
    labelledStories: votes.size,
    labelEvents: events.length,
    questionHashes: [...new Set(events.map((event) => event.questionHash))],
    consistency: {
      pairs,
      sameDecision,
      sameAsPublish,
      rate: pairs ? sameDecision / pairs : null,
      publishAgreementRate: pairs ? sameAsPublish / pairs : null
    },
    paired: {
      gateOnly: estimate(gateOnly),
      jevOnly: estimate(jevOnly),
      decided: decided.length,
      jevRight: jevRightVotes.length,
      gateRight: decided.length - jevRightVotes.length,
      jevRightShareWeighted: totalWeight ? jevWeight / totalWeight : null,
      jevRightShareRaw: decided.length ? jevRightVotes.length / decided.length : null
    },
    anchors: { bothIn: estimate(ofKind("anchor-both-in")), bothOut: estimate(ofKind("anchor-both-out")) },
    droppedPool: { ...estimate(dropped), days: droppedDays.size, rescuedPerDay: droppedDays.size ? droppedPublish / droppedDays.size : null },
    ranking: {
      n: scored.length,
      readerWantsAuc: auc(wants.map((item) => ({ score: item.readerWants, positive: item.publish }))),
      rerankerAuc: auc(relevance.map((item) => ({ score: item.relevance, positive: item.publish }))),
      confidentLowButPublished: wants.filter((item) => item.readerWants < 0.2 && item.publish).length,
      rankRuns: correlations.length,
      meanRankCorrelation: correlations.length ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length : null
    }
  };
}
