const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const script = readFileSync(join(__dirname, "../contentScript.js"), "utf8");
const url = "https://www.rollingstone.com/feature/example/";
const paragraph = (id, words) => `<p id="${id}">${"word ".repeat(words).trim()}</p>`;
const article = [paragraph("first", 160), paragraph("middle", 220),
  paragraph("later", 200), paragraph("last", 180)];
const expectedWords = 760;

function fixture(wrapperAttributes = 'class="pmc-paywall"') {
  return `<main><div class="a-content"><div ${wrapperAttributes}>
    ${article[0]}
    <section class="brands-most-popular editors-pick-module">
      <h2>Editor's picks</h2>${paragraph("extra-one", 120)}
    </section>
    ${article[1]}
    <div class="advert">${paragraph("extra-two", 100)}</div>
    <section class="brands-most-popular recirculation-modules"><h2>Related</h2>${paragraph("extra-three", 100)}</section>
    ${article[2]}
    <div class="paywall-prompt">${paragraph("extra-four", 100)}</div>
    <section class="brands-most-popular recirculation-modules trending-in-article">
      <h2>Trending stories</h2><a href="/another-article"><h3>Another story headline</h3></a>${paragraph("extra-five", 100)}
    </section>
    ${article[3]}
  </div></div><div><h4>In this article tags</h4></div></main>
  <footer>${paragraph("footer", 100)}</footer>`;
}

function loadPage(t, html, pageUrl = url) {
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only" });
  let listener;
  dom.window.chrome = {
    runtime: {
      onMessage: { addListener: fn => { listener = fn; }, removeListener: () => {} },
      sendMessage: () => Promise.resolve({ ok: true })
    }
  };
  dom.window.eval(script);
  t.after(() => dom.window.close());
  return {
    window: dom.window,
    request(type) {
      let response;
      listener({ type, forceRefresh: true }, {}, value => { response = value; });
      assert.equal(response.ok, true, response.error);
      return response;
    }
  };
}

test("counts the full Rolling Stone body while excluding inserted promos", t => {
  const page = loadPage(t, fixture());
  const result = page.request("GET_ARTICLE_WORD_COUNT");
  assert.equal(result.words, expectedWords);
  assert.equal(result.paragraphs, 4);
  assert.equal(result.confidence, "High");
  assert.equal(result.extractionSource, "candidate");
});

test("reading progress reaches the final article word after related and trending modules", t => {
  const page = loadPage(t, fixture());
  const text = page.window.document.querySelector("#last").firstChild;
  const range = page.window.document.createRange();
  range.setStart(text, text.length - 4);
  range.setEnd(text, text.length);
  page.window.getSelection().addRange(range);
  assert.deepEqual({ ...page.request("GET_SELECTION_PROGRESS").progress },
    { percent: 100, totalWords: expectedWords, wordsRead: expectedWords, remainingWords: 0 });
});

test("the wrapper exception is scoped to Rolling Stone domains", t => {
  for (const host of ["example.com", "notrollingstone.com", "rollingstone.com.example.com"]) {
    const page = loadPage(t, fixture(), `https://${host}/article`);
    assert.equal(page.request("GET_ARTICLE_WORD_COUNT").words, 4);
  }
});

test("the wrapper exception also works on the bare Rolling Stone domain", t => {
  const page = loadPage(t, fixture(), "https://rollingstone.com/feature/example/");
  assert.equal(page.request("GET_ARTICLE_WORD_COUNT").words, expectedWords);
});

test("unrelated paywall containers remain excluded on Rolling Stone", t => {
  const page = loadPage(t, fixture().replace('class="a-content"', 'class="layout"'));
  assert.equal(page.request("GET_ARTICLE_WORD_COUNT").words, 4);
});

test("a known wrapper still respects other junk labels and hidden state", t => {
  for (const attributes of [
    'class="pmc-paywall promo"', 'class="pmc-paywall" hidden',
    'class="pmc-paywall" aria-hidden="true"', 'class="pmc-paywall" style="display:none"'
  ]) {
    const page = loadPage(t, fixture(attributes));
    assert.equal(page.request("GET_ARTICLE_WORD_COUNT").words, 4, attributes);
  }
});

test("ordinary article extraction remains intact", t => {
  const page = loadPage(t, `<article>${article.join("")}</article>`, "https://example.com/article");
  assert.equal(page.request("GET_ARTICLE_WORD_COUNT").words, expectedWords);
});

test("New Yorker paywall paragraphs and end marker remain supported", t => {
  const page = loadPage(t, `<article><p class="paywall">${"word ".repeat(300)}<span>♦</span></p>
    ${paragraph("after-end", 160)}</article>`, "https://www.newyorker.com/culture/example");
  const result = page.request("GET_ARTICLE_WORD_COUNT");
  assert.equal(result.words, 300);
  assert.equal(result.debug.decision, "newyorker-end-marker");
});
