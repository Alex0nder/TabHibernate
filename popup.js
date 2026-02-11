/**
 * Popup: загрузка/сохранение настроек, кнопка бэкапа, отображение счётчика приостановок.
 */

const el = {
  enabled: document.getElementById('enabled'),
  timeout: document.getElementById('timeout'),
  mode: document.getElementById('mode'),
  backup: document.getElementById('backup'),
  stats: document.getElementById('stats'),
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

async function refreshStats() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getStats' }, (res) => {
      if (res && typeof res.suspendedToday === 'number') {
        el.stats.textContent = `Приостановлено сегодня: ${res.suspendedToday}`;
      }
      resolve();
    });
  });
}

el.enabled.addEventListener('change', saveSettings);
el.timeout.addEventListener('change', saveSettings);
el.mode.addEventListener('change', saveSettings);

el.backup.addEventListener('click', async () => {
  el.backup.disabled = true;
  el.backup.textContent = 'Сохранение…';
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'backupNow' }, (res) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(res);
      });
    });
    el.backup.textContent = 'Готово';
    setTimeout(() => {
      el.backup.textContent = 'Бэкап вкладок сейчас';
      el.backup.disabled = false;
    }, 1500);
  } catch (e) {
    el.backup.textContent = 'Ошибка';
    el.backup.disabled = false;
  }
});

loadSettings().then(refreshStats);
