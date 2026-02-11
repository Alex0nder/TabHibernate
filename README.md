# Tab Hibernate

**Chrome extension (Manifest V3)** that reduces memory usage by automatically suspending inactive tabs after a timeout (5–15 min), saving their URLs to bookmarks and local storage. Two modes: **Discard** (unload tab) and **Placeholder** (stub page with “Restore” button). Manual “Suspend all tabs” and “Backup tabs now” are available.

- Repository: [github.com/Alex0nder/TabHibernate](https://github.com/Alex0nder/TabHibernate)

**Requirements:** Chrome with Manifest V3 support (Chrome 88+).

## Installation

1. Clone the repo or download the archive.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.

## Features

- **Inactivity timeout:** a tab is considered inactive after no interaction for 5 min (configurable in popup: 5 / 10 / 15 min).
- **Two suspension modes:**
  - **Discard** — `chrome.tabs.discard(tabId)` (tab is unloaded; clicking reloads it).
  - **Placeholder** — redirect to extension stub page with a “Restore” button for the original URL.
- **Backup:** on suspend and via “Backup tabs now” — bookmarks in **Tab Backup / YYYY-MM-DD** and JSON in `chrome.storage.local`.
- **Manual suspend:** “Suspend all tabs” button in the popup.
- **Exclusions:** active tab, pinned, audible, `chrome://`, `chrome-extension://`, and incognito tabs are not suspended.

## Limitations

- When a tab is suspended (discard or placeholder), the page is unloaded. **Unsaved form data and SPA state may be lost** — use save/autosave on important pages.

## Structure

- `manifest.json` — MV3, permissions, background, content_script.
- `service_worker.js` — alarm timer, activity tracking, suspend and backup logic.
- `content_script.js` — reports activity (mousemove, keydown, scroll) to the service worker.
- `popup.html` / `popup.js` — settings, backup, suspend-all, stats.
- `theme.css` — dark minimal theme.
- `suspended.html` / `suspended.js` — Placeholder stub page with “Restore” button.
- `DEVELOPMENT.md` — roadmap and stability notes.

## License

MIT.
