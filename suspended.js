/**
 * Placeholder page after Placeholder mode: shows URL and Restore button.
 * Reads from chrome.storage.local so it works even when the service worker is idle.
 */

const params = new URLSearchParams(window.location.search);
const tabIdParam = params.get('tabId');
const tabId = tabIdParam ? parseInt(tabIdParam, 10) : null;

const urlEl = document.getElementById('url');
const btn = document.getElementById('reload');

function showError(msg) {
  urlEl.textContent = msg;
  if (btn) btn.disabled = true;
}

// Restore: load original URL in this same tab (no new tab, no window.close).
function restore(url) {
  btn.disabled = true;
  const key = `suspended_${tabId}`;
  chrome.storage.local.remove(key);
  chrome.tabs.update(tabId, { url }).then(() => {
    // Tab navigates to url; this page is replaced. Do not close the tab.
  }).catch((e) => {
    console.warn('[TabHibernate] restore failed', e);
    btn.disabled = false;
  });
}

if (!tabId) {
  showError('Unknown tab');
} else {
  const key = `suspended_${tabId}`;
  chrome.storage.local.get(key, (data) => {
    if (chrome.runtime.lastError) {
      showError('Could not load restore data');
      return;
    }
    const item = data[key];
    if (item && item.url) {
      urlEl.innerHTML = '';
      const link = document.createElement('a');
      link.href = item.url;
      link.textContent = item.url;
      link.title = item.url;
      link.target = '_blank';
      link.rel = 'noopener';
      urlEl.appendChild(link);
      if (btn) btn.onclick = () => restore(item.url);
    } else {
      showError('Restore data unavailable');
    }
  });
}
