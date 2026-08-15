export const DEFAULT_PROFILE: Profile = {
  version: 2,
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
export type Profile = {
  version: number;
  storyBudget: number;
  storyBudgetRange: [number, number];
  exceptionalStoryOverride: boolean;
  safeguards: { watchPermissions: boolean; watchGeography: boolean };
  weights: Weight[];
  pinnedCategories: string[];
  watching: string[];
};

export type Source = { label: string; url: string };
export type RankedItem = {
  title: string;
  category: string;
  base: number;
  exceptional?: boolean;
  watchPermission?: boolean;
  watchGeography?: boolean;
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
};

export type RunResult =
  | { status: "success"; edition: StoredEdition }
  | { status: "skipped"; reason: "already-published" }
  | { status: "failed"; code: string; reason?: string };

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

export type SupplementalSourceId = "tldr-ai" | "alphasignal" | "cloudflare-agents";
export type SupplementalSourceHealth = {
  id: SupplementalSourceId;
  name: string;
  status: "healthy" | "degraded" | "failed";
  requests: number;
  fetchedItems: number;
  acceptedCandidates: number;
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
  sourceAttributions: SupplementalAttribution[];
};
export type ShadowCandidate = Pick<SupplementalCandidate, "title" | "summary" | "url" | "publishedAt" | "category" | "categoryLabel" | "score"> & {
  sourceIds: SupplementalSourceId[];
  sourceNames: string[];
};
export type SupplementalShadowReport = {
  schemaVersion: 1;
  mode: "shadow";
  generatedAt: string;
  baseIssue: { url: string; issueDate: string; publicationDate: string };
  limits: { modelCandidates: 18; publishedStories: 14; tldr: 3; alphaSignal: 2; cloudflare: 1 };
  sources: SupplementalSourceHealth[];
  totals: {
    aiNewsCandidates: number;
    supplementalCandidates: number;
    supplementalAfterDeduplication: number;
    overlapsWithAiNews: number;
    novelQualifiedCandidates: number;
    wouldAdd: number;
  };
  overlaps: Array<{ supplementalTitle: string; aiNewsTitle: string; preferredUrl: string; sourceIds: SupplementalSourceId[] }>;
  wouldAdd: ShadowCandidate[];
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
