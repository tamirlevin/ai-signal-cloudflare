export const VIEWER_OVERRIDE_VERSION = 1;
export const VIEWER_OVERRIDE_STORAGE_KEY = "ai-signal.viewer-overrides.v1";

const WEIGHT_LABELS = ["Demote", "Background", "Balanced", "Prioritize", "Lead"];
const SAFE_OVERRIDE_KEYS = new Set(["version", "storyBudget", "weights", "exceptionalStoryOverride", "safeguards"]);
const SAFE_SAFEGUARD_KEYS = new Set(["watchPermissions", "watchGeography"]);
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasPermissionDesignLanguage(item) {
  const text = `${item.title ?? ""} ${item.summary ?? ""}`;
  return PERMISSION_DESIGN_TERMS.some((pattern) => pattern.test(text));
}

function activePermissionWatch(item, profile) {
  return Boolean(item.watchPermission && profile.safeguards.watchPermissions && hasPermissionDesignLanguage(item));
}

export function baseProfileForEdition(sharedProfile, editionProfile, isHistoricalEdition) {
  return clone(isHistoricalEdition && editionProfile ? editionProfile : sharedProfile);
}

function supportedRange(profile) {
  const range = Array.isArray(profile?.storyBudgetRange) ? profile.storyBudgetRange : [5, 14];
  const low = Number.isInteger(range[0]) ? range[0] : 5;
  const high = Number.isInteger(range[1]) ? range[1] : 14;
  return [Math.max(5, low), Math.min(14, high)];
}

/**
 * Returns a normalized, sparse viewer override or null. It deliberately accepts
 * only the current version and only category IDs in the supplied global profile.
 */
export function normalizeViewerOverride(raw, profile) {
  if (!isObject(raw) || raw.version !== VIEWER_OVERRIDE_VERSION) return null;
  if (Object.keys(raw).some((key) => !SAFE_OVERRIDE_KEYS.has(key))) return null;
  const weightsById = new Map((profile?.weights ?? []).map((weight) => [weight.id, weight.value]));
  if (!weightsById.size) return null;
  const normalized = { version: VIEWER_OVERRIDE_VERSION };
  let changed = false;
  const [low, high] = supportedRange(profile);

  if (raw.storyBudget !== undefined) {
    if (!Number.isInteger(raw.storyBudget) || raw.storyBudget < low || raw.storyBudget > high) return null;
    if (raw.storyBudget !== profile.storyBudget) {
      normalized.storyBudget = raw.storyBudget;
      changed = true;
    }
  }
  if (raw.weights !== undefined) {
    if (!isObject(raw.weights)) return null;
    const weights = {};
    for (const [id, value] of Object.entries(raw.weights)) {
      if (!weightsById.has(id) || !Number.isInteger(value) || value < 0 || value > 4) return null;
      if (value !== weightsById.get(id)) weights[id] = value;
    }
    if (Object.keys(weights).length) {
      normalized.weights = weights;
      changed = true;
    }
  }
  if (raw.exceptionalStoryOverride !== undefined) {
    if (typeof raw.exceptionalStoryOverride !== "boolean") return null;
    if (raw.exceptionalStoryOverride !== profile.exceptionalStoryOverride) {
      normalized.exceptionalStoryOverride = raw.exceptionalStoryOverride;
      changed = true;
    }
  }
  if (raw.safeguards !== undefined) {
    if (!isObject(raw.safeguards) || Object.keys(raw.safeguards).some((key) => !SAFE_SAFEGUARD_KEYS.has(key))) return null;
    const safeguards = {};
    for (const key of SAFE_SAFEGUARD_KEYS) {
      if (raw.safeguards[key] === undefined) continue;
      if (typeof raw.safeguards[key] !== "boolean") return null;
      if (raw.safeguards[key] !== profile.safeguards[key]) safeguards[key] = raw.safeguards[key];
    }
    if (Object.keys(safeguards).length) {
      normalized.safeguards = safeguards;
      changed = true;
    }
  }
  return changed ? normalized : null;
}

export function mergeViewerOverride(profile, override) {
  const normalized = normalizeViewerOverride(override, profile);
  if (!normalized) return clone(profile);
  const merged = clone(profile);
  if (normalized.storyBudget !== undefined) merged.storyBudget = normalized.storyBudget;
  if (normalized.weights) merged.weights.forEach((weight) => { if (normalized.weights[weight.id] !== undefined) weight.value = normalized.weights[weight.id]; });
  if (normalized.exceptionalStoryOverride !== undefined) merged.exceptionalStoryOverride = normalized.exceptionalStoryOverride;
  if (normalized.safeguards) Object.assign(merged.safeguards, normalized.safeguards);
  return merged;
}

export function createViewerOverride(profile, candidate) {
  const raw = {
    version: VIEWER_OVERRIDE_VERSION,
    storyBudget: candidate.storyBudget,
    weights: Object.fromEntries((candidate.weights ?? []).map((weight) => [weight.id, weight.value])),
    exceptionalStoryOverride: candidate.exceptionalStoryOverride,
    safeguards: candidate.safeguards
  };
  return normalizeViewerOverride(raw, profile);
}

export function rankItems(items, profile) {
  const weights = new Map((profile.weights ?? []).map((weight) => [weight.id, weight.value]));
  const score = (item) => Number(item.base ?? 0)
    + (weights.get(item.category) ?? 0) * 10
    + (item.exceptional && profile.exceptionalStoryOverride ? 45 : 0)
    + (activePermissionWatch(item, profile) ? 20 : 0)
    + (item.watchGeography && profile.safeguards.watchGeography ? 20 : 0);
  return [...items].map((item, index) => ({ item, index, score: score(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

/**
 * Returns one plain-language explanation for why an item is prominent.
 * Raw ranking scores are deliberately not exposed: they are implementation
 * details, while these reasons map to controls a reader can understand.
 */
export function rankingReason(item, profile) {
  if (item.exceptional && profile.exceptionalStoryOverride) return { label: "Exceptional signal", tone: "exceptional" };
  if (activePermissionWatch(item, profile)) return { label: "Watching · agent permission design", tone: "watched" };
  if (item.watchGeography && profile.safeguards.watchGeography) return { label: "Watching · AI cluster geography", tone: "watched" };
  const weight = (profile.weights ?? []).find((candidate) => candidate.id === item.category);
  if (!weight) return null;
  if ((profile.pinnedCategories ?? []).includes(weight.label)) return { label: `Pinned · ${weight.label}`, tone: "pinned" };
  const tone = weight.value >= 3 ? "priority" : weight.value <= 1 ? "background" : "balanced";
  return { label: `${weight.label} · ${weightLabel(weight.value)}`, tone };
}

function editorialStrengthLabel(value) {
  const strength = Number(value ?? 0);
  if (strength >= 80) return "Strong editorial signal";
  if (strength >= 60) return "Useful editorial signal";
  return "Supporting context";
}

/**
 * Explains the factors that actually influence ranking without exposing the
 * internal integer score or inventing a normalized rating.
 */
export function rankingExplanation(item, profile) {
  const weight = (profile.weights ?? []).find((candidate) => candidate.id === item.category);
  const factors = [];
  if (item.exceptional && profile.exceptionalStoryOverride) {
    factors.push({ label: "Editorial override", value: "Exceptional-story rule", state: "Applied", tone: "exceptional" });
  }
  if (activePermissionWatch(item, profile)) {
    factors.push({ label: "Watched topic", value: "Agent permission design", state: "Applied", tone: "watched" });
  }
  if (item.watchGeography && profile.safeguards.watchGeography) {
    factors.push({ label: "Watched topic", value: "AI cluster geography", state: "Applied", tone: "watched" });
  }
  if (weight) {
    const tone = weight.value >= 3 ? "priority" : weight.value <= 1 ? "background" : "balanced";
    factors.push({ label: "Category", value: weight.label, state: weightLabel(weight.value), tone });
    if ((profile.pinnedCategories ?? []).includes(weight.label)) {
      factors.push({ label: "Editorial marker", value: `Pinned · ${weight.label}`, state: "Label only", tone: "pinned" });
    }
  }
  const editorialSources = [];
  const provenance = item?.provenance;
  if (provenance?.lead?.layer === "editorial") editorialSources.push(provenance.lead);
  for (const source of provenance?.editorialCorroboration ?? []) {
    if (source.layer === "editorial") editorialSources.push(source);
  }
  const seenEditorialIds = new Set();
  const distinctEditorialSources = editorialSources.filter((source) => {
    if (seenEditorialIds.has(source.id)) return false;
    seenEditorialIds.add(source.id);
    return true;
  });
  if (distinctEditorialSources.length > 1) {
    factors.push({ label: "Coverage", value: distinctEditorialSources.map((source) => source.name).join(" + "), state: `${distinctEditorialSources.length} editorial sources`, tone: "neutral" });
  }
  factors.push({ label: "Editorial strength", value: editorialStrengthLabel(item.base), state: "Underlying", tone: "neutral" });
  return { primary: rankingReason(item, profile), factors };
}

export function weightLabel(value) {
  return WEIGHT_LABELS[value] ?? "Balanced";
}

export function readStoredViewerOverride(profile) {
  try {
    return normalizeViewerOverride(JSON.parse(localStorage.getItem(VIEWER_OVERRIDE_STORAGE_KEY) ?? "null"), profile);
  } catch {
    return null;
  }
}

export function persistViewerOverride(override, profile) {
  const normalized = normalizeViewerOverride(override, profile);
  try {
    if (normalized) localStorage.setItem(VIEWER_OVERRIDE_STORAGE_KEY, JSON.stringify(normalized));
    else localStorage.removeItem(VIEWER_OVERRIDE_STORAGE_KEY);
  } catch {
    // Private browsing or disabled storage: the current-page preview still works.
  }
  return normalized;
}

export function clearStoredViewerOverride() {
  try { localStorage.removeItem(VIEWER_OVERRIDE_STORAGE_KEY); } catch { /* Storage is optional. */ }
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function tuningFragment(override, profile) {
  const normalized = normalizeViewerOverride(override, profile);
  return normalized ? `#tune=${base64UrlEncode(JSON.stringify(normalized))}` : "";
}

export function readTuningFragment(hash, profile) {
  const match = /^#tune=([A-Za-z0-9_-]{1,4096})$/.exec(hash ?? "");
  if (!match?.[1]) return null;
  try { return normalizeViewerOverride(JSON.parse(base64UrlDecode(match[1])), profile); } catch { return null; }
}
