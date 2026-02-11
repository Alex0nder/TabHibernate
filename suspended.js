/**
 * Placeholder page: показывает URL и кнопку Restore.
 * Сначала читает из storage; при потере данных (обновление/переустановка) использует fallback из query (param u).
 */

const params = new URLSearchParams(window.location.search);
const tabIdParam = params.get('tabId');
const tabId = tabIdParam ? parseInt(tabIdParam, 10) : null;
const fallbackUrl = params.get('u') || '';

const urlEl = document.getElementById('url');
const btn = document.getElementById('reload');

function showError(msg) {
  urlEl.textContent = msg;
  if (btn) btn.disabled = true;
}

function isRestorableUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://'));
}

function showUrlAndRestore(url) {
  if (!url || !isRestorableUrl(url)) {
    showError('Restore data unavailable');
    return;
  }
  urlEl.innerHTML = '';
  const link = document.createElement('a');
  link.href = url;
  link.textContent = url;
  link.title = url;
  link.target = '_blank';
  link.rel = 'noopener';
  urlEl.appendChild(link);
  if (btn) btn.onclick = () => restore(url);
}

// Restore: загрузить URL в этой вкладке. getCurrent() нужен после перезапуска браузера (tabId в URL устарел).
function restore(url) {
  btn.disabled = true;
  const key = `suspended_${tabId}`;
  chrome.storage.local.remove(key);
  chrome.tabs.getCurrent((tab) => {
    const targetId = tab ? tab.id : tabId;
    chrome.tabs.update(targetId, { url }).then(() => {}).catch((e) => {
      console.warn('[TabHibernate] restore failed', e);
      btn.disabled = false;
    });
  });
}

if (!tabId) {
  showError('Unknown tab');
} else {
  const key = `suspended_${tabId}`;
  chrome.storage.local.get(key, (data) => {
    if (chrome.runtime.lastError) {
      if (isRestorableUrl(fallbackUrl)) {
        showUrlAndRestore(fallbackUrl);
      } else {
        showError('Could not load restore data');
      }
      return;
    }
    const item = data[key];
    if (item && item.url && isRestorableUrl(item.url)) {
      showUrlAndRestore(item.url);
    } else if (isRestorableUrl(fallbackUrl)) {
      showUrlAndRestore(fallbackUrl);
    } else {
      showError('Restore data unavailable');
    }
  });
}
