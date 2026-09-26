export const DEFAULT_PROFILE: Profile = {
  version: 2,
  sourcePackId: "core-ai",
  storyBudget: 7,
  storyBudgetRange: [5, 14],
  exceptionalStoryOverride: true,
  safeguards: { watchPermissions: true, watchGeography: true },
  weights: [
    { id: "agents", label: "Agents in practice", value: 3 },
    { id: "codex", label: "Codex & agent craft", value: 4 },
    { id: "newSystems", label: "New systems", value: 3 },
    { id: "integration", label: "Integration & platforms", value: 3 },
    { id: "business", label: "AI business & economics", value: 3 },
    { id: "frontier", label: "Frontier signals", value: 1 },
    { id: "research", label: "AI research & science", value: 1 },
    { id: "harness", label: "Model–harness co-design", value: 2 },
    { id: "newly", label: "Newly detected", value: 3 },
    { id: "lowFit", label: "Policy, cyber & infrastructure", value: 1 },
    { id: "training", label: "Pre-training, training & data", value: 1 }
  ],
  pinnedCategories: ["Model–harness co-design"],
  watching: ["Agent permission design", "AI cluster geography"]
};

export type Weight = { id: string; label: string; value: number };
export type SourcePackId = "core-ai";
export type Profile = {
  version: number;
  sourcePackId: SourcePackId;
  storyBudget: number;
  storyBudgetRange: [number, number];
  exceptionalStoryOverride: boolean;
  safeguards: { watchPermissions: boolean; watchGeography: boolean };
  weights: Weight[];
  pinnedCategories: string[];
  watching: string[];
};

export type Source = { label: string; url: string };
export type StorySourceId = SupplementalSourceId;
export type StorySourceAttribution = {
  id: StorySourceId;
  name: string;
  layer: "editorial" | "primary";
};
/** `direct` means a usable non-aggregator link supplied by a source; it is not independently verified. */
export type StoryEvidence = Source & { kind: "direct" | "primary" };
export type StoryCoverage = {
  editorialSourceIds: Array<"ainews" | Exclude<SupplementalSourceId, "cloudflare-agents">>;
  editorialSourceCount: number;
  primaryEvidenceCount: number;
  boost: number;
};
export type StoryProvenance = {
  clusterId: string;
  lead: StorySourceAttribution;
  /** Editorial agreement is useful discovery context, but is not primary evidence. */
  editorialCorroboration: StorySourceAttribution[];
  evidence: StoryEvidence[];
  coverage?: StoryCoverage;
  selection: {
    score: number;
    reason: "ainews-base" | "cross-source" | "strong-fit-supplemental" | "single-source";
  };
};
export type RankedItem = {
  title: string;
  category: string;
  base: number;
  exceptional?: boolean;
  watchPermission?: boolean;
  watchGeography?: boolean;
  provenance?: StoryProvenance;
};

export type Signal = RankedItem & {
  candidateId?: number;
  summary: string;
  source: string;
  date?: string;
  url: string;
  categoryLabel: string;
};

export type HotTopic = RankedItem & { summary: string; sources: Source[] };

export type Edition = {
  schemaVersion: 1;
  issue: { publicationDate: string; coverage: string; url: string; quiet: boolean };
  collection?: LegacyCollection | DailyCollection;
  presentation: {
    hotTitle: string;
    hotIntro: string;
    allTitle: string;
    allIntro: string;
    synthesisTitle: string;
    synthesisIntro: string;
    sourceReadMinutes: number;
    briefReadMinutes: number;
  };
  synthesis: {
    lead: string;
    bigPicture: string;
    sources: Source[];
    sections: Array<{ title: string; kicker: string; body: string; sources: Source[] }>;
  };
  hotTopics: HotTopic[];
  signals: Signal[];
  profile?: Profile;
};

export type StoredEdition = Edition & {
  id: string;
  issueDate: string;
  publishedAt: string;
};

export type RssIssue = {
  url: string;
  issueDate: string;
  publicationDate: string;
  publishedAt: string;
  body: string;
  anchors: Source[];
};

export type CandidateStory = {
  id: number;
  title: string;
  summary: string;
  category: string;
  categoryLabel: string;
  score: number;
  exceptional: boolean;
  watchPermission: boolean;
  watchGeography: boolean;
  sources: Source[];
  publishedAt?: string;
  provenance?: StoryProvenance;
  /** Compact collector context used only for synthesis input; it is not published. */
  modelText?: string;
};
/** One recorded merge/drop decision: a selected candidate folded into another card (or rejected) before publication. */
export type CandidateMerge = {
  id: number;
  /** Surviving candidate id, or null when rejected outright. */
  intoId: number | null;
  reason: "duplicate-url" | "duplicate-title" | "duplicate-text" | "product-version" | "invalid-candidate";
  key: string;
};

export type RunResult =
  | { status: "success"; edition: StoredEdition }
  | { status: "skipped"; reason: "already-published" | "manual-republish-limit" }
  | { status: "failed"; code: string; reason?: string };

export type ModelAttemptAudit = {
  attempt: number;
  model: string;
  outcome: "success" | "timeout" | "output-truncated" | "invalid-json" | "validation" | "failed";
  durationMs: number;
  finishReason?: string;
  incompleteReason?: string;
  completionTokens?: number;
  reasoningTokens?: number;
  contentChars?: number;
  error?: string;
};

export type RunStatus = {
  trigger: "cron" | "manual" | "local-scheduled";
  status: "success" | "failed" | "skipped";
  issueDate?: string;
  errorCode?: string;
  failureDetail?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type ScheduledHeartbeat = {
  status: "healthy" | "stale" | "missing";
  staleAfterHours: number;
  lastCompletedAt?: string;
  lastOutcome?: RunStatus["status"];
};

export type LegacyCollection = {
  mode: "ainews-only" | "blended";
  baseSource: "AInews";
  editorialDiscovery: string[];
  primaryEvidenceFeeds: string[];
  selectedSupplemental: number;
  supplementalCap: number;
  sourcePackId?: SourcePackId;
  sourcePackVersion?: number;
};

export type DailyCollection = {
  mode: "daily-pool";
  sourcesChecked: string[];
  sourcesContributing: string[];
  preferredFreshnessHours: 36;
  maxFreshnessHours: 48 | 72;
  eligibleCandidates: number;
  selectedCandidates: number;
  sourcePackId?: SourcePackId;
  sourcePackVersion?: number;
};

export type SupplementalSourceId = "ainews" | "tldr-ai" | "alphasignal" | "ai-secret" | "mts-situations" | "ai-brief" | "cloudflare-agents";
export type SourcePackSource = {
  id: SupplementalSourceId;
  name: string;
  kind: "discovery" | "primary";
  url: string;
  enabled: boolean;
  lookbackHours?: number;
  enrichLimit?: number;
};

export type SourcePack = {
  id: SourcePackId;
  version: number;
  label: string;
  description: string;
  sources: SourcePackSource[];
};
export type SupplementalCandidateFunnel = {
  /** Distinct in-window clusters that include this source after deduplication. */
  inWindow: number;
  /** Same-source candidates merged into another in-window cluster; not discarded coverage. */
  merged: number;
  qualified: number;
  selected: number;
  filtered: {
    outsideWindow: number;
    noUsableEvidence: number;
    weakProfileFit: number;
    rankedOut: number;
  };
};
export type TriageScoredItem = {
  url: string;
  title: string;
  relevance: number | null;
  /** Raw combined reranker score before per-run normalization; comparable only within its run. */
  rawRelevance: number | null;
  /** Per-interest query with the highest raw score; null when unscored. Weights gate queries, never scale scores. */
  winningInterest: string | null;
  /** Dense rank by relevance within the run (1 = best); null when unscored. */
  rank: number | null;
  novelty: number | null;
  outcome: "selected" | "rankedOut" | "noUsableEvidence" | "weakProfileFit";
  sourceIds: SupplementalSourceId[];
};
export type JevScoredItem = {
  url: string;
  title: string;
  summary?: string;
  publishedAt?: string;
  sourceIds?: SupplementalSourceId[];
  /** Best-fit reader interest, or "none"; null when unscored. */
  interest: string | null;
  interestConfidence: number | null;
  /** Probability the story is materially new vs pre-today editions; null when unscored. */
  novel: number | null;
  /** Probability the story is substantive rather than promotional; null when unscored. */
  substantive: number | null;
  /** Probability the reader would want this story; null when unscored. */
  readerWants: number | null;
  outcome: TriageScoredItem["outcome"];
};
export type SupplementalSourceHealth = {
  id: SupplementalSourceId;
  name: string;
  status: "healthy" | "degraded" | "failed";
  /** Candidate yield is separate from transport/parser health. */
  yieldStatus?: "active" | "quiet" | "unknown";
  requests: number;
  fetchedItems: number;
  acceptedCandidates: number;
  funnel?: SupplementalCandidateFunnel;
  errors: string[];
};
export type SupplementalAttribution = {
  sourceId: SupplementalSourceId;
  sourceName: string;
  kind: "discovery" | "primary";
  sourceUrl: string;
};
export type SupplementalCandidate = {
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  category: string;
  categoryLabel: string;
  score: number;
  exceptional: boolean;
  /** Source selected for this candidate's title/summary framing; not a first-seen timestamp claim. */
  leadSourceId?: SupplementalSourceId;
  sourceAttributions: SupplementalAttribution[];
};
export type ShadowCandidate = Pick<SupplementalCandidate, "title" | "summary" | "url" | "publishedAt" | "category" | "categoryLabel" | "score"> & {
  sourceIds: SupplementalSourceId[];
  sourceNames: string[];
  /** Advisory classifier scores; never gates selection. Absent unless triage shadow scoring ran. */
  triage?: { relevance: number | null; novelty: number | null };
};
export type SupplementalShadowReport = {
  schemaVersion: 1;
  mode: "shadow" | "blend" | "daily-pool";
  generatedAt: string;
  /** Profile and Jev question context used for the shadow evaluation. */
  profileVersion?: number;
  jevQuestionSetVersion?: string;
  jevQuestions?: Record<string, unknown>;
  baseIssue: { url: string; issueDate: string; publicationDate: string };
  sourcePack?: { id: SourcePackId; version: number };
  limits: { modelCandidates: 18; publishedStories: 14; tldr?: 3; alphaSignal?: 2; cloudflare?: 1 };
  freshness?: { preferredHours: 36; maxHours: 48 | 72; eligibleCandidates: number; expiredCandidates: number };
  sources: SupplementalSourceHealth[];
  totals: {
    aiNewsCandidates: number;
    supplementalCandidates: number;
    supplementalAfterDeduplication: number;
    overlapsWithAiNews: number;
    novelQualifiedCandidates: number;
    wouldAdd: number;
    selectedForBlend?: number;
  };
  overlaps: Array<{ supplementalTitle: string; aiNewsTitle: string; preferredUrl: string; sourceIds: SupplementalSourceId[] }>;
  wouldAdd: ShadowCandidate[];
  selectedForBlend?: ShadowCandidate[];
  /** Advisory per-item triage log over the full fresh pool, not just the selected. Absent unless triage shadow scoring ran. */
  triageScores?: TriageScoredItem[];
  /** Advisory per-item Jev log over the full fresh pool. Absent unless Jev shadow scoring ran. */
  jevScores?: JevScoredItem[];
};
export type SupplementalShadowRun = {
  id: string;
  trigger: "cron" | "manual" | "local-scheduled";
  status: "healthy" | "degraded" | "failed";
  baseIssueUrl?: string;
  baseIssueDate?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  report?: SupplementalShadowReport;
  errorCode?: string;
  errorMessage?: string;
};
