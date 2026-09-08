/// <reference types="node" />
/** Read-only source/profile sensitivity check. No generation, D1, or publication. */
import { createHash } from "node:crypto";
import type { Profile } from "../src/contracts";
import { materializeCandidateStories } from "../src/editorial";
import { buildDailyCandidateInventory, collectSupplementalSources, parseAiSecretFeed, type SourceResult } from "../src/supplemental";
import { getSourcePack } from "../src/source-packs";
import { validateProfile } from "../src/validation";

// End is a Melbourne calendar date; this bounded September comparison uses AEST.
const endDay = process.argv[2] ?? "2026-09-09";
if (!/^2026-09-\d{2}$/.test(endDay) || Number(endDay.slice(-2)) < 1 || Number(endDay.slice(-2)) > 30) throw new Error("Supply a September 2026 end date (YYYY-MM-DD, AEST)");
const end = new Date(`${endDay}T08:15:00+10:00`);
const source = getSourcePack().sources.find((item) => item.id === "ai-secret")!;
async function read(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 2_000_000) throw new Error("Replay input exceeds 2 MB");
  return text;
}
const [xml, profileJson] = await Promise.all([read(source.url), read("https://signal.tamirlevin.dev/api/profile")]);
const current = validateProfile(JSON.parse(profileJson).profile);
const proposed: Profile = {
  ...current,
  version: current.version + 1,
  weights: current.weights.map((weight) => ({ ...weight, value: ({ codex: 3, newSystems: 3, research: 2 } as Record<string, number>)[weight.id] ?? weight.value }))
};
// Experimental removal of generic-word penalties is replay-only, not runtime policy.
const genericPenalty = (text: string) => (text.match(/\bvideo\b|\blocal\b|on-device|\bhardware\b/gi)?.length ?? 0) * 6;
const variants = [
  { name: "current", profile: current, removePenalty: false },
  { name: "proposed", profile: proposed, removePenalty: false },
  { name: "experimental-penalties", profile: proposed, removePenalty: true }
];
const unique = new Map(variants.map(({ name }) => [name, new Map<string, { title: string; category: string }>()]));
console.log(JSON.stringify({ scope: "AI Secret only, not a reconstruction of historical multi-source pools", endDay, feedSha256: createHash("sha256").update(xml).digest("hex"), profile: current, proposedWeights: proposed.weights, feedItems: (xml.match(/<item>/g) ?? []).length }));
for (let offset = 9; offset >= 0; offset--) {
  const now = new Date(end.getTime() - offset * 86_400_000);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(now);
  const results = variants.map(({ name, profile, removePenalty }) => {
    const candidates = parseAiSecretFeed(xml, now, profile).map((candidate) => ({ ...candidate, score: candidate.score + (removePenalty ? genericPenalty(`${candidate.title} ${candidate.summary}`) : 0) }));
    const result: SourceResult = { candidates, health: { id: source.id, name: source.name, requests: 1, fetchedItems: 0, acceptedCandidates: candidates.length, status: "healthy", errors: [] } };
    const inventory = buildDailyCandidateInventory({ sourceResults: [result], profile, now });
    const cards = materializeCandidateStories(inventory.candidates, profile, day).signals;
    for (const card of cards) unique.get(name)!.set(card.url, { title: card.title, category: card.category });
    return { name, parsed: candidates.length, eligible: inventory.eligibleCandidates, window: inventory.collection.maxFreshnessHours, selected: cards.length, ...(process.argv.includes("--details") ? { cards: cards.map(({ title, url, category }) => ({ title, url, category })) } : {}) };
  });
  console.log(JSON.stringify({ day, results }));
}
console.log(JSON.stringify({ uniqueSelected: Object.fromEntries([...unique].map(([name, cards]) => [name, { total: cards.size, categories: [...cards.values()].reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.category]: (counts[item.category] ?? 0) + 1 }), {}) }])), added: [...unique.get("proposed")!].filter(([url]) => !unique.get("current")!.has(url)).map(([url, card]) => ({ ...card, url })), removed: [...unique.get("current")!].filter(([url]) => !unique.get("proposed")!.has(url)).map(([url, card]) => ({ ...card, url })) }));

if (process.argv.includes("--live-pool")) {
  // Reuse the same responses for shared URLs across both profiles. This is a
  // current collection, not a historical reconstruction or a publication.
  const cache = new Map<string, Promise<Response>>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!cache.has(url)) cache.set(url, fetch(input, init));
    return (await cache.get(url)!).clone();
  };
  const now = new Date();
  for (const [name, profile] of [["current", current], ["proposed", proposed]] as const) {
    const sourceResults = await collectSupplementalSources({ profile, now, fetcher });
    const inventory = buildDailyCandidateInventory({ sourceResults, profile, now });
    const cards = materializeCandidateStories(inventory.candidates, profile, endDay).signals;
    console.log(JSON.stringify({ live: name, at: now.toISOString(), sources: sourceResults.map(({ health }) => health), eligible: inventory.eligibleCandidates, window: inventory.collection.maxFreshnessHours, cards: cards.map(({ title, category, provenance }) => ({ title, category, lead: provenance?.lead.name })) }));
  }
}
