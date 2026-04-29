"use strict";

const MIN_READING_WPM = 100;
const MAX_READING_WPM = 2000;
const DEFAULT_READER_PRESETS = Object.freeze({
  skim: 325,
  normal: 250,
  deep: 200
});
const PRESET_ORDER = ["skim", "normal", "deep"];
const PRESET_META = Object.freeze({
  skim: { label: "Skim" },
  normal: { label: "Normal" },
  deep: { label: "Deep" }
});
const DEFAULT_READING_MODE = "normal";
const CONTENT_SCRIPT_VERSION = 17;
const DEBUG_MODE_KEY = "debugModeEnabled";
const READER_PRESETS_KEY = "readerPresets";
const READER_PRESETS_CONFIRMED_KEY = "readerPresetsConfirmed";
const LEGACY_READING_SPEED_BY_TAB_KEY = "readerWpmByTab";

const presetEditorPanelEl = document.getElementById("presetEditorPanel");
const presetEditorEyebrowEl = document.getElementById("presetEditorEyebrow");
const presetEditorTitleEl = document.getElementById("presetEditorTitle");
const presetEditorDescriptionEl = document.getElementById("presetEditorDescription");
const presetFormEl = document.getElementById("presetForm");
const presetSaveButton = document.getElementById("presetSaveButton");
const presetCancelButton = document.getElementById("presetCancelButton");
const presetFormErrorEl = document.getElementById("presetFormError");
const presetInputEls = {
  skim: document.getElementById("presetSkimInput"),
  normal: document.getElementById("presetNormalInput"),
  deep: document.getElementById("presetDeepInput")
};
const appShellEl = document.getElementById("appShell");
const countEl = document.getElementById("count");
const metaEl = document.getElementById("meta");
const titleEl = document.getElementById("title");
const readingTimeEl = document.getElementById("readingTime");
const readingTimeValueEl = document.getElementById("readingTimeValue");
const readingTimeUnitEl = document.getElementById("readingTimeUnit");
const progressPanelEl = document.getElementById("progressPanel");
const progressValueEl = document.getElementById("progressValue");
const progressTimeEl = document.getElementById("progressTime");
const progressTimeValueEl = document.getElementById("progressTimeValue");
const progressTimeUnitEl = document.getElementById("progressTimeUnit");
const progressMetaEl = document.getElementById("progressMeta");
const speedChipEl = document.getElementById("speedChip");
const confidenceEl = document.getElementById("confidence");
const refreshButton = document.getElementById("refreshButton");
const presetButton = document.getElementById("presetButton");
const presetButtons = Array.from(document.querySelectorAll(".presetChip"));
const debugToggleButton = document.getElementById("debugToggleButton");
const debugPanelEl = document.getElementById("debugPanel");
const debugDetailsEl = document.getElementById("debugDetails");

const numberFormatter = new Intl.NumberFormat();

let readerPresets = cloneDefaultPresets();
let currentMode = DEFAULT_READING_MODE;
let currentWpm = DEFAULT_READER_PRESETS[DEFAULT_READING_MODE];
let currentTabId = null;
let debugModeEnabled = false;
let presetEditorMode = "setup";
let lastResult = null;
let lastTabProgress = null;
let countHoverEnabled = false;

function cloneDefaultPresets() {
  return { ...DEFAULT_READER_PRESETS };
}

function getPresetLabel(mode) {
  return PRESET_META[mode] ? PRESET_META[mode].label : "Preset";
}

function isValidWpm(value) {
  return Number.isFinite(value) && value >= MIN_READING_WPM && value <= MAX_READING_WPM;
}

function hasValidPresetMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return PRESET_ORDER.every((mode) => isValidWpm(Number(value[mode])));
}

function normalizeReaderPresets(value) {
  const normalized = cloneDefaultPresets();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return normalized;
  }

  for (const mode of PRESET_ORDER) {
    const parsed = Number(value[mode]);
    if (isValidWpm(parsed)) {
      normalized[mode] = Math.round(parsed);
    }
  }

  return normalized;
}

function formatWordCount(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return numberFormatter.format(value);
}

function roundWordCountToNearestHundred(value) {
  if (!Number.isFinite(value)) {
    return NaN;
  }
  return Math.round(value / 100) * 100;
}

function hasRenderableWordCount() {
  return Boolean(countHoverEnabled && lastResult && lastResult.ok && Number.isFinite(lastResult.words));
}

function clearCountHoverDetails() {
  countEl.removeAttribute("title");
  countEl.removeAttribute("aria-label");
}

function renderCountValue(showExact = false) {
  if (!hasRenderableWordCount()) {
    return;
  }

  const exactWords = Math.round(lastResult.words);
  const roundedWords = roundWordCountToNearestHundred(exactWords);
  const displayedWords = showExact ? exactWords : roundedWords;
  const exactLabel = `${formatWordCount(exactWords)} words`;

  countEl.textContent = formatWordCount(displayedWords);
  countEl.title = exactLabel;
  countEl.setAttribute("aria-label", exactLabel);
}

function setDebugUi() {
  debugToggleButton.textContent = debugModeEnabled ? "Debug On" : "Debug Off";
  debugToggleButton.setAttribute("aria-pressed", String(debugModeEnabled));
  debugToggleButton.setAttribute(
    "aria-label",
    debugModeEnabled ? "Debug mode on" : "Debug mode off"
  );
  debugToggleButton.title = debugModeEnabled ? "Debug mode: on" : "Debug mode: off";
  debugPanelEl.hidden = !debugModeEnabled;
}

function formatDebugOption(option) {
  if (!option) {
    return "unavailable";
  }

  const source = option.source || "unknown";
  const adapter = option.adapterId ? ` (${option.adapterId})` : "";
  const countSource = option.countSource ? ` [${option.countSource}]` : "";
  const rootTag = option.rootTag ? `<${option.rootTag}>` : "<unknown>";
  const rootSelector = option.rootSelector ? ` via ${option.rootSelector}` : "";
  const words = formatWordCount(option.words);
  const blocks = Number.isFinite(option.paragraphs) ? option.paragraphs : "--";

  return `${source}${adapter}${countSource}: ${words} words, ${blocks} blocks, ${rootTag}${rootSelector}`;
}

function renderDebug(result, statusMessage = "") {
  if (!debugModeEnabled) {
    debugDetailsEl.textContent = "Debug mode is off.";
    return;
  }

  if (statusMessage) {
    debugDetailsEl.textContent = statusMessage;
    return;
  }

  if (!result || !result.ok) {
    debugDetailsEl.textContent = "No diagnostics available.";
    return;
  }

  const debug = result.debug || {};
  const chosen = debug.chosen || {
    source: result.extractionSource,
    words: result.words,
    paragraphs: result.paragraphs,
    rootTag: result.rootTag,
    rootSelector: result.rootSelector || null,
    adapterId: result.adapterId || null
  };
  const alternatives = Array.isArray(debug.topAlternatives) ? debug.topAlternatives : [];

  const lines = [
    `Bootstrap: ${debug.bootstrap || "unknown"}`,
    `Decision: ${debug.decision || "n/a"}`,
    `Chosen: ${formatDebugOption(chosen)}`,
    `Progress root: ${formatDebugOption(debug.progressSource)}`
  ];

  if (alternatives.length === 0) {
    lines.push("Top alternatives: none");
  } else {
    lines.push("Top alternatives:");
    for (let index = 0; index < alternatives.length; index += 1) {
      lines.push(`${index + 1}. ${formatDebugOption(alternatives[index])}`);
    }
  }

  debugDetailsEl.textContent = lines.join("\n");
}

function resetPresetInputValidity() {
  for (const mode of PRESET_ORDER) {
    presetInputEls[mode].setAttribute("aria-invalid", "false");
  }
}

function populatePresetForm(presets) {
  resetPresetInputValidity();
  presetFormErrorEl.hidden = true;
  presetFormErrorEl.textContent = "";

  for (const mode of PRESET_ORDER) {
    presetInputEls[mode].value = String(presets[mode]);
  }
}

function showPresetFormError(message, invalidMode = "") {
  presetFormErrorEl.textContent = message;
  presetFormErrorEl.hidden = false;

  if (!invalidMode || !presetInputEls[invalidMode]) {
    return;
  }

  presetInputEls[invalidMode].setAttribute("aria-invalid", "true");
  presetInputEls[invalidMode].focus();
  presetInputEls[invalidMode].select();
}

function configurePresetEditor(mode) {
  presetEditorMode = mode;
  populatePresetForm(readerPresets);

  if (mode === "setup") {
    presetEditorEyebrowEl.textContent = "Reading Presets";
    presetEditorTitleEl.textContent = "Set your reading pace";
    presetEditorDescriptionEl.textContent =
      "Confirm or customize your skim, normal, and deep speeds. You will only see this setup once.";
    presetSaveButton.textContent = "Confirm Presets";
    presetCancelButton.hidden = true;
    return;
  }

  presetEditorEyebrowEl.textContent = "Set Presets";
  presetEditorTitleEl.textContent = "Update your reading presets";
  presetEditorDescriptionEl.textContent =
    "These values power your Skim, Normal, and Deep buttons everywhere in the extension.";
  presetSaveButton.textContent = "Save Presets";
  presetCancelButton.hidden = false;
}

function openPresetEditor(mode) {
  configurePresetEditor(mode);
  appShellEl.hidden = true;
  presetEditorPanelEl.hidden = false;
}

function closePresetEditor() {
  presetEditorPanelEl.hidden = true;
  appShellEl.hidden = false;
  presetFormErrorEl.hidden = true;
  presetFormErrorEl.textContent = "";
  resetPresetInputValidity();
}

function setPresetUi() {
  for (const button of presetButtons) {
    const mode = button.dataset.mode;
    const selected = mode === currentMode;
    const presetValue = readerPresets[mode];
    const valueEl = button.querySelector(".presetChipValue");

    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-label", `${getPresetLabel(mode)}, ${presetValue} words per minute`);
    button.title = `${getPresetLabel(mode)}: ${presetValue} wpm`;

    if (valueEl) {
      valueEl.textContent = String(presetValue);
    }
  }
}

function setSpeedUi() {
  currentWpm = readerPresets[currentMode] || readerPresets[DEFAULT_READING_MODE];
  speedChipEl.textContent = `${getPresetLabel(currentMode)} ${currentWpm}`;
  speedChipEl.setAttribute(
    "aria-label",
    `${getPresetLabel(currentMode)}, ${currentWpm} words per minute`
  );
  speedChipEl.title = `${getPresetLabel(currentMode)}: ${currentWpm} wpm`;
  setPresetUi();
}

function refreshDerivedTimes() {
  setSpeedUi();

  if (lastResult && lastResult.ok) {
    renderReadingTime(lastResult.words, currentWpm);
  } else {
    resetReadingTime();
  }

  if (lastTabProgress) {
    renderSelectionProgress(lastTabProgress);
  }
}

function setCurrentMode(nextMode) {
  currentMode = PRESET_ORDER.includes(nextMode) ? nextMode : DEFAULT_READING_MODE;
  refreshDerivedTimes();
}

function setBusyState() {
  countEl.textContent = "...";
  countHoverEnabled = false;
  clearCountHoverDetails();
  metaEl.textContent = "Analyzing the current page...";
  progressPanelEl.classList.remove("isActive");
  progressValueEl.textContent = "Checking progress";
  progressTimeEl.hidden = true;
  resetProgressTime();
  progressMetaEl.textContent = "Looking for a selected word in the article.";
  renderDebug(lastResult, "Analyzing the current page...");
}

function setErrorState(message) {
  countEl.textContent = "--";
  countHoverEnabled = false;
  clearCountHoverDetails();
  metaEl.textContent = message;
  resetReadingTime();
  confidenceEl.textContent = "Confidence --";
  confidenceEl.setAttribute("aria-label", "Confidence unavailable");
  confidenceEl.title = "Confidence unavailable";
  lastResult = null;
  renderSelectionProgress(null);
  renderDebug(null, `Error: ${message}`);
}

async function resolveActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0] || typeof tabs[0].id !== "number") {
      return null;
    }
    return tabs[0];
  } catch (_error) {
    return null;
  }
}

function isInjectableTabUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function loadReaderPreferences() {
  try {
    const stored = await chrome.storage.local.get([
      READER_PRESETS_KEY,
      READER_PRESETS_CONFIRMED_KEY
    ]);
    const presets = normalizeReaderPresets(stored[READER_PRESETS_KEY]);
    const confirmed =
      Boolean(stored[READER_PRESETS_CONFIRMED_KEY]) &&
      hasValidPresetMap(stored[READER_PRESETS_KEY]);

    return { presets, confirmed };
  } catch (_error) {
    return {
      presets: cloneDefaultPresets(),
      confirmed: false
    };
  }
}

async function saveReaderPreferences(nextPresets) {
  const normalized = normalizeReaderPresets(nextPresets);

  try {
    await chrome.storage.local.set({
      [READER_PRESETS_KEY]: normalized,
      [READER_PRESETS_CONFIRMED_KEY]: true
    });
    await chrome.storage.local.remove(LEGACY_READING_SPEED_BY_TAB_KEY);
    readerPresets = normalized;
    return true;
  } catch (_error) {
    return false;
  }
}

async function loadDebugMode() {
  try {
    const stored = await chrome.storage.local.get(DEBUG_MODE_KEY);
    return Boolean(stored[DEBUG_MODE_KEY]);
  } catch (_error) {
    return false;
  }
}

async function saveDebugMode(enabled) {
  try {
    await chrome.storage.local.set({ [DEBUG_MODE_KEY]: enabled });
  } catch (_error) {
    metaEl.textContent = "Could not save debug mode.";
  }
}

function getReadingTimeParts(words, wpm) {
  if (!Number.isFinite(words) || words <= 0 || !isValidWpm(wpm)) {
    return { value: "--", unit: "read", label: "-- read" };
  }

  const minutes = Math.max(1, Math.round(words / wpm));
  return { value: `${minutes}m`, unit: "read", label: `${minutes}m read` };
}

function resetReadingTime() {
  readingTimeValueEl.textContent = "--";
  readingTimeUnitEl.textContent = "read";
  readingTimeEl.removeAttribute("aria-label");
  readingTimeEl.removeAttribute("title");
}

function renderReadingTime(words, wpm) {
  const readingTime = getReadingTimeParts(words, wpm);
  readingTimeValueEl.textContent = readingTime.value;
  readingTimeUnitEl.textContent = readingTime.unit;

  const accessibleLabel = `Estimated article reading time: ${readingTime.label}`;
  readingTimeEl.setAttribute("aria-label", accessibleLabel);
  readingTimeEl.title = accessibleLabel;
  return readingTime.label;
}

function getRemainingTimeParts(words, wpm) {
  if (!Number.isFinite(words) || words < 0 || !isValidWpm(wpm)) {
    return { value: "--", unit: "left", label: "-- left" };
  }

  if (words === 0) {
    return { value: "Done", unit: "", label: "Done" };
  }

  const minutes = Math.max(1, Math.round(words / wpm));
  return { value: `${minutes}m`, unit: "left", label: `${minutes}m left` };
}

function resetProgressTime() {
  progressTimeValueEl.textContent = "--";
  progressTimeUnitEl.textContent = "left";
  progressTimeUnitEl.hidden = false;
  progressTimeEl.removeAttribute("aria-label");
  progressTimeEl.removeAttribute("title");
}

function renderProgressTime(words, wpm) {
  const remainingTime = getRemainingTimeParts(words, wpm);
  progressTimeValueEl.textContent = remainingTime.value;
  progressTimeUnitEl.textContent = remainingTime.unit;
  progressTimeUnitEl.hidden = !remainingTime.unit;

  const accessibleLabel =
    remainingTime.label === "Done" ? "Article complete" : `Estimated time left: ${remainingTime.label}`;
  progressTimeEl.setAttribute("aria-label", accessibleLabel);
  progressTimeEl.title = accessibleLabel;
  return remainingTime.label;
}

function renderSelectionProgress(progress) {
  lastTabProgress = progress || null;

  if (!progress) {
    progressPanelEl.classList.remove("isActive");
    progressValueEl.textContent = "No word selected";
    progressTimeEl.hidden = true;
    resetProgressTime();
    progressMetaEl.textContent = "Double-click a word to estimate time left.";
    return;
  }

  progressPanelEl.classList.add("isActive");
  progressValueEl.textContent = `${progress.percent}% done`;
  progressTimeEl.hidden = false;
  renderProgressTime(progress.remainingWords, currentWpm);

  if (progress.remainingWords <= 0) {
    progressMetaEl.textContent = `${formatWordCount(progress.totalWords)} words total`;
    return;
  }

  progressMetaEl.textContent = `${formatWordCount(progress.remainingWords)} words remaining`;
}

function setResultState(result) {
  lastResult = result;
  countHoverEnabled = true;
  renderCountValue(false);
  titleEl.textContent = result.pageTitle || "Current tab";
  renderReadingTime(result.words, currentWpm);
  confidenceEl.textContent = `Confidence ${result.confidence}`;
  confidenceEl.setAttribute("aria-label", `Confidence: ${result.confidence}`);
  confidenceEl.title = `Confidence: ${result.confidence}`;

  if (result.extractionSource === "metadata") {
    metaEl.textContent = "Used publisher word-count metadata.";
  } else if (result.countSource === "jsonld-word-count") {
    metaEl.textContent = "Used structured article word-count metadata.";
  } else if (result.extractionSource === "jsonld") {
    metaEl.textContent = `Used structured article data with ${result.paragraphs} text blocks.`;
  } else {
    metaEl.textContent = `Detected main content in <${result.rootTag}> with ${result.paragraphs} text blocks.`;
  }

  renderDebug(result);
}

function parsePresetForm() {
  resetPresetInputValidity();
  presetFormErrorEl.hidden = true;
  presetFormErrorEl.textContent = "";

  const nextPresets = {};

  for (const mode of PRESET_ORDER) {
    const raw = presetInputEls[mode].value.trim();
    const parsed = Number(raw);

    if (!raw || !isValidWpm(parsed)) {
      return {
        ok: false,
        invalidMode: mode,
        message: `Enter a valid ${getPresetLabel(mode).toLowerCase()} speed from ${MIN_READING_WPM} to ${MAX_READING_WPM} WPM.`
      };
    }

    nextPresets[mode] = Math.round(parsed);
  }

  return {
    ok: true,
    presets: nextPresets
  };
}

async function handlePresetSubmit(event) {
  event.preventDefault();

  const parsed = parsePresetForm();
  if (!parsed.ok) {
    showPresetFormError(parsed.message, parsed.invalidMode);
    return;
  }

  const previousMode = currentMode;
  const saved = await saveReaderPreferences(parsed.presets);
  if (!saved) {
    showPresetFormError("Could not save your presets. Try again.");
    return;
  }

  currentMode = presetEditorMode === "setup" ? DEFAULT_READING_MODE : previousMode;
  refreshDerivedTimes();
  closePresetEditor();

  if (presetEditorMode === "setup") {
    await fetchWordCount();
  }
}

function handlePresetCancel() {
  if (presetEditorMode !== "edit") {
    return;
  }

  closePresetEditor();
}

function openPresetManager() {
  openPresetEditor("edit");
}

function applyPresetReadingMode(event) {
  const mode = event.currentTarget && event.currentTarget.dataset
    ? event.currentTarget.dataset.mode
    : "";

  if (!PRESET_ORDER.includes(mode)) {
    return;
  }

  setCurrentMode(mode);
}

async function toggleDebugMode() {
  debugModeEnabled = !debugModeEnabled;
  setDebugUi();
  await saveDebugMode(debugModeEnabled);
  renderDebug(lastResult);
}

function shouldRetryAnalysis(result) {
  return result && result.ok && result.words < 120 && result.confidence === "Low";
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function showExactWordCount() {
  renderCountValue(true);
}

function showRoundedWordCount() {
  renderCountValue(false);
}

async function requestArticleAnalysis(tabId) {
  return chrome.tabs.sendMessage(tabId, {
    type: "GET_ARTICLE_WORD_COUNT",
    forceRefresh: true
  });
}

async function requestSelectionProgress(tabId, forceRefresh = false) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "GET_SELECTION_PROGRESS",
      forceRefresh
    });
    return response && response.ok ? response.progress || null : null;
  } catch (_error) {
    return null;
  }
}

async function requestTabProgress(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_TAB_PROGRESS",
      tabId
    });
    return response && response.ok ? response.progress || null : null;
  } catch (_error) {
    return null;
  }
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "PING_ARTICLE_WORD_COUNTER"
    });
    if (!response || !response.ok) {
      return { ok: false, reason: "no-response" };
    }

    if (response.version !== CONTENT_SCRIPT_VERSION) {
      return {
        ok: false,
        reason: "version-mismatch",
        detectedVersion: response.version
      };
    }

    return {
      ok: true,
      bootstrap: "existing-content-script"
    };
  } catch (_error) {
    return { ok: false, reason: "send-failed" };
  }
}

async function ensureAnalyzerInjected(tab) {
  if (!tab || typeof tab.id !== "number") {
    return {
      ok: false,
      reason: "no-tab",
      message: "No active tab found."
    };
  }

  if (!isInjectableTabUrl(tab.url)) {
    return {
      ok: false,
      reason: "restricted-scheme",
      message: "This page does not allow extension access."
    };
  }

  const initialPing = await pingContentScript(tab.id);
  if (initialPing.ok) {
    return initialPing;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["contentScript.js"]
    });
  } catch (_error) {
    return {
      ok: false,
      reason: "bootstrap-failed",
      message: "The extension could not start on this page."
    };
  }

  const recoveredPing = await pingContentScript(tab.id);
  if (recoveredPing.ok) {
    return {
      ok: true,
      bootstrap: "execute-script-recovery"
    };
  }

  return {
    ok: false,
    reason: recoveredPing.reason || "bootstrap-failed",
    message: "The extension could not start on this page."
  };
}

async function fetchWordCount() {
  setBusyState();

  const activeTab = await resolveActiveTab();
  const activeTabId = activeTab && typeof activeTab.id === "number" ? activeTab.id : null;
  currentTabId = activeTabId;

  if (typeof activeTabId !== "number") {
    setErrorState("No active tab found.");
    return;
  }

  const readiness = await ensureAnalyzerInjected(activeTab);
  if (!readiness.ok) {
    setErrorState(readiness.message || "The extension could not start on this page.");
    return;
  }

  try {
    await wait(30);
    let response = await requestArticleAnalysis(activeTabId);

    if (shouldRetryAnalysis(response)) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await wait(700);
        const retry = await requestArticleAnalysis(activeTabId);
        if (retry && retry.ok && retry.words > response.words) {
          response = retry;
        }
        if (!shouldRetryAnalysis(response)) {
          break;
        }
      }
    }

    if (!response || !response.ok) {
      const errorMessage =
        response && response.error
          ? `Could not analyze this article: ${response.error}`
          : "Could not analyze this article.";
      setErrorState(errorMessage);
      await wait(30);
      renderSelectionProgress(await requestTabProgress(activeTabId));
      return;
    }

    response.debug = response.debug || {};
    response.debug.bootstrap = readiness.bootstrap;
    setResultState(response);
    await wait(30);
    const liveProgress =
      (await requestSelectionProgress(activeTabId, false)) || (await requestTabProgress(activeTabId));
    renderSelectionProgress(liveProgress);
  } catch (_error) {
    setErrorState("The extension could not reach the page analyzer.");
    await wait(30);
    const liveProgress =
      (await requestSelectionProgress(activeTabId, false)) || (await requestTabProgress(activeTabId));
    renderSelectionProgress(liveProgress);
  }
}

refreshButton.addEventListener("click", fetchWordCount);
presetButton.addEventListener("click", openPresetManager);
presetFormEl.addEventListener("submit", handlePresetSubmit);
presetCancelButton.addEventListener("click", handlePresetCancel);
for (const button of presetButtons) {
  button.addEventListener("click", applyPresetReadingMode);
}
debugToggleButton.addEventListener("click", toggleDebugMode);
countEl.addEventListener("mouseenter", showExactWordCount);
countEl.addEventListener("mouseleave", showRoundedWordCount);

document.addEventListener("DOMContentLoaded", async () => {
  const activeTab = await resolveActiveTab();
  currentTabId = activeTab && typeof activeTab.id === "number" ? activeTab.id : null;
  debugModeEnabled = await loadDebugMode();
  setDebugUi();
  renderSelectionProgress(null);
  renderDebug(null);

  const readerPreferenceState = await loadReaderPreferences();
  readerPresets = readerPreferenceState.presets;
  currentMode = DEFAULT_READING_MODE;
  refreshDerivedTimes();

  if (!readerPreferenceState.confirmed) {
    openPresetEditor("setup");
    return;
  }

  appShellEl.hidden = false;
  await fetchWordCount();
});
