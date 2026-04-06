"use strict";

const MIN_READING_WPM = 100;
const MAX_READING_WPM = 2000;
const SKIM_READING_WPM = 650;
const NORMAL_READING_WPM = 500;
const DEEP_READING_WPM = 350;
const DEFAULT_READING_WPM = NORMAL_READING_WPM;
const CONTENT_SCRIPT_VERSION = 9;
const DEBUG_MODE_KEY = "debugModeEnabled";
const READING_SPEED_BY_TAB_KEY = "readerWpmByTab";

const countEl = document.getElementById("count");
const metaEl = document.getElementById("meta");
const titleEl = document.getElementById("title");
const readingTimeEl = document.getElementById("readingTime");
const progressValueEl = document.getElementById("progressValue");
const progressTimeEl = document.getElementById("progressTime");
const progressMetaEl = document.getElementById("progressMeta");
const speedChipEl = document.getElementById("speedChip");
const confidenceEl = document.getElementById("confidence");
const refreshButton = document.getElementById("refreshButton");
const speedButton = document.getElementById("speedButton");
const presetButtons = Array.from(document.querySelectorAll(".presetChip"));
const debugToggleButton = document.getElementById("debugToggleButton");
const debugPanelEl = document.getElementById("debugPanel");
const debugDetailsEl = document.getElementById("debugDetails");

const numberFormatter = new Intl.NumberFormat();

let currentWpm = DEFAULT_READING_WPM;
let currentTabId = null;
let debugModeEnabled = false;
let lastResult = null;
let lastTabProgress = null;
let countHoverEnabled = false;

function isPresetSpeed(wpm) {
  return wpm === SKIM_READING_WPM || wpm === NORMAL_READING_WPM || wpm === DEEP_READING_WPM;
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
  debugToggleButton.textContent = debugModeEnabled ? "Debug: On" : "Debug: Off";
  debugToggleButton.setAttribute("aria-pressed", String(debugModeEnabled));
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

function setBusyState() {
  countEl.textContent = "...";
  countHoverEnabled = false;
  clearCountHoverDetails();
  metaEl.textContent = "Analyzing the current page...";
  progressValueEl.textContent = "Checking progress";
  progressTimeEl.hidden = true;
  progressTimeEl.textContent = "-- left";
  progressMetaEl.textContent = "Looking for a selected word in the article.";
  renderDebug(lastResult, "Analyzing the current page...");
}

function setErrorState(message) {
  countEl.textContent = "--";
  countHoverEnabled = false;
  clearCountHoverDetails();
  metaEl.textContent = message;
  readingTimeEl.textContent = "-- read";
  confidenceEl.textContent = "Confidence: --";
  lastResult = null;
  renderSelectionProgress(null);
  renderDebug(null, `Error: ${message}`);
}

function isValidWpm(value) {
  return Number.isFinite(value) && value >= MIN_READING_WPM && value <= MAX_READING_WPM;
}

function setPresetUi(wpm) {
  for (const button of presetButtons) {
    const presetValue = Number(button.dataset.presetWpm);
    const selected = Number.isFinite(presetValue) && presetValue === wpm;
    button.setAttribute("aria-pressed", String(selected));
  }
}

function setSpeedUi(wpm) {
  speedChipEl.textContent = `${wpm} wpm`;
  setPresetUi(wpm);
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

function toSpeedByTabMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

async function loadReadingSpeed(tabId) {
  if (typeof tabId !== "number") {
    return DEFAULT_READING_WPM;
  }

  try {
    const stored = await chrome.storage.local.get(READING_SPEED_BY_TAB_KEY);
    const speedByTab = toSpeedByTabMap(stored[READING_SPEED_BY_TAB_KEY]);
    const parsed = Number(speedByTab[String(tabId)]);
    if (isValidWpm(parsed)) {
      return Math.round(parsed);
    }
  } catch (_error) {
    return DEFAULT_READING_WPM;
  }

  return DEFAULT_READING_WPM;
}

async function saveReadingSpeed(wpm) {
  if (typeof currentTabId !== "number") {
    return;
  }

  try {
    const stored = await chrome.storage.local.get(READING_SPEED_BY_TAB_KEY);
    const speedByTab = toSpeedByTabMap(stored[READING_SPEED_BY_TAB_KEY]);
    speedByTab[String(currentTabId)] = wpm;
    await chrome.storage.local.set({ [READING_SPEED_BY_TAB_KEY]: speedByTab });
  } catch (_error) {
    metaEl.textContent = "Could not save your reading speed.";
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

function formatReadingTimeFromWords(words, wpm) {
  if (!Number.isFinite(words) || words <= 0 || !isValidWpm(wpm)) {
    return "-- read";
  }

  const minutes = Math.max(1, Math.round(words / wpm));
  return `${minutes}m read`;
}

function formatRemainingTimeFromWords(words, wpm) {
  if (!Number.isFinite(words) || words < 0 || !isValidWpm(wpm)) {
    return "-- left";
  }

  if (words === 0) {
    return "Done";
  }

  const minutes = Math.max(1, Math.round(words / wpm));
  return `${minutes}m left`;
}

function renderSelectionProgress(progress) {
  lastTabProgress = progress || null;

  if (!progress) {
    progressValueEl.textContent = "No word selected";
    progressTimeEl.hidden = true;
    progressTimeEl.textContent = "-- left";
    progressMetaEl.textContent = "Double-click a single word in the article to set progress.";
    return;
  }

  progressValueEl.textContent = `${progress.percent}% done`;
  progressTimeEl.hidden = false;
  progressTimeEl.textContent = formatRemainingTimeFromWords(progress.remainingWords, currentWpm);

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
  readingTimeEl.textContent = formatReadingTimeFromWords(result.words, currentWpm);
  confidenceEl.textContent = `Confidence: ${result.confidence}`;

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

async function applyReadingSpeed(nextWpm, refreshAfterUpdate = false) {
  currentWpm = Math.round(nextWpm);
  setSpeedUi(currentWpm);
  await saveReadingSpeed(currentWpm);

  if (lastResult && lastResult.ok) {
    readingTimeEl.textContent = formatReadingTimeFromWords(lastResult.words, currentWpm);
  }
  if (lastTabProgress) {
    renderSelectionProgress(lastTabProgress);
  }

  if (refreshAfterUpdate) {
    await fetchWordCount();
  }
}

async function promptForReadingSpeed() {
  const promptText = `Set your reading speed in WPM (${MIN_READING_WPM}-${MAX_READING_WPM}).`;
  const value = window.prompt(promptText, String(currentWpm));
  if (value === null) {
    return;
  }

  const parsed = Number(value.trim());
  if (!isValidWpm(parsed)) {
    metaEl.textContent = `Enter a valid reading speed from ${MIN_READING_WPM} to ${MAX_READING_WPM} WPM.`;
    return;
  }

  await applyReadingSpeed(parsed, true);
}

async function applyPresetReadingSpeed(event) {
  const target = event.currentTarget;
  const parsed = Number(target && target.dataset ? target.dataset.presetWpm : NaN);

  if (!isValidWpm(parsed) || !isPresetSpeed(parsed)) {
    return;
  }

  await applyReadingSpeed(parsed, false);
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
    renderSelectionProgress(await requestTabProgress(activeTabId));
  } catch (_error) {
    setErrorState("The extension could not reach the page analyzer.");
    await wait(30);
    renderSelectionProgress(await requestTabProgress(activeTabId));
  }
}

refreshButton.addEventListener("click", fetchWordCount);
speedButton.addEventListener("click", promptForReadingSpeed);
for (const button of presetButtons) {
  button.addEventListener("click", applyPresetReadingSpeed);
}
debugToggleButton.addEventListener("click", toggleDebugMode);
countEl.addEventListener("mouseenter", showExactWordCount);
countEl.addEventListener("mouseleave", showRoundedWordCount);

document.addEventListener("DOMContentLoaded", async () => {
  const activeTab = await resolveActiveTab();
  currentTabId = activeTab && typeof activeTab.id === "number" ? activeTab.id : null;
  currentWpm = await loadReadingSpeed(currentTabId);
  debugModeEnabled = await loadDebugMode();
  setSpeedUi(currentWpm);
  setDebugUi();
  renderSelectionProgress(null);
  renderDebug(null);
  await fetchWordCount();
});
