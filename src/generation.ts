import type { Edition, ModelAttemptAudit, RssIssue, RunResult, Source } from "./contracts";
import { deterministicEditorialEdition, editorialMessages, extractGeneratedEdition, generationInput, issueFromCandidateInventory, materializeCandidateStories, ModelJsonError, ModelOutputTruncatedError, modelResponseDiagnostic, type ModelResponseDiagnostic } from "./editorial";
import { claimManualRepublish, completeManualRepublish, errorCode, getActiveProfile, insertEdition, melbourneCalendarDay, publishedEditionState, recordRun, recordSupplementalShadowRun, releaseManualRepublish, replaceEdition, type ManualRepublishClaim } from "./repository";
import { normalizeEditionStories } from "./story-normalization";
import { buildDailyCandidateInventory, buildDailySourceReport, collectSupplementalSources } from "./supplemental";
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
    const trackingKeys: string[] = [];
    parsed.searchParams.forEach((_value, key) => { if (TRACKING_KEYS.test(key)) trackingKeys.push(key); });
    for (const key of trackingKeys) parsed.searchParams.delete(key);
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
    ...edition.synthesis,
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

export function isModelJsonInvalid(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof ModelJsonError;
}

export function isModelOutputTruncated(error: unknown): boolean {
  return error instanceof ModelOutputTruncatedError;
}

export function supportsStructuredOutput(model: string): boolean {
  return new Set([
    "@cf/meta/llama-3.1-8b-instruct-fast",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/openai/gpt-oss-20b",
    "@cf/openai/gpt-oss-120b",
    "@cf/moonshotai/kimi-k2.6"
  ]).has(model);
}

function configuredModelChain(env: Env): string[] {
  const seen = new Set<string>();
  return [env.AI_MODEL, env.AI_FALLBACK_MODEL, env.AI_QUALITY_FALLBACK_MODEL]
    .map((model) => model.trim())
    .filter((model) => {
      if (!model || seen.has(model)) return false;
      seen.add(model);
      return true;
    });
}

function modelAttemptOutcome(error: unknown): ModelAttemptAudit["outcome"] {
  if (isModelTimeout(error)) return "timeout";
  if (isModelOutputTruncated(error)) return "output-truncated";
  if (isModelJsonInvalid(error)) return "invalid-json";
  if (error instanceof ValidationError) return "validation";
  return "failed";
}

function modelAttemptAudit(attempt: number, model: string, outcome: ModelAttemptAudit["outcome"], durationMs: number, diagnostic: ModelResponseDiagnostic, error?: unknown): ModelAttemptAudit {
  return {
    attempt,
    model,
    outcome,
    durationMs,
    ...diagnostic,
    ...(error === undefined ? {} : { error: (error instanceof Error ? error.message : String(error)).slice(0, 280) })
  };
}

export type GenerationOptions = { forceRepublish?: boolean };

function dailyIssue(at: Date): RssIssue {
  const issueDate = melbourneCalendarDay(at);
  return {
    url: `https://signal.tamirlevin.dev/?edition=${issueDate}`,
    issueDate,
    publicationDate: new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Melbourne" }).format(at),
    publishedAt: at.toISOString(),
    body: "",
    anchors: []
  };
}

/** Runs synchronously so scheduled() owns the promise and preserves the last good edition on failure. */
export async function generateLatestEdition(env: Env, trigger: Trigger, options: GenerationOptions = {}): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const forceRepublish = trigger === "manual" && options.forceRepublish === true;
  let republishClaim: ManualRepublishClaim | undefined;
  let issueUrl: string | undefined;
  let issueDate: string | undefined;
  let modelUsed: string = env.AI_MODEL;
  const modelAttempts: ModelAttemptAudit[] = [];
  try {
    const issue = dailyIssue(new Date(startedAt));
    issueUrl = issue.url;
    issueDate = issue.issueDate;
    const publication = await publishedEditionState(env.DB, issue.url, issue.issueDate);
    const replacingExistingEdition = trigger === "manual" && publication.exists && (publication.needsStoryRepair || forceRepublish);
    if (forceRepublish && publication.exists) {
      const claim = await claimManualRepublish(env.DB, melbourneCalendarDay());
      if (!claim) {
        await recordRun(env.DB, {
          trigger,
          status: "skipped",
          issueUrl,
          issueDate,
          model: env.AI_MODEL,
          errorCode: "MANUAL_REPUBLISH_LIMIT",
          errorMessage: "one forced manual republish is allowed per Melbourne calendar day",
          startedAt,
          durationMs: Date.now() - started
        });
        return { status: "skipped", reason: "manual-republish-limit" };
      }
      republishClaim = claim;
    }
    if (publication.exists && !replacingExistingEdition) {
      await recordRun(env.DB, { trigger, status: "skipped", issueUrl, issueDate, model: env.AI_MODEL, startedAt, durationMs: Date.now() - started });
      return { status: "skipped", reason: "already-published" };
    }
    const profile = await getActiveProfile(env.DB);
    const supplementalStartedAt = new Date().toISOString();
    const supplementalStarted = Date.now();
    const sourceResults = await collectSupplementalSources({ profile, now: new Date(startedAt), rssUrl: env.RSS_URL });
    const inventory = buildDailyCandidateInventory({ sourceResults, profile, now: new Date(startedAt) });
    if (!inventory.candidates.length) throw new ValidationError("No qualified stories were published inside the 48-hour source window");
    const modelIssue = issueFromCandidateInventory(issue, inventory.candidates);
    const sourceIssue = {
      ...issue,
      anchors: inventory.candidates.flatMap((candidate) => candidate.sources)
    };
    const sourceCatalog = buildPermittedSourceCatalog(sourceIssue);
    const report = buildDailySourceReport({ issue, sourceResults, inventory, generatedAt: new Date().toISOString(), profile });
    const failedSources = report.sources.filter((source) => source.status === "failed").length;
    const degradedSources = report.sources.filter((source) => source.status === "degraded").length;
    const sourceStatus = failedSources === report.sources.length ? "failed" : failedSources || degradedSources ? "degraded" : "healthy";
    try {
      await recordSupplementalShadowRun(env.DB, { trigger, status: sourceStatus, startedAt: supplementalStartedAt, durationMs: Date.now() - supplementalStarted, report });
    } catch (reportError) {
      console.warn(JSON.stringify({ message: "ai-signal source report could not be stored; publication continues", issueUrl, error: reportError instanceof Error ? reportError.message : String(reportError) }));
    }
    console.log(JSON.stringify({ message: "ai-signal daily candidate pool compacted", issueUrl, candidateChars: modelIssue.body.length, candidateLinks: modelIssue.anchors.length, eligibleCandidates: inventory.eligibleCandidates, expiredCandidates: inventory.expiredCandidates, candidates: inventory.candidates.length, contributingSources: inventory.collection.mode === "daily-pool" ? inventory.collection.sourcesContributing : [] }));
    const allowedStoryUrls = sourceCatalog.permittedUrls;
    const finalizeEdition = (generated: Edition): Edition => {
      const stories = materializeCandidateStories(inventory.candidates, profile, issue.publicationDate);
      // Source metadata and every story card are collector-derived, not model-authored.
      generated.issue = {
        ...(generated.issue ?? {}),
        url: issue.url,
        publicationDate: issue.publicationDate,
        coverage: "Qualified signals published in the previous 48 hours",
        quiet: stories.signals.length < profile.storyBudget
      };
      generated.signals = stories.signals;
      generated.hotTopics = stories.hotTopics;
      generated.collection = inventory.collection;
      const repaired = repairEditionSources(generated, issue.url, sourceCatalog);
      const normalized = normalizeEditionStories(repaired, profile, inventory.candidates);
      if (normalized.duplicateSignalsRemoved || normalized.invalidCandidateSignalsRemoved || normalized.titlesRewritten) {
        console.warn(JSON.stringify({ message: "ai-signal edition stories normalized", issueUrl, duplicatesRemoved: normalized.duplicateSignalsRemoved, invalidCandidatesRemoved: normalized.invalidCandidateSignalsRemoved, titlesRewritten: normalized.titlesRewritten, remaining: normalized.edition.signals.length }));
      }
      const validated = validateEdition(normalized.edition, profile, allowedStoryUrls);
      validatePresentationDiversity(validated.presentation);
      validateSynthesisDiversity(validated.synthesis);
      validated.profile = profile;
      return validated;
    };

    let edition: Edition | undefined;
    const models = configuredModelChain(env);
    for (const [index, model] of models.entries()) {
      modelUsed = model;
      const attempt = index + 1;
      const attemptStarted = Date.now();
      let diagnostic: ModelResponseDiagnostic = {};
      try {
        const raw = await askModel(env, model, generationInput(modelIssue, profile, undefined, supportsStructuredOutput(model), model));
        diagnostic = modelResponseDiagnostic(raw);
        const generated = extractGeneratedEdition(raw);
        edition = finalizeEdition(generated);
        modelAttempts.push(modelAttemptAudit(attempt, model, "success", Date.now() - attemptStarted, diagnostic));
        break;
      } catch (error) {
        const outcome = modelAttemptOutcome(error);
        modelAttempts.push(modelAttemptAudit(attempt, model, outcome, Date.now() - attemptStarted, diagnostic, error));
        console.warn(JSON.stringify({
          message: "ai-signal model attempt rejected",
          issueUrl,
          attempt,
          model,
          outcome,
          ...diagnostic,
          nextModel: models[index + 1] ?? "collector-deterministic"
        }));
      }
    }

    if (!edition) {
      modelUsed = "collector-deterministic";
      const attempt = modelAttempts.length + 1;
      const attemptStarted = Date.now();
      try {
        edition = finalizeEdition(deterministicEditorialEdition(issue, inventory.candidates, profile));
        modelAttempts.push(modelAttemptAudit(attempt, modelUsed, "success", Date.now() - attemptStarted, {}));
        console.warn(JSON.stringify({ message: "ai-signal deterministic editorial fallback activated", issueUrl, failedModelAttempts: models.length }));
      } catch (error) {
        modelAttempts.push(modelAttemptAudit(attempt, modelUsed, modelAttemptOutcome(error), Date.now() - attemptStarted, {}, error));
        throw error;
      }
    }

    const sourceBodyHash = await hash(modelIssue.body);
    const stored = replacingExistingEdition ? await replaceEdition(env.DB, edition, issue.issueDate, sourceBodyHash) : await insertEdition(env.DB, edition, issue.issueDate, sourceBodyHash);
    if (republishClaim) await completeManualRepublish(env.DB, republishClaim);
    await recordRun(env.DB, { trigger, status: "success", issueUrl, issueDate, model: modelUsed, editionId: stored.id, modelAttempts, startedAt, durationMs: Date.now() - started });
    return { status: "success", edition: stored };
  } catch (error) {
    if (republishClaim) {
      try {
        await releaseManualRepublish(env.DB, republishClaim);
      } catch (releaseError) {
        console.error(JSON.stringify({ message: "ai-signal republish claim could not be released", issueUrl, error: releaseError instanceof Error ? releaseError.message : String(releaseError) }));
      }
    }
    const code = errorCode(error);
    console.error(JSON.stringify({ message: "ai-signal generation failed", code, issueUrl, issueDate, error: error instanceof Error ? error.message : String(error) }));
    try {
      await recordRun(env.DB, { trigger, status: "failed", issueUrl, issueDate, model: modelUsed, errorCode: code, errorMessage: error instanceof Error ? error.message : String(error), modelAttempts, startedAt, durationMs: Date.now() - started });
    } catch (recordError) {
      console.error(JSON.stringify({ message: "ai-signal failure could not be logged", error: recordError instanceof Error ? recordError.message : String(recordError) }));
    }
    return { status: "failed", code, ...(error instanceof ValidationError ? { reason: error.message } : {}) };
  }
}

// Kept exported for tests and to make the model prompt path explicit.
export { editorialMessages };
