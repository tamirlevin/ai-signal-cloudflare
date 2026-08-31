import type { CandidateStory, Edition, HotTopic, Profile, RssIssue, Signal } from "./contracts";

const MAX_CANDIDATE_BLOCKS = 18;
const PRIORITY_BLOCKS = 15;
const MAX_LINKS_PER_BLOCK = 3;
const MAX_BLOCK_TEXT = 900;

const CATEGORY_TERMS: Record<string, RegExp> = {
  agents: /\bagent(?:s|ic)?\b|autonom|multi-agent|subagent/gi,
  codex: /\bcodex\b|claude code|\bcursor\b|coding agent|developer tool|software engineering|terminal/gi,
  newSystems: /\blaunch|\brelease|new system|first[- ]ever|now possible|new product/gi,
  integration: /integrat|platform|plugin|connector|browser|identity|memory|tool use|foundry|cloud/gi,
  business: /enterprise|business|adoption|revenue|market|economic|company|pricing|cost/gi,
  frontier: /frontier|capability|benchmark|intelligence index|state of the art/gi,
  research: /research|science|scientific|mathemat|discovery/gi,
  harness: /harness|evaluation|\beval|permission|approval|orchestrat|reliab|observability|access control|sandbox|redact|prompt injection|credential|revocation|audit/gi,
  newly: /\bnew\b|emerging|first[- ]ever|novel/gi,
  lowFit: /policy|cyber|infrastructure|incident|governance|safety|\bgpu\b|cuda|hardware|data cent(?:er|re)/gi,
  training: /pre[- ]?train|training data|dataset|fine[- ]?tun/gi
};
const SCORE_ONLY_TERMS: Partial<Record<string, RegExp>> = { agents: /workflow/gi };

const DEPRIORITIZED_TERMS = /\bvideo\b|\blocal\b|on-device|stable diffusion|comfyui|quantization|\bgpu\b|cuda|\bhardware\b|api pricing/gi;
const EXCEPTIONAL_TERMS = /\bfirst[- ]ever\b|\bbreakthrough\b|\bunprecedented\b|new state[- ]of[- ]the[- ]art/gi;
const PERMISSION_DESIGN_TERMS = [
  /\b(?:agent|tool|runtime|command|action|file|network|browser|terminal|shell|system|user) permission(?:s)?\b/i,
  /\bpermission(?:s)? (?:design|model|scope|scopes|boundary|boundaries|policy|policies|prompt|prompts|gate|gates|control|controls|system|systems|setting|settings)\b/i,
  /\b(?:grant|grants|granted|granting|deny|denies|denied|denying|revoke|revokes|revoked|revoking|request|requests|requested|requesting|require|requires|required|requiring|bypass|bypasses|bypassed|bypassing|check|checks|checked|checking|enforce|enforces|enforced|enforcing) (?:a |the |user )?permission(?:s)?\b/i,
  /\b(?:human|manual|user|operator|admin|administrator|reviewer) approval(?:s)?\b/i,
  /\bapproval(?:s)? (?:gate|gates|flow|flows|workflow|workflows|policy|policies|prompt|prompts|requirement|requirements|request|requests|queue|queues|step|steps|checkpoint|checkpoints|control|controls|mode|modes)\b/i,
  /\b(?:require|requires|required|requiring|request|requests|requested|requesting|seek|seeks|seeking|await|awaits|awaiting|bypass|bypasses|bypassed|bypassing|grant|grants|granted|granting) (?:human |user |manual )?approval(?:s)?\b/i,
  /\bapprove(?:d|s|ing)? (?:or deny|before|commands?|actions?|tool calls?)\b/i,
  /\bapproval(?:s)? (?:for|before|to) (?:run|execute|access|use|call|modify|delete|write|deploy)\b/i,
  /access control/i,
  /agent security/i,
  /sandbox(?:ing|ed)?/i
];
const GEOGRAPHY_TERMS = /cluster geography|data cent(?:er|re)|sovereign|regional capacity|\bchina\b|united states|\bu\.s\.\b/gi;
const CATEGORY_PRIORITY = ["codex", "harness", "agents", "integration", "business", "newSystems", "frontier", "research", "training", "lowFit"];

type CandidateBlock = { index: number; heading?: string; text: string; anchors: RssIssue["anchors"]; score: number };

export type ModelIssueInventory = { issue: RssIssue; candidates: CandidateStory[] };

function matches(pattern: RegExp, value: string): number {
  pattern.lastIndex = 0;
  return value.match(pattern)?.length ?? 0;
}

export function isPermissionDesignSignal(textValue: string): boolean {
  return PERMISSION_DESIGN_TERMS.some((pattern) => matches(pattern, textValue) > 0);
}

function blockScore(text: string, profile: Profile, linkCount: number): number {
  let score = Math.min(linkCount, MAX_LINKS_PER_BLOCK) * 2;
  for (const weight of profile.weights) {
    const pattern = CATEGORY_TERMS[weight.id];
    if (!pattern) continue;
    score += matches(pattern, text) * (weight.value - 2) * 4;
    const scoreOnlyPattern = SCORE_ONLY_TERMS[weight.id];
    if (scoreOnlyPattern) score += matches(scoreOnlyPattern, text) * (weight.value - 2) * 4;
  }
  return score - matches(DEPRIORITIZED_TERMS, text) * 6;
}

export function scoreCandidateForProfile(text: string, profile: Profile, linkCount = 1): number {
  return blockScore(text, profile, linkCount);
}

function distinctAnchors(line: string, anchorsByUrl: Map<string, RssIssue["anchors"][number]>): RssIssue["anchors"] {
  const found: RssIssue["anchors"] = [];
  const seen = new Set<string>();
  for (const match of line.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)) {
    const source = anchorsByUrl.get(match[1]!);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    found.push(source);
    if (found.length === MAX_LINKS_PER_BLOCK) break;
  }
  return found;
}

function compactText(line: string): string {
  return line.replace(/\[([^\]]+)\]\(https:\/\/[^)\s]+\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, MAX_BLOCK_TEXT);
}

function candidateTitle(textValue: string): string {
  const withoutActivity = textValue.replace(/\s*\(Activity:\s*\d+\).*$/i, "");
  const separator = withoutActivity.search(/\s+:\s+/);
  const titleText = separator > 0 ? withoutActivity.slice(separator).replace(/^\s*:\s*/, "") : withoutActivity;
  const sentence = (titleText.split(/[.!?](?:\s|$)/, 1)[0] ?? titleText).replace(/\s+([,.;:!?])/g, "$1").trim();
  const boundary = sentence.search(/,(?=\s)|\s+(?:where|which|while|powering|reporting|described as|less for|sharing a story)\s+/i);
  const clause = boundary >= 16 ? sentence.slice(0, boundary) : sentence;
  const words = clause.split(/\s+/).slice(0, 14);
  while (words.length > 3 && /^(?:and|or|with|from|to|for|as|at|in|on|of|the|a|an|now|both)$/i.test(words.at(-1)!)) words.pop();
  return words.join(" ").replace(/[,:;]+$/, "") || "AI update";
}

function candidateSummary(textValue: string): string {
  const clean = textValue.replace(/\s*\(Activity:\s*\d+\).*$/i, "").trim();
  const separator = clean.search(/\s+:\s+/);
  const afterSeparator = separator > 0 ? clean.slice(separator).replace(/^\s*:\s*/, "") : clean;
  const words = (afterSeparator.trim() || clean).split(/\s+/);
  const summary = words.slice(0, 45).join(" ").replace(/\s+([,.;:!?])/g, "$1").replace(/[,:;]+$/, "");
  return summary ? `${summary}${words.length > 45 ? "…" : ""}` : "AI update";
}

function displaySource(source: RssIssue["anchors"][number]): RssIssue["anchors"][number] {
  try {
    const url = new URL(source.url);
    if (/^(?:www\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)) {
      const handle = url.pathname.split("/").filter(Boolean)[0];
      if (handle && handle !== "i") return { ...source, label: `@${handle}` };
    }
  } catch { /* URL validity is enforced again before publication. */ }
  return source;
}

function categoryFor(textValue: string, profile: Profile): { id: string; label: string } {
  const weights = new Map(profile.weights.map((weight) => [weight.id, weight]));
  let selected: { id: string; label: string; score: number } | undefined;
  for (const id of CATEGORY_PRIORITY) {
    const weight = weights.get(id);
    const pattern = CATEGORY_TERMS[id];
    if (!weight || !pattern) continue;
    const count = matches(pattern, textValue);
    if (!count) continue;
    const score = count * 10 + weight.value * 3 + (profile.pinnedCategories.includes(weight.label) ? 3 : 0);
    if (!selected || score > selected.score) selected = { id, label: weight.label, score };
  }
  const fallback = weights.get("newly") ?? profile.weights[0]!;
  return selected ? { id: selected.id, label: selected.label } : { id: fallback.id, label: fallback.label };
}

export function categoryForProfile(textValue: string, profile: Profile): { id: string; label: string } {
  return categoryFor(textValue, profile);
}

function productVersionKey(title: string): string | undefined {
  const tokens = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9.]+/g, " ").trim().split(/\s+/);
  const versionIndex = tokens.findIndex((token) => /\d/.test(token));
  if (versionIndex < 0) return undefined;
  return tokens.slice(Math.max(0, versionIndex - 1), versionIndex + 1).join(":");
}

function distinctCandidates(candidates: CandidateStory[]): CandidateStory[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const seenProducts = new Set<string>();
  return candidates.filter((candidate) => {
    const urls = candidate.sources.map((source) => source.url).filter(Boolean);
    const title = candidate.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
    const product = productVersionKey(candidate.title);
    if (urls.some((url) => seenUrls.has(url)) || seenTitles.has(title) || (product && seenProducts.has(product))) return false;
    for (const url of urls) seenUrls.add(url);
    seenTitles.add(title);
    if (product) seenProducts.add(product);
    return true;
  });
}

/** Builds source-bound story cards without asking the model to enumerate or relabel them. */
export function materializeCandidateStories(candidates: CandidateStory[], profile: Profile, publicationDate: string): { signals: Signal[]; hotTopics: HotTopic[] } {
  const selected = distinctCandidates(candidates).slice(0, Math.min(profile.storyBudgetRange[1], 14));
  const signals = selected.map((candidate, index): Signal => {
    const source = candidate.sources[0]!;
    const displayedSource = displaySource(source);
    return {
      candidateId: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      source: displayedSource.label,
      date: candidate.publishedAt
        ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Melbourne" }).format(new Date(candidate.publishedAt))
        : publicationDate,
      url: source.url,
      category: candidate.category,
      categoryLabel: candidate.categoryLabel,
      base: Math.max(48, 100 - index * 4),
      exceptional: candidate.exceptional,
      watchPermission: candidate.watchPermission,
      watchGeography: candidate.watchGeography,
      ...(candidate.provenance ? { provenance: candidate.provenance } : {})
    };
  });
  const hotTopics = selected.slice(0, Math.min(3, selected.length)).map((candidate, index): HotTopic => ({
    title: candidate.title,
    summary: candidate.summary,
    category: candidate.category,
    base: Math.max(80, 100 - index * 7),
    exceptional: candidate.exceptional,
    watchPermission: candidate.watchPermission,
    watchGeography: candidate.watchGeography,
    sources: candidate.sources.slice(0, 3).map(displaySource),
    ...(candidate.provenance ? { provenance: candidate.provenance } : {})
  }));
  return { signals, hotTopics };
}

/** Selects and orders a profile-aware candidate inventory before invoking Workers AI. */
export function compactIssueInventory(issue: RssIssue, profile: Profile): ModelIssueInventory {
  const anchorsByUrl = new Map(issue.anchors.map((source) => [source.url, source]));
  const lines = issue.body.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates: CandidateBlock[] = [];
  let heading: string | undefined;
  for (const [index, line] of lines.entries()) {
    const anchors = distinctAnchors(line, anchorsByUrl);
    if (!anchors.length) {
      if (line.length <= 180) heading = compactText(line);
      continue;
    }
    const textValue = compactText(line);
    if (/^AI News for\b/i.test(textValue)) continue;
    if (heading && /^Top tweets\b/i.test(heading)) continue;
    const sectionPenalty = heading && /^\d+\./.test(heading) ? 18 : 0;
    candidates.push({ index, ...(heading ? { heading } : {}), text: textValue, anchors, score: blockScore(line, profile, anchors.length) - sectionPenalty });
  }
  if (!candidates.length) return { issue, candidates: [] };

  const priority = [...candidates].sort((left, right) => right.score - left.score || left.index - right.index).slice(0, PRIORITY_BLOCKS);
  const selectedIndexes = new Set(priority.map((candidate) => candidate.index));
  const remaining = candidates.filter((candidate) => !selectedIndexes.has(candidate.index));
  const diversitySlots = Math.min(MAX_CANDIDATE_BLOCKS - priority.length, remaining.length);
  const diverse: CandidateBlock[] = [];
  for (let slot = 0; slot < diversitySlots; slot += 1) {
    const position = Math.floor(((slot + 0.5) * remaining.length) / diversitySlots);
    diverse.push(remaining[Math.min(position, remaining.length - 1)]!);
  }
  const selected = [...priority, ...diverse].sort((left, right) => right.score - left.score || left.index - right.index);
  const compactAnchors: RssIssue["anchors"] = [];
  const candidateStories: CandidateStory[] = [];
  const seenUrls = new Set<string>();
  const body = selected.map((candidate, index) => {
    for (const source of candidate.anchors) {
      if (seenUrls.has(source.url)) continue;
      seenUrls.add(source.url);
      compactAnchors.push(source);
    }
    const id = index + 1;
    const title = candidateTitle(candidate.text);
    const category = categoryFor(`${candidate.heading ?? ""} ${candidate.text}`, profile);
    candidateStories.push({
      id,
      title,
      summary: candidateSummary(candidate.text),
      category: category.id,
      categoryLabel: category.label,
      score: candidate.score,
      exceptional: matches(EXCEPTIONAL_TERMS, candidate.text) > 0,
      watchPermission: isPermissionDesignSignal(candidate.text),
      watchGeography: matches(GEOGRAPHY_TERMS, candidate.text) > 0,
      sources: candidate.anchors.map(displaySource),
      modelText: candidate.text
    });
    const sources = candidate.anchors.map((source) => `[${source.label}](${source.url})`).join(" | ");
    return `Candidate ${id}\nStory: ${title}${candidate.heading ? `\nSection: ${candidate.heading}` : ""}\nEvidence: ${candidate.text}\nAllowed links for this candidate: ${sources}`;
  }).join("\n\n");
  return { issue: { ...issue, body, anchors: compactAnchors }, candidates: candidateStories };
}

export function compactIssueForModel(issue: RssIssue, profile: Profile): RssIssue {
  return compactIssueInventory(issue, profile).issue;
}

/** Rebuilds model context from the exact deterministic inventory selected for publication. */
export function issueFromCandidateInventory(issue: RssIssue, candidates: CandidateStory[]): RssIssue {
  const anchors: RssIssue["anchors"] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const source of candidate.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      anchors.push(source);
    }
  }
  const body = candidates.map((candidate) => {
    const provenance = candidate.provenance;
    const corroboration = provenance?.editorialCorroboration.map((source) => source.name).join(", ") || "none";
    const evidence = provenance?.evidence.map((source) => `${source.kind === "primary" ? "primary" : "linked"}: ${source.label}`).join(", ") || "linked sources below";
    const sources = candidate.sources.map((source) => `[${source.label}](${source.url})`).join(" | ");
    return `Candidate ${candidate.id}\nStory: ${candidate.title}\nPublished: ${candidate.publishedAt ?? "timestamp unavailable"}\nEvidence summary: ${candidate.modelText ?? candidate.summary}\nLead source (${provenance?.lead.layer ?? "editorial"}): ${provenance?.lead.name ?? "source feed"}\nEditorial corroboration (discovery context, not proof): ${corroboration}\nEvidence links: ${evidence}\nAllowed links for this candidate: ${sources}`;
  }).join("\n\n");
  return { ...issue, body, anchors };
}

const TEXT_SCHEMA = { type: "string", minLength: 1 } as const;
const SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "url"],
  properties: { label: TEXT_SCHEMA, url: TEXT_SCHEMA }
} as const;
const SOURCES_SCHEMA = { type: "array", minItems: 1, maxItems: 6, items: SOURCE_SCHEMA } as const;
export const EDITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "issue", "presentation", "synthesis"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    issue: {
      type: "object",
      additionalProperties: false,
      required: ["publicationDate", "coverage", "url", "quiet"],
      properties: {
        publicationDate: TEXT_SCHEMA,
        coverage: TEXT_SCHEMA,
        url: TEXT_SCHEMA,
        quiet: { type: "boolean" }
      }
    },
    presentation: {
      type: "object",
      additionalProperties: false,
      required: ["hotTitle", "hotIntro", "allTitle", "allIntro", "synthesisTitle", "synthesisIntro", "sourceReadMinutes", "briefReadMinutes"],
      properties: {
        hotTitle: TEXT_SCHEMA,
        hotIntro: TEXT_SCHEMA,
        allTitle: TEXT_SCHEMA,
        allIntro: TEXT_SCHEMA,
        synthesisTitle: TEXT_SCHEMA,
        synthesisIntro: TEXT_SCHEMA,
        sourceReadMinutes: { type: "integer", minimum: 1, maximum: 999 },
        briefReadMinutes: { type: "integer", minimum: 1, maximum: 999 }
      }
    },
    synthesis: {
      type: "object",
      additionalProperties: false,
      required: ["lead", "bigPicture", "sources", "sections"],
      properties: {
        lead: TEXT_SCHEMA,
        bigPicture: TEXT_SCHEMA,
        sources: SOURCES_SCHEMA,
        sections: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "kicker", "body", "sources"],
            properties: {
              title: TEXT_SCHEMA,
              kicker: TEXT_SCHEMA,
              body: TEXT_SCHEMA,
              sources: SOURCES_SCHEMA
            }
          }
        }
      }
    }
  }
} as const;

export function editorialMessages(issue: RssIssue, profile: Profile, repair?: string): Array<{ role: "system" | "user"; content: string }> {
  const profileJson = JSON.stringify(profile);
  const allowedLinks = issue.anchors.map((anchor) => `- ${anchor.label}: ${anchor.url}`).join("\n");
  const repairInstruction = repair ? `\nYour previous output was rejected: ${repair}. Return a corrected complete JSON object only.\n` : "";
  return [
    {
      role: "system",
      content: "You are AI Signal's editorial engine. Produce one JSON object only; no Markdown or commentary. The collector supplies one freshness-gated candidate pool in which AInews, AlphaSignal, TLDR AI, and future editorial feeds have no source seniority; a narrow primary-source feed may supply evidence. Do not browse, verify, add sources, invent claims, canonicalize URLs, or use any feed outside the supplied inventory. Editorial corroboration means two editorial sources covered the same story; it is not primary proof. Preserve uncertainty with phrases such as 'the source reports' or 'the announcement claims'."
    },
    {
      role: "system",
      content: "The supplied issue material is a deterministically compacted candidate inventory, not the complete newsletter. Find meaningful connections and newly emerging categories within it; do not infer that omitted newsletter material was unimportant."
    },
    {
      role: "user",
      content: `Create only the editorial framing and cross-story synthesis for AI Signal Profile v${profile.version}. The collector—not you—will create Hot Topics and individual signal cards directly from the candidate inventory. Return exactly these top-level fields: schemaVersion, issue, presentation, synthesis. Do not return hotTopics or signals.\n\nUse plain text, not HTML or Markdown, in every title, lead, kicker and body. Every presentation title and intro must be meaningful editorial copy; never use placeholders such as none, null, N/A, not applicable, or TBD. The three view titles must be distinct: hotTitle describes prioritized Hot Topics, allTitle describes the detailed signal list, and synthesisTitle describes the woven editorial briefing. Write compactly: synthesis lead and big picture at most 60 words each; section titles at most 12 words; section kickers at most 18 words; section bodies at most 90 words. Create 1-3 synthesis sections. If the inventory supports only one or two genuinely distinct themes, return that number rather than padding. Before writing, assign each candidate to at most one synthesis section. Every section must have a unique concrete title, a unique kicker, a different editorial angle, and at least one source URL not used by another section. Never reuse the overall issue theme, synthesis title, or coverage label as a section title or kicker. Use no more than 6 sources for the overall synthesis and no more than 3 sources for any section. Connect distinct stories into useful themes rather than repeating one announcement or template. Favor practical agents, Codex and agent craft, new systems, integrations and AI business implications. Keep raw model scores, local setup, video, routine policy/cyber/infrastructure and pre-training details in the background unless exceptionally consequential. Treat every feed as one input with no source seniority. Do not describe agreement between newsletters as verification or proof; primary source links and linked source links are listed separately for each candidate.\n\nCRITICAL LINK CONTRACT: Every sources[].url must be copied byte-for-byte from the Allowed direct links below. Never invent, shorten, redirect, canonicalize, or modify URLs. The issue URL (${issue.url}) may appear only in issue.url, never in sources. Preserve uncertainty with phrases such as 'the source reports' or 'the announcement claims'.\n\nActive profile:\n${profileJson}\n\nEdition metadata: publicationDate=${issue.publicationDate}; coverage is the collector's 48-hour source window; url=${issue.url}\n\nAllowed direct links:\n${allowedLinks}\n\nRanked source-aware candidate inventory:\n${issue.body}\n${repairInstruction}`
    }
  ];
}

export function generationInput(issue: RssIssue, profile: Profile, repair?: string, useStructuredOutput = true, model?: string): ChatCompletionsMessagesInput {
  const input: ChatCompletionsMessagesInput = {
    messages: editorialMessages(issue, profile, repair),
    max_completion_tokens: 3200,
    reasoning_effort: "low",
    temperature: 0.2,
    frequency_penalty: 0.35,
    presence_penalty: 0.15
  };
  if (!useStructuredOutput) return input;
  const structured = { ...input, response_format: { type: "json_schema" as const, json_schema: { name: "ai_signal_edition", strict: true, schema: EDITION_SCHEMA } } };
  return model === "@cf/meta/llama-3.1-8b-instruct-fast" ? { ...structured, chat_template_kwargs: { enable_thinking: false } } : structured;
}

export class ModelJsonError extends Error {
  override name = "ModelJsonError";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapJsonFence(value: string): string {
  const trimmed = value.trim();
  return trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
}

function responseDiagnostic(raw: unknown): string {
  if (!record(raw)) return `response_type=${raw === null ? "null" : typeof raw}`;
  const details: string[] = [`keys=${Object.keys(raw).sort().slice(0, 8).join(",") || "none"}`];
  const choices = Array.isArray(raw.choices) ? raw.choices : [];
  const choice = record(choices[0]) ? choices[0] : undefined;
  if (typeof choice?.finish_reason === "string") details.push(`finish_reason=${choice.finish_reason}`);
  const message = record(choice?.message) ? choice.message : undefined;
  if (message && "content" in message) {
    const content = message.content;
    details.push(`content=${content === null ? "null" : Array.isArray(content) ? `parts:${content.length}` : typeof content}`);
  }
  const usage = record(raw.usage) ? raw.usage : undefined;
  if (typeof usage?.completion_tokens === "number") details.push(`completion_tokens=${usage.completion_tokens}`);
  const completionDetails = record(usage?.completion_tokens_details) ? usage.completion_tokens_details : undefined;
  if (typeof completionDetails?.reasoning_tokens === "number") details.push(`reasoning_tokens=${completionDetails.reasoning_tokens}`);
  if (typeof raw.status === "string") details.push(`status=${raw.status}`);
  const incomplete = record(raw.incomplete_details) ? raw.incomplete_details : undefined;
  if (typeof incomplete?.reason === "string") details.push(`incomplete_reason=${incomplete.reason}`);
  return details.join("; ");
}

function textParts(value: unknown, acceptedType: "text" | "output_text"): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => record(part) && part.type === acceptedType && typeof part.text === "string" ? [part.text] : []).join("");
}

function parseModelJson(value: string, diagnostic: string): Edition {
  const text = unwrapJsonFence(value);
  try {
    return JSON.parse(text) as Edition;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ModelJsonError(`Model returned invalid JSON (${diagnostic}; chars=${text.length}): ${detail}`);
  }
}

export function extractGeneratedEdition(raw: unknown): Edition {
  const diagnostic = responseDiagnostic(raw);
  if (record(raw) && "response" in raw) {
    const response = raw.response;
    if (record(response)) return response as Edition;
    if (typeof response === "string") return parseModelJson(response, `format=response; ${diagnostic}`);
  }
  if (typeof raw === "string") return parseModelJson(raw, diagnostic);
  if (record(raw) && typeof raw.output_text === "string" && raw.output_text) {
    return parseModelJson(raw.output_text, `format=responses-output-text; ${diagnostic}`);
  }
  if (record(raw) && Array.isArray(raw.output)) {
    const text = raw.output.flatMap((item) => record(item) ? [textParts(item.content, "output_text")] : []).join("");
    if (text) return parseModelJson(text, `format=responses-output; ${diagnostic}`);
  }
  if (record(raw) && Array.isArray(raw.choices)) {
    const choice = record(raw.choices[0]) ? raw.choices[0] : undefined;
    const message = record(choice?.message) ? choice.message : undefined;
    const content = message?.content;
    const text = typeof content === "string" ? content : textParts(content, "text");
    if (text) return parseModelJson(text, `format=chat-completions; ${diagnostic}`);
  }
  throw new ModelJsonError(`Model did not return a JSON edition (${diagnostic})`);
}
