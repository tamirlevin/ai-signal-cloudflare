import type {
  CandidateStory,
  Edition,
  Profile,
  RssIssue,
  StoryEvidence,
  StoryProvenance,
  StorySourceAttribution,
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
const ALPHA_LOOKBACK_HOURS = 72;
const ALPHA_LOOKBACK_MS = ALPHA_LOOKBACK_HOURS * 60 * 60 * 1000;
export const MAX_BLENDED_CANDIDATES = 18;
export const MAX_NOVEL_SUPPLEMENTAL = 2;
const MAX_NOVEL_PER_SOURCE = 1;
const AI_NEWS_SOURCE: StorySourceAttribution = { id: "ainews", name: "AInews", layer: "editorial" };
const CLOUDFLARE_PRIMARY_HOSTS = new Set(["blog.cloudflare.com"]);
// Deterministic editorial tie-break only. It does not claim which feed surfaced a story first.
const SOURCE_ORDER: Record<SupplementalSourceId, number> = { alphasignal: 0, "tldr-ai": 1, "cloudflare-agents": 2 };

function aggregatorHost(host: string): boolean {
  return AGGREGATOR_HOSTS.has(host) || host.endsWith(".alphasignal.ai") || host.endsWith(".tldr.tech") || host.endsWith(".news.smol.ai");
}

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

function attribution(source: SourceDefinition, sourceUrl: string, kind: SupplementalAttribution["kind"] = source.kind): SupplementalAttribution {
  return { sourceId: source.id, sourceName: source.name, kind, sourceUrl };
}

function isTrustedCloudflarePrimary(value: string): boolean {
  try {
    return CLOUDFLARE_PRIMARY_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function exceptional(text: string): boolean {
  return /\b(?:first[- ]ever|breakthrough|unprecedented|new state[- ]of[- ]the[- ]art)\b/i.test(text);
}

function prepareCandidate(input: Omit<SupplementalCandidate, "category" | "categoryLabel" | "score" | "exceptional">, profile: Profile): SupplementalCandidate {
  const evidence = `${input.title} ${input.summary}`;
  const category = categoryForProfile(evidence, profile);
  return { ...input, leadSourceId: input.leadSourceId ?? input.sourceAttributions[0]?.sourceId, category: category.id, categoryLabel: category.label, score: scoreCandidateForProfile(evidence, profile), exceptional: exceptional(evidence) };
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
  const cutoff = now.getTime() - ALPHA_LOOKBACK_MS;
  const available = blocks(xml, "url").map((entry) => ({
    title: titleFromAlphaUrl(plainText(tag(entry, "loc"))),
    url: canonicalizeSupplementalUrl(plainText(tag(entry, "loc"))) ?? "",
    publishedAt: isoDate(tag(entry, "lastmod")) ?? ""
  })).filter((item) => item.title && item.url && item.publishedAt).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  const recent = available.filter((item) => new Date(item.publishedAt).getTime() >= cutoff);
  // AlphaSignal is a low-frequency editorial source rather than a daily RSS issue.
  // Keep the newest available item when the source is quiet so the blend does not
  // silently disappear; the collector marks this fallback as degraded below.
  return recent.length ? recent : available.slice(0, 1);
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
    if (aggregatorHost(parsed.hostname) || NON_EVIDENCE_HOSTS.has(host) || host.endsWith(".typeform.com") || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(parsed.pathname)) continue;
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
  }).filter((item) => item.title && item.url && item.publishedAt && new Date(item.publishedAt).getTime() >= cutoff).map((item) => prepareCandidate({
    ...item,
    // The feed is a primary-source lane only for the explicitly allowlisted Cloudflare host.
    // An unexpected external link remains discovery context and cannot receive primary weight.
    sourceAttributions: [attribution(SOURCES.cloudflare, item.url, isTrustedCloudflarePrimary(item.url) ? "primary" : "discovery")]
  }, profile));
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
    const freshnessCutoff = now.getTime() - ALPHA_LOOKBACK_MS;
    const newest = recent[0];
    if (newest && new Date(newest.publishedAt).getTime() < freshnessCutoff) {
      health.status = "degraded";
      health.errors.push(`no AlphaSignal item in the preceding ${ALPHA_LOOKBACK_HOURS} hours; using the newest available item`);
    }
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

export async function collectSupplementalSources(input: { profile: Profile; now?: Date; fetcher?: Fetcher }): Promise<SourceResult[]> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  return Promise.all([collectTldr(input.profile, fetcher), collectAlpha(input.profile, now, fetcher), collectCloudflare(input.profile, now, fetcher)]);
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
    if (aggregatorHost(host)) return 0;
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
  const leftAuthority = urlAuthority(left.url, leftPrimary);
  const rightAuthority = urlAuthority(right.url, rightPrimary);
  const leftOrder = SOURCE_ORDER[left.leadSourceId ?? left.sourceAttributions[0]?.sourceId ?? "cloudflare-agents"];
  const rightOrder = SOURCE_ORDER[right.leadSourceId ?? right.sourceAttributions[0]?.sourceId ?? "cloudflare-agents"];
  const preferred = rightAuthority > leftAuthority
    || (rightAuthority === leftAuthority && (right.score > left.score || (right.score === left.score && (rightOrder < leftOrder || (rightOrder === leftOrder && `${right.title}|${right.url}`.localeCompare(`${left.title}|${left.url}`) < 0)))))
    ? right
    : left;
  return {
    ...preferred,
    score: Math.max(left.score, right.score),
    leadSourceId: preferred.leadSourceId ?? preferred.sourceAttributions[0]?.sourceId,
    sourceAttributions: [...attributions.values()].sort((first, second) => SOURCE_ORDER[first.sourceId] - SOURCE_ORDER[second.sourceId] || first.sourceUrl.localeCompare(second.sourceUrl))
  };
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

function sourceReference(attribution: SupplementalAttribution): StorySourceAttribution {
  return {
    id: attribution.sourceId,
    name: attribution.sourceName,
    layer: attribution.kind === "primary" ? "primary" : "editorial"
  };
}

function sourceReferences(candidate: SupplementalCandidate): StorySourceAttribution[] {
  const seen = new Set<StorySourceAttribution["id"]>();
  return candidate.sourceAttributions
    .map(sourceReference)
    .sort((left, right) => {
      if (left.id === candidate.leadSourceId || right.id === candidate.leadSourceId) return left.id === candidate.leadSourceId ? -1 : 1;
      if (left.id === "ainews" || right.id === "ainews") return left.id === "ainews" ? -1 : 1;
      return SOURCE_ORDER[left.id] - SOURCE_ORDER[right.id];
    })
    .filter((source) => {
      if (seen.has(source.id)) return false;
      seen.add(source.id);
      return true;
    });
}

function evidenceLabel(value: string, primaryName?: string): string {
  if (primaryName) return primaryName;
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return "Linked source"; }
}

function supplementalEvidence(candidate: SupplementalCandidate): StoryEvidence | undefined {
  const url = canonicalizeSupplementalUrl(candidate.url);
  if (!url) return undefined;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  if (NON_EVIDENCE_HOSTS.has(host) || host.endsWith(".typeform.com") || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(parsed.pathname)) return undefined;
  const primary = candidate.sourceAttributions.find((item) => item.kind === "primary");
  if (!primary && urlAuthority(url, false) < 2) return undefined;
  return { label: evidenceLabel(url, primary?.sourceName), url, kind: primary ? "primary" : "direct" };
}

function baseEvidence(candidate: CandidateStory): StoryEvidence[] {
  const seen = new Set<string>();
  return candidate.sources.flatMap((source) => {
    try {
      const parsed = new URL(source.url);
      if (parsed.protocol !== "https:" || seen.has(source.url)) return [];
      seen.add(source.url);
      // AInews links remain byte-for-byte intact; only supplemental URLs are canonicalized.
      return [{ ...source, kind: "direct" as const }];
    } catch {
      return [];
    }
  });
}

function clusterId(candidate: { title: string; url: string }): string {
  const value = `${candidate.title.toLowerCase()}|${canonicalizeSupplementalUrl(candidate.url) ?? candidate.url}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `story-${(hash >>> 0).toString(36)}`;
}

function categoryWeight(candidate: Pick<CandidateStory, "category"> | Pick<SupplementalCandidate, "category">, profile: Profile): number {
  return profile.weights.find((weight) => weight.id === candidate.category)?.value ?? 0;
}

function selectionScore(candidate: Pick<CandidateStory, "category" | "score"> | Pick<SupplementalCandidate, "category" | "score">, profile: Profile, opts?: { corroboration?: number; primary?: boolean }): number {
  return Math.max(0, Math.round(categoryWeight(candidate, profile) * 20 + candidate.score + (opts?.corroboration ?? 0) * 4 + (opts?.primary ? 4 : 0)));
}

function withBaseProvenance(candidate: CandidateStory, profile: Profile): CandidateStory {
  const evidence = baseEvidence(candidate);
  const provenance: StoryProvenance = {
    clusterId: clusterId({ title: candidate.title, url: evidence[0]?.url ?? candidate.sources[0]?.url ?? candidate.title }),
    lead: AI_NEWS_SOURCE,
    editorialCorroboration: [],
    evidence,
    selection: { score: selectionScore(candidate, profile), reason: "ainews-base" }
  };
  return { ...candidate, sources: evidence.map(({ label, url }) => ({ label, url })), provenance };
}

function mergeEvidence(base: CandidateStory, supplemental: SupplementalCandidate): StoryEvidence[] {
  const direct = supplementalEvidence(supplemental);
  const original = baseEvidence(base);
  const preferred = direct ? preferredUrl(original[0]?.url ?? direct.url, supplemental) : original[0]?.url;
  const merged = [...original, ...(direct ? [direct] : [])];
  const unique = new Map<string, StoryEvidence>();
  for (const item of merged) {
    const key = canonicalizeSupplementalUrl(item.url) ?? item.url;
    const existing = unique.get(key);
    if (!existing || item.url === preferred || (existing.url !== preferred && item.kind === "primary" && existing.kind !== "primary")) unique.set(key, item);
  }
  return [...unique.values()]
    .sort((left, right) => {
      if (left.url === preferred) return -1;
      if (right.url === preferred) return 1;
      if (left.kind !== right.kind) return left.kind === "primary" ? -1 : 1;
      return 0;
    })
    .slice(0, 4);
}

function mergeWithAiNews(base: CandidateStory, supplemental: SupplementalCandidate, profile: Profile): CandidateStory {
  const references = sourceReferences(supplemental);
  const editorial = [AI_NEWS_SOURCE, ...references.filter((source) => source.layer === "editorial")];
  const supplementalLead = references.find((source) => source.layer === "editorial") ?? references.find((source) => source.layer === "primary");
  const primary = supplemental.sourceAttributions.some((item) => item.kind === "primary");
  const useSupplementalLead = Boolean(supplementalLead) && (supplemental.score > base.score || (supplemental.score === base.score && primary));
  const lead = useSupplementalLead ? supplementalLead! : AI_NEWS_SOURCE;
  const evidence = mergeEvidence(base, supplemental);
  const editorialCorroboration = editorial.filter((source, index) => source.id !== lead.id && editorial.findIndex((item) => item.id === source.id) === index);
  const provenance: StoryProvenance = {
    clusterId: clusterId({ title: useSupplementalLead ? supplemental.title : base.title, url: evidence[0]?.url ?? supplemental.url }),
    lead,
    editorialCorroboration,
    evidence,
    selection: {
      score: selectionScore(useSupplementalLead ? supplemental : base, profile, { corroboration: editorialCorroboration.length, primary: evidence.some((item) => item.kind === "primary") }),
      reason: "cross-source"
    }
  };
  return {
    ...(useSupplementalLead ? {
      ...base,
      title: supplemental.title,
      summary: supplemental.summary,
      category: supplemental.category,
      categoryLabel: supplemental.categoryLabel,
      score: Math.max(base.score, supplemental.score),
      exceptional: base.exceptional || supplemental.exceptional,
      watchPermission: base.watchPermission || isPermissionDesignSignal(`${supplemental.title} ${supplemental.summary}`),
      modelText: supplemental.summary
    } : { ...base, score: Math.max(base.score, supplemental.score) }),
    sources: evidence.map(({ label, url }) => ({ label, url })),
    provenance
  };
}

function strongProfileFit(candidate: SupplementalCandidate, profile: Profile): boolean {
  if (candidate.exceptional && profile.exceptionalStoryOverride) return true;
  if (candidate.score < 4) return false;
  return categoryWeight(candidate, profile) >= 3 || isPermissionDesignSignal(`${candidate.title} ${candidate.summary}`);
}

function novelCandidate(candidate: SupplementalCandidate, profile: Profile, id: number): CandidateStory | undefined {
  const evidence = supplementalEvidence(candidate);
  if (!evidence || !strongProfileFit(candidate, profile)) return undefined;
  const references = sourceReferences(candidate);
  const lead = references.find((source) => source.layer === "editorial") ?? references.find((source) => source.layer === "primary");
  if (!lead) return undefined;
  const editorialCorroboration = references.filter((source) => source.layer === "editorial" && source.id !== lead.id);
  const provenance: StoryProvenance = {
    clusterId: clusterId(candidate),
    lead,
    editorialCorroboration,
    evidence: [evidence],
    selection: {
      score: selectionScore(candidate, profile, { corroboration: editorialCorroboration.length, primary: evidence.kind === "primary" }),
      reason: "strong-fit-supplemental"
    }
  };
  return {
    id,
    title: candidate.title,
    summary: candidate.summary,
    category: candidate.category,
    categoryLabel: candidate.categoryLabel,
    score: candidate.score,
    exceptional: candidate.exceptional,
    watchPermission: isPermissionDesignSignal(`${candidate.title} ${candidate.summary}`),
    watchGeography: /cluster geography|data cent(?:er|re)|sovereign|regional capacity|\bchina\b|united states|\bu\.s\.\b/i.test(`${candidate.title} ${candidate.summary}`),
    sources: [{ label: evidence.label, url: evidence.url }],
    provenance,
    modelText: candidate.summary
  };
}

export type BlendedCandidateInventory = {
  candidates: CandidateStory[];
  overlaps: number;
  rejectedNovel: number;
  selectedSupplemental: SupplementalCandidate[];
  collection: NonNullable<Edition["collection"]>;
};

/** Builds the production inventory while preserving AInews as the base and limiting novel additions. */
export function buildBlendedCandidateInventory(input: {
  aiNewsCandidates: CandidateStory[];
  sourceResults: SourceResult[];
  profile: Profile;
  mode?: "ainews-only" | "blended";
}): BlendedCandidateInventory {
  const supplemental = deduplicateSupplemental(input.sourceResults.flatMap((result) => result.candidates));
  const clustered = input.aiNewsCandidates.map((candidate) => withBaseProvenance(candidate, input.profile));
  const novel: Array<{ raw: SupplementalCandidate; story: CandidateStory }> = [];
  let overlaps = 0;
  let nextId = Math.max(0, ...clustered.map((candidate) => candidate.id)) + 1;

  for (const candidate of supplemental) {
    const index = clustered.findIndex((base) => base.sources.some((source) => sameStory({ title: base.title, url: source.url }, candidate)));
    if (index >= 0) {
      clustered[index] = mergeWithAiNews(clustered[index]!, candidate, input.profile);
      overlaps += 1;
      continue;
    }
    const story = novelCandidate(candidate, input.profile, nextId);
    if (!story) continue;
    nextId += 1;
    novel.push({ raw: candidate, story });
  }

  novel.sort((left, right) => right.story.provenance!.selection.score - left.story.provenance!.selection.score || right.raw.publishedAt.localeCompare(left.raw.publishedAt) || left.story.title.localeCompare(right.story.title));
  const sourceCounts = new Map<StorySourceAttribution["id"], number>();
  const selected = novel.filter(({ story }) => {
    const source = story.provenance!.lead.id;
    if ((sourceCounts.get(source) ?? 0) >= MAX_NOVEL_PER_SOURCE) return false;
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    return true;
  }).slice(0, MAX_NOVEL_SUPPLEMENTAL);

  const baseLimit = Math.max(0, MAX_BLENDED_CANDIDATES - selected.length);
  const candidates = [...clustered.slice(0, baseLimit), ...selected.map((item) => item.story)]
    .sort((left, right) => right.provenance!.selection.score - left.provenance!.selection.score || left.id - right.id)
    .map((candidate, index) => ({ ...candidate, id: index + 1 }));
  return {
    candidates,
    overlaps,
    rejectedNovel: supplemental.length - overlaps - selected.length,
    selectedSupplemental: selected.map((item) => item.raw),
    collection: {
      mode: input.mode ?? "blended",
      baseSource: "AInews",
      editorialDiscovery: input.mode === "ainews-only" ? [] : ["AlphaSignal", "TLDR AI"],
      primaryEvidenceFeeds: input.mode === "ainews-only" ? [] : ["Cloudflare Agents"],
      selectedSupplemental: selected.length,
      supplementalCap: MAX_NOVEL_SUPPLEMENTAL
    }
  };
}

export function buildSupplementalShadowReport(input: {
  issue: RssIssue;
  aiNewsCandidates: CandidateStory[];
  sourceResults: SourceResult[];
  generatedAt: string;
  mode?: "shadow" | "blend";
  selectedForBlend?: SupplementalCandidate[];
}): SupplementalShadowReport {
  const collected = input.sourceResults.flatMap((result) => result.candidates);
  const deduplicated = deduplicateSupplemental(collected);
  const overlaps: SupplementalShadowReport["overlaps"] = [];
  const novel: SupplementalCandidate[] = [];
  for (const candidate of deduplicated) {
    const matchingBase = input.aiNewsCandidates.find((base) => base.sources.some((source) => sameStory({ title: base.title, url: source.url }, candidate)));
    if (matchingBase) {
      const matchingSource = matchingBase.sources.find((source) => sameStory({ title: matchingBase.title, url: source.url }, candidate));
      overlaps.push({ supplementalTitle: candidate.title, aiNewsTitle: matchingBase.title, preferredUrl: preferredUrl(matchingSource?.url ?? candidate.url, candidate), sourceIds: [...new Set(candidate.sourceAttributions.map((item) => item.sourceId))] });
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
    mode: input.mode ?? "shadow",
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
      wouldAdd: selected.length,
      ...(input.selectedForBlend ? { selectedForBlend: input.selectedForBlend.length } : {})
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
    })),
    ...(input.selectedForBlend ? {
      selectedForBlend: input.selectedForBlend.map((candidate) => ({
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
    } : {})
  };
}

export async function collectSupplementalShadow(input: { rssUrl: string; profile: Profile; now?: Date; fetcher?: Fetcher }): Promise<SupplementalShadowReport> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  const issue = await fetchLatestRss(input.rssUrl, fetcher);
  const aiNewsCandidates = compactIssueInventory(issue, input.profile).candidates;
  const sourceResults = await collectSupplementalSources({ profile: input.profile, now, fetcher });
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
