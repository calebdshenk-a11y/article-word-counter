"use strict";

(() => {

var CONTENT_SCRIPT_VERSION = 13;
var REQUIRED_SELECTION_WORDS = 1;
var NEWYORKER_END_MARKER_PATTERN = /^[♦◆❖◊]\s*$/;
var NEWYORKER_END_MARKER_ANYWHERE_PATTERN = /[♦◆❖◊]/;

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

function hasSiteAdapter(adapterId) {
  return siteAdaptersForCurrentHost().some((adapter) => adapter.id === adapterId);
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
  const blockData = collectArticleBlockData(root);
  const blocks = blockData.blocks;
  const text = blocks.map((block) => block.text).join("\n\n");
  const words = blocks.reduce((total, block) => total + block.words, 0);
  const paragraphs = blocks.length;
  return {
    root,
    text,
    words,
    paragraphs,
    blocks,
    score,
    source,
    rootTag: root.tagName.toLowerCase(),
    rootSelector: details.rootSelector || null,
    adapterId: details.adapterId || null,
    countSource: details.countSource || `dom-${source}`,
    endMarkerDetected: Boolean(blockData.endMarkerDetected)
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
    blocks: null,
    score,
    source: "legacy",
    rootTag: root.tagName.toLowerCase(),
    rootSelector: details.rootSelector || null,
    adapterId: details.adapterId || null,
    countSource: details.countSource || "dom-legacy",
    endMarkerDetected: false
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
    adapterId: null,
    countSource: "jsonld-article-body"
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

function extractNewYorkerPageContextCopyCount() {
  try {
    const pageContext = globalThis.window && window.cns && window.cns.pageContext;
    const slug = window.location.pathname.split("/").filter(Boolean).pop() || "";
    const contextSlug =
      pageContext && typeof pageContext.slug === "string" ? pageContext.slug : "";
    const hintedCopyCount =
      pageContext && pageContext.content ? parseCountValue(pageContext.content.copyCount) : null;

    if (hintedCopyCount && (!slug || !contextSlug || slug === contextSlug)) {
      return hintedCopyCount;
    }
  } catch (_error) {
    // Fall back to scanning inline scripts below.
  }

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

  return null;
}

function extractNewYorkerDataLayerWordCount() {
  try {
    const dataLayer = globalThis.window && Array.isArray(window.dataLayer) ? window.dataLayer : [];
    const path = window.location.pathname;

    for (const entry of dataLayer) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const content = entry.content && typeof entry.content === "object" ? entry.content : null;
      const canonical =
        entry.page && typeof entry.page === "object" && typeof entry.page.canonical === "string"
          ? entry.page.canonical
          : "";
      const hinted = content ? parseCountValue(content.wordCount) : null;

      if (
        hinted &&
        ((!path && !canonical) ||
          !canonical ||
          canonical.includes(path) ||
          content.contentType === "article")
      ) {
        return hinted;
      }
    }
  } catch (_error) {
    // Fall back to scanning inline scripts below.
  }

  const scripts = document.querySelectorAll(INLINE_SCRIPT_SELECTOR);
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

function extractNewYorkerWordCountHint() {
  return extractNewYorkerPageContextCopyCount() || extractNewYorkerDataLayerWordCount();
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

function buildHintExtraction(words, baselineParagraphs, details) {
  if (!Number.isFinite(words)) {
    return null;
  }

  const paragraphEstimate = Math.max(
    baselineParagraphs || 1,
    Math.min(120, Math.round(words / 90))
  );

  return {
    root: document.body,
    rootTag: details.rootTag || (details.source === "jsonld" ? "json-ld" : "publisher"),
    rootSelector: details.rootSelector || null,
    adapterId: details.adapterId || null,
    text: "",
    words,
    paragraphs: paragraphEstimate,
    score: Number.isFinite(details.score) ? details.score : 28,
    source: details.source || "metadata",
    countSource: details.countSource || details.source || "metadata"
  };
}

function buildPublisherHintExtraction(baselineParagraphs) {
  const hints = [];
  const jsonLdWordCount = extractJsonLdWordCountHint();
  if (jsonLdWordCount) {
    hints.push({
      words: jsonLdWordCount,
      source: "jsonld",
      countSource: "jsonld-word-count",
      adapterId: null,
      rootSelector: JSON_LD_SELECTOR,
      priority: 100
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
      countSource: `${adapter.id}-metadata`,
      adapterId: adapter.id,
      rootSelector: adapter.metadataSelectorHint || INLINE_SCRIPT_SELECTOR,
      priority: 200
    });
  }

  if (hints.length === 0) {
    return null;
  }

  let bestHint = hints[0];
  for (const hint of hints) {
    if (
      hint.priority > bestHint.priority ||
      (hint.priority === bestHint.priority && hint.words > bestHint.words)
    ) {
      bestHint = hint;
    }
  }

  return buildHintExtraction(bestHint.words, baselineParagraphs, bestHint);
}

function buildNewYorkerCountExtraction(baselineParagraphs) {
  const adapter = siteAdaptersForCurrentHost().find((candidate) => candidate.id === "newyorker");
  if (!adapter) {
    return null;
  }

  const pageContextWords = normalizeAdapterWordCount(adapter, extractNewYorkerPageContextCopyCount());
  if (pageContextWords) {
    return buildHintExtraction(pageContextWords, baselineParagraphs, {
      source: "metadata",
      countSource: "newyorker-page-context",
      adapterId: adapter.id,
      rootSelector: "window.cns.pageContext.content.copyCount",
      score: 30
    });
  }

  const dataLayerWords = normalizeAdapterWordCount(adapter, extractNewYorkerDataLayerWordCount());
  if (dataLayerWords) {
    return buildHintExtraction(dataLayerWords, baselineParagraphs, {
      source: "metadata",
      countSource: "newyorker-data-layer",
      adapterId: adapter.id,
      rootSelector: "window.dataLayer[].content.wordCount",
      score: 29
    });
  }

  const jsonLdWordCount = extractJsonLdWordCountHint();
  if (jsonLdWordCount) {
    return buildHintExtraction(jsonLdWordCount, baselineParagraphs, {
      source: "jsonld",
      countSource: "jsonld-word-count",
      rootSelector: JSON_LD_SELECTOR,
      score: 28
    });
  }

  const jsonLdExtraction = buildJsonLdExtraction();
  if (jsonLdExtraction) {
    return jsonLdExtraction;
  }

  return null;
}

function buildPreferredCountExtraction(baselineParagraphs) {
  if (hasSiteAdapter("newyorker")) {
    return buildNewYorkerCountExtraction(baselineParagraphs) || buildPublisherHintExtraction(
      baselineParagraphs
    );
  }

  return buildPublisherHintExtraction(baselineParagraphs);
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
    countSource: extraction.countSource || extraction.source,
    endMarkerDetected: Boolean(extraction.endMarkerDetected),
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
    (a.countSource || "") === (b.countSource || "") &&
    a.words === b.words &&
    a.paragraphs === b.paragraphs &&
    (a.rootTag || "") === (b.rootTag || "") &&
    (a.rootSelector || "") === (b.rootSelector || "") &&
    (a.adapterId || "") === (b.adapterId || "")
  );
}

function buildExtractionDebug(primary, alternatives, chosen, decision, progressExtraction) {
  const topAlternatives = [primary, ...alternatives]
    .filter((option) => option && !isSameExtraction(option, chosen))
    .sort((a, b) => b.words - a.words)
    .slice(0, 3)
    .map((option) => summarizeExtractionForDebug(option));

  return {
    decision,
    chosen: summarizeExtractionForDebug(chosen),
    primary: summarizeExtractionForDebug(primary),
    progressSource: summarizeExtractionForDebug(progressExtraction),
    topAlternatives
  };
}

function isDomTrackableExtraction(extraction) {
  return Boolean(
    extraction &&
      extraction.root instanceof Element &&
      extraction.source !== "jsonld" &&
      extraction.source !== "metadata"
  );
}

function pickBestExtractionByWords(extractions) {
  let best = null;
  for (const extraction of extractions) {
    if (!extraction) {
      continue;
    }
    if (!best || extraction.words > best.words) {
      best = extraction;
    }
  }
  return best;
}

function chooseBestExtraction(primaryRoot, primaryScore, primarySelector = null) {
  const primary = evaluateRoot(primaryRoot, primaryScore, "candidate", {
    rootSelector: primarySelector
  });
  const semantic = pickBestSemanticRoot();
  const ancestor = pickBestAncestorRoot(primary.root);
  const jsonLd = buildJsonLdExtraction();
  const preferredCount = buildPreferredCountExtraction(primary.paragraphs);
  const legacy = pickBestLegacyExtraction();

  const alternatives = [semantic, ancestor, jsonLd, preferredCount, legacy].filter(Boolean);
  let bestAlternative = null;
  for (const option of alternatives) {
    if (!bestAlternative || option.words > bestAlternative.words) {
      bestAlternative = option;
    }
  }

  if (!bestAlternative) {
    return {
      extraction: primary,
      progressExtraction: primary,
      debug: buildExtractionDebug(primary, alternatives, primary, "primary", primary)
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
  const newYorkerDomCandidates = [primary, semantic, ancestor].filter(isDomTrackableExtraction);
  const newYorkerMarkerExtraction = hasSiteAdapter("newyorker")
    ? pickBestExtractionByWords(
        newYorkerDomCandidates.filter((option) => option && option.endMarkerDetected)
      )
    : null;

  if (newYorkerMarkerExtraction) {
    chosen = {
      ...newYorkerMarkerExtraction,
      score: Math.max(primary.score, newYorkerMarkerExtraction.score || 0, 18)
    };
    decision = "newyorker-end-marker";
  } else if (hasSiteAdapter("newyorker") && preferredCount) {
    chosen = {
      ...preferredCount,
      score: Math.max(primary.score, preferredCount.score || 28)
    };
    decision = "newyorker-authoritative-count";
  }

  if (decision === "primary" && (primaryIsDisallowed || primaryLooksWeak) && alternativeClearlyBetter) {
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

  const progressCandidates = hasSiteAdapter("newyorker")
    ? [newYorkerMarkerExtraction, primary, semantic, ancestor].filter(isDomTrackableExtraction)
    : [chosen, primary, semantic, ancestor, legacy].filter(isDomTrackableExtraction);
  const progressExtraction = pickBestExtractionByWords(progressCandidates);

  return {
    extraction: chosen,
    progressExtraction,
    debug: buildExtractionDebug(primary, alternatives, chosen, decision, progressExtraction)
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

function findNewYorkerEndMarker(root) {
  if (!hasSiteAdapter("newyorker") || !(root instanceof Element)) {
    return null;
  }

  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  var wordsCollected = 0;
  var current;

  while ((current = walker.nextNode())) {
    if (!(current instanceof Text)) {
      continue;
    }

    var parent = current.parentElement;
    if (!parent || !isProbablyVisible(parent) || isInsideBoilerplate(parent, root)) {
      continue;
    }

    var rawText = current.textContent || "";
    if (!rawText.trim()) {
      continue;
    }

    var markerIndex = rawText.search(NEWYORKER_END_MARKER_ANYWHERE_PATTERN);
    if (markerIndex !== -1 && wordsCollected >= 250) {
      return {
        node: current,
        markerIndex: markerIndex
      };
    }

    wordsCollected += countWords(rawText);
  }

  return null;
}

function trimNewYorkerBlockAtMarker(text) {
  var normalized = normalizeText(text);
  if (!normalized) {
    return { text: "", stopAfter: false };
  }

  if (NEWYORKER_END_MARKER_PATTERN.test(normalized)) {
    return { text: "", stopAfter: true };
  }

  var markerIndex = normalized.search(NEWYORKER_END_MARKER_ANYWHERE_PATTERN);
  if (markerIndex === -1) {
    return { text: normalized, stopAfter: false };
  }

  var beforeMarker = normalizeText(normalized.slice(0, markerIndex));
  var afterMarker = normalizeText(normalized.slice(markerIndex + 1));
  if (afterMarker && countWords(afterMarker) > 30) {
    return { text: normalized, stopAfter: false };
  }

  return {
    text: beforeMarker,
    stopAfter: true
  };
}

function collectArticleBlockData(root) {
  const blocks = [];
  let endMarkerDetected = false;
  const candidates = root.querySelectorAll(BLOCK_SELECTOR);
  const newYorkerMarker = findNewYorkerEndMarker(root);

  for (const node of candidates) {
    if (!isProbablyVisible(node)) {
      continue;
    }
    if (isInsideBoilerplate(node, root)) {
      continue;
    }
    if (hasJunkLabel(node)) {
      continue;
    }

    let text = normalizeText(node.textContent);
    let shouldStopAfterBlock = false;
    if (newYorkerMarker) {
      if (node.contains(newYorkerMarker.node)) {
        const trimmed = trimNewYorkerBlockAtMarker(node.textContent || "");
        shouldStopAfterBlock = trimmed.stopAfter;
        if (!trimmed.text) {
          endMarkerDetected = true;
          break;
        }
        text = trimmed.text;
      } else if (newYorkerMarker.node.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        endMarkerDetected = true;
        break;
      }
    }

    if (!text) {
      if (shouldStopAfterBlock) {
        endMarkerDetected = true;
        break;
      }
      continue;
    }

    const words = countWords(text);
    if (words < 2) {
      continue;
    }

    if (/^H[2-4]$/.test(node.tagName) && JUNK_HEADING.test(text)) {
      continue;
    }

    if (looksLikeByline(text) && words < 15) {
      continue;
    }

    const density = linkDensity(node);
    if (density > 0.55 && words < 90) {
      continue;
    }

    blocks.push({ node, text, words });
    if (shouldStopAfterBlock) {
      endMarkerDetected = true;
      break;
    }
  }

  return { blocks, endMarkerDetected };
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

function collectArticleBlocks(root) {
  return collectArticleBlockData(root).blocks;
}

function collectArticleText(root) {
  return collectArticleBlocks(root)
    .map((block) => block.text)
    .join("\n\n");
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

function buildSerializableAnalysis(analysis) {
  const extraction = analysis.extraction;
  return {
    ok: true,
    pageTitle: analysis.pageTitle,
    url: analysis.url,
    words: extraction.words,
    paragraphs: extraction.paragraphs,
    confidence: confidenceLevel(extraction.words, extraction.paragraphs, extraction.score),
    rootTag: extraction.rootTag || extraction.root.tagName.toLowerCase(),
    extractionSource: extraction.source,
    countSource: extraction.countSource || extraction.source,
    rootSelector: extraction.rootSelector || null,
    adapterId: extraction.adapterId || null,
    debug: analysis.debug,
    generatedAt: analysis.generatedAt
  };
}

var cachedPageAnalysis = null;

function buildFallbackDebug(extraction, error) {
  return {
    decision: extraction && extraction.source === "metadata" ? "fallback-metadata" : "fallback-jsonld",
    chosen: summarizeExtractionForDebug(extraction),
    primary: null,
    progressSource: null,
    topAlternatives: error ? [{ source: "error", rootTag: "fallback", rootSelector: error }] : []
  };
}

function buildFallbackAnalysis(error) {
  const metadata = buildPreferredCountExtraction(0);
  const jsonLd = buildJsonLdExtraction();
  const extraction = metadata || jsonLd;

  if (!extraction) {
    return null;
  }

  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown analysis error";

  return {
    pageTitle: document.title || "",
    url: window.location.href,
    extraction,
    progressExtraction: null,
    debug: buildFallbackDebug(extraction, message),
    generatedAt: new Date().toISOString()
  };
}

function getPageAnalysis(forceRefresh) {
  if (!forceRefresh && cachedPageAnalysis && cachedPageAnalysis.url === window.location.href) {
    return cachedPageAnalysis;
  }

  try {
    const {
      node: primaryRoot,
      score: primaryScore,
      selector: primarySelector
    } = pickMainContentRoot();
    const { extraction, progressExtraction, debug } = chooseBestExtraction(
      primaryRoot,
      primaryScore,
      primarySelector
    );

    cachedPageAnalysis = {
      pageTitle: document.title || "",
      url: window.location.href,
      extraction,
      progressExtraction,
      debug,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    const fallback = buildFallbackAnalysis(error);
    if (!fallback) {
      throw error;
    }
    cachedPageAnalysis = fallback;
  }

  return cachedPageAnalysis;
}

function analyzePage(forceRefresh) {
  return buildSerializableAnalysis(getPageAnalysis(Boolean(forceRefresh)));
}

function getProgressExtraction(analysis) {
  if (!analysis) {
    return null;
  }

  if (isDomTrackableExtraction(analysis.progressExtraction)) {
    return analysis.progressExtraction;
  }
  if (isDomTrackableExtraction(analysis.extraction)) {
    return analysis.extraction;
  }
  return null;
}

function getElementForNode(node) {
  if (node instanceof Element) {
    return node;
  }

  if (node && node.parentElement instanceof Element) {
    return node.parentElement;
  }

  return null;
}

function isEditableTarget(node) {
  const element = getElementForNode(node);
  return Boolean(
    element &&
      element.closest(
        "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']"
      )
  );
}

function getCurrentSelectionRange() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!range || range.collapsed) {
    return null;
  }

  return range;
}

function getProgressPositionFromBlocks(blocks, range) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null;
  }

  let visibleWordsTotal = 0;
  for (const block of blocks) {
    visibleWordsTotal += block.words;
  }
  if (visibleWordsTotal <= 0) {
    return null;
  }

  let wordsThrough = 0;
  for (const block of blocks) {
    if (!(block.node instanceof Element) || !block.node.isConnected) {
      continue;
    }

    if (!block.node.contains(range.endContainer)) {
      wordsThrough += block.words;
      continue;
    }

    const partialRange = document.createRange();
    partialRange.selectNodeContents(block.node);
    partialRange.setEnd(range.endContainer, range.endOffset);
    wordsThrough += Math.min(block.words, countWords(partialRange.toString()));

    return {
      wordsThrough: Math.min(wordsThrough, visibleWordsTotal),
      visibleWordsTotal
    };
  }

  return null;
}

function getProgressPositionFromRoot(root, range) {
  if (!(root instanceof Element) || !root.contains(range.endContainer)) {
    return null;
  }

  const visibleWordsTotal = countWords(root.textContent);
  if (visibleWordsTotal <= 0) {
    return null;
  }

  const partialRange = document.createRange();
  partialRange.selectNodeContents(root);
  partialRange.setEnd(range.endContainer, range.endOffset);

  return {
    wordsThrough: Math.min(visibleWordsTotal, countWords(partialRange.toString())),
    visibleWordsTotal
  };
}

function getSelectionProgress(forceRefresh) {
  const range = getCurrentSelectionRange();
  if (!range) {
    return null;
  }

  if (isEditableTarget(range.startContainer) || isEditableTarget(range.endContainer)) {
    return null;
  }

  const selectionText = normalizeText(range.toString());
  const selectedWords = countWords(selectionText);
  if (selectedWords !== REQUIRED_SELECTION_WORDS) {
    return null;
  }

  const analysis = getPageAnalysis(Boolean(forceRefresh));
  const progressExtraction = getProgressExtraction(analysis);

  if (
    !progressExtraction ||
    !(progressExtraction.root instanceof Element) ||
    !progressExtraction.root.contains(range.startContainer) ||
    !progressExtraction.root.contains(range.endContainer)
  ) {
    return null;
  }

  let position = getProgressPositionFromBlocks(progressExtraction.blocks, range);
  if (!position) {
    position = getProgressPositionFromRoot(progressExtraction.root, range);
  }
  if (!position || position.visibleWordsTotal <= 0) {
    return null;
  }

  const ratio = Math.max(0, Math.min(1, position.wordsThrough / position.visibleWordsTotal));
  const totalWords = analysis.extraction.words;
  const wordsRead = Math.max(0, Math.min(totalWords, Math.round(totalWords * ratio)));
  const remainingWords = Math.max(0, totalWords - wordsRead);

  return {
    percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    totalWords,
    wordsRead,
    remainingWords
  };
}

function sendRuntimeMessage(message) {
  try {
    return chrome.runtime.sendMessage(message);
  } catch (_error) {
    return Promise.resolve(null);
  }
}

async function clearTabProgress() {
  await sendRuntimeMessage({ type: "CLEAR_TAB_PROGRESS" });
}

async function setTabProgress(progress) {
  await sendRuntimeMessage({
    type: "SET_TAB_PROGRESS",
    progress: {
      percent: progress.percent,
      totalWords: progress.totalWords,
      wordsRead: progress.wordsRead,
      remainingWords: progress.remainingWords,
      updatedAt: new Date().toISOString()
    }
  });
}

async function syncSelectionProgress(forceRefresh) {
  const progress = getSelectionProgress(forceRefresh);
  if (!progress) {
    await clearTabProgress();
    return null;
  }

  await setTabProgress(progress);
  return progress;
}

async function updateSelectionProgress(forceRefresh) {
  try {
    await syncSelectionProgress(forceRefresh);
  } catch (_error) {
    await clearTabProgress();
  }
}

var selectionProgressTimer = 0;
var selectionProgressNeedsRefresh = false;
var selectionProgressDelayMs = 80;

function clearSelectionProgressTimer() {
  if (selectionProgressTimer) {
    window.clearTimeout(selectionProgressTimer);
    selectionProgressTimer = 0;
  }
}

function scheduleSelectionProgressUpdate(forceRefresh, delayMs) {
  selectionProgressNeedsRefresh = selectionProgressNeedsRefresh || Boolean(forceRefresh);
  if (Number.isFinite(delayMs)) {
    selectionProgressDelayMs = Math.max(selectionProgressDelayMs, Math.round(delayMs));
  }
  clearSelectionProgressTimer();
  selectionProgressTimer = window.setTimeout(() => {
    const shouldRefresh = selectionProgressNeedsRefresh;
    selectionProgressNeedsRefresh = false;
    selectionProgressDelayMs = 80;
    selectionProgressTimer = 0;
    void updateSelectionProgress(shouldRefresh);
  }, selectionProgressDelayMs);
}

function onDocumentDoubleClick(event) {
  if (isEditableTarget(event.target)) {
    void clearTabProgress();
    return;
  }
  scheduleSelectionProgressUpdate(false, 120);
}

function onSelectionChange() {
  scheduleSelectionProgressUpdate(false, 80);
}

function onDocumentMouseUp(event) {
  if (isEditableTarget(event.target)) {
    void clearTabProgress();
    return;
  }
  scheduleSelectionProgressUpdate(false, 120);
}

function onDocumentKeyUp() {
  scheduleSelectionProgressUpdate(false, 120);
}

var onMessage = (message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "PING_ARTICLE_WORD_COUNTER") {
    sendResponse({ ok: true, version: CONTENT_SCRIPT_VERSION });
    return;
  }

  if (message.type === "GET_SELECTION_PROGRESS") {
    try {
      const forceRefresh = Boolean(message.forceRefresh);
      const progress = getSelectionProgress(forceRefresh);
      if (progress) {
        void setTabProgress(progress);
      } else {
        void clearTabProgress();
      }
      sendResponse({ ok: true, progress: progress || null });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unable to read the current selection."
      });
    }
    return;
  }

  if (message.type !== "GET_ARTICLE_WORD_COUNT") {
    return;
  }

  try {
    const forceRefresh = Boolean(message.forceRefresh);
    sendResponse(analyzePage(forceRefresh));
    scheduleSelectionProgressUpdate(forceRefresh);
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to analyze this page."
    });
  }
};

var CLEANUP_KEY = "__articleWordCounterCleanup__";
var previousCleanup = globalThis[CLEANUP_KEY];
if (typeof previousCleanup === "function") {
  previousCleanup();
}

chrome.runtime.onMessage.addListener(onMessage);
document.addEventListener("dblclick", onDocumentDoubleClick, true);
document.addEventListener("mouseup", onDocumentMouseUp, true);
document.addEventListener("keyup", onDocumentKeyUp, true);
document.addEventListener("selectionchange", onSelectionChange);
scheduleSelectionProgressUpdate(false);

globalThis[CLEANUP_KEY] = function cleanupArticleWordCounter() {
  chrome.runtime.onMessage.removeListener(onMessage);
  document.removeEventListener("dblclick", onDocumentDoubleClick, true);
  document.removeEventListener("mouseup", onDocumentMouseUp, true);
  document.removeEventListener("keyup", onDocumentKeyUp, true);
  document.removeEventListener("selectionchange", onSelectionChange);
  clearSelectionProgressTimer();
  cachedPageAnalysis = null;
};
})();
