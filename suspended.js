/**
 * Placeholder page: показывает URL и кнопку Restore.
 * Restore по кнопке или по клику по фону/карточке (кроме клика по ссылке — там открытие в новой вкладке).
 */

const params = new URLSearchParams(window.location.search);
const tabIdParam = params.get('tabId');
const tabId = tabIdParam ? parseInt(tabIdParam, 10) : null;
const fallbackUrl = params.get('u') || '';

const urlEl = document.getElementById('url');
const btn = document.getElementById('reload');
const pageFaviconEl = document.getElementById('pageFavicon');
const pageTitleEl = document.getElementById('pageTitle');

/** Текущий URL для восстановления (если есть) — используется и кнопкой, и кликом по фону. */
let currentRestoreUrl = null;

/** Домен из URL для запроса favicon (только http(s)). */
function getDomainForFavicon(url) {
  try {
    const u = new URL(url);
    return u.hostname || '';
  } catch (e) {
    return '';
  }
}

/** URL иконки по домену (внешний сервис; при ошибке загрузки иконка скрывается). */
const FAVICON_BASE = 'https://www.google.com/s2/favicons?sz=32&domain=';

function showError(msg) {
  urlEl.textContent = msg;
  if (btn) btn.disabled = true;
}

function isRestorableUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://'));
}

/** Показать заголовок страницы и favicon, затем URL и кнопку Restore. */
function showUrlAndRestore(url, title) {
  if (!url || !isRestorableUrl(url)) {
    showError('Restore data unavailable');
    return;
  }
  currentRestoreUrl = url;
  const displayTitle = (title && String(title).trim()) || url || '—';
  if (pageTitleEl) pageTitleEl.textContent = displayTitle;

  if (pageFaviconEl) {
    const domain = getDomainForFavicon(url);
    if (domain && (url.startsWith('http://') || url.startsWith('https://'))) {
      pageFaviconEl.hidden = true;
      pageFaviconEl.onerror = () => { pageFaviconEl.hidden = true; };
      pageFaviconEl.onload = () => { pageFaviconEl.hidden = false; };
      pageFaviconEl.src = FAVICON_BASE + encodeURIComponent(domain);
    } else {
      pageFaviconEl.hidden = true;
    }
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
  if (!url || !isRestorableUrl(url)) return;
  if (btn) btn.disabled = true;
  const key = `suspended_${tabId}`;
  chrome.storage.local.remove(key);
  chrome.tabs.getCurrent((tab) => {
    const targetId = tab ? tab.id : tabId;
    chrome.tabs.update(targetId, { url }).then(() => {}).catch((e) => {
      console.warn('[TabHibernate] restore failed', e);
      if (btn) btn.disabled = false;
    });
  });
}

// Клик по фону или по карточке — восстановить вкладку (кнопка и ссылка обрабатываются сами).
document.body.addEventListener('click', (e) => {
  if (!currentRestoreUrl) return;
  if (e.target.closest('a') || e.target.closest('button')) return;
  e.preventDefault();
  restore(currentRestoreUrl);
});

if (!tabId) {
  showError('Unknown tab');
} else {
  const key = `suspended_${tabId}`;
  chrome.storage.local.get(key, (data) => {
    if (chrome.runtime.lastError) {
      if (isRestorableUrl(fallbackUrl)) {
        showUrlAndRestore(fallbackUrl, '');
      } else {
        showError('Could not load restore data');
      }
      return;
    }
    const item = data[key];
    if (item && item.url && isRestorableUrl(item.url)) {
      showUrlAndRestore(item.url, item.title);
    } else if (isRestorableUrl(fallbackUrl)) {
      showUrlAndRestore(fallbackUrl, '');
    } else {
      showError('Restore data unavailable');
    }
  });
}
