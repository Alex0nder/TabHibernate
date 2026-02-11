/**
 * Popup: load/save settings, backup button, suspend-all, stats.
 * Handles lastError and retries when the service worker is waking up.
 */

const el = {
  enabled: document.getElementById('enabled'),
  timeout: document.getElementById('timeout'),
  mode: document.getElementById('mode'),
  backup: document.getElementById('backup'),
  suspendAll: document.getElementById('suspendAll'),
  restoreAll: document.getElementById('restoreAll'),
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
  if (!ts) return 'never';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min === 1) return '1 min ago';
  return `${min} min ago`;
}

async function refreshStats() {
  try {
    const res = await sendMessageWithRetry({ type: 'getStatus' });
    if (res && typeof res.suspendedToday === 'number') {
      el.stats.textContent = `Suspended today: ${res.suspendedToday}`;
    }
    if (res && el.statusLine) {
      const lastRun = res.lastAlarmRun || 0;
      const eligible = typeof res.eligibleTabCount === 'number' ? res.eligibleTabCount : 0;
      el.statusLine.textContent = `Last check: ${formatLastCheck(lastRun)} • Eligible tabs: ${eligible}`;
      if (lastRun && Date.now() - lastRun > 10 * 60 * 1000) {
        el.statusLine.textContent += ' (reload extension if needed)';
      }
    }
  } catch (e) {
    el.stats.textContent = 'Suspended today: —';
    if (el.statusLine) el.statusLine.textContent = 'No connection to extension. Open popup again.';
  }
}

el.enabled.addEventListener('change', saveSettings);
el.timeout.addEventListener('change', saveSettings);
el.mode.addEventListener('change', saveSettings);

el.backup.addEventListener('click', async () => {
  el.backup.disabled = true;
  el.backup.textContent = 'Saving…';
  try {
    const res = await sendMessageWithRetry({ type: 'backupNow' });
    const count = res && typeof res.count === 'number' ? res.count : 0;
    el.backup.textContent = count > 0 ? `Done (${count})` : 'Done';
    if (res && res.error) el.stats.textContent = res.error;
  } catch (e) {
    el.backup.textContent = 'Error';
    el.stats.textContent = 'Could not reach extension. Open popup again.';
  }
  setTimeout(() => {
    el.backup.textContent = 'Backup tabs now';
    el.backup.disabled = false;
    refreshStats();
  }, 2000);
});

if (el.suspendAll) {
  el.suspendAll.addEventListener('click', async () => {
    el.suspendAll.disabled = true;
    el.suspendAll.textContent = 'Suspending…';
    try {
      const res = await sendMessageWithRetry({ type: 'suspendAllNow' });
      const n = res && typeof res.suspended === 'number' ? res.suspended : 0;
      el.suspendAll.textContent = n > 0 ? `Suspended: ${n}` : 'Done';
      refreshStats();
    } catch (e) {
      el.suspendAll.textContent = 'Error';
    }
    setTimeout(() => {
      el.suspendAll.textContent = 'Suspend all tabs';
      el.suspendAll.disabled = false;
    }, 2000);
  });
}

if (el.restoreAll) {
  el.restoreAll.addEventListener('click', async () => {
    el.restoreAll.disabled = true;
    el.restoreAll.textContent = 'Restoring…';
    try {
      const res = await sendMessageWithRetry({ type: 'restoreAllSuspended' });
      const n = res && typeof res.restored === 'number' ? res.restored : 0;
      el.restoreAll.textContent = n > 0 ? `Restored: ${n}` : 'Done';
    } catch (e) {
      el.restoreAll.textContent = 'Error';
    }
    setTimeout(() => {
      el.restoreAll.textContent = 'Restore all tabs';
      el.restoreAll.disabled = false;
    }, 2000);
  });
}

loadSettings().then(refreshStats);
