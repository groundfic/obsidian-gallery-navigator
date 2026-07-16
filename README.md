# Gallery Navigator

A visual way to browse your Obsidian vault: a folder/tag tree on the left, a Pinterest-style **cover-image card wall** on the right. Designed as a visual alternative to list-based file explorers.

Interface available in **English** and **繁體中文** (follows your Obsidian language setting, with a manual override in settings).

## Features

### Card wall
- True JS masonry layout with lazy, chunked rendering (handles folders with thousands of files, mobile-friendly)
- Covers from `cover:` frontmatter, first embedded image, image files themselves, PDF first pages, and web page `og:image` for link notes
- Pin cards to top, per-card background colors, hover text preview, multi-select with batch move / delete / copy-wiki-links
- Link wall: click a card's link button to browse its outgoing links and backlinks as cards

### Navigation
- Folder tree with drag-to-reorder, custom colors, hide/unhide, favorites, and inline rename
- Bear-style nested tag tree with an "untagged" node
- Follow mode: opening a note reveals it in the tree and card wall
- Mobile: side-by-side panes with finger-following swipe navigation

### Full-text search
- Built-in BM25 index over all notes **and PDFs** (Chinese word segmentation + bigram fallback)
- Spotlight-style popup search (assignable hotkey) with thumbnails, highlighted matches, and context snippets
- `Shift+Enter` sends all results to the card wall
- PDF text is read from the [Text Extractor](https://github.com/scambier/obsidian-text-extractor) plugin's cache when available (optional dependency — file-name search works without it)

### Calendar sidebar
- Month view + day timeline fed by **Google Calendar ICS URLs** (read-only, multiple calendars with colors)
- Daily notes integration: shows notes created on each day, creates daily notes from a configurable template

### Extras (can be disabled individually)
- **Image peek**: Quick Look-style image preview with share/copy actions
- **Link cards**: bare URLs rendered as rich preview cards
- **Pinterest visual search** (experimental, off by default): reverse-image search from any cover. This uses an unofficial Pinterest endpoint and may stop working at any time — see the network disclosure below.

## Network use disclosure

This plugin makes network requests only for the features below. Nothing is collected, tracked, or sent anywhere else; there is no telemetry.

| Feature | What is sent | To where |
|---|---|---|
| Calendar | GET requests for the ICS URLs you configure | Your calendar provider (e.g. Google) |
| Link previews / link cards | GET requests for URLs found in your notes, to read `og:image`/metadata | The sites your notes link to |
| Pinterest visual search (optional, experimental) | The image you explicitly search with | `api.pinterest.com` (unofficial endpoint) |

All caches (link previews, calendar events, PDF thumbnails) are stored locally in the plugin folder.

## Install

Until this plugin is available in the community store, install manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/groundfic/obsidian-gallery-navigator/releases)
2. Copy them into `<your vault>/.obsidian/plugins/gallery-navigator/`
3. Enable **Gallery Navigator** in Settings → Community plugins

Or use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with this repository.

## Development

```bash
npm install
npm run dev     # esbuild watch
npm run build   # production bundle → main.js
```

Source lives in `src/` (`main.js` is the bundled artifact — don't edit it directly). UI strings use `src/i18n.js` — English text as keys, with a zh-TW dictionary.

## License

[MIT](LICENSE)
