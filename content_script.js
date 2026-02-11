/**
 * Content script: отправляет в service worker сообщения об активности пользователя
 * (mousemove, keydown), чтобы таб не считался неактивным.
 * Не инжектируется в chrome:// и chrome-extension:// (исключено в manifest).
 */

const REPORT_THROTTLE_MS = 2000;
let lastReport = 0;

function reportActivity() {
  const now = Date.now();
  if (now - lastReport < REPORT_THROTTLE_MS) return;
  lastReport = now;
  chrome.runtime.sendMessage({ type: 'activity' }).catch(() => {});
}

document.addEventListener('mousemove', reportActivity, { passive: true });
document.addEventListener('keydown', reportActivity, { passive: true });
document.addEventListener('scroll', reportActivity, { passive: true });
