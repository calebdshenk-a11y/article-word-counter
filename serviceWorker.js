"use strict";

const BADGE_BACKGROUND_COLOR = "#555555";
const BADGE_TEXT_COLOR = "#ffffff";
const DEFAULT_ACTION_TITLE = "Article Word Counter";

const progressByTabId = new Map();

async function trySetBadgeBackgroundColor(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BACKGROUND_COLOR });
  } catch (_error) {
    // Badge text should still appear even if this browser rejects custom colors.
  }
}

async function trySetBadgeTextColor(tabId) {
  if (!(chrome.action && typeof chrome.action.setBadgeTextColor === "function")) {
    return;
  }

  try {
    await chrome.action.setBadgeTextColor({ tabId, color: BADGE_TEXT_COLOR });
  } catch (_error) {
    // Optional in older Chrome-compatible browsers.
  }
}

async function trySetActionTitle(tabId, title) {
  try {
    await chrome.action.setTitle({ tabId, title });
  } catch (_error) {
    // The badge is the primary signal; keep it if the title update fails.
  }
}

async function setBadgeForTab(tabId, percent) {
  if (typeof tabId !== "number") {
    return false;
  }

  const roundedPercent = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : null;
  const text = Number.isFinite(roundedPercent) ? String(roundedPercent) : "";

  await chrome.action.setBadgeText({ tabId, text });
  await trySetBadgeBackgroundColor(tabId);
  await trySetBadgeTextColor(tabId);
  await trySetActionTitle(
    tabId,
    Number.isFinite(roundedPercent)
      ? `${roundedPercent}% done with this article`
      : DEFAULT_ACTION_TITLE
  );
  return true;
}

async function clearProgressForTab(tabId) {
  if (typeof tabId !== "number") {
    return false;
  }

  progressByTabId.delete(tabId);
  await chrome.action.setBadgeText({ tabId, text: "" });
  await trySetActionTitle(tabId, DEFAULT_ACTION_TITLE);
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  (async () => {
    const senderTabId =
      sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;

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

      const badgeUpdated = await setBadgeForTab(senderTabId, percent);
      sendResponse({ ok: badgeUpdated });
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
  })().catch(() => {
    sendResponse({ ok: false });
  });

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
    await trySetActionTitle(tabId, DEFAULT_ACTION_TITLE);
    return;
  }

  await setBadgeForTab(tabId, progress.percent);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  progressByTabId.delete(tabId);
});
