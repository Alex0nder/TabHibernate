# Tab Hibernate

Chrome extension (Manifest V3) that reduces memory usage by suspending inactive tabs after a timeout or on demand, and saves URLs to bookmarks and local storage. The UI opens in the **Side Panel** when you click the extension icon.

- **Repository:** [github.com/Alex0nder/TabHibernate](https://github.com/Alex0nder/TabHibernate)

**Requirements:** Chrome 88+ with Manifest V3 support; Chrome 114+ recommended for Side Panel.

---

## Installation

1. Clone the repo or download the archive.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.

---

## Features

- **Inactivity timeout** — a tab is considered inactive after 5–60 minutes without interaction (configurable in the panel).
- **Two suspension modes:**
  - **Discard** — unloads the tab via Chrome API; reload on click.
  - **Placeholder** — redirects to the extension stub page with a **Restore** button to bring back the original URL.
- **Backup:** on suspend and via button — bookmarks in **Tab Backup / date** folder and data in `chrome.storage.local`.
- **Manual actions:** suspend current tab, suspend all, restore all, close all and save to history.
- **History:** “Closed and saved” list, export/import JSON, open selected or all tabs; history is cleared after “Open all”.
- **Badge on icon** — count of placeholder tabs plus history entries (suspended/saved).
- **Exclusions:** active tab, pinned, audible, `chrome://`, `chrome-extension://`, and incognito tabs are not suspended.

---

## Limitations

When a tab is suspended (discard or placeholder), the page is unloaded. **Unsaved form data and SPA state may be lost** — save important data beforehand.

---

## Project structure

| File | Purpose |
|------|---------|
| `manifest.json` | MV3, permissions, Side Panel, content script |
| `service_worker.js` | Timer, activity tracking, suspend, backup, badge |
| `content_script.js` | Sends activity (mouse, keyboard, scroll) to the service worker |
| `side_panel.html` / `popup.js` | Settings panel, buttons, counter |
| `popup.html` | Fallback popup (shared logic with side panel) |
| `history.html` / `history.js` | History page: export/import, list, open tabs |
| `suspended.html` / `suspended.js` | Stub page with Restore button |
| `theme.css` | Dark theme |
| `icons/` | Icons (check, select arrow) |
| `DEVELOPMENT.md` | Roadmap and development notes |

---

## License

MIT.
