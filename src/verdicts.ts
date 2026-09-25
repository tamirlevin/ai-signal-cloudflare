import type { SupplementalShadowReport, TriageScoredItem } from "./contracts";

export type JevRecommendation = { recommendation: "publish" | "reject"; confident: boolean };

/**
 * Jev's implied publish/reject recommendation from one row's answers.
 * Publish needs all four: substantive, novel, a real interest fit, and the
 * reader's want. Fit and want are separate on purpose: a story can match a
 * topic without deserving attention, and taste shifts over time while topics
 * stay put. Unscored rows fail closed to a non-confident reject, except a
 * missing want alone is not confident (the taste model may simply not know yet).
 * Thresholds are the v1 calibration knobs for the promotion rule.
 */
export function jevRecommendation(scores: { substantive: number | null; novel: number | null; interest: string | null; readerWants: number | null }): JevRecommendation {
  const substantive = scores.substantive ?? -1;
  const novel = scores.novel ?? -1;
  const wants = scores.readerWants ?? -1;
  const fit = scores.interest !== null && scores.interest !== "none";
  if (substantive >= 0.5 && novel >= 0.5 && fit && wants >= 0.5) {
    return { recommendation: "publish", confident: substantive >= 0.8 && novel >= 0.8 && wants >= 0.8 };
  }
  const measuredLow = (scores.substantive !== null && scores.substantive < 0.2)
    || (scores.readerWants !== null && scores.readerWants < 0.2);
  return { recommendation: "reject", confident: measuredLow || scores.interest === "none" };
}

export type JevDisagreement = {
  url: string;
  title: string;
  issueDate: string;
  gateOutcome: TriageScoredItem["outcome"];
  rerankerRelevance: number | null;
  rerankerRank: number | null;
  rerankerInterest: string | null;
  jevInterest: string | null;
  jevInterestConfidence: number | null;
  jevNovel: number | null;
  jevSubstantive: number | null;
  jevReaderWants: number | null;
  jevRecommendation: "publish" | "reject";
  jevConfident: boolean;
};

const MAX_DISAGREEMENTS = 20;

/**
 * Rows where Jev's recommendation and the gate outcome point opposite ways:
 * published-but-panned or rejected-but-praised. Confident disagreements first.
 * Rows Jev never scored are not disagreements; they are unscored.
 */
export function findJevDisagreements(
  report: Pick<SupplementalShadowReport, "baseIssue" | "triageScores" | "jevScores">,
  decidedUrls: Set<string> = new Set()
): JevDisagreement[] {
  const triageByUrl = new Map((report.triageScores ?? []).map((entry) => [entry.url, entry]));
  const found: JevDisagreement[] = [];
  for (const jev of report.jevScores ?? []) {
    if (decidedUrls.has(jev.url)) continue;
    const rec = jevRecommendation({ substantive: jev.substantive, novel: jev.novel, interest: jev.interest, readerWants: jev.readerWants });
    const published = jev.outcome === "selected";
    if ((rec.recommendation === "publish") === published) continue;
    const triage = triageByUrl.get(jev.url);
    found.push({
      url: jev.url,
      title: jev.title,
      issueDate: report.baseIssue.issueDate,
      gateOutcome: jev.outcome,
      rerankerRelevance: triage?.relevance ?? null,
      rerankerRank: triage?.rank ?? null,
      rerankerInterest: triage?.winningInterest ?? null,
      jevInterest: jev.interest,
      jevInterestConfidence: jev.interestConfidence,
      jevNovel: jev.novel,
      jevSubstantive: jev.substantive,
      jevReaderWants: jev.readerWants,
      jevRecommendation: rec.recommendation,
      jevConfident: rec.confident
    });
  }
  const distance = (entry: JevDisagreement): number => entry.jevSubstantive === null ? 0 : Math.abs(entry.jevSubstantive - 0.5);
  return found
    .sort((left, right) => Number(right.jevConfident) - Number(left.jevConfident) || distance(right) - distance(left))
    .slice(0, MAX_DISAGREEMENTS);
}

export type JevVerdictRow = {
  storyUrl: string;
  storyTitle: string;
  issueDate: string;
  rerankerRelevance: number | null;
  rerankerRank: number | null;
  rerankerInterest: string | null;
  jevInterest: string | null;
  jevInterestConfidence: number | null;
  jevNovel: number | null;
  jevSubstantive: number | null;
  jevReaderWants: number | null;
  jevRecommendation: "publish" | "reject";
  jevConfident: boolean;
  gateOutcome: string;
  verdict: 1 | -1;
  createdAt: string;
  updatedAt: string;
};

export type JevVerdictStats = {
  total: number;
  publishVerdicts: number;
  rejectVerdicts: number;
  /** Share of verdicts matching Jev's recommendation. Promotion needs >= 0.7 over 14 days. */
  sidedWithJev: number;
  /** Owner-wanted stories inside Jev's confident rejects. Promotion needs < 1. */
  confidentRejectMisses: number;
};

/**
 * Agreement accounting for the fixed promotion rule. A +1 verdict means the
 * owner would publish the story; -1 means correctly rejected.
 */
export function jevVerdictStats(rows: JevVerdictRow[]): JevVerdictStats {
  let sided = 0;
  let misses = 0;
  let publishVerdicts = 0;
  for (const row of rows) {
    if (row.verdict === 1) publishVerdicts += 1;
    const jevSaysPublish = row.jevRecommendation === "publish";
    if ((row.verdict === 1) === jevSaysPublish) sided += 1;
    if (row.jevRecommendation === "reject" && row.jevConfident && row.verdict === 1) misses += 1;
  }
  return {
    total: rows.length,
    publishVerdicts,
    rejectVerdicts: rows.length - publishVerdicts,
    sidedWithJev: rows.length ? sided / rows.length : 0,
    confidentRejectMisses: misses
  };
}
