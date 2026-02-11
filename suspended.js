/**
 * Страница-заглушка после режима Placeholder: показывает URL и кнопку «Восстановить».
 * Восстановление = переход на исходный URL; данные берутся из storage по tabId из query.
 */

const params = new URLSearchParams(window.location.search);
const tabIdParam = params.get('tabId');
const tabId = tabIdParam ? parseInt(tabIdParam, 10) : null;

const urlEl = document.getElementById('url');
const btn = document.getElementById('reload');

if (!tabId) {
  urlEl.textContent = 'Неизвестная вкладка';
  btn.disabled = true;
} else {
  chrome.runtime.sendMessage({ type: 'getRestoreData', tabId }, (data) => {
    if (data && data.url) {
      urlEl.textContent = data.url;
      urlEl.title = data.url;
      btn.onclick = () => {
        btn.disabled = true;
        chrome.runtime.sendMessage({ type: 'clearRestoreData', tabId });
        chrome.tabs.update(tabId, { url: data.url });
        window.close();
      };
    } else {
      urlEl.textContent = 'Данные восстановления недоступны';
      btn.disabled = true;
    }
  });
}
