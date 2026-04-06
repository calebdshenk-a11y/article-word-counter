# Article Word Counter (Browser Extension)

A lightweight Chrome/Edge extension that estimates the word count of the **main article body** on the current page while trying to ignore:

- site headers and footers
- sidebars and navigation
- ad/promo blocks
- related/recommended sections

## Why this is accurate

The content script does not count the whole page. It:

1. Scores page sections by text quality and structure.
2. Picks the most article-like container.
3. Filters out boilerplate nodes and high-link-density blocks (common in nav/related lists).
4. Counts words using `Intl.Segmenter` when available for better tokenization.

## Install locally

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   `/Users/calebshenk/Desktop/Files/Codex projects/article word counter`

## Use

1. Open any article page.
2. Click the extension icon.
3. The popup shows:
   - article word count (rounded to nearest hundred; hover for exact count)
   - estimated reading time (default: `500 WPM`, rounded to nearest minute)
   - extraction confidence
   - selected-word progress details (percent done, time left, words remaining)
4. Click **Refresh Count** after page updates.
5. Click **Set Speed** to update reading speed for the current tab (new tabs default to `500 WPM`).
6. Double-click a single word in the article body to set the toolbar badge percentage for that tab.
7. Open the extension popup to see the matching time-left and remaining-word details for the selected word.

## Troubleshooting

- If you changed local files, click **Reload** on the extension card in `chrome://extensions`.
- The extension cannot run on restricted tabs like `chrome://` pages or the Chrome Web Store.
