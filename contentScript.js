"use strict";

(() => {

var CONTENT_SCRIPT_VERSION = 6;

var JUNK_KEYWORDS =
  /\b(ad|ads|advert|promo|sponsor|newsletter|subscribe|header|footer|nav|menu|sidebar|related|recommend|popular|trending|cookie|consent|comment|share|social|banner|breadcrumb|outbrain|taboola|paywall)\b/i;
var POSITIVE_KEYWORDS = /\b(article|content|entry|post|story|main|body|text|blog)\b/i;
var JUNK_HEADING =
  /\b(related|recommended|more from|you may also|read next|popular|trending|advertisement|sponsored|comments)\b/i;
var BLOCK_SELECTOR = "p, blockquote, pre, h2, h3, h4";
var SCORING_BLOCK_SELECTOR = "p, blockquote, pre";
var LEGACY_BLOCK_BREAK_TAGS = new Set([
  "P",
  "BLOCKQUOTE",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "TR",
  "TD",
  "TABLE",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "HR"
]);
var LEGACY_SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "CANVAS",
  "IFRAME",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "BUTTON"
]);
var LEGACY_LINK_DENSITY_THRESHOLD = 0.35;
var BASE_SEMANTIC_ROOT_SELECTORS = [
  "[itemprop='articleBody']",
  "article",
  "[role='article']",
  "main article",
  "main",
  "[role='main']",
  ".article-body",
  ".article-content",
  ".story-body",
  ".entry-content",
  ".post-content",
  "[class*='article-body']",
  "[class*='articleBody']",
  "[class*='body__inner']",
  "[class*='body__content']",
  "[class*='entry-content']",
  "[class*='post-content']",
  "[data-testid*='Body']"
];
var DISALLOWED_ROOT_TAGS = new Set([
  "UL",
  "OL",
  "NAV",
  "HEADER",
  "FOOTER",
  "ASIDE",
  "FORM",
  "A",
  "SPAN",
  "P",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6"
]);
var ROOT_CONTAINER_TAGS = new Set(["ARTICLE", "MAIN", "SECTION", "DIV", "BODY"]);
var JSON_LD_SELECTOR = "script[type='application/ld+json']";
var INLINE_SCRIPT_SELECTOR = "script:not([src])";
var ARTICLE_TYPE_PATTERN = /(article|newsarticle|blogposting|report)/i;
var JSON_LD_NODE_BUDGET = 8000;
var SITE_ADAPTERS = [
  {
    id: "newyorker",
    domains: ["newyorker.com"],
    semanticRootSelectors: [
      "[class*='BodyWrapper']",
      "[class*='ArticleBody']",
      "[class*='body__inner-container']",
      "[class*='content'] article"
    ],
    metadataHintParser: "newyorker",
    metadataMultiplier: 0.993,
    metadataSelectorHint: "window.cns.pageContext"
  },
  {
    id: "wsj",
    domains: ["wsj.com"],
    metadataHintParser: "wsj",
    metadataSelectorHint: INLINE_SCRIPT_SELECTOR
  }
];

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function countWords(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return 0;
  }

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    let total = 0;
    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike) {
        total += 1;
      }
    }
    return total;
  }

  const matches = normalized.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function countPunctuation(text) {
  const matches = (text || "").match(/[,.!?;:]/g);
  return matches ? matches.length : 0;
}

function getClassAndId(node) {
  const className =
    typeof node.className === "string"
      ? node.className
      : node.className && typeof node.className.baseVal === "string"
        ? node.className.baseVal
        : "";
  return `${className} ${node.id || ""}`.toLowerCase();
}

function hasJunkLabel(node) {
  const combined = getClassAndId(node);
  return JUNK_KEYWORDS.test(combined) && !POSITIVE_KEYWORDS.test(combined);
}

function hasPositiveLabel(node) {
  const combined = getClassAndId(node);
  return POSITIVE_KEYWORDS.test(combined) && !JUNK_KEYWORDS.test(combined);
}

function isBoilerplateTag(tagName) {
  return ["HEADER", "FOOTER", "NAV", "ASIDE", "FORM"].includes(tagName);
}

function hasBoilerplateRole(node) {
  const role = (node.getAttribute("role") || "").toLowerCase();
  return (
    role === "banner" ||
    role === "navigation" ||
    role === "contentinfo" ||
    role === "complementary"
  );
}

function isProbablyVisible(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  if (node.hasAttribute("hidden")) {
    return false;
  }

  if ((node.getAttribute("aria-hidden") || "").toLowerCase() === "true") {
    return false;
  }

  const style = window.getComputedStyle(node);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number.parseFloat(style.opacity || "1") === 0
  ) {
    return false;
  }
  return true;
}

function isBoilerplateElement(node) {
  if (!(node instanceof Element)) {
    return true;
  }
  if (isBoilerplateTag(node.tagName)) {
    return true;
  }
  if (hasBoilerplateRole(node)) {
    return true;
  }
  if (hasJunkLabel(node)) {
    return true;
  }
  return false;
}

function isEligibleRootCandidate(node) {
  if (!(node instanceof Element)) {
    return false;
  }
  if (!ROOT_CONTAINER_TAGS.has(node.tagName)) {
    return false;
  }
  if (DISALLOWED_ROOT_TAGS.has(node.tagName)) {
    return false;
  }
  if (isBoilerplateElement(node)) {
    return false;
  }
  return true;
}

function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function siteAdaptersForCurrentHost() {
  const host = window.location.hostname.toLowerCase();
  return SITE_ADAPTERS.filter((adapter) =>
    adapter.domains.some((domain) => hostMatchesDomain(host, domain))
  );
}

function semanticRootSelectorsForCurrentHost() {
  const selectors = [...BASE_SEMANTIC_ROOT_SELECTORS];
  for (const adapter of siteAdaptersForCurrentHost()) {
    if (Array.isArray(adapter.semanticRootSelectors)) {
      selectors.push(...adapter.semanticRootSelectors);
    }
  }
  return selectors;
}

function isInsideBoilerplate(node, stopAt = null) {
  let current = node;
  while (current && current !== document.body && current !== stopAt) {
    if (isBoilerplateElement(current)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function linkDensity(node) {
  const allWords = countWords(node.textContent);
  if (allWords === 0) {
    return 0;
  }

  let linkWords = 0;
  const links = node.querySelectorAll("a");
  for (const link of links) {
    linkWords += countWords(link.textContent);
  }

  return linkWords / allWords;
}

function classWeight(node) {
  let score = 0;
  if (hasPositiveLabel(node)) {
    score += 18;
  }
  if (hasJunkLabel(node)) {
    score -= 30;
  }
  if (node.tagName === "ARTICLE") {
    score += 25;
  }
  if (node.tagName === "MAIN") {
    score += 12;
  }
  return score;
}

function scoreCandidates() {
  const candidates = new Map();
  const blocks = document.querySelectorAll(SCORING_BLOCK_SELECTOR);

  for (const block of blocks) {
    if (!isProbablyVisible(block)) {
      continue;
    }
    if (isInsideBoilerplate(block)) {
      continue;
    }

    const text = normalizeText(block.textContent);
    const words = countWords(text);
    if (words < 6) {
      continue;
    }

    const density = linkDensity(block);
    if (density > 0.65) {
      continue;
    }

    const punctuation = countPunctuation(text);
    const blockScore = 1 + Math.min(4, words / 35) + Math.min(2, punctuation / 12) - density * 2;
    const parent = block.parentElement;
    const grandParent = parent ? parent.parentElement : null;

    const targets = [parent, grandParent];
    for (const target of targets) {
      if (!isEligibleRootCandidate(target)) {
        continue;
      }
      const weighted = blockScore + classWeight(target) * 0.08;
      candidates.set(target, (candidates.get(target) || 0) + weighted);
    }
  }

  return candidates;
}

function evaluateRoot(root, score = 0, source = "candidate", details = {}) {
  const text = collectArticleText(root);
  const words = countWords(text);
  const paragraphs = text ? text.split(/\n{2,}/).length : 0;
  return {
    root,
    text,
    words,
    paragraphs,
    score,
    source,
    rootTag: root.tagName.toLowerCase(),
    rootSelector: details.rootSelector || null,
    adapterId: details.adapterId || null
  };
}

function evaluateLegacyRoot(root, score = 0, details = {}) {
  const blocks = collectLegacyArticleText(root);
  const text = blocks.join("\n\n");
  const words = countWords(text);
  return {
    root,
    text,
    words,
    paragraphs: blocks.length,
    score,
    source: "legacy",
    rootTag: root.tagName.toLowerCase(),
    rootSelector: details.rootSelector || null,
    adapterId: details.adapterId || null
  };
}

function shouldTryLegacyFallback(extraction) {
  if (!extraction) {
    return true;
  }
  return extraction.paragraphs < 2 || extraction.words < 80;
}

function parseCountValue(raw, min = 120, max = 50000) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) {
    return null;
  }

  const value = Number.parseInt(digits, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function hasArticleType(value) {
  if (typeof value === "string") {
    return ARTICLE_TYPE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasArticleType(item)) {
        return true;
      }
    }
  }
  return false;
}

function appendCandidateText(value, out) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        out.push(item);
      }
    }
  }
}

function collectJsonLdArticleBodies(node, out, seen, budget, inArticleContext = false) {
  if (!node || budget.count >= JSON_LD_NODE_BUDGET) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectJsonLdArticleBodies(item, out, seen, budget, inArticleContext);
      if (budget.count >= JSON_LD_NODE_BUDGET) {
        return;
      }
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  if (seen.has(node)) {
    return;
  }
  seen.add(node);
  budget.count += 1;

  const hereIsArticle = hasArticleType(node["@type"]);
  const activeArticleContext = inArticleContext || hereIsArticle || Boolean(node.articleBody);

  if (activeArticleContext) {
    appendCandidateText(node.articleBody, out);
    if (typeof node.text === "string" && countWords(node.text) > 200) {
      out.push(node.text);
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      collectJsonLdArticleBodies(value, out, seen, budget, activeArticleContext);
      if (budget.count >= JSON_LD_NODE_BUDGET) {
        return;
      }
    }
  }
}

function buildJsonLdExtraction() {
  const scripts = document.querySelectorAll(JSON_LD_SELECTOR);
  let bestText = "";
  let bestWords = 0;

  for (const script of scripts) {
    const raw = script.textContent || "";
    if (!raw.trim()) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      continue;
    }

    const candidates = [];
    collectJsonLdArticleBodies(parsed, candidates, new WeakSet(), { count: 0 });

    for (const candidate of candidates) {
      const normalized = normalizeText(candidate);
      const words = countWords(normalized);
      if (words > bestWords) {
        bestWords = words;
        bestText = normalized;
      }
    }
  }

  if (bestWords < 120) {
    return null;
  }

  const paragraphs = bestText
    .split(/\n+/)
    .map((part) => normalizeText(part))
    .filter((part) => part.length > 0).length;

  return {
    root: document.body,
    rootTag: "json-ld",
    text: bestText,
    words: bestWords,
    paragraphs: Math.max(1, paragraphs),
    score: 26,
    source: "jsonld",
    rootSelector: JSON_LD_SELECTOR,
    adapterId: null
  };
}

function collectJsonLdWordCountHints(node, out, seen, budget, inArticleContext = false) {
  if (!node || budget.count >= JSON_LD_NODE_BUDGET) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectJsonLdWordCountHints(item, out, seen, budget, inArticleContext);
      if (budget.count >= JSON_LD_NODE_BUDGET) {
        return;
      }
    }
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  if (seen.has(node)) {
    return;
  }
  seen.add(node);
  budget.count += 1;

  const urlValue =
    typeof node.url === "string"
      ? node.url
      : typeof node.mainEntityOfPage === "string"
        ? node.mainEntityOfPage
        : "";
  const samePage = Boolean(urlValue && urlValue.includes(window.location.pathname));
  const activeArticleContext =
    inArticleContext ||
    hasArticleType(node["@type"]) ||
    samePage ||
    Boolean(node.articleBody) ||
    Boolean(node.wordCount) ||
    Boolean(node.word_count) ||
    Boolean(node.copyCount);

  if (activeArticleContext) {
    const directCandidates = [node.wordCount, node.word_count, node.copyCount];
    for (const candidate of directCandidates) {
      const parsed = parseCountValue(candidate);
      if (parsed) {
        out.push(parsed);
      }
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      collectJsonLdWordCountHints(value, out, seen, budget, activeArticleContext);
      if (budget.count >= JSON_LD_NODE_BUDGET) {
        return;
      }
    }
  }
}

function extractJsonLdWordCountHint() {
  const scripts = document.querySelectorAll(JSON_LD_SELECTOR);
  let best = null;

  for (const script of scripts) {
    const raw = script.textContent || "";
    if (!raw.trim()) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      continue;
    }

    const candidates = [];
    collectJsonLdWordCountHints(parsed, candidates, new WeakSet(), { count: 0 });
    for (const value of candidates) {
      if (!best || value > best) {
        best = value;
      }
    }
  }

  return best;
}

function extractWordCountCandidatesFromText(text) {
  const counts = [];
  const pattern =
    /(?:"(?:wordCount|word_count|copyCount)"|\b(?:wordCount|word_count|copyCount)\b)\s*:\s*"?([0-9][0-9,]{2,5})"?/g;

  let match;
  while ((match = pattern.exec(text))) {
    const parsed = parseCountValue(match[1]);
    if (parsed) {
      counts.push(parsed);
    }
  }

  return counts;
}

function extractWsjWordCountHint() {
  const scripts = document.querySelectorAll(INLINE_SCRIPT_SELECTOR);
  const path = window.location.pathname;
  const slugToken = path.split("-").filter(Boolean).pop() || "";

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text || !text.includes("wordCount")) {
      continue;
    }

    const candidates = extractWordCountCandidatesFromText(text);
    if (candidates.length === 0) {
      continue;
    }

    let score = 0;
    if (path && text.includes(path)) {
      score += 4;
    }
    if (slugToken && slugToken.length >= 6 && text.includes(slugToken)) {
      score += 3;
    }
    if (
      text.includes('"contentType":"article"') ||
      text.includes('"articleType"') ||
      text.includes('"@type":"NewsArticle"')
    ) {
      score += 1;
    }

    const candidate = Math.max(...candidates);
    if (score > bestScore || (score === bestScore && (!best || candidate > best))) {
      best = candidate;
      bestScore = score;
    }
  }

  if (bestScore < 1) {
    return null;
  }

  return best;
}

function extractNewYorkerWordCountHint() {
  const scripts = document.querySelectorAll(INLINE_SCRIPT_SELECTOR);
  const slug = window.location.pathname.split("/").filter(Boolean).pop() || "";

  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text.includes("window.cns.pageContext")) {
      continue;
    }
    if (slug && !text.includes(`"slug":"${slug}"`)) {
      continue;
    }

    const copyCountMatch = text.match(/"copyCount"\s*:\s*(\d{3,5})/);
    if (copyCountMatch) {
      const parsed = parseCountValue(copyCountMatch[1]);
      if (parsed) {
        return parsed;
      }
    }
  }

  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text.includes('"contentType":"article"') || !text.includes('"copyCount"')) {
      continue;
    }
    const copyCountMatch = text.match(/"copyCount"\s*:\s*(\d{3,5})/);
    if (copyCountMatch) {
      const parsed = parseCountValue(copyCountMatch[1]);
      if (parsed) {
        return parsed;
      }
    }
  }

  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text.includes('"event":"data-layer-loaded"')) {
      continue;
    }
    const wordCountMatch = text.match(/"wordCount"\s*:\s*"(\d{3,5})"/);
    if (wordCountMatch) {
      const parsed = parseCountValue(wordCountMatch[1]);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function extractAdapterWordCountHint(adapter) {
  if (!adapter || !adapter.metadataHintParser) {
    return null;
  }

  if (adapter.metadataHintParser === "newyorker") {
    return extractNewYorkerWordCountHint();
  }
  if (adapter.metadataHintParser === "wsj") {
    return extractWsjWordCountHint();
  }

  return null;
}

function normalizeAdapterWordCount(adapter, hintedWords) {
  if (!Number.isFinite(hintedWords)) {
    return null;
  }

  if (Number.isFinite(adapter.metadataMultiplier)) {
    return Math.max(120, Math.round(hintedWords * adapter.metadataMultiplier));
  }

  return hintedWords;
}

function buildPublisherHintExtraction(baselineParagraphs) {
  const hints = [];
  const jsonLdWordCount = extractJsonLdWordCountHint();
  if (jsonLdWordCount) {
    hints.push({
      words: jsonLdWordCount,
      source: "jsonld",
      adapterId: null,
      rootSelector: JSON_LD_SELECTOR
    });
  }

  for (const adapter of siteAdaptersForCurrentHost()) {
    const hinted = extractAdapterWordCountHint(adapter);
    const normalized = normalizeAdapterWordCount(adapter, hinted);
    if (!normalized) {
      continue;
    }
    hints.push({
      words: normalized,
      source: "metadata",
      adapterId: adapter.id,
      rootSelector: adapter.metadataSelectorHint || INLINE_SCRIPT_SELECTOR
    });
  }

  if (hints.length === 0) {
    return null;
  }

  let bestHint = hints[0];
  for (const hint of hints) {
    if (hint.words > bestHint.words) {
      bestHint = hint;
    }
  }

  const paragraphEstimate = Math.max(
    baselineParagraphs || 1,
    Math.min(120, Math.round(bestHint.words / 90))
  );

  return {
    root: document.body,
    rootTag: "publisher",
    rootSelector: bestHint.rootSelector,
    adapterId: bestHint.adapterId,
    text: "",
    words: bestHint.words,
    paragraphs: paragraphEstimate,
    score: 28,
    source: "metadata"
  };
}

function pickBestSemanticRoot() {
  const seen = new Set();
  let best = null;

  for (const selector of semanticRootSelectorsForCurrentHost()) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (!isEligibleRootCandidate(node)) {
        continue;
      }
      if (seen.has(node)) {
        continue;
      }
      seen.add(node);

      const words = countWords(node.textContent);
      if (words < 120) {
        continue;
      }

      const extracted = evaluateRoot(node, 0, "semantic", { rootSelector: selector });
      if (extracted.words < 80) {
        continue;
      }

      if (!best || extracted.words > best.words) {
        best = extracted;
      }
    }
  }

  return best;
}

function isEligibleLegacyRootCandidate(node) {
  if (!(node instanceof Element)) {
    return false;
  }
  if (!["TD", "TABLE", "BODY"].includes(node.tagName)) {
    return false;
  }
  if (!isProbablyVisible(node)) {
    return false;
  }
  if (node !== document.body && isBoilerplateElement(node)) {
    return false;
  }
  return true;
}

function legacyRootPreference(node) {
  if (!(node instanceof Element)) {
    return 99;
  }
  if (node.tagName === "TD") {
    return 0;
  }
  if (node.tagName === "TABLE") {
    return 1;
  }
  if (node.tagName === "BODY") {
    return 2;
  }
  return 99;
}

function legacyLinkDensity(root, allWords) {
  if (!(root instanceof Element) || !Number.isFinite(allWords) || allWords <= 0) {
    return 0;
  }

  let linkWords = 0;
  const links = root.querySelectorAll("a");
  for (const link of links) {
    if (!isProbablyVisible(link)) {
      continue;
    }
    if (isInsideBoilerplate(link, root)) {
      continue;
    }
    if (hasJunkLabel(link)) {
      continue;
    }
    linkWords += countWords(link.textContent);
  }

  return linkWords / allWords;
}

function pickBestLegacyExtraction() {
  const candidates = [];
  const seen = new Set();
  const selectors = ["td", "table"];

  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      if (seen.has(node) || !isEligibleLegacyRootCandidate(node)) {
        continue;
      }
      seen.add(node);
      candidates.push({ node, selector });
    }
  }

  if (document.body && !seen.has(document.body) && isEligibleLegacyRootCandidate(document.body)) {
    candidates.push({ node: document.body, selector: "body" });
  }

  const accepted = [];
  for (const candidate of candidates) {
    if (candidate.node.querySelectorAll("br").length < 2) {
      continue;
    }

    const standard = evaluateRoot(candidate.node, 0, "candidate", {
      rootSelector: candidate.selector
    });
    if (!shouldTryLegacyFallback(standard)) {
      continue;
    }

    const extracted = evaluateLegacyRoot(candidate.node, 0, {
      rootSelector: candidate.selector
    });
    if (extracted.words < 200 || extracted.paragraphs < 3) {
      continue;
    }
    if (legacyLinkDensity(candidate.node, extracted.words) > LEGACY_LINK_DENSITY_THRESHOLD) {
      continue;
    }

    accepted.push(extracted);
  }

  if (accepted.length === 0) {
    return null;
  }

  accepted.sort((a, b) => {
    if (b.words !== a.words) {
      return b.words - a.words;
    }
    return legacyRootPreference(a.root) - legacyRootPreference(b.root);
  });

  const strongest = accepted[0];
  const narrowCandidates = accepted
    .filter(
      (option) =>
        option.root instanceof Element &&
        option.root.tagName !== "BODY" &&
        option.words >= strongest.words * 0.95
    )
    .sort((a, b) => {
      const preferenceDiff = legacyRootPreference(a.root) - legacyRootPreference(b.root);
      if (preferenceDiff !== 0) {
        return preferenceDiff;
      }
      return b.words - a.words;
    });

  return narrowCandidates[0] || strongest;
}

function pickBestAncestorRoot(startNode) {
  let best = null;
  let current = startNode instanceof Element ? startNode.parentElement : null;
  let depth = 0;

  while (current && current !== document.body && depth < 10) {
    if (isEligibleRootCandidate(current)) {
      const extracted = evaluateRoot(current, 0, "ancestor", { rootSelector: "ancestor" });
      if (extracted.words >= 80) {
        if (!best || extracted.words > best.words) {
          best = extracted;
        }
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  if (document.body && isEligibleRootCandidate(document.body)) {
    const bodyExtraction = evaluateRoot(document.body, 0, "ancestor", { rootSelector: "body" });
    if (bodyExtraction.words >= 120) {
      if (!best || bodyExtraction.words > best.words) {
        best = bodyExtraction;
      }
    }
  }

  return best;
}

function summarizeExtractionForDebug(extraction) {
  if (!extraction) {
    return null;
  }
  return {
    source: extraction.source,
    words: extraction.words,
    paragraphs: extraction.paragraphs,
    score: Math.round(extraction.score || 0),
    rootTag:
      extraction.rootTag ||
      (extraction.root && extraction.root.tagName
        ? extraction.root.tagName.toLowerCase()
        : "unknown"),
    rootSelector: extraction.rootSelector || null,
    adapterId: extraction.adapterId || null
  };
}

function isSameExtraction(a, b) {
  if (!a || !b) {
    return false;
  }

  return (
    a.source === b.source &&
    a.words === b.words &&
    a.paragraphs === b.paragraphs &&
    (a.rootTag || "") === (b.rootTag || "") &&
    (a.rootSelector || "") === (b.rootSelector || "") &&
    (a.adapterId || "") === (b.adapterId || "")
  );
}

function buildExtractionDebug(primary, alternatives, chosen, decision) {
  const topAlternatives = [primary, ...alternatives]
    .filter((option) => option && !isSameExtraction(option, chosen))
    .sort((a, b) => b.words - a.words)
    .slice(0, 3)
    .map((option) => summarizeExtractionForDebug(option));

  return {
    decision,
    chosen: summarizeExtractionForDebug(chosen),
    primary: summarizeExtractionForDebug(primary),
    topAlternatives
  };
}

function chooseBestExtraction(primaryRoot, primaryScore, primarySelector = null) {
  const primary = evaluateRoot(primaryRoot, primaryScore, "candidate", {
    rootSelector: primarySelector
  });
  const semantic = pickBestSemanticRoot();
  const ancestor = pickBestAncestorRoot(primary.root);
  const jsonLd = buildJsonLdExtraction();
  const metadata = buildPublisherHintExtraction(primary.paragraphs);
  const legacy = pickBestLegacyExtraction();

  const alternatives = [semantic, ancestor, jsonLd, metadata, legacy].filter(Boolean);
  let bestAlternative = null;
  for (const option of alternatives) {
    if (!bestAlternative || option.words > bestAlternative.words) {
      bestAlternative = option;
    }
  }

  if (!bestAlternative) {
    return {
      extraction: primary,
      debug: buildExtractionDebug(primary, alternatives, primary, "primary")
    };
  }

  const primaryIsDisallowed = !isEligibleRootCandidate(primary.root);
  const primaryLooksWeak = primary.words < 140 || primary.paragraphs < 3;
  const alternativeClearlyBetter = bestAlternative.words >= primary.words + 80;
  const alternativeIsAuthoritative =
    bestAlternative.source === "jsonld" || bestAlternative.source === "metadata";
  const alternativeDominates = alternativeIsAuthoritative
    ? bestAlternative.words >= primary.words + 80
    : bestAlternative.words >= primary.words * 1.25 && bestAlternative.words >= 200;

  let chosen = primary;
  let decision = "primary";

  if ((primaryIsDisallowed || primaryLooksWeak) && alternativeClearlyBetter) {
    const scoreHint = Math.max(
      primary.score,
      Math.min(24, bestAlternative.paragraphs * 1.5 + bestAlternative.words / 200)
    );
    chosen = { ...bestAlternative, score: scoreHint };
    decision = "weak-primary-alternative";
  }

  if (decision === "primary" && alternativeDominates) {
    const scoreHint = Math.max(
      primary.score,
      Math.min(24, bestAlternative.paragraphs * 1.5 + bestAlternative.words / 200)
    );
    chosen = { ...bestAlternative, score: scoreHint };
    decision = alternativeIsAuthoritative
      ? "authoritative-alternative"
      : "dominant-alternative";
  }

  return {
    extraction: chosen,
    debug: buildExtractionDebug(primary, alternatives, chosen, decision)
  };
}

function pickMainContentRoot() {
  const candidates = scoreCandidates();
  let bestNode = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const [node, score] of candidates.entries()) {
    const finalScore = score + classWeight(node) * 0.2;
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestNode = node;
    }
  }

  if (bestNode) {
    return { node: bestNode, score: bestScore, selector: "scored-parent" };
  }

  const article = document.querySelector("article");
  if (article) {
    return { node: article, score: 0, selector: "article" };
  }

  const itempropArticleBody = document.querySelector("[itemprop='articleBody']");
  if (itempropArticleBody) {
    return { node: itempropArticleBody, score: 0, selector: "[itemprop='articleBody']" };
  }

  const main = document.querySelector("main");
  if (main) {
    return { node: main, score: 0, selector: "main" };
  }

  const roleMain = document.querySelector("[role='main']");
  if (roleMain) {
    return { node: roleMain, score: 0, selector: "[role='main']" };
  }

  return { node: document.body, score: 0, selector: "body" };
}

function looksLikeByline(text) {
  return /^by\s+[a-z]/i.test(text) || /^\w+\s+\|\s+\w+/.test(text);
}

function collectLegacyArticleText(root) {
  const blocks = [];
  let current = "";
  let pendingBreaks = 0;

  function flushBlock() {
    const normalized = normalizeText(current);
    if (normalized) {
      const words = countWords(normalized);
      if (
        words >= 2 &&
        !(looksLikeByline(normalized) && words < 15) &&
        !(words < 12 && JUNK_HEADING.test(normalized))
      ) {
        blocks.push(normalized);
      }
    }
    current = "";
    pendingBreaks = 0;
  }

  function queueLineBreak() {
    pendingBreaks = Math.min(2, pendingBreaks + 1);
  }

  function queueParagraphBreak() {
    pendingBreaks = Math.max(pendingBreaks, 2);
  }

  function commitPendingBreaks(nextText) {
    if (pendingBreaks >= 2) {
      flushBlock();
      return;
    }
    if (
      pendingBreaks === 1 &&
      current &&
      nextText &&
      !/\s$/.test(current) &&
      !/^[,.;:!?)\]]/.test(nextText)
    ) {
      current += " ";
    }
    pendingBreaks = 0;
  }

  function appendText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return;
    }

    commitPendingBreaks(normalized);
    if (current && !/\s$/.test(current) && !/^[,.;:!?)\]]/.test(normalized)) {
      current += " ";
    }
    current += normalized;
  }

  // Legacy pages often store paragraphs in a single table cell split by repeated <br> tags.
  function walk(node) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent);
      return;
    }

    if (!(node instanceof Element)) {
      return;
    }

    if (node !== root) {
      if (LEGACY_SKIP_TAGS.has(node.tagName)) {
        return;
      }
      if (!isProbablyVisible(node)) {
        return;
      }
      if (isBoilerplateElement(node)) {
        return;
      }
    }

    if (node.tagName === "BR") {
      queueLineBreak();
      return;
    }

    const breaksAroundChildren = LEGACY_BLOCK_BREAK_TAGS.has(node.tagName);
    if (breaksAroundChildren) {
      queueParagraphBreak();
    }

    for (const child of node.childNodes) {
      walk(child);
    }

    if (breaksAroundChildren) {
      queueParagraphBreak();
    }
  }

  walk(root);
  flushBlock();

  return blocks;
}

function collectArticleText(root) {
  const pieces = [];
  const blocks = root.querySelectorAll(BLOCK_SELECTOR);

  for (const block of blocks) {
    if (!isProbablyVisible(block)) {
      continue;
    }
    if (isInsideBoilerplate(block, root)) {
      continue;
    }
    if (hasJunkLabel(block)) {
      continue;
    }

    const text = normalizeText(block.textContent);
    const words = countWords(text);
    if (words < 2) {
      continue;
    }

    if (/^H[2-4]$/.test(block.tagName) && JUNK_HEADING.test(text)) {
      continue;
    }

    if (looksLikeByline(text) && words < 15) {
      continue;
    }

    const density = linkDensity(block);
    if (density > 0.55 && words < 90) {
      continue;
    }

    pieces.push(text);
  }

  return pieces.join("\n\n");
}

function confidenceLevel(wordCount, blockCount, rawScore) {
  if (wordCount >= 300 && blockCount >= 4 && rawScore >= 12) {
    return "High";
  }
  if (wordCount >= 120 && blockCount >= 2) {
    return "Medium";
  }
  return "Low";
}

function analyzePage() {
  const { node: primaryRoot, score: primaryScore, selector: primarySelector } = pickMainContentRoot();
  const { extraction, debug } = chooseBestExtraction(primaryRoot, primaryScore, primarySelector);

  return {
    ok: true,
    pageTitle: document.title || "",
    url: window.location.href,
    words: extraction.words,
    paragraphs: extraction.paragraphs,
    confidence: confidenceLevel(extraction.words, extraction.paragraphs, extraction.score),
    rootTag: extraction.rootTag || extraction.root.tagName.toLowerCase(),
    extractionSource: extraction.source,
    rootSelector: extraction.rootSelector || null,
    adapterId: extraction.adapterId || null,
    debug,
    generatedAt: new Date().toISOString()
  };
}

var LISTENER_KEY = "__articleWordCounterMessageListener__";

var onMessage = (message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "PING_ARTICLE_WORD_COUNTER") {
    sendResponse({ ok: true, version: CONTENT_SCRIPT_VERSION });
    return;
  }

  if (message.type !== "GET_ARTICLE_WORD_COUNT") {
    return;
  }

  try {
    sendResponse(analyzePage());
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to analyze this page."
    });
  }
};

var previousListener = globalThis[LISTENER_KEY];
if (typeof previousListener === "function") {
  chrome.runtime.onMessage.removeListener(previousListener);
}

chrome.runtime.onMessage.addListener(onMessage);
globalThis[LISTENER_KEY] = onMessage;
})();
