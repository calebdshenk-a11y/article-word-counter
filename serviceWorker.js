"use strict";

const MIN_READING_WPM = 100;
const MAX_READING_WPM = 2000;
const DEFAULT_READING_WPM = 500;
const READING_SPEED_BY_TAB_KEY = "readerWpmByTab";

function isValidWpm(value) {
  return Number.isFinite(value) && value >= MIN_READING_WPM && value <= MAX_READING_WPM;
}

function toSpeedByTabMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GET_READING_SPEED_FOR_TAB") {
    return;
  }

  (async () => {
    const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
    if (typeof tabId !== "number") {
      sendResponse({ ok: true, wpm: DEFAULT_READING_WPM });
      return;
    }

    try {
      const stored = await chrome.storage.local.get(READING_SPEED_BY_TAB_KEY);
      const speedByTab = toSpeedByTabMap(stored[READING_SPEED_BY_TAB_KEY]);
      const parsed = Number(speedByTab[String(tabId)]);

      sendResponse({
        ok: true,
        wpm: isValidWpm(parsed) ? Math.round(parsed) : DEFAULT_READING_WPM
      });
    } catch (_error) {
      sendResponse({ ok: true, wpm: DEFAULT_READING_WPM });
    }
  })();

  return true;
});
