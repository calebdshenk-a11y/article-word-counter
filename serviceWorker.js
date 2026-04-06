"use strict";

const MIN_READING_WPM = 100;
const MAX_READING_WPM = 2000;
const DEFAULT_READING_WPM = 500;
const READING_SPEED_BY_TAB_KEY = "readerWpmByTab";
const BADGE_BACKGROUND_COLOR = "#555555";
const BADGE_TEXT_COLOR = "#ffffff";
const DEFAULT_ACTION_TITLE = "Article Word Counter";

const progressByTabId = new Map();

function isValidWpm(value) {
  return Number.isFinite(value) && value >= MIN_READING_WPM && value <= MAX_READING_WPM;
}

function toSpeedByTabMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

async function getReadingSpeedForTab(tabId) {
  if (typeof tabId !== "number") {
    return DEFAULT_READING_WPM;
  }

  try {
    const stored = await chrome.storage.local.get(READING_SPEED_BY_TAB_KEY);
    const speedByTab = toSpeedByTabMap(stored[READING_SPEED_BY_TAB_KEY]);
    const parsed = Number(speedByTab[String(tabId)]);
    return isValidWpm(parsed) ? Math.round(parsed) : DEFAULT_READING_WPM;
  } catch (_error) {
    return DEFAULT_READING_WPM;
  }
}

async function setBadgeForTab(tabId, percent) {
  if (typeof tabId !== "number") {
    return;
  }

  const roundedPercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  const text = Number.isFinite(roundedPercent) ? String(roundedPercent) : "";
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BACKGROUND_COLOR });
  if (chrome.action && typeof chrome.action.setBadgeTextColor === "function") {
    await chrome.action.setBadgeTextColor({ tabId, color: BADGE_TEXT_COLOR });
  }
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({
    tabId,
    title: Number.isFinite(roundedPercent)
      ? `${roundedPercent}% done with this article`
      : DEFAULT_ACTION_TITLE
  });
}

async function clearProgressForTab(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  progressByTabId.delete(tabId);
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  (async () => {
    const senderTabId =
      sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;

    if (message.type === "GET_READING_SPEED_FOR_TAB") {
      sendResponse({
        ok: true,
        wpm: await getReadingSpeedForTab(senderTabId)
      });
      return;
    }

    if (message.type === "SET_TAB_PROGRESS") {
      if (typeof senderTabId !== "number" || !message.progress || typeof message.progress !== "object") {
        sendResponse({ ok: false });
        return;
      }

      const percent = Number(message.progress.percent);
      const totalWords = Number(message.progress.totalWords);
      const wordsRead = Number(message.progress.wordsRead);
      const remainingWords = Number(message.progress.remainingWords);

      if (
        !Number.isFinite(percent) ||
        !Number.isFinite(totalWords) ||
        !Number.isFinite(wordsRead) ||
        !Number.isFinite(remainingWords)
      ) {
        await clearProgressForTab(senderTabId);
        sendResponse({ ok: false });
        return;
      }

      progressByTabId.set(senderTabId, {
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        totalWords: Math.max(0, Math.round(totalWords)),
        wordsRead: Math.max(0, Math.round(wordsRead)),
        remainingWords: Math.max(0, Math.round(remainingWords)),
        updatedAt:
          typeof message.progress.updatedAt === "string"
            ? message.progress.updatedAt
            : new Date().toISOString()
      });

      await setBadgeForTab(senderTabId, percent);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CLEAR_TAB_PROGRESS") {
      await clearProgressForTab(senderTabId);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_TAB_PROGRESS") {
      const requestedTabId =
        typeof message.tabId === "number" ? message.tabId : senderTabId;
      sendResponse({
        ok: true,
        progress:
          typeof requestedTabId === "number" ? progressByTabId.get(requestedTabId) || null : null
      });
    }
  })();

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void clearProgressForTab(tabId);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const progress = progressByTabId.get(tabId);
  if (!progress) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE });
    return;
  }

  await setBadgeForTab(tabId, progress.percent);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  progressByTabId.delete(tabId);
});
