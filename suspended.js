/**
 * Страница-заглушка после режима Placeholder: показывает URL и кнопку «Восстановить».
 * Читает данные из chrome.storage.local напрямую — не зависит от Service Worker (работает даже если SW спит).
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

function restore(url) {
  btn.disabled = true;
  const key = `suspended_${tabId}`;
  chrome.storage.local.remove(key);
  chrome.tabs.update(tabId, { url }).then(() => {
    window.close();
  }).catch((e) => {
    console.warn('[TabHibernate] restore failed', e);
    btn.disabled = false;
  });
}

if (!tabId) {
  showError('Неизвестная вкладка');
} else {
  const key = `suspended_${tabId}`;
  chrome.storage.local.get(key, (data) => {
    if (chrome.runtime.lastError) {
      showError('Ошибка доступа к данным');
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
      showError('Данные восстановления недоступны');
    }
  });
}
