/**
 * Popup: загрузка/сохранение настроек, кнопка бэкапа, отображение счётчика приостановок.
 * Учитывает lastError и повтор запроса при «спящем» Service Worker.
 */

const el = {
  enabled: document.getElementById('enabled'),
  timeout: document.getElementById('timeout'),
  mode: document.getElementById('mode'),
  backup: document.getElementById('backup'),
  suspendAll: document.getElementById('suspendAll'),
  stats: document.getElementById('stats'),
  statusLine: document.getElementById('statusLine'),
};

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings) {
    el.enabled.checked = settings.enabled !== false;
    el.timeout.value = String(settings.timeoutMinutes ?? 5);
    el.mode.value = settings.mode === 'placeholder' ? 'placeholder' : 'discard';
  }
}

function saveSettings() {
  const settings = {
    enabled: el.enabled.checked,
    timeoutMinutes: parseInt(el.timeout.value, 10) || 5,
    mode: el.mode.value === 'placeholder' ? 'placeholder' : 'discard',
  };
  chrome.storage.local.set({ settings });
}

function sendMessageWithRetry(msg, retries = 3) {
  return new Promise((resolve, reject) => {
    const trySend = (attempt) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          if (attempt < retries) {
            setTimeout(() => trySend(attempt + 1), 500);
          } else {
            reject(new Error(chrome.runtime.lastError.message));
          }
          return;
        }
        resolve(res);
      });
    };
    trySend(0);
  });
}

function formatLastCheck(ts) {
  if (!ts) return 'ещё не было';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'только что';
  if (min === 1) return '1 мин назад';
  return `${min} мин назад`;
}

async function refreshStats() {
  try {
    const res = await sendMessageWithRetry({ type: 'getStatus' });
    if (res && typeof res.suspendedToday === 'number') {
      el.stats.textContent = `Приостановлено сегодня: ${res.suspendedToday}`;
    }
    if (res && el.statusLine) {
      const lastRun = res.lastAlarmRun || 0;
      const eligible = typeof res.eligibleTabCount === 'number' ? res.eligibleTabCount : 0;
      el.statusLine.textContent = `Проверка: ${formatLastCheck(lastRun)} • Подходящих вкладок: ${eligible}`;
      if (lastRun && Date.now() - lastRun > 10 * 60 * 1000) {
        el.statusLine.textContent += ' (давно — перезагрузите расширение при необходимости)';
      }
    }
  } catch (e) {
    el.stats.textContent = 'Приостановлено сегодня: —';
    if (el.statusLine) el.statusLine.textContent = 'Нет связи с расширением. Откройте popup снова.';
  }
}

el.enabled.addEventListener('change', saveSettings);
el.timeout.addEventListener('change', saveSettings);
el.mode.addEventListener('change', saveSettings);

el.backup.addEventListener('click', async () => {
  el.backup.disabled = true;
  el.backup.textContent = 'Сохранение…';
  try {
    const res = await sendMessageWithRetry({ type: 'backupNow' });
    const count = res && typeof res.count === 'number' ? res.count : 0;
    el.backup.textContent = count > 0 ? `Готово (${count})` : 'Готово';
    if (res && res.error) el.stats.textContent = res.error;
  } catch (e) {
    el.backup.textContent = 'Ошибка';
    el.stats.textContent = 'Не удалось связаться с расширением. Попробуйте открыть popup снова.';
  }
  setTimeout(() => {
    el.backup.textContent = 'Бэкап вкладок сейчас';
    el.backup.disabled = false;
    refreshStats();
  }, 2000);
});

if (el.suspendAll) {
  el.suspendAll.addEventListener('click', async () => {
    el.suspendAll.disabled = true;
    el.suspendAll.textContent = 'Приостановка…';
    try {
      const res = await sendMessageWithRetry({ type: 'suspendAllNow' });
      const n = res && typeof res.suspended === 'number' ? res.suspended : 0;
      el.suspendAll.textContent = n > 0 ? `Приостановлено: ${n}` : 'Готово';
      refreshStats();
    } catch (e) {
      el.suspendAll.textContent = 'Ошибка';
    }
    setTimeout(() => {
      el.suspendAll.textContent = 'Приостановить все вкладки';
      el.suspendAll.disabled = false;
    }, 2000);
  });
}

loadSettings().then(refreshStats);
