import type {
  CandidateStory,
  Edition,
  Profile,
  RssIssue,
  SourcePackSource,
  StoryCoverage,
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
import { getActiveProfile, melbourneCalendarDay, recordSupplementalShadowRun } from "./repository";
import { getSourcePack } from "./source-packs";

type Fetcher = typeof fetch;
export type SourceResult = { candidates: SupplementalCandidate[]; health: SupplementalSourceHealth; issue?: RssIssue };
type SourceDefinition = SourcePackSource;

const AGGREGATOR_HOSTS = new Set(["alphasignal.ai", "news.smol.ai", "tldr.tech", "www.alphasignal.ai", "www.tldr.tech"]);
const NON_EVIDENCE_HOSTS = new Set(["calendly.com", "forms.gle", "tally.so", "typeform.com", "www.googletagmanager.com"]);
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with"]);
const MAX_FEED_BYTES = 2_000_000;
const MAX_PAGE_BYTES = 2_500_000;
const ALPHA_LOOKBACK_HOURS = 48;
export const MAX_BLENDED_CANDIDATES = 18;
export const PREFERRED_FRESHNESS_HOURS = 36;
export const MAX_FRESHNESS_HOURS = 48;
const CLOUDFLARE_PRIMARY_HOSTS = new Set(["blog.cloudflare.com"]);
const SOCIAL_HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com"]);

function aggregatorHost(host: string): boolean {
  return AGGREGATOR_HOSTS.has(host) || host.endsWith(".alphasignal.ai") || host.endsWith(".tldr.tech") || host.endsWith(".news.smol.ai");
}

function socialHost(host: string): boolean {
  return SOCIAL_HOSTS.has(host.toLowerCase());
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

export function parseTldrIssue(html: string, issue: { url: string; publishedAt: string }, profile: Profile, source = sourceDefinition(profile, "tldr-ai")): SupplementalCandidate[] {
  if (!source) return [];
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
      sourceAttributions: [attribution(source, issue.url)]
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

export function parseAlphaSitemap(xml: string, now: Date, lookbackHours = ALPHA_LOOKBACK_HOURS): Array<{ title: string; url: string; publishedAt: string }> {
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1000;
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
    if (socialHost(parsed.hostname)) continue;
    links.set(url, `${links.get(url) ?? ""} ${plainText(match[2] ?? "")}`.trim());
  }
  const preferredUrl = [...links.entries()].sort((left, right) => evidenceUrlScore(heading, right[1], right[0]) - evidenceUrlScore(heading, left[1], left[0]))[0]?.[0] ?? articleUrl;
  return { title: heading || titleFromAlphaUrl(articleUrl), summary: description || heading || titleFromAlphaUrl(articleUrl), preferredUrl };
}

export function parseCloudflareFeed(xml: string, now: Date, profile: Profile, source = sourceDefinition(profile, "cloudflare-agents")): SupplementalCandidate[] {
  if (!source) return [];
  const cutoff = now.getTime() - (source.lookbackHours ?? 72) * 60 * 60 * 1000;
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
    sourceAttributions: [attribution(source, item.url, isTrustedCloudflarePrimary(item.url) ? "primary" : "discovery")]
  }, profile));
}

async function collectAiNews(profile: Profile, fetcher: Fetcher, source: SourceDefinition): Promise<SourceResult> {
  const health = sourceHealth(source);
  try {
    health.requests += 1;
    const issue = await fetchLatestRss(source.url, fetcher);
    const inventory = compactIssueInventory(issue, profile);
    health.fetchedItems = inventory.candidates.length;
    const candidates = inventory.candidates.flatMap((candidate): SupplementalCandidate[] => {
      const evidence = candidate.sources.find((item) => {
        try { return !socialHost(new URL(item.url).hostname); } catch { return false; }
      });
      if (!evidence) return [];
      return [{
        title: candidate.title,
        summary: candidate.summary,
        url: evidence.url,
        publishedAt: issue.publishedAt,
        category: candidate.category,
        categoryLabel: candidate.categoryLabel,
        score: candidate.score,
        exceptional: candidate.exceptional,
        leadSourceId: source.id,
        sourceAttributions: [attribution(source, issue.url)]
      }];
    });
    health.acceptedCandidates = candidates.length;
    if (!candidates.length) {
      health.status = "degraded";
      health.errors.push("AInews supplied no non-social publishable candidates");
    }
    return { candidates, health, issue };
  } catch (error) {
    health.status = "failed";
    health.errors.push(error instanceof Error ? error.message : String(error));
    return { candidates: [], health };
  }
}

async function collectTldr(profile: Profile, fetcher: Fetcher, source: SourceDefinition): Promise<SourceResult> {
  const health = sourceHealth(source);
  try {
    health.requests += 1;
    const feed = await boundedText(fetcher, source.url, MAX_FEED_BYTES, "application/rss+xml, application/xml;q=0.9");
    const issue = parseTldrFeed(feed)[0];
    health.fetchedItems = issue ? 1 : 0;
    if (!issue) throw new Error("TLDR feed contains no current issue");
    health.requests += 1;
    const html = await boundedText(fetcher, issue.url, MAX_PAGE_BYTES, "text/html");
    const candidates = parseTldrIssue(html, issue, profile, source);
    health.acceptedCandidates = candidates.length;
    if (!candidates.length) health.status = "failed";
    return { candidates, health };
  } catch (error) {
    health.status = "failed";
    health.errors.push(error instanceof Error ? error.message : String(error));
    return { candidates: [], health };
  }
}

async function collectAlpha(profile: Profile, now: Date, fetcher: Fetcher, source: SourceDefinition): Promise<SourceResult> {
  const health = sourceHealth(source);
  try {
    health.requests += 1;
    const sitemap = await boundedText(fetcher, source.url, MAX_FEED_BYTES, "application/xml, text/xml;q=0.9");
    const lookbackHours = source.lookbackHours ?? ALPHA_LOOKBACK_HOURS;
    const recent = parseAlphaSitemap(sitemap, now, lookbackHours);
    health.fetchedItems = recent.length;
    const freshnessCutoff = now.getTime() - lookbackHours * 60 * 60 * 1000;
    const newest = recent[0];
    if (newest && new Date(newest.publishedAt).getTime() < freshnessCutoff) {
      health.status = "degraded";
      health.errors.push(`no ${source.name} item in the preceding ${lookbackHours} hours; using the newest available item`);
    }
    const prioritized = recent.map((item) => ({ ...item, score: scoreCandidateForProfile(item.title, profile) })).sort((left, right) => right.score - left.score || right.publishedAt.localeCompare(left.publishedAt)).slice(0, source.enrichLimit ?? 5);
    const enriched = await Promise.all(prioritized.map(async (item) => {
      try {
        health.requests += 1;
        const html = await boundedText(fetcher, item.url, MAX_PAGE_BYTES, "text/html");
        const article = parseAlphaArticle(html, item.url);
        return prepareCandidate({ title: article.title, summary: article.summary.slice(0, 600), url: article.preferredUrl, publishedAt: item.publishedAt, sourceAttributions: [attribution(source, item.url)] }, profile);
      } catch (error) {
        health.status = "degraded";
        health.errors.push(error instanceof Error ? error.message : String(error));
        return prepareCandidate({ title: item.title, summary: item.title, url: item.url, publishedAt: item.publishedAt, sourceAttributions: [attribution(source, item.url)] }, profile);
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

async function collectCloudflare(profile: Profile, now: Date, fetcher: Fetcher, source: SourceDefinition): Promise<SourceResult> {
  const health = sourceHealth(source);
  try {
    health.requests += 1;
    const feed = await boundedText(fetcher, source.url, MAX_FEED_BYTES, "application/rss+xml, application/xml;q=0.9");
    const candidates = parseCloudflareFeed(feed, now, profile, source);
    health.fetchedItems = blocks(feed, "item").length;
    health.acceptedCandidates = candidates.length;
    return { candidates, health };
  } catch (error) {
    health.status = "failed";
    health.errors.push(error instanceof Error ? error.message : String(error));
    return { candidates: [], health };
  }
}

export async function collectSupplementalSources(input: { profile: Profile; now?: Date; fetcher?: Fetcher; rssUrl?: string }): Promise<SourceResult[]> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  const sources = sourcePack(input.profile).sources.filter((source) => source.enabled).map((source) => source.id === "ainews" && input.rssUrl ? { ...source, url: input.rssUrl } : source);
  return Promise.all(sources.map((source) => {
    switch (source.id) {
      case "ainews": return collectAiNews(input.profile, fetcher, source);
      case "tldr-ai": return collectTldr(input.profile, fetcher, source);
      case "alphasignal": return collectAlpha(input.profile, now, fetcher, source);
      case "cloudflare-agents": return collectCloudflare(input.profile, now, fetcher, source);
    }
  }));
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
    if (socialHost(host)) return -1;
    if (host.endsWith("reddit.com")) return 1;
    return 2;
  } catch {
    return -1;
  }
}

function mergeSupplemental(left: SupplementalCandidate, right: SupplementalCandidate): SupplementalCandidate {
  const attributions = new Map<string, SupplementalAttribution>();
  for (const item of [...left.sourceAttributions, ...right.sourceAttributions]) attributions.set(`${item.sourceId}|${item.sourceUrl}`, item);
  const leftPrimary = left.sourceAttributions.some((item) => item.kind === "primary");
  const rightPrimary = right.sourceAttributions.some((item) => item.kind === "primary");
  const leftAuthority = urlAuthority(left.url, leftPrimary);
  const rightAuthority = urlAuthority(right.url, rightPrimary);
  const preferred = rightAuthority > leftAuthority
    || (rightAuthority === leftAuthority && (right.score > left.score
      || (right.score === left.score && (right.publishedAt > left.publishedAt
        || (right.publishedAt === left.publishedAt && `${right.title}|${right.url}`.localeCompare(`${left.title}|${left.url}`) < 0)))))
    ? right
    : left;
  return {
    ...preferred,
    score: Math.max(left.score, right.score),
    leadSourceId: preferred.leadSourceId ?? preferred.sourceAttributions[0]?.sourceId,
    sourceAttributions: [...attributions.values()].sort((first, second) => first.sourceName.localeCompare(second.sourceName) || first.sourceUrl.localeCompare(second.sourceUrl))
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

function sourceReference(attribution: SupplementalAttribution): StorySourceAttribution | undefined {
  // Cloudflare Agents is a primary-evidence lane, not an editorial publication.
  // If its feed unexpectedly points off-host, keep the linked URL available as
  // evidence for an existing cluster without counting Cloudflare as editorial
  // corroboration or allowing it to lead a novel discovery-only story.
  if (attribution.sourceId === "cloudflare-agents" && attribution.kind !== "primary") return undefined;
  return {
    id: attribution.sourceId,
    name: attribution.sourceName,
    layer: attribution.kind === "primary" ? "primary" : "editorial"
  };
}

function sourceReferences(candidate: SupplementalCandidate): StorySourceAttribution[] {
  const seen = new Set<StorySourceAttribution["id"]>();
  return candidate.sourceAttributions
    .flatMap((attribution) => {
      const source = sourceReference(attribution);
      return source ? [source] : [];
    })
    .sort((left, right) => {
      if (left.id === candidate.leadSourceId || right.id === candidate.leadSourceId) return left.id === candidate.leadSourceId ? -1 : 1;
      if (left.layer !== right.layer) return left.layer === "editorial" ? -1 : 1;
      return left.name.localeCompare(right.name);
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
  if (socialHost(parsed.hostname) || NON_EVIDENCE_HOSTS.has(host) || host.endsWith(".typeform.com") || /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(parsed.pathname)) return undefined;
  const primary = candidate.sourceAttributions.find((item) => item.kind === "primary");
  if (!primary && urlAuthority(url, false) < 2) return undefined;
  return { label: evidenceLabel(url, primary?.sourceName), url, kind: primary ? "primary" : "direct" };
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

/** Give independent editorial corroboration a small, capped contribution to ranking. */
export function independentCoverageBoost(corroboration: number): number {
  return Math.min(Math.max(corroboration, 0), 2) * 4;
}

function coverageMetadata(lead: StorySourceAttribution, editorialCorroboration: StorySourceAttribution[], evidence: StoryEvidence[]): StoryCoverage {
  const editorialSourceIds = [...new Set([lead, ...editorialCorroboration]
    .filter((source) => source.layer === "editorial")
    .map((source) => source.id))] as StoryCoverage["editorialSourceIds"];
  return {
    editorialSourceIds,
    editorialSourceCount: editorialSourceIds.length,
    primaryEvidenceCount: evidence.filter((item) => item.kind === "primary").length,
    boost: independentCoverageBoost(Math.max(0, editorialSourceIds.length - 1))
  };
}

function selectionScore(candidate: Pick<CandidateStory, "category" | "score"> | Pick<SupplementalCandidate, "category" | "score">, profile: Profile, opts?: { corroboration?: number; primary?: boolean }): number {
  return Math.max(0, Math.round(categoryWeight(candidate, profile) * 20 + candidate.score + independentCoverageBoost(opts?.corroboration ?? 0) + (opts?.primary ? 4 : 0)));
}

function strongProfileFit(candidate: SupplementalCandidate, profile: Profile): boolean {
  if (candidate.exceptional && profile.exceptionalStoryOverride) return true;
  if (candidate.score < 4) return false;
  return categoryWeight(candidate, profile) >= 3 || isPermissionDesignSignal(`${candidate.title} ${candidate.summary}`);
}

export function freshnessBoost(publishedAt: string, now: Date): number {
  const ageHours = (now.getTime() - Date.parse(publishedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > MAX_FRESHNESS_HOURS) return 0;
  if (ageHours <= PREFERRED_FRESHNESS_HOURS) return 6;
  return Math.max(0, Math.round(6 * (MAX_FRESHNESS_HOURS - ageHours) / (MAX_FRESHNESS_HOURS - PREFERRED_FRESHNESS_HOURS)));
}

function qualifiesForDailyPool(candidate: SupplementalCandidate, profile: Profile): boolean {
  const references = sourceReferences(candidate);
  const editorialCount = references.filter((source) => source.layer === "editorial").length;
  const primary = candidate.sourceAttributions.some((item) => item.kind === "primary");
  return strongProfileFit(candidate, profile) || editorialCount > 1 || (primary && categoryWeight(candidate, profile) >= 2);
}

function dailyCandidate(candidate: SupplementalCandidate, profile: Profile, id: number, now: Date): CandidateStory | undefined {
  const evidence = supplementalEvidence(candidate);
  if (!evidence || !qualifiesForDailyPool(candidate, profile)) return undefined;
  const references = sourceReferences(candidate);
  const lead = references.find((source) => source.id === candidate.leadSourceId)
    ?? references.find((source) => source.layer === "editorial")
    ?? references.find((source) => source.layer === "primary");
  if (!lead) return undefined;
  const editorialCorroboration = references.filter((source) => source.layer === "editorial" && source.id !== lead.id);
  const coverage = coverageMetadata(lead, editorialCorroboration, [evidence]);
  const provenance: StoryProvenance = {
    clusterId: clusterId(candidate),
    lead,
    editorialCorroboration,
    evidence: [evidence],
    coverage,
    selection: {
      score: selectionScore(candidate, profile, { corroboration: Math.max(0, coverage.editorialSourceCount - 1), primary: evidence.kind === "primary" }) + freshnessBoost(candidate.publishedAt, now),
      reason: coverage.editorialSourceCount > 1 ? "cross-source" : "single-source"
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
    publishedAt: candidate.publishedAt,
    provenance,
    modelText: candidate.summary
  };
}

function gentlyDiversify(stories: CandidateStory[]): CandidateStory[] {
  const remaining = [...stories];
  const selected: CandidateStory[] = [];
  while (remaining.length) {
    let index = 0;
    const previousLead = selected.at(-1)?.provenance?.lead.id;
    const top = remaining[0]!;
    if (previousLead && top.provenance?.lead.id === previousLead) {
      const alternative = remaining.findIndex((candidate) => candidate.provenance?.lead.id !== previousLead
        && top.provenance!.selection.score - candidate.provenance!.selection.score <= 4);
      if (alternative > 0) index = alternative;
    }
    selected.push(remaining.splice(index, 1)[0]!);
  }
  return selected;
}

export type DailyCandidateInventory = {
  candidates: CandidateStory[];
  eligibleCandidates: number;
  expiredCandidates: number;
  collection: NonNullable<Edition["collection"]>;
};

/** Builds one ranked daily pool. Feed identity never contributes source seniority. */
export function buildDailyCandidateInventory(input: {
  sourceResults: SourceResult[];
  profile: Profile;
  now?: Date;
}): DailyCandidateInventory {
  const now = input.now ?? new Date();
  const allCandidates = input.sourceResults.flatMap((result) => result.candidates);
  const cutoff = now.getTime() - MAX_FRESHNESS_HOURS * 3_600_000;
  const fresh = allCandidates.filter((candidate) => {
    const publishedAt = Date.parse(candidate.publishedAt);
    return Number.isFinite(publishedAt) && publishedAt <= now.getTime() && publishedAt >= cutoff;
  });
  const eligible = deduplicateSupplemental(fresh)
    .flatMap((candidate, index) => {
      const story = dailyCandidate(candidate, input.profile, index + 1, now);
      return story ? [story] : [];
    })
    .sort((left, right) => right.provenance!.selection.score - left.provenance!.selection.score
      || (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "")
      || left.title.localeCompare(right.title));
  const candidates = gentlyDiversify(eligible).slice(0, MAX_BLENDED_CANDIDATES)
    .map((candidate, index) => ({ ...candidate, id: index + 1 }));
  const pack = sourcePack(input.profile);
  const contributing = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.provenance?.lead.name) contributing.add(candidate.provenance.lead.name);
    for (const source of candidate.provenance?.editorialCorroboration ?? []) contributing.add(source.name);
  }
  return {
    candidates,
    eligibleCandidates: eligible.length,
    expiredCandidates: allCandidates.length - fresh.length,
    collection: {
      mode: "daily-pool",
      sourcesChecked: input.sourceResults.map((result) => result.health.name),
      sourcesContributing: [...contributing].sort(),
      preferredFreshnessHours: PREFERRED_FRESHNESS_HOURS,
      maxFreshnessHours: MAX_FRESHNESS_HOURS,
      eligibleCandidates: eligible.length,
      selectedCandidates: candidates.length,
      sourcePackId: pack.id,
      sourcePackVersion: pack.version
    }
  };
}

export function buildDailySourceReport(input: {
  issue: RssIssue;
  sourceResults: SourceResult[];
  inventory: DailyCandidateInventory;
  generatedAt: string;
  profile: Profile;
}): SupplementalShadowReport {
  const allCandidates = input.sourceResults.flatMap((result) => result.candidates);
  const selected = input.inventory.candidates.map((candidate): SupplementalShadowReport["wouldAdd"][number] => ({
    title: candidate.title,
    summary: candidate.summary,
    url: candidate.sources[0]!.url,
    publishedAt: candidate.publishedAt ?? input.generatedAt,
    category: candidate.category,
    categoryLabel: candidate.categoryLabel,
    score: candidate.provenance?.selection.score ?? candidate.score,
    sourceIds: [...new Set([candidate.provenance?.lead.id, ...(candidate.provenance?.editorialCorroboration ?? []).map((source) => source.id)].filter((id): id is SupplementalSourceId => Boolean(id)))],
    sourceNames: [...new Set([candidate.provenance?.lead.name, ...(candidate.provenance?.editorialCorroboration ?? []).map((source) => source.name)].filter((name): name is string => Boolean(name)))]
  }));
  const pack = sourcePack(input.profile);
  const aiNewsCandidates = input.sourceResults.find((result) => result.health.id === "ainews")?.candidates.length ?? 0;
  return {
    schemaVersion: 1,
    mode: "daily-pool",
    generatedAt: input.generatedAt,
    baseIssue: { url: input.issue.url, issueDate: input.issue.issueDate, publicationDate: input.issue.publicationDate },
    sourcePack: { id: pack.id, version: pack.version },
    limits: { modelCandidates: 18, publishedStories: 14 },
    freshness: {
      preferredHours: PREFERRED_FRESHNESS_HOURS,
      maxHours: MAX_FRESHNESS_HOURS,
      eligibleCandidates: input.inventory.eligibleCandidates,
      expiredCandidates: input.inventory.expiredCandidates
    },
    sources: input.sourceResults.map((result) => result.health),
    totals: {
      aiNewsCandidates,
      supplementalCandidates: allCandidates.length - aiNewsCandidates,
      supplementalAfterDeduplication: input.inventory.eligibleCandidates,
      overlapsWithAiNews: input.inventory.candidates.filter((candidate) => (candidate.provenance?.coverage?.editorialSourceCount ?? 0) > 1).length,
      novelQualifiedCandidates: input.inventory.eligibleCandidates,
      wouldAdd: selected.length,
      selectedForBlend: selected.length
    },
    overlaps: [],
    wouldAdd: selected,
    selectedForBlend: selected
  };
}

export async function collectSupplementalShadow(input: { rssUrl: string; profile: Profile; now?: Date; fetcher?: Fetcher }): Promise<SupplementalShadowReport> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  const issueDate = melbourneCalendarDay(now);
  const issue: RssIssue = {
    url: `https://signal.tamirlevin.dev/?edition=${issueDate}`,
    issueDate,
    publicationDate: new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Melbourne" }).format(now),
    publishedAt: now.toISOString(),
    body: "",
    anchors: []
  };
  const sourceResults = await collectSupplementalSources({ profile: input.profile, now, fetcher, rssUrl: input.rssUrl });
  const inventory = buildDailyCandidateInventory({ sourceResults, profile: input.profile, now });
  return buildDailySourceReport({ issue, sourceResults, inventory, generatedAt: now.toISOString(), profile: input.profile });
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

function sourceDefinition(profile: Profile, id: SupplementalSourceId): SourceDefinition | undefined {
  return getSourcePack(profile.sourcePackId).sources.find((source) => source.id === id && source.enabled);
}

function sourcePack(profile: Profile) {
  return getSourcePack(profile.sourcePackId);
}
