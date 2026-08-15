import type {
  CandidateStory,
  Profile,
  RssIssue,
  SupplementalAttribution,
  SupplementalCandidate,
  SupplementalShadowReport,
  SupplementalSourceHealth,
  SupplementalSourceId
} from "./contracts";
import { categoryForProfile, compactIssueInventory, isPermissionDesignSignal, scoreCandidateForProfile } from "./editorial";
import { fetchLatestRss } from "./rss";
import { getActiveProfile, recordSupplementalShadowRun } from "./repository";

type Fetcher = typeof fetch;
export type SourceResult = { candidates: SupplementalCandidate[]; health: SupplementalSourceHealth };
type SourceDefinition = {
  id: SupplementalSourceId;
  name: string;
  kind: "discovery" | "primary";
  url: string;
};

const SOURCES = {
  tldr: { id: "tldr-ai", name: "TLDR AI", kind: "discovery", url: "https://tldr.tech/api/rss/ai" },
  alpha: { id: "alphasignal", name: "AlphaSignal", kind: "discovery", url: "https://alphasignal.ai/sitemaps/news.xml" },
  cloudflare: { id: "cloudflare-agents", name: "Cloudflare Agents", kind: "primary", url: "https://blog.cloudflare.com/tag/agents/rss" }
} as const satisfies Record<string, SourceDefinition>;

const SOURCE_CAPS: Record<SupplementalSourceId, number> = {
  "tldr-ai": 3,
  alphasignal: 2,
  "cloudflare-agents": 1
};
const AGGREGATOR_HOSTS = new Set(["alphasignal.ai", "news.smol.ai", "tldr.tech", "www.alphasignal.ai", "www.tldr.tech"]);
const NON_EVIDENCE_HOSTS = new Set(["calendly.com", "forms.gle", "tally.so", "typeform.com", "www.googletagmanager.com"]);
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with"]);
const MAX_FEED_BYTES = 2_000_000;
const MAX_PAGE_BYTES = 2_500_000;
const ALPHA_ENRICH_LIMIT = 5;

function sourceHealth(source: SourceDefinition): SupplementalSourceHealth {
  return { id: source.id, name: source.name, status: "healthy", requests: 0, fetchedItems: 0, acceptedCandidates: 0, errors: [] };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity.toLowerCase()] ?? _);
}

function plainText(value: string): string {
  return decodeEntities(value.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match?.[1]?.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, "$1").trim() ?? "";
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "gi"))].map((match) => match[1] ?? "");
}

function isoDate(value: string): string | undefined {
  const date = new Date(decodeEntities(plainText(value)));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function canonicalizeSupplementalUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    if (url.protocol !== "https:") return undefined;
    url.hash = "";
    const trackingKeys: string[] = [];
    url.searchParams.forEach((_value, key) => {
      if (/^(?:utm_.+|fbclid|gclid|ref|source|campaign|medium)$/i.test(key)) trackingKeys.push(key);
    });
    for (const key of trackingKeys) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return undefined;
  }
}

async function boundedText(fetcher: Fetcher, url: string, maxBytes: number, accept: string): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: accept } });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`${new URL(url).hostname} response is too large`);
  const text = await response.text();
  if (text.length > maxBytes) throw new Error(`${new URL(url).hostname} response is too large`);
  return text;
}

function attribution(source: SourceDefinition, sourceUrl: string): SupplementalAttribution {
  return { sourceId: source.id, sourceName: source.name, kind: source.kind, sourceUrl };
}

function exceptional(text: string): boolean {
  return /\b(?:first[- ]ever|breakthrough|unprecedented|new state[- ]of[- ]the[- ]art)\b/i.test(text);
}

function prepareCandidate(input: Omit<SupplementalCandidate, "category" | "categoryLabel" | "score" | "exceptional">, profile: Profile): SupplementalCandidate {
  const evidence = `${input.title} ${input.summary}`;
  const category = categoryForProfile(evidence, profile);
  return { ...input, category: category.id, categoryLabel: category.label, score: scoreCandidateForProfile(evidence, profile), exceptional: exceptional(evidence) };
}

export function parseTldrFeed(xml: string): Array<{ title: string; url: string; publishedAt: string }> {
  return blocks(xml, "item").map((item) => ({
    title: plainText(tag(item, "title")),
    url: canonicalizeSupplementalUrl(plainText(tag(item, "link"))) ?? "",
    publishedAt: isoDate(tag(item, "pubDate")) ?? ""
  })).filter((item) => item.title && item.url && item.publishedAt);
}

function promotionalTldrStory(title: string): boolean {
  return /\b(?:sponsor|sponsored|advertisement)\b/i.test(title) || /\b(?:hiring|job|jobs)\b/i.test(title) || /^⚡/.test(title);
}

export function parseTldrIssue(html: string, issue: { url: string; publishedAt: string }, profile: Profile): SupplementalCandidate[] {
  const candidates: SupplementalCandidate[] = [];
  for (const article of blocks(html, "article")) {
    const rawTitle = plainText(tag(article, "h3"));
    const title = rawTitle.replace(/\s*\(\d+\s+minute read\)\s*$/i, "").trim();
    if (!title || promotionalTldrStory(rawTitle)) continue;
    const anchor = article.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<h3\b/i) ?? article.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
    const url = canonicalizeSupplementalUrl(anchor?.[1] ?? "", issue.url);
    if (!url) continue;
    const summaryBlock = article.match(/<[^>]+class=["'][^"']*newsletter-html[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] ?? "";
    const summary = plainText(summaryBlock) || title;
    candidates.push(prepareCandidate({
      title,
      summary: summary.slice(0, 600),
      url,
      publishedAt: issue.publishedAt,
      sourceAttributions: [attribution(SOURCES.tldr, issue.url)]
    }, profile));
  }
  return candidates;
}

function titleFromAlphaUrl(value: string): string {
  try {
    const slug = new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? "";
    return slug.replace(/-/g, " ").replace(/\b(?:ai|api|mcp|gpt|llm)\b/gi, (word) => word.toUpperCase()).replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
  } catch {
    return "";
  }
}

export function parseAlphaSitemap(xml: string, now: Date): Array<{ title: string; url: string; publishedAt: string }> {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  return blocks(xml, "url").map((entry) => ({
    title: titleFromAlphaUrl(plainText(tag(entry, "loc"))),
    url: canonicalizeSupplementalUrl(plainText(tag(entry, "loc"))) ?? "",
    publishedAt: isoDate(tag(entry, "lastmod")) ?? ""
  })).filter((item) => item.title && item.url && item.publishedAt && new Date(item.publishedAt).getTime() >= cutoff).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}

function evidenceUrlScore(title: string, anchorText: string, value: string): number {
  try {
    const url = new URL(value);
    const titleTokens = tokenSet(title);
    const linkTokens = tokenSet(`${anchorText} ${url.hostname} ${decodeURIComponent(url.pathname)}`);
    const overlap = [...titleTokens].filter((token) => linkTokens.has(token)).length;
    const pathBonus = /\/(?:article|blog|changelog|news|post|press|research|releases?)(?:\/|$)/i.test(url.pathname) ? 4 : 0;
    const specificity = url.pathname.replace(/\/+$/, "").length > 1 || url.search.length > 1 ? 1 : -5;
    return overlap + pathBonus + specificity;
  } catch {
    return -100;
  }
}

export function parseAlphaArticle(html: string, articleUrl: string): { title: string; summary: string; preferredUrl: string } {
  const heading = plainText(tag(html, "h1"));
  const description = plainText(html.match(/<meta\b[^>]*(?:name=["']description["']|property=["']og:description["'])[^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:name=["']description["']|property=["']og:description["'])[^>]*>/i)?.[1] ?? "");
  const links = new Map<string, string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = canonicalizeSupplementalUrl(match[1] ?? "", articleUrl);
    if (!url) continue;
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (AGGREGATOR_HOSTS.has(parsed.hostname) || NON_EVIDENCE_HOSTS.has(host) || host.endsWith(".typeform.com") || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(parsed.pathname)) continue;
    if ((host === "x.com" || host === "twitter.com") && !/\/status\/\d+/i.test(parsed.pathname)) continue;
    links.set(url, `${links.get(url) ?? ""} ${plainText(match[2] ?? "")}`.trim());
  }
  const preferredUrl = [...links.entries()].sort((left, right) => evidenceUrlScore(heading, right[1], right[0]) - evidenceUrlScore(heading, left[1], left[0]))[0]?.[0] ?? articleUrl;
  return { title: heading || titleFromAlphaUrl(articleUrl), summary: description || heading || titleFromAlphaUrl(articleUrl), preferredUrl };
}

export function parseCloudflareFeed(xml: string, now: Date, profile: Profile): SupplementalCandidate[] {
  const cutoff = now.getTime() - 3 * 24 * 60 * 60 * 1000;
  return blocks(xml, "item").map((item) => {
    const title = plainText(tag(item, "title"));
    const url = canonicalizeSupplementalUrl(plainText(tag(item, "link"))) ?? "";
    const publishedAt = isoDate(tag(item, "pubDate")) ?? "";
    const summary = plainText(tag(item, "description")) || title;
    return { title, url, publishedAt, summary };
  }).filter((item) => item.title && item.url && item.publishedAt && new Date(item.publishedAt).getTime() >= cutoff).map((item) => prepareCandidate({ ...item, sourceAttributions: [attribution(SOURCES.cloudflare, item.url)] }, profile));
}

async function collectTldr(profile: Profile, fetcher: Fetcher): Promise<SourceResult> {
  const health = sourceHealth(SOURCES.tldr);
  try {
    health.requests += 1;
    const feed = await boundedText(fetcher, SOURCES.tldr.url, MAX_FEED_BYTES, "application/rss+xml, application/xml;q=0.9");
    const issue = parseTldrFeed(feed)[0];
    health.fetchedItems = issue ? 1 : 0;
    if (!issue) throw new Error("TLDR feed contains no current issue");
    health.requests += 1;
    const html = await boundedText(fetcher, issue.url, MAX_PAGE_BYTES, "text/html");
    const candidates = parseTldrIssue(html, issue, profile);
    health.acceptedCandidates = candidates.length;
    if (!candidates.length) health.status = "failed";
    return { candidates, health };
  } catch (error) {
    health.status = "failed";
    health.errors.push(error instanceof Error ? error.message : String(error));
    return { candidates: [], health };
  }
}

async function collectAlpha(profile: Profile, now: Date, fetcher: Fetcher): Promise<SourceResult> {
  const health = sourceHealth(SOURCES.alpha);
  try {
    health.requests += 1;
    const sitemap = await boundedText(fetcher, SOURCES.alpha.url, MAX_FEED_BYTES, "application/xml, text/xml;q=0.9");
    const recent = parseAlphaSitemap(sitemap, now);
    health.fetchedItems = recent.length;
    const prioritized = recent.map((item) => ({ ...item, score: scoreCandidateForProfile(item.title, profile) })).sort((left, right) => right.score - left.score || right.publishedAt.localeCompare(left.publishedAt)).slice(0, ALPHA_ENRICH_LIMIT);
    const enriched = await Promise.all(prioritized.map(async (item) => {
      try {
        health.requests += 1;
        const html = await boundedText(fetcher, item.url, MAX_PAGE_BYTES, "text/html");
        const article = parseAlphaArticle(html, item.url);
        return prepareCandidate({ title: article.title, summary: article.summary.slice(0, 600), url: article.preferredUrl, publishedAt: item.publishedAt, sourceAttributions: [attribution(SOURCES.alpha, item.url)] }, profile);
      } catch (error) {
        health.status = "degraded";
        health.errors.push(error instanceof Error ? error.message : String(error));
        return prepareCandidate({ title: item.title, summary: item.title, url: item.url, publishedAt: item.publishedAt, sourceAttributions: [attribution(SOURCES.alpha, item.url)] }, profile);
      }
    }));
    health.acceptedCandidates = enriched.length;
    if (!enriched.length) health.status = "failed";
    return { candidates: enriched, health };
  } catch (error) {
    health.status = "failed";
    health.errors.push(error instanceof Error ? error.message : String(error));
    return { candidates: [], health };
  }
}

async function collectCloudflare(profile: Profile, now: Date, fetcher: Fetcher): Promise<SourceResult> {
  const health = sourceHealth(SOURCES.cloudflare);
  try {
    health.requests += 1;
    const feed = await boundedText(fetcher, SOURCES.cloudflare.url, MAX_FEED_BYTES, "application/rss+xml, application/xml;q=0.9");
    const candidates = parseCloudflareFeed(feed, now, profile);
    health.fetchedItems = blocks(feed, "item").length;
    health.acceptedCandidates = candidates.length;
    return { candidates, health };
  } catch (error) {
    health.status = "failed";
    health.errors.push(error instanceof Error ? error.message : String(error));
    return { candidates: [], health };
  }
}

function tokenSet(title: string): Set<string> {
  return new Set(plainText(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

export function titleSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size < 3 || rightTokens.size < 3) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return Math.max(intersection / union, (intersection / Math.min(leftTokens.size, rightTokens.size)) * 0.9);
}

function productVersionKey(title: string): string | undefined {
  const tokens = plainText(title).toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim().split(/\s+/);
  const versionIndex = tokens.findIndex((token) => /^(?:v\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*|(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]+)$/i.test(token));
  return versionIndex < 0 ? undefined : tokens.slice(Math.max(0, versionIndex - 1), versionIndex + 1).join(":");
}

function sameStory(left: { title: string; url: string }, right: { title: string; url: string }): boolean {
  const leftUrl = canonicalizeSupplementalUrl(left.url);
  const rightUrl = canonicalizeSupplementalUrl(right.url);
  if (leftUrl && rightUrl && leftUrl === rightUrl) return true;
  const leftProduct = productVersionKey(left.title);
  const rightProduct = productVersionKey(right.title);
  if (leftProduct && rightProduct && leftProduct === rightProduct) return true;
  return titleSimilarity(left.title, right.title) >= 0.62;
}

function urlAuthority(value: string, primary: boolean): number {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (primary) return 4;
    if (AGGREGATOR_HOSTS.has(host)) return 0;
    if (host === "x.com" || host === "twitter.com" || host.endsWith("reddit.com")) return 1;
    return 2;
  } catch {
    return -1;
  }
}

function preferredUrl(baseUrl: string, supplemental: SupplementalCandidate): string {
  const supplementalPrimary = supplemental.sourceAttributions.some((item) => item.kind === "primary");
  return urlAuthority(supplemental.url, supplementalPrimary) > urlAuthority(baseUrl, false) ? supplemental.url : baseUrl;
}

function mergeSupplemental(left: SupplementalCandidate, right: SupplementalCandidate): SupplementalCandidate {
  const attributions = new Map<string, SupplementalAttribution>();
  for (const item of [...left.sourceAttributions, ...right.sourceAttributions]) attributions.set(`${item.sourceId}|${item.sourceUrl}`, item);
  const leftPrimary = left.sourceAttributions.some((item) => item.kind === "primary");
  const rightPrimary = right.sourceAttributions.some((item) => item.kind === "primary");
  const preferred = urlAuthority(right.url, rightPrimary) > urlAuthority(left.url, leftPrimary) || right.score > left.score ? right : left;
  return { ...preferred, score: Math.max(left.score, right.score), sourceAttributions: [...attributions.values()] };
}

export function deduplicateSupplemental(candidates: SupplementalCandidate[]): SupplementalCandidate[] {
  const merged: SupplementalCandidate[] = [];
  for (const candidate of candidates) {
    const index = merged.findIndex((current) => sameStory(current, candidate));
    if (index < 0) merged.push(candidate);
    else merged[index] = mergeSupplemental(merged[index]!, candidate);
  }
  return merged;
}

export function buildSupplementalShadowReport(input: {
  issue: RssIssue;
  aiNewsCandidates: CandidateStory[];
  sourceResults: SourceResult[];
  generatedAt: string;
}): SupplementalShadowReport {
  const collected = input.sourceResults.flatMap((result) => result.candidates);
  const deduplicated = deduplicateSupplemental(collected);
  const overlaps: SupplementalShadowReport["overlaps"] = [];
  const novel: SupplementalCandidate[] = [];
  for (const candidate of deduplicated) {
    const matchingBase = input.aiNewsCandidates.find((base) => sameStory({ title: base.title, url: base.sources[0]?.url ?? "" }, candidate));
    if (matchingBase) {
      overlaps.push({ supplementalTitle: candidate.title, aiNewsTitle: matchingBase.title, preferredUrl: preferredUrl(matchingBase.sources[0]?.url ?? candidate.url, candidate), sourceIds: [...new Set(candidate.sourceAttributions.map((item) => item.sourceId))] });
    } else if (candidate.score >= 4 || candidate.exceptional || isPermissionDesignSignal(`${candidate.title} ${candidate.summary}`)) {
      novel.push(candidate);
    }
  }
  const selected: Array<{ candidate: SupplementalCandidate; countedFor: SupplementalSourceId }> = [];
  const sourceCounts = new Map<SupplementalSourceId, number>();
  for (const candidate of [...novel].sort((left, right) => right.score - left.score || right.publishedAt.localeCompare(left.publishedAt))) {
    const source = candidate.sourceAttributions.map((item) => item.sourceId).find((id) => (sourceCounts.get(id) ?? 0) < SOURCE_CAPS[id]);
    if (!source) continue;
    selected.push({ candidate, countedFor: source });
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    if (selected.length === 6) break;
  }
  return {
    schemaVersion: 1,
    mode: "shadow",
    generatedAt: input.generatedAt,
    baseIssue: { url: input.issue.url, issueDate: input.issue.issueDate, publicationDate: input.issue.publicationDate },
    limits: { modelCandidates: 18, publishedStories: 14, tldr: 3, alphaSignal: 2, cloudflare: 1 },
    sources: input.sourceResults.map((result) => result.health),
    totals: {
      aiNewsCandidates: input.aiNewsCandidates.length,
      supplementalCandidates: collected.length,
      supplementalAfterDeduplication: deduplicated.length,
      overlapsWithAiNews: overlaps.length,
      novelQualifiedCandidates: novel.length,
      wouldAdd: selected.length
    },
    overlaps,
    wouldAdd: selected.map(({ candidate }) => ({
      title: candidate.title,
      summary: candidate.summary,
      url: candidate.url,
      publishedAt: candidate.publishedAt,
      category: candidate.category,
      categoryLabel: candidate.categoryLabel,
      score: candidate.score,
      sourceIds: [...new Set(candidate.sourceAttributions.map((item) => item.sourceId))],
      sourceNames: [...new Set(candidate.sourceAttributions.map((item) => item.sourceName))]
    }))
  };
}

export async function collectSupplementalShadow(input: { rssUrl: string; profile: Profile; now?: Date; fetcher?: Fetcher }): Promise<SupplementalShadowReport> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  const issue = await fetchLatestRss(input.rssUrl, fetcher);
  const aiNewsCandidates = compactIssueInventory(issue, input.profile).candidates;
  const sourceResults = await Promise.all([collectTldr(input.profile, fetcher), collectAlpha(input.profile, now, fetcher), collectCloudflare(input.profile, now, fetcher)]);
  return buildSupplementalShadowReport({ issue, aiNewsCandidates, sourceResults, generatedAt: now.toISOString() });
}

export async function runSupplementalShadow(env: Env, trigger: "cron" | "manual" | "local-scheduled"): Promise<{ status: "healthy" | "degraded" | "failed"; report?: SupplementalShadowReport; error?: string }> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const profile = await getActiveProfile(env.DB);
    const report = await collectSupplementalShadow({ rssUrl: env.RSS_URL, profile });
    const failedSources = report.sources.filter((source) => source.status === "failed").length;
    const degradedSources = report.sources.filter((source) => source.status === "degraded").length;
    const status = failedSources === report.sources.length ? "failed" : failedSources || degradedSources ? "degraded" : "healthy";
    await recordSupplementalShadowRun(env.DB, { trigger, status, startedAt, durationMs: Date.now() - started, report });
    console.log(JSON.stringify({ message: "ai-signal supplemental shadow completed", status, baseIssue: report.baseIssue.url, totals: report.totals }));
    return { status, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordSupplementalShadowRun(env.DB, { trigger, status: "failed", startedAt, durationMs: Date.now() - started, errorCode: "SHADOW_COLLECTION_FAILED", errorMessage: message });
    console.error(JSON.stringify({ message: "ai-signal supplemental shadow failed", error: message }));
    return { status: "failed", error: message };
  }
}
