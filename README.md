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

## Install from GitHub

1. Download this repository:
   - Click **Code > Download ZIP** on GitHub, then unzip it, or
   - Clone it with `git clone <repo-url>`
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the downloaded or cloned project folder.

## Use

1. Open any article page.
2. Click the extension icon.
3. The popup shows:
   - article word count (rounded to nearest hundred; hover for exact count)
   - estimated reading time using your selected reading mode
   - extraction confidence
   - selected-word progress details (percent done, time left, words remaining)
4. On first open, confirm or customize your reading presets.
   - default presets are `Skim 325 WPM`, `Normal 250 WPM`, and `Deep 200 WPM`
   - after you save them once, the extension will keep using your presets until you change them
5. Click **Refresh Count** after page updates.
6. Click **Set Presets** any time you want to change your saved skim, normal, and deep speeds.
7. Use the **Skim**, **Normal**, and **Deep** buttons to switch the current article's time estimates.
8. Double-click a single word in the article body to set the toolbar badge percentage for that tab.
9. Open the extension popup to see the matching time-left and remaining-word details for the selected word.

## Troubleshooting

- If you changed local files, click **Reload** on the extension card in `chrome://extensions`.
- The extension cannot run on restricted tabs like `chrome://` pages or the Chrome Web Store.
