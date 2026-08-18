import type { Edition, RssIssue, RunResult, Source } from "./contracts";
import { compactIssueInventory, editorialMessages, extractGeneratedEdition, generationInput, materializeCandidateStories } from "./editorial";
import { fetchLatestRss } from "./rss";
import { errorCode, getActiveProfile, insertEdition, publishedEditionState, recordRun, replaceEdition } from "./repository";
import { normalizeEditionStories } from "./story-normalization";
import { ValidationError, validateEdition, validatePresentationDiversity, validateSynthesisDiversity } from "./validation";

type Trigger = "cron" | "manual" | "local-scheduled";

const TRACKING_KEYS = /^(?:utm_[^=]+|fbclid|gclid|ref|source|campaign|medium)$/i;

function canonicalizeSourceUrl(raw: string, baseUrl: string): string | undefined {
  const trimmed = raw.trim().replace(/^[`"'(<{\[]+|^\s+/, "").replace(/[`"'.,;:!?[\]})>]+$/g, "");
  if (!trimmed) return undefined;
  const withScheme = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(withScheme, baseUrl);
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    if (parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_KEYS.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function buildPermittedSourceCatalog(issue: RssIssue): { permittedUrls: Set<string>; labelByUrl: Map<string, string>; orderedUrls: string[] } {
  const permittedUrls = new Set<string>();
  const labelByUrl = new Map<string, string>();
  const orderedUrls: string[] = [];
  for (const source of issue.anchors) {
    const canonical = canonicalizeSourceUrl(source.url, issue.url);
    const candidateUrls = [source.url];
    if (canonical && canonical !== source.url) candidateUrls.push(canonical);
    for (const url of candidateUrls) {
      if (!permittedUrls.has(url)) {
        permittedUrls.add(url);
        labelByUrl.set(url, source.label);
        orderedUrls.push(url);
      }
    }
  }
  return { permittedUrls, labelByUrl, orderedUrls };
}

function repairSourceList(
  sources: Source[] | undefined,
  issueUrl: string,
  catalog: ReturnType<typeof buildPermittedSourceCatalog>,
  opts: { maxItems: number; reserveAcrossList?: boolean; reserved?: Set<string> }
): Source[] {
  const reserved = opts.reserveAcrossList ? opts.reserved ?? new Set<string>() : undefined;
  const repaired: Source[] = [];
  const seen = new Set<string>();

  for (const source of sources ?? []) {
    const normalized = canonicalizeSourceUrl(source.url, issueUrl);
    if (!normalized) continue;
    if (!catalog.permittedUrls.has(normalized)) continue;
    if (reserved?.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    repaired.push({ label: source.label || catalog.labelByUrl.get(normalized) || "Source", url: normalized });
    seen.add(normalized);
    reserved?.add(normalized);
    if (repaired.length >= opts.maxItems) break;
  }

  if (repaired.length === 0) {
    for (const candidateUrl of catalog.orderedUrls) {
      if (reserved?.has(candidateUrl)) continue;
      const label = catalog.labelByUrl.get(candidateUrl);
      if (!label) continue;
      repaired.push({ label, url: candidateUrl });
      reserved?.add(candidateUrl);
      break;
    }
  }

  return repaired.slice(0, opts.maxItems);
}

function repairEditionSources(edition: Edition, issueUrl: string, catalog: ReturnType<typeof buildPermittedSourceCatalog>): Edition {
  const sectionReserved = new Set<string>();
  const synthesis = {
    sources: Array.isArray(edition.synthesis?.sources) ? edition.synthesis.sources : [],
    sections: Array.isArray(edition.synthesis?.sections) ? edition.synthesis.sections : []
  };
  return {
    ...edition,
    hotTopics: Array.isArray(edition.hotTopics)
      ? edition.hotTopics.map((topic) => ({ ...topic, sources: repairSourceList(topic.sources, issueUrl, catalog, { maxItems: 3 }) }))
      : [],
    synthesis: {
      ...synthesis,
      sources: repairSourceList(synthesis.sources, issueUrl, catalog, { maxItems: 6, reserveAcrossList: true }),
      sections: synthesis.sections.map((section) => ({
        ...section,
        sources: repairSourceList(section.sources, issueUrl, catalog, { maxItems: 3, reserveAcrossList: true, reserved: sectionReserved })
      }))
    }
  };
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function askModel(env: Env, modelName: string, input: ChatCompletionsMessagesInput): Promise<unknown> {
  const gateway = env.AI_GATEWAY_ID.trim();
  const model = modelName as keyof AiModels;
  if (gateway) return env.AI.run(model, input, { gateway: { id: gateway } });
  return env.AI.run(model, input);
}

export function isModelTimeout(error: unknown): boolean {
  return error instanceof Error && /(?:3007|3046|request timeout|timed out)/i.test(error.message);
}

export function supportsStructuredOutput(model: string): boolean {
  return new Set([
    "@cf/meta/llama-3.1-8b-instruct-fast",
    "@cf/openai/gpt-oss-20b",
    "@cf/openai/gpt-oss-120b",
    "@cf/moonshotai/kimi-k2.6"
  ]).has(model);
}

function canRepairModelOutput(error: unknown): boolean {
  if (error instanceof ValidationError || error instanceof SyntaxError) return true;
  return error instanceof Error && error.message === "Model did not return a JSON edition";
}

/** Runs synchronously so scheduled() owns the promise and preserves the last good edition on failure. */
export async function generateLatestEdition(env: Env, trigger: Trigger): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let issueUrl: string | undefined;
  let issueDate: string | undefined;
  let modelUsed: string = env.AI_MODEL;
  try {
    const issue = await fetchLatestRss(env.RSS_URL);
    issueUrl = issue.url;
    issueDate = issue.issueDate;
    const publication = await publishedEditionState(env.DB, issue.url, issue.issueDate);
    const sourceCatalog = buildPermittedSourceCatalog(issue);
    const replacingExistingEdition = trigger === "manual" && publication.exists && publication.needsStoryRepair;
    if (publication.exists && !replacingExistingEdition) {
      await recordRun(env.DB, { trigger, status: "skipped", issueUrl, issueDate, model: env.AI_MODEL, startedAt, durationMs: Date.now() - started });
      return { status: "skipped", reason: "already-published" };
    }
    const profile = await getActiveProfile(env.DB);
    const inventory = compactIssueInventory(issue, profile);
    const modelIssue = inventory.issue;
    console.log(JSON.stringify({ message: "ai-signal candidate inventory compacted", issueUrl, sourceChars: issue.body.length, candidateChars: modelIssue.body.length, sourceLinks: issue.anchors.length, candidateLinks: modelIssue.anchors.length }));
    const allowedStoryUrls = sourceCatalog.permittedUrls;
    let lastError: unknown;
    let repair: string | undefined;
    let usedFallback = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = await askModel(env, modelUsed, generationInput(modelIssue, profile, repair, supportsStructuredOutput(modelUsed), modelUsed));
        const generated = extractGeneratedEdition(raw);
        const stories = materializeCandidateStories(inventory.candidates, profile, issue.publicationDate);
        // Source metadata and every story card are collector-derived, not model-authored.
        generated.issue = {
          ...(generated.issue ?? {}),
          url: issue.url,
          publicationDate: issue.publicationDate,
          quiet: stories.signals.length < profile.storyBudget
        };
        generated.signals = stories.signals;
        generated.hotTopics = stories.hotTopics;
        const repaired = repairEditionSources(generated, issue.url, sourceCatalog);
        const normalized = normalizeEditionStories(repaired, profile, inventory.candidates);
        if (normalized.duplicateSignalsRemoved || normalized.invalidCandidateSignalsRemoved || normalized.titlesRewritten) {
          console.warn(JSON.stringify({ message: "ai-signal model stories normalized", issueUrl, duplicatesRemoved: normalized.duplicateSignalsRemoved, invalidCandidatesRemoved: normalized.invalidCandidateSignalsRemoved, titlesRewritten: normalized.titlesRewritten, remaining: normalized.edition.signals.length }));
        }
        const edition = validateEdition(normalized.edition, profile, allowedStoryUrls);
        validatePresentationDiversity(edition.presentation);
        validateSynthesisDiversity(edition.synthesis);
        edition.profile = profile;
        const sourceBodyHash = await hash(issue.body);
        const stored = replacingExistingEdition ? await replaceEdition(env.DB, edition, issue.issueDate, sourceBodyHash) : await insertEdition(env.DB, edition, issue.issueDate, sourceBodyHash);
        await recordRun(env.DB, { trigger, status: "success", issueUrl, issueDate, model: modelUsed, editionId: stored.id, startedAt, durationMs: Date.now() - started });
        return { status: "success", edition: stored };
      } catch (error) {
        lastError = error;
        const fallback = env.AI_FALLBACK_MODEL.trim();
        if (isModelTimeout(error) && !usedFallback && fallback && fallback !== modelUsed) {
          console.warn(JSON.stringify({ message: "ai-signal primary model timed out; switching once", issueUrl, primaryModel: modelUsed, fallbackModel: fallback }));
          modelUsed = fallback;
          usedFallback = true;
          repair = undefined;
          continue;
        }
        if (attempt < 2 && canRepairModelOutput(error)) {
          repair = String(error).slice(0, 280);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  } catch (error) {
    const code = errorCode(error);
    console.error(JSON.stringify({ message: "ai-signal generation failed", code, issueUrl, issueDate, error: error instanceof Error ? error.message : String(error) }));
    try {
      await recordRun(env.DB, { trigger, status: "failed", issueUrl, issueDate, model: modelUsed, errorCode: code, errorMessage: error instanceof Error ? error.message : String(error), startedAt, durationMs: Date.now() - started });
    } catch (recordError) {
      console.error(JSON.stringify({ message: "ai-signal failure could not be logged", error: recordError instanceof Error ? recordError.message : String(recordError) }));
    }
    return { status: "failed", code, ...(error instanceof ValidationError ? { reason: error.message } : {}) };
  }
}

// Kept exported for tests and to make the model prompt path explicit.
export { editorialMessages };
