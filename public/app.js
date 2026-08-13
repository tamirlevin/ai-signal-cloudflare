import {
  baseProfileForEdition,
  clearStoredViewerOverride,
  createViewerOverride,
  mergeViewerOverride,
  persistViewerOverride,
  rankItems,
  readStoredViewerOverride,
  readTuningFragment,
  tuningFragment,
  weightLabel
} from "/personalization.js";

const app = document.querySelector("#app");
const dialog = document.querySelector("#tune-dialog");
const openTune = document.querySelector("#open-tune");
const state = { baseProfile: null, override: null, previewOverride: null, edition: null, historyEditions: null, adminProfile: null, collectionStatus: null, isHistoricalEdition: false };

function escape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function sourceLinks(sources) {
  return `<div class="sources">${sources.map((source) => `<a href="${escape(source.url)}" target="_blank" rel="noreferrer">${escape(source.label)}</a>`).join("")}</div>`;
}

function sourceLabel(value) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; }
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
  if (!lastRun) return `<p class="refresh-status">Brief generated ${escape(localDateTime(edition.publishedAt))}.</p>`;
  const outcome = lastRun.status === "failed" ? `failed${lastRun.errorCode ? ` (${escape(lastRun.errorCode)})` : ""}${lastRun.failureDetail ? `: ${escape(lastRun.failureDetail)}` : ""}` : lastRun.status === "skipped" ? "found no newer issue" : "published a new brief";
  return `<p class="refresh-status"><strong>Collector last checked ${escape(localDateTime(lastRun.finishedAt))}</strong> and ${outcome}. This brief was generated ${escape(localDateTime(edition.publishedAt))}. Automatic check: daily at ${escape(scheduledTimeLabel(state.collectionStatus.scheduledDailyAtUtc))}.</p>`;
}

function profileNotice(edition, profile, visibleCount) {
  const generatedVersion = edition.profile?.version;
  const versionText = generatedVersion && generatedVersion !== profile.version
    ? `Generated with Profile v${generatedVersion} · viewing with ${state.isHistoricalEdition ? "Profile" : "global Profile"} v${profile.version}`
    : `Profile v${profile.version}`;
  const countText = edition.signals.length < profile.storyBudget
    ? `${visibleCount} available · target ${profile.storyBudget}`
    : `${visibleCount} stories · ${edition.signals.length} qualified candidates`;
  return `${versionText} · ${countText}`;
}

function syncPersonaliseControl() {
  openTune.classList.toggle("preview", Boolean(state.previewOverride));
  openTune.textContent = state.previewOverride ? "Personalise · Preview" : state.override ? "Personalise · On" : "Personalise";
  openTune.setAttribute("aria-label", state.previewOverride ? "Personalise: shared preview available" : state.override ? "Personalise: browser preferences active" : "Personalise AI Signal");
}

function tabs(mode, detail) {
  return `<div class="tabs" role="tablist" aria-label="Reader view"><button data-mode="synthesis" aria-selected="${mode === "synthesis"}">Synthesis</button><button data-mode="detailed" aria-selected="${mode === "detailed"}">Detailed</button></div>${mode === "detailed" ? `<div class="tabs" role="tablist" aria-label="Detailed view"><button data-detail="hot" aria-selected="${detail === "hot"}">Hot Topics</button><button data-detail="all" aria-selected="${detail === "all"}">All Signals</button></div>` : ""}`;
}

function renderEdition(edition, profile, mode = "detailed", detail = "hot") {
  const visibleSignals = rankItems(edition.signals, profile).slice(0, profile.storyBudget);
  const hot = rankItems(edition.hotTopics, profile).map((topic) => {
    const primary = topic.sources[0];
    const title = primary
      ? `<a href="${escape(primary.url)}" target="_blank" rel="noreferrer">${escape(topic.title)}</a>`
      : escape(topic.title);
    return `<article class="topic"><h2>${title}</h2><p>${escape(topic.summary)}</p>${sourceLinks(topic.sources)}</article>`;
  }).join("");
  const cards = visibleSignals.map((signal) => `<article class="card"><span class="category">${escape(signal.categoryLabel)}</span><h2><a href="${escape(signal.url)}" target="_blank" rel="noreferrer">${escape(signal.title)}</a></h2><p>${escape(signal.summary)}</p><p class="meta">${escape([sourceLabel(signal.source), signal.date].filter(Boolean).join(" · "))}</p></article>`).join("");
  const sections = edition.synthesis.sections.map((section, index) => `<section class="section"><p class="eyebrow">${String(index + 1).padStart(2, "0")}</p><h2>${escape(section.title)}</h2><p class="kicker">${escape(section.kicker)}</p><p>${escape(section.body)}</p>${sourceLinks(section.sources)}</section>`).join("");
  const detailed = detail === "hot"
    ? `<section><div class="banner"><h1>${escape(edition.presentation.hotTitle)}</h1><p>${escape(edition.presentation.hotIntro)}</p></div><div class="hot-list">${hot}</div></section>`
    : `<section><div class="banner"><h1>All Signals</h1><p>${escape(edition.presentation.allIntro)}</p></div><p class="caption"><strong>${escape(profileNotice(edition, profile, visibleSignals.length))}</strong></p><div class="cards">${cards}</div></section>`;
  const synthesis = `<section><div class="banner"><h1>${escape(edition.presentation.synthesisTitle)}</h1><p>${escape(edition.presentation.synthesisIntro)}</p></div><article class="synthesis"><p class="time">${edition.presentation.sourceReadMinutes} min source → ${edition.presentation.briefReadMinutes} min brief</p><p class="lead">${escape(edition.synthesis.lead)}</p><div class="big">${escape(edition.synthesis.bigPicture)}</div>${sourceLinks(edition.synthesis.sources)}<div>${sections}</div></article></section>`;
  app.innerHTML = `<div class="utility"><p class="edition"><strong>AI Signal</strong> · <a href="${escape(edition.issue.url)}" target="_blank" rel="noreferrer">${escape(edition.issue.publicationDate)}</a></p></div>${collectionNotice(edition)}${tabs(mode, detail)}<p class="caption">AInews for ${escape(edition.issue.coverage)} · ${state.previewOverride ? "shared tuning preview" : state.override ? "personalised in this browser" : profileNotice(edition, profile, visibleSignals.length)}</p>${mode === "synthesis" ? synthesis : detailed}`;
  app.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => renderEdition(edition, profile, button.dataset.mode, detail)));
  app.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", () => renderEdition(edition, profile, "detailed", button.dataset.detail)));
  syncPersonaliseControl();
}

function renderHistory(editions) {
  state.historyEditions = editions;
  const fragment = state.previewOverride ? location.hash : "";
  app.innerHTML = `<div class="utility"><p class="edition"><strong>Edition history</strong> · the latest 15 successfully published AInews editions</p></div><div class="history-list">${editions.map((edition) => `<a class="history-item" href="/?edition=${encodeURIComponent(edition.issueDate)}${fragment}"><span><strong>${escape(edition.issue.publicationDate)}</strong><br><small>${escape(edition.issue.coverage)}</small></span><span>Open</span></a>`).join("")}</div>`;
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
  if (state.edition) renderEdition(state.edition, activeProfile(), "detailed", "all");
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

function renderAdmin(profile) {
  state.adminProfile = profile;
  app.innerHTML = `<section class="admin"><div class="banner"><p class="eyebrow">Owner controls</p><h1>AI Signal administration</h1><p>Global profile changes affect future generation only. Browser personalisation remains local and is not shown here.</p></div><div class="admin-panel"><label>Admin token <input id="admin-token" type="password" autocomplete="off"></label><p class="muted">Used only for the request you submit below; it is not stored in the browser.</p>${adminControls(profile)}<div class="admin-actions"><button class="button" id="save-global-profile" type="button">Save global Profile v${profile.version + 1}</button><button class="button secondary" id="run-refresh" type="button">Run latest issue now</button></div><p class="status" id="admin-status" aria-live="polite"></p></div></section>`;
  app.querySelectorAll("[data-admin-weight]").forEach((input) => input.addEventListener("input", () => { input.previousElementSibling.querySelector("output").textContent = weightLabel(Number(input.value)); }));
  app.querySelector("#admin-story-budget").addEventListener("input", (event) => { app.querySelector("#admin-budget-value").textContent = event.target.value; });
  app.querySelector("#save-global-profile").addEventListener("click", saveGlobalProfile);
  app.querySelector("#run-refresh").addEventListener("click", runRefresh);
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
function setAdminStatus(message) { app.querySelector("#admin-status").textContent = message; }
function clearAdminToken() { app.querySelector("#admin-token").value = ""; }

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

async function runRefresh() {
  const token = adminToken();
  if (!token) { setAdminStatus("Enter the admin token to run the latest issue."); return; }
  setAdminStatus("Running the latest AInews issue…");
  try {
    const result = await request("/api/refresh", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const message = result.status === "success" ? `Published ${result.edition.issue.publicationDate}.` : result.status === "skipped" ? "Skipped: this AInews issue is already published." : `Run failed: ${result.code}${result.reason ? ` — ${result.reason}` : ""}.`;
    setAdminStatus(message);
  } catch (caught) { setAdminStatus(caught.message); } finally { clearAdminToken(); }
}

async function boot() {
  try {
    const route = location.pathname.replace(/\/+$/, "") || "/";
    openTune.hidden = route === "/admin";
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
