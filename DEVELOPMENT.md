# Tab Hibernate — Development roadmap

Goal: stable, predictable behavior under long runs and after the service worker sleeps.

---

## 1. Stability (high priority)

| Task | Why |
|------|-----|
| **Restore state on every alarm run** | After SW sleep, in-memory state is lost; without restoring `lastActivityByTab` from storage, tabs can be treated as inactive and suspended in bulk. |
| **Throttle lastActivity writes to storage** | Frequent `persistLastActivity()` on every mouse move adds load and can hit storage limits. Throttle to once every 3–5 sec. |
| **Error handling in onMessage** | Wrap async handlers in try/catch and always call `sendResponse`, or popup/suspended may hang. |
| **Mark new tabs as active** | Subscribe to `chrome.tabs.onCreated` so new tabs are not treated as inactive before first focus. |
| **Suspended page independent of SW** | Read restore data from `chrome.storage.local` in suspended.js so the page works when the SW is idle. |
| **Prune lastActivityByTab** | Remove entries for closed tab IDs to avoid unbounded storage growth. |

---

## 2. API and edge cases

| Task | Why |
|------|-----|
| **Check tab exists before discard/update** | Use `chrome.tabs.get(tabId)` first to avoid “tab not found” on rapid close. |
| **Storage quotas** | Cap backup history (e.g. keep last 30 days for `backup_YYYY-MM-DD`). |
| **Bookmark creation limits** | With hundreds of tabs, create bookmarks in batches or with delay and handle failures. |
| **Alarm when extension disabled** | Keep the alarm when `enabled: false` and simply skip suspend in `onAlarmCheck`. Already done. |

---

## 3. UX and feedback

| Task | Why |
|------|-----|
| **Popup: SW availability** | Retry sendMessage once or twice with a short delay, or show “Refresh”, when popup opens after long idle. |
| **Popup: lastError handling** | Check `chrome.runtime.lastError` in all sendMessage callbacks and show a short message on failure. |
| **Badge with count** | Optionally show suspended-today count on the icon. |
| **First-suspend notification** | Optionally notify once that the extension ran (with “don’t show again”). |

---

## 4. Future (optional)

| Task | Why |
|------|-----|
| **Site whitelist** | Do not suspend selected domains (e.g. mail, messengers). |
| **Exclude tabs with unsaved forms** | Not reliably detectable without page injection; document the limitation only. |
| **Suspend in incognito** | Optional setting. |
| **Export/import settings** | Backup settings as JSON. |
| **Configurable check interval** | Currently 1 min; make it 1/2/5 min with a note about battery. |

---

## 5. Code quality

| Task | Why |
|------|-----|
| **Consistent log prefix** | Use `[TabHibernate]` for filtering in chrome://extensions → Service worker → Inspect. |
| **Storage versioning** | Add `storageVersion`; migrate old keys on extension update if needed. |
| **Comments for Chrome quirks** | E.g. alarm may fire delayed after SW wake; content script not injected in chrome://. |

---

## Already implemented

- Restore `lastActivityByTab` at the start of `onAlarmCheck`.
- Throttle `persistLastActivity` (at most once per 4 sec).
- Async message handlers with try/catch and guaranteed `sendResponse`.
- `tabs.onCreated` — new tabs marked active.
- Suspended page reads from `chrome.storage.local` directly.
- Prune stale tab IDs on each alarm run.
