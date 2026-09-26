import {
  baseProfileForEdition,
  clearStoredViewerOverride,
  createViewerOverride,
  mergeViewerOverride,
  persistViewerOverride,
  rankItems,
  rankingExplanation,
  rankingReason,
  readStoredViewerOverride,
  readTuningFragment,
  tuningFragment,
  weightLabel
} from "/personalization.js";

const app = document.querySelector("#app");
const dialog = document.querySelector("#tune-dialog");
const openTune = document.querySelector("#open-tune");
const readerStatus = document.querySelector("#reader-status");
const rankingDialog = document.querySelector("#ranking-dialog");
const rankingTitle = document.querySelector("#ranking-title");
const rankingContent = document.querySelector("#ranking-content");
const closeRanking = document.querySelector("#close-ranking");
const rankingPersonalise = document.querySelector("#ranking-personalise");
const state = { baseProfile: null, override: null, previewOverride: null, edition: null, historyEditions: null, adminProfile: null, collectionStatus: null, isHistoricalEdition: false, readerView: "hot", rankingItems: new Map(), jevReviewBatch: null };
const READER_VIEWS = [
  { id: "synthesis", label: "Synthesis" },
  { id: "hot", label: "Hot topics" },
  { id: "all", label: "All signals" }
];

function escape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function sourceLinks(sources, label = "Sources") {
  return `<div class="sources"><span>${escape(label)}</span>${sources.map((source) => `<a href="${escape(source.url)}" target="_blank" rel="noreferrer">${escape(source.label)}</a>`).join("")}</div>`;
}

function sourceLabel(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; }
}

function provenanceMarkup(item) {
  const provenance = item?.provenance;
  if (!provenance) return "";
  const crossChecks = (provenance.editorialCorroboration ?? []).map((source) => source.name).join(", ");
  const evidenceKinds = [...new Set((provenance.evidence ?? []).map((source) => source.kind === "primary" ? "Primary evidence" : "Linked source"))].join(" + ");
  const leadLabel = provenance.lead.layer === "primary" ? "Primary-source lead" : "Editorial lead";
  return `<div class="source-context" aria-label="Story source context"><span>${leadLabel} · ${escape(provenance.lead.name)}</span>${crossChecks ? `<span>Editorial cross-check · ${escape(crossChecks)}</span>` : ""}${evidenceKinds ? `<span>${escape(evidenceKinds)}</span>` : ""}</div>`;
}

function collectionLabel(edition) {
  const collection = edition.collection;
  if (collection?.mode === "daily-pool") {
    const sources = collection.sourcesContributing.join(" + ") || "No contributing source";
    return `${sources} · ${collection.selectedCandidates} qualified · ${collection.maxFreshnessHours}-hour window`;
  }
  if (!collection || collection.mode !== "blended") return "AInews source inventory";
  const discovery = collection.editorialDiscovery.join(" + ");
  const additions = collection.selectedSupplemental === 1 ? "1 novel supplemental story" : `${collection.selectedSupplemental} novel supplemental stories`;
  return `AInews base · ${discovery} discovery policy · ${additions}`;
}

function activeOverride() { return state.previewOverride ?? state.override; }
function activeProfile() { return mergeViewerOverride(state.baseProfile, activeOverride()); }

function localDateTime(value) {
  if (!value) return "not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function scheduledTimeLabel(value) {
  const [hours, minutes] = String(value ?? "22:15").split(":").map(Number);
  const date = new Date();
  date.setUTCHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}

function collectionNotice(edition) {
  const lastRun = state.collectionStatus?.lastRun;
  if (!lastRun) return `<p class="refresh-status">Updated ${escape(localDateTime(edition.publishedAt))}.</p>`;
  const outcome = lastRun.status === "failed" ? `failed${lastRun.errorCode ? ` (${escape(lastRun.errorCode)})` : ""}${lastRun.failureDetail ? `: ${escape(lastRun.failureDetail)}` : ""}` : lastRun.status === "skipped" ? lastRun.errorCode === "MANUAL_REPUBLISH_LIMIT" ? "the once-daily manual republish limit was reached" : "found today's edition already published" : "published a new brief";
  const stateLabel = lastRun.status === "failed" ? "Check failed" : lastRun.status === "skipped" ? "Current" : "Published";
  return `<details class="refresh-status"><summary><span>Updated ${escape(localDateTime(edition.publishedAt))} · source checked ${escape(localDateTime(lastRun.finishedAt))}</span><span class="refresh-state ${lastRun.status === "failed" ? "failed" : ""}">${stateLabel}</span></summary><p>The collector ${outcome}. Automatic check: daily at ${escape(scheduledTimeLabel(state.collectionStatus.scheduledDailyAtUtc))}.</p></details>`;
}

function heartbeatNotice() {
  if (state.isHistoricalEdition) return "";
  const heartbeat = state.collectionStatus?.scheduledHeartbeat;
  if (!heartbeat || heartbeat.status === "healthy") return "";
  if (heartbeat.status === "missing") return `<aside class="heartbeat-alert" role="alert"><strong>Scheduled heartbeat unavailable.</strong><span>No completed cron check is recorded yet. The last good edition remains available.</span></aside>`;
  const outcome = heartbeat.lastOutcome ? ` Its recorded outcome was ${heartbeat.lastOutcome}.` : "";
  return `<aside class="heartbeat-alert" role="alert"><strong>Scheduled check overdue.</strong><span>The last completed cron check was ${escape(localDateTime(heartbeat.lastCompletedAt))}; the alert threshold is ${escape(heartbeat.staleAfterHours)} hours.${escape(outcome)}</span></aside>`;
}

function profileNotice(edition, profile, visibleCount) {
  const generatedVersion = edition.profile?.version;
  const profileLabel = state.isHistoricalEdition ? "Profile" : "Current profile";
  const versionText = generatedVersion && generatedVersion !== profile.version ? `${profileLabel} v${profile.version} · generated with v${generatedVersion}` : `${profileLabel} v${profile.version}`;
  const countText = edition.signals.length < profile.storyBudget
    ? `${visibleCount} available · target ${profile.storyBudget}`
    : `${visibleCount}/${edition.signals.length} signals`;
  return `${versionText} · ${countText}`;
}

function syncPersonaliseControl() {
  openTune.classList.toggle("preview", Boolean(state.previewOverride));
  openTune.textContent = state.previewOverride ? "Personalise · Preview" : state.override ? "Personalise · On" : "Personalise";
  openTune.setAttribute("aria-label", state.previewOverride ? "Personalise: shared preview available" : state.override ? "Personalise: browser preferences active" : "Personalise AI Signal");
}

function normalizedDisplayText(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}

function tabs(view) {
  return `<div class="reader-tabs" role="tablist" aria-label="Reader view">${READER_VIEWS.map((candidate) => `<button id="reader-tab-${candidate.id}" type="button" role="tab" aria-controls="reader-panel" aria-selected="${candidate.id === view}" tabindex="${candidate.id === view ? "0" : "-1"}" data-view="${candidate.id}">${candidate.label}</button>`).join("")}</div>`;
}

function viewIntro(label, title, intro) {
  const normalizedLabel = normalizedDisplayText(label);
  const normalizedTitle = normalizedDisplayText(title);
  const distinctLabel = normalizedLabel !== normalizedTitle && !normalizedTitle.startsWith(`${normalizedLabel} `);
  return `<header class="view-intro">${distinctLabel ? `<p class="view-label">${escape(label)}</p>` : ""}<h2>${escape(title)}</h2><p>${escape(intro)}</p></header>`;
}

function reasonMarkup(item, profile, key, rank, group, items) {
  const reason = rankingReason(item, profile);
  if (!reason) return "";
  state.rankingItems.set(key, { item, profile, rank, group, items });
  return `<button class="ranking-trigger ${escape(reason.tone)}" type="button" data-ranking-key="${escape(key)}" aria-haspopup="dialog" aria-label="Explain why ${escape(item.title)} is ranked ${rank}"><span class="ranking-trigger-label">Why it surfaced</span><strong>${escape(reason.label)}</strong><span class="ranking-trigger-action">Explain</span></button>`;
}

function reasonClass(item, profile) {
  const reason = rankingReason(item, profile);
  return reason ? ` is-${reason.tone}` : "";
}

function markerLegend(profile) {
  const markers = [];
  if (profile.safeguards.watchPermissions || profile.safeguards.watchGeography) markers.push(`<span><i class="legend-mark watched" aria-hidden="true"></i><strong>Green</strong> · watched topic</span>`);
  if (profile.exceptionalStoryOverride) markers.push(`<span><i class="legend-mark exceptional" aria-hidden="true"></i><strong>Orange</strong> · exceptional signal</span>`);
  return markers.length ? `<aside class="marker-legend" aria-label="Editorial marker legend"><span class="legend-title">Markers</span>${markers.join("")}</aside>` : "";
}

function rankingDriversMarkup(items, profile) {
  const categories = new Set(items.map((item) => item.category));
  const drivers = (profile.weights ?? [])
    .filter((weight) => categories.has(weight.id))
    .sort((left, right) => right.value - left.value)
    .slice(0, 4);
  if (!drivers.length) return "";
  return `<section class="ranking-drivers"><h3>Today’s active category drivers</h3>${drivers.map((weight) => `<div class="ranking-driver"><span><strong>${escape(weight.label)}</strong><small>${escape(weightLabel(weight.value))}</small></span><span class="ranking-driver-bars" aria-label="${escape(weight.label)}: ${escape(weightLabel(weight.value))}">${[1, 2, 3, 4].map((step) => `<i class="${step <= weight.value ? "active" : ""}" aria-hidden="true"></i>`).join("")}</span></div>`).join("")}</section>`;
}

function openRankingInspector(key) {
  const record = state.rankingItems.get(key);
  if (!record) return;
  const explanation = rankingExplanation(record.item, record.profile);
  const sourceUrl = record.item.url ?? record.item.sources?.[0]?.url;
  const titleMarkup = sourceUrl
    ? `<a href="${escape(sourceUrl)}" target="_blank" rel="noreferrer">${escape(record.item.title)}</a>`
    : escape(record.item.title);
  rankingTitle.textContent = `Why #${String(record.rank).padStart(2, "0")} surfaced`;
  rankingContent.innerHTML = `<p class="ranking-group">${escape(record.group)} ranking</p><h3 class="ranking-story-title">${titleMarkup}</h3>${explanation.primary ? `<p class="ranking-primary ${escape(explanation.primary.tone)}">${escape(explanation.primary.label)}</p>` : ""}<div class="ranking-factors">${explanation.factors.map((factor) => `<div class="ranking-factor ${escape(factor.tone)}"><span>${escape(factor.label)}</span><strong>${escape(factor.value)}</strong><em>${escape(factor.state)}</em></div>`).join("")}</div>${rankingDriversMarkup(record.items, record.profile)}`;
  if (!rankingDialog.open) rankingDialog.showModal();
  readerStatus.textContent = `Showing the ranking explanation for ${record.item.title}.`;
}

function issueHeader(edition, profile, visibleCount) {
  const personalState = state.previewOverride ? "Shared tuning preview" : state.override ? "Personalised in this browser" : "";
  return `<header class="issue-header"><div><p class="view-label">Daily AI brief</p><h1><a href="${escape(edition.issue.url)}">${escape(edition.issue.publicationDate)}</a></h1><p>${escape(edition.issue.coverage)}</p><p class="collection-source">${escape(collectionLabel(edition))}</p></div><div class="issue-meta"><span>${escape(profileNotice(edition, profile, visibleCount))}</span>${personalState ? `<span class="personal-state">${escape(personalState)}</span>` : ""}</div></header>`;
}

function renderEdition(edition, profile, view = "hot") {
  state.readerView = view;
  state.rankingItems = new Map();
  const visibleSignals = rankItems(edition.signals, profile).slice(0, profile.storyBudget);
  const rankedHotTopics = rankItems(edition.hotTopics, profile);
  const hot = rankedHotTopics.map((topic, index) => {
    const primary = topic.sources[0];
    const title = primary
      ? `<a href="${escape(primary.url)}" target="_blank" rel="noreferrer">${escape(topic.title)}</a>`
      : escape(topic.title);
    return `<article class="topic${reasonClass(topic, profile)}"><span class="story-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><div><h3>${title}</h3><p>${escape(topic.summary)}</p><div class="story-footer">${sourceLinks(topic.sources)}${provenanceMarkup(topic)}</div></div>${reasonMarkup(topic, profile, `hot-${index}`, index + 1, "Hot topics", rankedHotTopics)}</article>`;
  }).join("");
  const signals = visibleSignals.map((signal, index) => `<article class="signal-row${index === 0 ? " signal-lead" : ""}${reasonClass(signal, profile)}"><span class="story-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><div><h3><a href="${escape(signal.url)}" target="_blank" rel="noreferrer">${escape(signal.title)}</a></h3><p>${escape(signal.summary)}</p><div class="story-footer"><span class="signal-source">${escape([sourceLabel(signal.source), signal.date].filter(Boolean).join(" · "))}</span>${provenanceMarkup(signal)}${reasonMarkup(signal, profile, `signal-${index}`, index + 1, "All signals", visibleSignals)}</div></div></article>`).join("");
  const sections = edition.synthesis.sections.map((section, index) => {
    const kicker = normalizedDisplayText(section.kicker) === normalizedDisplayText(section.title) ? "" : `<p class="kicker">${escape(section.kicker)}</p>`;
    return `<section class="section"><p class="section-index">${String(index + 1).padStart(2, "0")}</p><h3>${escape(section.title)}</h3>${kicker}<p>${escape(section.body)}</p>${sourceLinks(section.sources)}</section>`;
  }).join("");
  const hotView = `${viewIntro("Hot topics", edition.presentation.hotTitle, edition.presentation.hotIntro)}${markerLegend(profile)}<div class="hot-list">${hot}</div>`;
  const allView = `${viewIntro("All signals", edition.presentation.allTitle, edition.presentation.allIntro)}${markerLegend(profile)}<div class="signals-list">${signals}</div>`;
  const synthesisView = `${viewIntro("Synthesis", edition.presentation.synthesisTitle, edition.presentation.synthesisIntro)}<article class="synthesis-layout"><div class="synthesis-main"><p class="lead">${escape(edition.synthesis.lead)}</p><div class="big">${escape(edition.synthesis.bigPicture)}</div><div>${sections}</div></div><aside class="synthesis-rail"><p class="rail-label">Reading time</p><p class="time">${edition.presentation.sourceReadMinutes} min source → ${edition.presentation.briefReadMinutes} min brief</p>${sourceLinks(edition.synthesis.sources, "Brief sources")}</aside></article>`;
  const content = view === "synthesis" ? synthesisView : view === "all" ? allView : hotView;
  app.innerHTML = `${issueHeader(edition, profile, visibleSignals.length)}${heartbeatNotice()}${collectionNotice(edition)}<div class="reader-toolbar">${tabs(view)}</div><section class="view-panel" id="reader-panel" role="tabpanel" aria-labelledby="reader-tab-${view}" tabindex="0">${content}</section>`;
  const buttons = [...app.querySelectorAll("[data-view]")];
  const activate = (nextView, focus = false) => {
    renderEdition(edition, profile, nextView);
    if (focus) app.querySelector(`[data-view="${nextView}"]`)?.focus();
    readerStatus.textContent = `Showing ${READER_VIEWS.find((candidate) => candidate.id === nextView)?.label ?? nextView}.`;
  };
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => activate(button.dataset.view, true));
    button.addEventListener("keydown", (event) => {
      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % buttons.length;
      else if (event.key === "ArrowLeft") nextIndex = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = buttons.length - 1;
      else return;
      event.preventDefault();
      activate(buttons[nextIndex].dataset.view, true);
    });
  });
  app.querySelectorAll("[data-ranking-key]").forEach((button) => button.addEventListener("click", () => openRankingInspector(button.dataset.rankingKey)));
  syncPersonaliseControl();
}

function renderHistory(editions) {
  state.historyEditions = editions;
  const fragment = state.previewOverride ? location.hash : "";
  app.innerHTML = `<header class="history-header"><p class="view-label">Archive</p><h1>Edition history</h1><p>The latest 15 successfully published AI Signal editions.</p></header><div class="history-list">${editions.map((edition) => `<a class="history-item" href="/?edition=${encodeURIComponent(edition.issueDate)}${fragment}"><span><strong>${escape(edition.issue.publicationDate)}</strong><small>${escape(edition.issue.coverage)}</small></span><span>Open</span></a>`).join("")}</div>`;
  syncPersonaliseControl();
}

function syncTune() {
  const profile = activeProfile();
  document.querySelector("#story-budget").min = profile.storyBudgetRange[0];
  document.querySelector("#story-budget").max = profile.storyBudgetRange[1];
  document.querySelector("#story-budget").value = profile.storyBudget;
  document.querySelector("#budget-value").textContent = profile.storyBudget;
  document.querySelector("#weights").innerHTML = profile.weights.map((weight) => `<div class="weight"><label>${escape(weight.label)} <output>${weightLabel(weight.value)}</output></label><input data-weight="${escape(weight.id)}" type="range" min="0" max="4" value="${weight.value}"></div>`).join("");
  document.querySelector("#exceptional").checked = profile.exceptionalStoryOverride;
  document.querySelector("#watch-permissions").checked = profile.safeguards.watchPermissions;
  document.querySelector("#watch-geography").checked = profile.safeguards.watchGeography;
  const candidateNotice = state.edition && state.edition.signals.length < profile.storyBudget
    ? `This edition has ${state.edition.signals.length} qualified candidates, so it can show fewer than your ${profile.storyBudget}-story target. The target remains saved for editions with more candidates.`
    : "";
  document.querySelector("#tune-notice").hidden = !state.previewOverride && !candidateNotice;
  document.querySelector("#tune-notice").textContent = state.previewOverride ? "This shared tuning is a preview. Accept it explicitly to save it in this browser." : candidateNotice;
  document.querySelector("#apply-tune").textContent = state.previewOverride ? "Accept and save" : "Save in this browser";
  document.querySelectorAll("[data-weight]").forEach((input) => input.addEventListener("input", () => { input.previousElementSibling.querySelector("output").textContent = weightLabel(Number(input.value)); }));
  document.querySelector("#story-budget").addEventListener("input", (event) => { document.querySelector("#budget-value").textContent = event.target.value; });
}

function tuneCandidate() {
  const profile = activeProfile();
  profile.storyBudget = Number(document.querySelector("#story-budget").value);
  profile.weights.forEach((weight) => { weight.value = Number(document.querySelector(`[data-weight="${CSS.escape(weight.id)}"]`).value); });
  profile.exceptionalStoryOverride = document.querySelector("#exceptional").checked;
  profile.safeguards.watchPermissions = document.querySelector("#watch-permissions").checked;
  profile.safeguards.watchGeography = document.querySelector("#watch-geography").checked;
  return profile;
}

function clearFragment() {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function renderCurrentEdition() {
  if (state.edition) renderEdition(state.edition, activeProfile(), state.readerView);
  else if (state.historyEditions) renderHistory(state.historyEditions);
}

function openTuneDialog() {
  if (!state.baseProfile) return;
  document.querySelector("#tune-status").textContent = "";
  syncTune();
  dialog.showModal();
}

async function copyTuningLink() {
  const override = createViewerOverride(state.baseProfile, tuneCandidate());
  const status = document.querySelector("#tune-status");
  if (!override) { status.textContent = "Make a change from the shared profile before copying a tuning link."; return; }
  const link = `${location.origin}${location.pathname}${location.search}${tuningFragment(override, state.baseProfile)}`;
  try {
    await navigator.clipboard.writeText(link);
    status.textContent = "Tuning link copied. It carries preferences in its fragment and is not sent to the server.";
  } catch {
    status.textContent = `Copy this link: ${link}`;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Accept: "application/json", ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.code || "Could not load AI Signal");
  return body;
}

function adminControls(profile) {
  return `<label class="range-row">Default stories <output id="admin-budget-value">${profile.storyBudget}</output><input id="admin-story-budget" type="range" min="${profile.storyBudgetRange[0]}" max="${profile.storyBudgetRange[1]}" value="${profile.storyBudget}"></label><div id="admin-weights" class="weights">${profile.weights.map((weight) => `<div class="weight"><label>${escape(weight.label)} <output>${weightLabel(weight.value)}</output></label><input data-admin-weight="${escape(weight.id)}" type="range" min="0" max="4" value="${weight.value}"></div>`).join("")}</div><fieldset><legend>Editorial safeguards</legend><label><input id="admin-exceptional" type="checkbox" ${profile.exceptionalStoryOverride ? "checked" : ""}> Exceptional-story override</label><label><input id="admin-watch-permissions" type="checkbox" ${profile.safeguards.watchPermissions ? "checked" : ""}> Watch agent permission design</label><label><input id="admin-watch-geography" type="checkbox" ${profile.safeguards.watchGeography ? "checked" : ""}> Watch AI cluster geography</label></fieldset>`;
}

function visitLocationLabel(visit) {
  return [visit.city, visit.region, visit.country].filter(Boolean).join(", ") || "Unknown";
}

function visitPanel() {
  return `<section class="visit-panel"><h2>Anonymous visit entries</h2><p class="muted">One entry per anonymous browser per UTC day. Country, region and city are recorded when Cloudflare can provide them. No names, IP addresses, clicks, or reading time are stored.</p><div class="visit-actions"><button class="button secondary" id="load-visits" type="button">Load recent visits</button><p class="visit-total" id="visit-status" aria-live="polite"></p></div><div class="visit-summary" id="visit-summary" hidden></div><div class="visit-list" id="visit-list" hidden></div></section>`;
}

function verdictPanel() {
  return `<section class="visit-panel"><h2>Legacy Jev disagreement audit</h2><p class="muted">Earlier binary verdicts for Jev/pipeline disagreements. This is a separate historical calibration set; it does not promote Jev into the selection path.</p><div class="visit-actions"><button class="button secondary" id="load-disagreements" type="button">Load legacy disagreements</button><p class="visit-total" id="verdict-stats" aria-live="polite"></p></div><div class="visit-list" id="verdict-list" hidden></div><p class="status" id="verdict-status" aria-live="polite"></p></section>`;
}

function jevReviewPanel() {
  return `<section class="visit-panel"><h2>Jev and taste review</h2><p class="muted">Review a small, balanced sample from the latest Jev-scored pool. Label each story publish, reject, or unsure. Rank only publish choices, with 1 as your strongest. Jev remains in shadow mode.</p><div class="visit-actions"><button class="button secondary" id="load-jev-review" type="button">Load review sample</button><p class="visit-total" id="jev-review-status" aria-live="polite"></p></div><div class="visit-summary" id="jev-review-meta" hidden></div><div class="jev-review-list" id="jev-review-list" hidden></div><div class="admin-actions"><button class="button" id="save-jev-review" type="button" hidden>Save sample labels</button></div></section>`;
}

function renderAdmin(profile) {
  state.adminProfile = profile;
  app.innerHTML = `<section class="admin"><div class="banner"><p class="eyebrow">Owner controls</p><h1>AI Signal administration</h1><p>Global profile changes affect future generation only. Browser personalisation remains local and is not shown here.</p></div><div class="admin-panel"><label>Admin token <input id="admin-token" type="password" autocomplete="off"></label><p class="muted">Used only for the request you submit below; it is not stored in the browser.</p>${adminControls(profile)}<div class="admin-actions"><button class="button" id="save-global-profile" type="button">Save global Profile v${profile.version + 1}</button><button class="button secondary" id="run-refresh" type="button">Build today's edition</button><button class="button secondary" id="run-republish" type="button">Republish today's edition (once daily)</button></div><p class="muted">Normal refresh skips today's edition after it has been published. Republish replaces that daily edition so you can test a code or profile change; one successful republish is allowed per Melbourne calendar day.</p><p class="status" id="admin-status" aria-live="polite"></p></div>${jevReviewPanel()}${verdictPanel()}${visitPanel()}</section>`;
  app.querySelectorAll("[data-admin-weight]").forEach((input) => input.addEventListener("input", () => { input.previousElementSibling.querySelector("output").textContent = weightLabel(Number(input.value)); }));
  app.querySelector("#admin-story-budget").addEventListener("input", (event) => { app.querySelector("#admin-budget-value").textContent = event.target.value; });
  app.querySelector("#save-global-profile").addEventListener("click", saveGlobalProfile);
  app.querySelector("#run-refresh").addEventListener("click", runRefresh);
  app.querySelector("#run-republish").addEventListener("click", () => runRefresh(true));
  app.querySelector("#load-visits").addEventListener("click", loadVisits);
  app.querySelector("#load-disagreements").addEventListener("click", loadDisagreements);
  app.querySelector("#load-jev-review").addEventListener("click", loadJevReviewBatch);
  app.querySelector("#save-jev-review").addEventListener("click", saveJevReviewBatch);
}

function globalProfileCandidate() {
  const profile = structuredClone(state.adminProfile);
  profile.version += 1;
  profile.storyBudget = Number(app.querySelector("#admin-story-budget").value);
  profile.weights.forEach((weight) => { weight.value = Number(app.querySelector(`[data-admin-weight="${CSS.escape(weight.id)}"]`).value); });
  profile.exceptionalStoryOverride = app.querySelector("#admin-exceptional").checked;
  profile.safeguards.watchPermissions = app.querySelector("#admin-watch-permissions").checked;
  profile.safeguards.watchGeography = app.querySelector("#admin-watch-geography").checked;
  return profile;
}

function adminToken() { return app.querySelector("#admin-token").value; }
function setVerdictStatus(message) { app.querySelector("#verdict-status").textContent = message; }

function disagreementRow(entry) {
  const jev = `Jev ${escape(entry.jevRecommendation)}${entry.jevConfident ? " (confident)" : ""}: interest ${escape(entry.jevInterest ?? "unscored")} · novel ${escape(entry.jevNovel ?? "—")} · substantive ${escape(entry.jevSubstantive ?? "—")} · want ${escape(entry.jevReaderWants ?? "—")}`;
  const reranker = entry.rerankerRank === null ? "reranker unscored" : `reranker rank ${escape(entry.rerankerRank)} (${escape(entry.rerankerInterest ?? "—")})`;
  return `<div class="visit-entry"><div><strong>${escape(entry.title)}</strong><br><span class="muted">gates ${escape(entry.gateOutcome)} · ${reranker} · ${jev}</span><br><a href="${escape(entry.url)}" target="_blank" rel="noreferrer">${escape(entry.url.slice(0, 80))}</a></div><div class="visit-actions"><button class="button secondary" data-verdict="1" data-url="${escape(entry.url)}" type="button">Should publish</button><button class="button secondary" data-verdict="-1" data-url="${escape(entry.url)}" type="button">Correctly rejected</button></div></div>`;
}

async function refreshVerdictStats(token) {
  try {
    const data = await request("/api/jev-verdicts/stats", { headers: { Authorization: `Bearer ${token}` } });
    app.querySelector("#verdict-stats").textContent = `${data.stats.total} legacy verdicts · matched Jev ${Math.round(data.stats.sidedWithJev * 100)}% · owner picks inside confident Jev rejects ${data.stats.confidentRejectMisses}`;
  } catch (caught) { app.querySelector("#verdict-stats").textContent = caught.message; }
}

function reviewStratumLabel(value) {
  return ({
    "pipeline-selected_jev-publish": "Both favor selection",
    "pipeline-selected_jev-reject": "Pipeline selects · Jev rejects",
    "pipeline-excluded_jev-publish": "Pipeline excludes · Jev favors",
    "pipeline-excluded_jev-reject": "Both favor exclusion"
  })[value] || value;
}

function jevReviewAssessment(item) {
  const jev = `Jev ${item.jevRecommendation}${item.jevConfident ? " (confident)" : ""}: interest ${item.interest ?? "unscored"} · confidence ${item.interestConfidence ?? "—"} · novel ${item.novel ?? "—"} · substantive ${item.substantive ?? "—"} · reader wants ${item.readerWants ?? "—"}`;
  const reranker = item.reranker
    ? `Reranker: rank ${item.reranker.rank ?? "—"} · relevance ${item.reranker.relevance ?? "—"} · interest ${item.reranker.winningInterest ?? "—"} · novelty ${item.reranker.novelty ?? "—"}`
    : "Reranker assessment unavailable on this run.";
  return `<details class="jev-review-assessment"><summary>Show Jev and reranker assessment</summary><p>Pipeline outcome: ${escape(item.pipelineOutcome)} · sample group: ${escape(reviewStratumLabel(item.sampleStratum))}</p><p>${escape(jev)}</p><p>${escape(reranker)}</p></details>`;
}

function jevReviewCard(item, index) {
  const id = `jev-review-${index}`;
  const names = (item.sourceNames?.length ? item.sourceNames : item.sourceIds ?? []).join(" · ") || "Source not recorded";
  const safeUrl = /^https?:\/\//i.test(item.url ?? "") ? item.url : "";
  const sources = safeUrl ? `<a href="${escape(safeUrl)}" target="_blank" rel="noreferrer">Open source</a>` : "Source link unavailable";
  const decisions = [["publish", "I would publish"], ["reject", "I would reject"], ["unsure", "Unsure"]];
  const controls = decisions.map(([value, label]) => `<label><input type="radio" name="${id}-decision" value="${value}" ${item.decision === value ? "checked" : ""}> ${label}</label>`).join("");
  return `<article class="jev-review-item" data-review-url="${escape(item.url)}"><div class="jev-review-heading"><span class="eyebrow">Candidate ${index + 1}</span></div><h3>${safeUrl ? `<a href="${escape(safeUrl)}" target="_blank" rel="noreferrer">${escape(item.title)}</a>` : escape(item.title)}</h3><p>${escape(item.summary || "No summary recorded for this candidate.")}</p><p class="jev-review-source">${escape(names)} · ${escape(item.publishedAt || "Date unavailable")} · ${sources}</p><fieldset class="jev-review-choice"><legend>Would you include this in an edition?</legend>${controls}</fieldset><label class="jev-review-rank-wrap" ${item.decision === "publish" ? "" : "hidden"}>Publish-set rank (1 = strongest) <input class="jev-review-rank" type="number" min="1" step="1" value="${item.rankPosition ?? ""}" aria-label="Publish-set rank for ${escape(item.title)}"></label>${jevReviewAssessment(item)}</article>`;
}

function normalizeJevReviewRanks() {
  const cards = [...app.querySelectorAll(".jev-review-item")];
  for (const card of cards) {
    const publish = card.querySelector('input[type="radio"][value="publish"]').checked;
    card.querySelector(".jev-review-rank-wrap").hidden = !publish;
  }
  const selected = cards.filter((card) => card.querySelector('input[type="radio"][value="publish"]').checked);
  if (selected.length === 1) {
    const rank = selected[0].querySelector(".jev-review-rank");
    if (!rank.value) rank.value = "1";
  }
}

function renderJevReviewBatch(data) {
  state.jevReviewBatch = data;
  const meta = app.querySelector("#jev-review-meta");
  const list = app.querySelector("#jev-review-list");
  const save = app.querySelector("#save-jev-review");
  meta.innerHTML = `<strong>${data.items.length} candidates</strong> · issue ${escape(data.issueDate)} · profile v${escape(data.profileVersion ?? "unknown")} · source pack ${escape(data.sourcePack?.id ?? "unknown")} v${escape(data.sourcePack?.version ?? "?")} · Jev questions ${escape(data.questionSetVersion)} · run ${escape(data.generatedAt)}`;
  meta.hidden = false;
  if (!data.items.length) {
    list.innerHTML = `<p class="muted">No Jev-scored candidates are available for this sample.</p>`;
    save.hidden = true;
    list.hidden = false;
    return;
  }
  const questionLabels = Object.keys(data.questions ?? {}).map((key) => `<code>${escape(key)}</code>`).join(" · ");
  list.innerHTML = `<details class="jev-review-questions"><summary>Question set ${escape(data.questionSetVersion)} · ${questionLabels || "labels unavailable"}</summary><pre>${escape(JSON.stringify(data.questions, null, 2))}</pre></details>${data.items.map(jevReviewCard).join("")}`;
  list.hidden = false;
  save.hidden = false;
  list.querySelectorAll('.jev-review-choice input[type="radio"]').forEach((input) => input.addEventListener("change", normalizeJevReviewRanks));
  normalizeJevReviewRanks();
}

async function loadJevReviewBatch(runId = null, tokenOverride = null) {
  const token = tokenOverride || adminToken();
  if (!token) { app.querySelector("#jev-review-status").textContent = "Enter the admin token first."; return; }
  app.querySelector("#jev-review-status").textContent = "Loading a balanced sample…";
  try {
    const suffix = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
    const data = await request(`/api/jev-review-batch${suffix}`, { headers: { Authorization: `Bearer ${token}` } });
    renderJevReviewBatch(data);
    app.querySelector("#jev-review-status").textContent = data.items.length ? `${data.items.length} candidates loaded. Jev and reranker assessments stay hidden unless you open them.` : "No review candidates in this run.";
  } catch (caught) { app.querySelector("#jev-review-status").textContent = caught.message; }
}

async function saveJevReviewBatch() {
  const token = adminToken();
  const batch = state.jevReviewBatch;
  if (!token) { app.querySelector("#jev-review-status").textContent = "Enter the admin token first."; return; }
  if (!batch) return;
  const reviews = [...app.querySelectorAll(".jev-review-item")].map((card) => {
    const decision = card.querySelector('input[type="radio"]:checked')?.value;
    const rankPosition = decision === "publish" ? Number(card.querySelector(".jev-review-rank").value) : null;
    return { story_url: card.dataset.reviewUrl, decision, rank_position: rankPosition };
  });
  if (reviews.some((review) => !review.decision)) {
    app.querySelector("#jev-review-status").textContent = "Choose publish, reject, or unsure for every candidate before saving.";
    return;
  }
  const publishRanks = reviews.filter((review) => review.decision === "publish").map((review) => review.rank_position).sort((left, right) => left - right);
  if (publishRanks.some((rank, index) => !Number.isInteger(rank) || rank !== index + 1)) {
    app.querySelector("#jev-review-status").textContent = `Rank publish choices with unique numbers from 1 to ${publishRanks.length}; 1 is strongest.`;
    return;
  }
  app.querySelector("#jev-review-status").textContent = "Saving labels and publish ranking…";
  const button = app.querySelector("#save-jev-review");
  button.disabled = true;
  try {
    const result = await request("/api/jev-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ shadow_run_id: batch.runId, reviews })
    });
    await loadJevReviewBatch(batch.runId, token);
    app.querySelector("#jev-review-status").textContent = `${result.saved} candidate labels saved. Jev remains in shadow mode.`;
  } catch (caught) { app.querySelector("#jev-review-status").textContent = caught.message; }
  finally { button.disabled = false; }
}

async function loadDisagreements() {
  const token = adminToken();
  if (!token) { setVerdictStatus("Enter the admin token first."); return; }
  setVerdictStatus("Loading disagreements…");
  try {
    const data = await request("/api/jev-disagreements", { headers: { Authorization: `Bearer ${token}` } });
    const list = app.querySelector("#verdict-list");
    list.innerHTML = data.disagreements.length
      ? data.disagreements.map(disagreementRow).join("")
      : `<p class="muted">No open disagreements in the latest shadow run.</p>`;
    list.hidden = false;
    list.querySelectorAll("[data-verdict]").forEach((button) => button.addEventListener("click", () => castVerdict(button.dataset.url, Number(button.dataset.verdict))));
    setVerdictStatus(data.disagreements.length ? `${data.disagreements.length} open disagreements.` : "All disagreements decided.");
    await refreshVerdictStats(token);
  } catch (caught) { setVerdictStatus(caught.message); }
}

async function castVerdict(url, verdict) {
  const token = adminToken();
  if (!token) { setVerdictStatus("Enter the admin token first."); return; }
  try {
    const data = await request("/api/jev-verdicts", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ story_url: url, verdict }) });
    setVerdictStatus(`Legacy verdict recorded. Jev agreement ${Math.round(data.stats.sidedWithJev * 100)}% across ${data.stats.total}.`);
    await loadDisagreementsKeepToken(token);
  } catch (caught) { setVerdictStatus(caught.message); }
}

async function loadDisagreementsKeepToken(token) {
  try {
    const data = await request("/api/jev-disagreements", { headers: { Authorization: `Bearer ${token}` } });
    const list = app.querySelector("#verdict-list");
    list.innerHTML = data.disagreements.length ? data.disagreements.map(disagreementRow).join("") : `<p class="muted">No open disagreements in the latest shadow run.</p>`;
    list.querySelectorAll("[data-verdict]").forEach((button) => button.addEventListener("click", () => castVerdict(button.dataset.url, Number(button.dataset.verdict))));
    await refreshVerdictStats(token);
  } catch (caught) { setVerdictStatus(caught.message); }
}
function setAdminStatus(message) { app.querySelector("#admin-status").textContent = message; }
function clearAdminToken() { app.querySelector("#admin-token").value = ""; }
function setVisitStatus(message) { app.querySelector("#visit-status").textContent = message; }

async function loadVisits() {
  const token = adminToken();
  if (!token) { setVisitStatus("Enter the admin token first."); return; }
  setVisitStatus("Loading visit entries…");
  try {
    const data = await request("/api/visits?limit=50", { headers: { Authorization: `Bearer ${token}` } });
    const summary = app.querySelector("#visit-summary");
    const locations = (data.byLocation ?? []).slice(0, 6).map((location) => `<span>${escape([location.country, location.region].filter(Boolean).join(" · ") || "Unknown")} <strong>${escape(location.uniqueVisitors)}</strong></span>`).join("");
    summary.innerHTML = `<strong>${escape(data.uniqueVisitors)} unique browsers</strong> over 30 days · <strong>${escape(data.todayUniqueVisitors)} today</strong> · ${escape(data.totalEntries)} daily entries${locations ? `<div class="visit-locations">${locations}</div>` : ""}`;
    summary.hidden = false;
    const list = app.querySelector("#visit-list");
    list.innerHTML = data.visits.length
      ? data.visits.map((visit) => `<div class="visit-entry"><time datetime="${escape(visit.visitedAt)}">${escape(localDateTime(visit.visitedAt))}</time><span>${escape(visit.path)} · ${escape(visitLocationLabel(visit))}</span><code title="Opaque browser key">${escape(visit.visitorKey.slice(0, 12))}…</code></div>`).join("")
      : `<p class="muted">No visit entries yet.</p>`;
    list.hidden = false;
    setVisitStatus(`${data.totalEntries} total anonymous daily entries · showing ${data.visits.length}`);
  } catch (caught) { setVisitStatus(caught.message); } finally { clearAdminToken(); }
}

async function saveGlobalProfile() {
  const token = adminToken();
  if (!token) { setAdminStatus("Enter the admin token to save the global profile."); return; }
  setAdminStatus("Saving global profile…");
  try {
    const data = await request("/api/profile", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(globalProfileCandidate()) });
    renderAdmin(data.profile);
    setAdminStatus(`Saved global Profile v${data.profile.version}. It will be used by future runs.`);
  } catch (caught) { setAdminStatus(caught.message); } finally { clearAdminToken(); }
}

async function runRefresh(republish = false) {
  const token = adminToken();
  if (!token) { setAdminStatus(republish ? "Enter the admin token to republish today's edition." : "Enter the admin token to build today's edition."); return; }
  const button = app.querySelector(republish ? "#run-republish" : "#run-refresh");
  button.disabled = true;
  setAdminStatus(republish ? "Republishing today's edition…" : "Building today's edition…");
  try {
    const path = republish ? "/api/refresh?republish=1" : "/api/refresh";
    const result = await request(path, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const message = result.status === "success"
      ? `${republish ? "Republished" : "Published"} ${result.edition.issue.publicationDate}.`
      : result.reason === "manual-republish-limit"
        ? "Republish limit reached: one successful republish is allowed per Melbourne calendar day."
        : result.status === "skipped"
          ? "Skipped: today's edition is already published."
          : `Run failed: ${result.code}${result.reason ? ` — ${result.reason}` : ""}.`;
    setAdminStatus(message);
  } catch (caught) { setAdminStatus(caught.message); } finally { clearAdminToken(); button.disabled = false; }
}

async function boot() {
  try {
    const route = location.pathname.replace(/\/+$/, "") || "/";
    document.querySelectorAll(".topbar nav a").forEach((link) => {
      const linkRoute = new URL(link.href).pathname.replace(/\/+$/, "") || "/";
      if (linkRoute === route) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    openTune.hidden = route === "/admin" || route === "/history";
    if (route === "/admin") { renderAdmin((await request("/api/profile")).profile); return; }
    const [profileData, collectionStatus] = await Promise.all([request("/api/profile"), request("/api/status")]);
    const sharedProfile = profileData.profile;
    state.collectionStatus = collectionStatus;
    if (route === "/history") {
      state.baseProfile = sharedProfile;
      state.override = readStoredViewerOverride(sharedProfile);
      state.previewOverride = readTuningFragment(location.hash, sharedProfile);
      renderHistory((await request("/api/editions")).editions);
      return;
    }
    const key = new URLSearchParams(location.search).get("edition");
    const data = await request(key ? `/api/editions/${encodeURIComponent(key)}` : "/api/editions/latest");
    state.edition = data.edition;
    state.isHistoricalEdition = Boolean(key);
    state.baseProfile = baseProfileForEdition(sharedProfile, data.edition.profile, Boolean(key));
    state.override = readStoredViewerOverride(state.baseProfile);
    state.previewOverride = readTuningFragment(location.hash, state.baseProfile);
    renderEdition(state.edition, activeProfile());
  } catch (caught) {
    app.innerHTML = `<p class="error">${escape(caught.message)}</p>`;
  }
}

openTune.addEventListener("click", openTuneDialog);
closeRanking.addEventListener("click", () => rankingDialog.close());
rankingPersonalise.addEventListener("click", () => {
  rankingDialog.close();
  openTuneDialog();
});
rankingDialog.addEventListener("click", (event) => {
  if (event.target === rankingDialog) rankingDialog.close();
});
document.querySelector("#apply-tune").addEventListener("click", () => {
  state.override = persistViewerOverride(createViewerOverride(state.baseProfile, tuneCandidate()), state.baseProfile);
  state.previewOverride = null;
  clearFragment();
  dialog.close();
  renderCurrentEdition();
});
document.querySelector("#reset-tune").addEventListener("click", () => {
  clearStoredViewerOverride();
  state.override = null;
  state.previewOverride = null;
  clearFragment();
  dialog.close();
  renderCurrentEdition();
});
document.querySelector("#copy-tune").addEventListener("click", copyTuningLink);
boot();
