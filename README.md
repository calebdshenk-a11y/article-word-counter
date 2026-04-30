# Article Word Counter (Browser Extension)

A lightweight Chrome/Edge extension that estimates the word count of the **main article body** on the current page and lets you **double-click any word** in the article to update the toolbar badge with your reading progress.

It tries to ignore:

- site headers and footers
- sidebars and navigation
- ad/promo blocks
- related/recommended sections

## Install in Chrome

This extension is not currently in the Chrome Web Store, so you install it manually from GitHub. No coding is required.

1. Click the green **Code** button on this GitHub page.
2. Click **Download ZIP**.
3. Unzip the downloaded file.
4. Open Chrome and go to `chrome://extensions`.
5. Turn on **Developer mode** in the top right.
6. Click **Load unpacked**.
7. Select the unzipped extension folder.

## Highlights

- estimates the main article word count instead of counting the whole page
- lets you double-click a word in the article to track exactly how far through the piece you are
- updates the extension badge with your reading progress for the current tab
- shows percent done, time left, and words remaining in the popup

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
2. Double-click any single word in the article body whenever you want to mark your place.
   - the toolbar badge updates to show your reading progress for that tab
3. Click the extension icon.
4. The popup shows:
   - article word count (rounded to nearest hundred; hover for exact count)
   - estimated reading time using your selected reading mode
   - extraction confidence
   - selected-word progress details (percent done, time left, words remaining)
5. On first open, confirm or customize your reading presets.
   - default presets are `Skim 325 WPM`, `Normal 250 WPM`, and `Deep 200 WPM`
   - after you save them once, the extension will keep using your presets until you change them
6. Click **Refresh Count** after page updates.
7. Click **Set Presets** any time you want to change your saved skim, normal, and deep speeds.
8. Use the **Skim**, **Normal**, and **Deep** buttons to switch the current article's time estimates.
9. Open the extension popup to see the matching time-left and remaining-word details for the selected word.

## Troubleshooting

- If you changed local files, click **Reload** on the extension card in `chrome://extensions`.
- The extension cannot run on restricted tabs like `chrome://` pages or the Chrome Web Store.
