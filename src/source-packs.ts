import type { SourcePack, SourcePackId } from "./contracts";

export const DEFAULT_SOURCE_PACK_ID: SourcePackId = "core-ai";

/**
 * Source packs are deliberately code-defined and owner-controlled for now.
 * They describe public, bounded feeds only; they never contain X credentials
 * or arbitrary user-supplied URLs.
 */
export const SOURCE_PACKS: Record<SourcePackId, SourcePack> = {
  "core-ai": {
    id: "core-ai",
    version: 1,
    label: "Core AI",
    description: "AInews base coverage with newsletter discovery and Cloudflare primary evidence.",
    sources: [
      { id: "tldr-ai", name: "TLDR AI", kind: "discovery", url: "https://tldr.tech/api/rss/ai", enabled: true, shadowCap: 3 },
      { id: "alphasignal", name: "AlphaSignal", kind: "discovery", url: "https://alphasignal.ai/sitemaps/news.xml", enabled: true, shadowCap: 2, lookbackHours: 72, enrichLimit: 5 },
      { id: "cloudflare-agents", name: "Cloudflare Agents", kind: "primary", url: "https://blog.cloudflare.com/tag/agents/rss", enabled: true, shadowCap: 1, lookbackHours: 72 }
    ]
  }
};

export function isSourcePackId(value: string): value is SourcePackId {
  return Object.prototype.hasOwnProperty.call(SOURCE_PACKS, value);
}

export function getSourcePack(id: SourcePackId = DEFAULT_SOURCE_PACK_ID): SourcePack {
  return SOURCE_PACKS[id] ?? SOURCE_PACKS[DEFAULT_SOURCE_PACK_ID];
}
