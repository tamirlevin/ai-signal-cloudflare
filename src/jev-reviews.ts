import type { JevScoredItem, SupplementalShadowReport, TriageScoredItem } from "./contracts";
import { jevRecommendation } from "./verdicts";

export const JEV_REVIEW_BATCH_SIZE = 12;
const PER_STRATUM = 3;

export type JevReviewStratum =
  | "pipeline-selected_jev-publish"
  | "pipeline-selected_jev-reject"
  | "pipeline-excluded_jev-publish"
  | "pipeline-excluded_jev-reject";

export type JevReviewBatchItem = JevScoredItem & {
  sampleStratum: JevReviewStratum;
  pipelineOutcome: JevScoredItem["outcome"];
  jevRecommendation: "publish" | "reject";
  jevConfident: boolean;
  reranker: Pick<TriageScoredItem, "relevance" | "rawRelevance" | "winningInterest" | "rank" | "novelty"> | null;
};

function hasAnswer(item: JevScoredItem): boolean {
  return item.interest !== null || item.novel !== null || item.substantive !== null || item.readerWants !== null;
}

function seededHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function stratum(item: JevScoredItem, recommendation: "publish" | "reject"): JevReviewStratum {
  const selected = item.outcome === "selected";
  if (selected && recommendation === "publish") return "pipeline-selected_jev-publish";
  if (selected) return "pipeline-selected_jev-reject";
  if (recommendation === "publish") return "pipeline-excluded_jev-publish";
  return "pipeline-excluded_jev-reject";
}

/**
 * Makes a stable, small stratified sample of Jev-scored candidates. Each
 * available agreement/disagreement group contributes up to three rows before
 * remaining places are filled from the rest of the scored pool.
 */
export function buildJevReviewBatch(runId: string, report: SupplementalShadowReport): JevReviewBatchItem[] {
  const triageByUrl = new Map((report.triageScores ?? []).map((item) => [item.url, item]));
  const assessed = (report.jevScores ?? [])
    .filter((item) => hasAnswer(item) && item.outcome !== "noUsableEvidence")
    .map((item) => {
      const recommendation = jevRecommendation({
        substantive: item.substantive,
        novel: item.novel,
        interest: item.interest,
        readerWants: item.readerWants
      });
      const reranker = triageByUrl.get(item.url);
      return {
        ...item,
        sourceIds: item.sourceIds ?? [],
        summary: item.summary ?? "",
        publishedAt: item.publishedAt ?? "",
        sampleStratum: stratum(item, recommendation.recommendation),
        pipelineOutcome: item.outcome,
        jevRecommendation: recommendation.recommendation,
        jevConfident: recommendation.confident,
        reranker: reranker ? {
          relevance: reranker.relevance,
          rawRelevance: reranker.rawRelevance,
          winningInterest: reranker.winningInterest,
          rank: reranker.rank,
          novelty: reranker.novelty
        } : null
      } satisfies JevReviewBatchItem;
    });
  const bySampleOrder = (left: JevReviewBatchItem, right: JevReviewBatchItem): number =>
    seededHash(`${runId}:${left.url}`) - seededHash(`${runId}:${right.url}`) || left.url.localeCompare(right.url);
  const strata: JevReviewStratum[] = [
    "pipeline-selected_jev-publish",
    "pipeline-selected_jev-reject",
    "pipeline-excluded_jev-publish",
    "pipeline-excluded_jev-reject"
  ];
  const selected = new Map<string, JevReviewBatchItem>();
  for (const name of strata) {
    for (const item of assessed.filter((candidate) => candidate.sampleStratum === name).sort(bySampleOrder).slice(0, PER_STRATUM)) {
      selected.set(item.url, item);
    }
  }
  for (const item of assessed.filter((candidate) => !selected.has(candidate.url)).sort(bySampleOrder)) {
    if (selected.size >= JEV_REVIEW_BATCH_SIZE) break;
    selected.set(item.url, item);
  }
  return [...selected.values()].sort(bySampleOrder).slice(0, JEV_REVIEW_BATCH_SIZE);
}
