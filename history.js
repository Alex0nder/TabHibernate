/**
 * History page: list closedAndSaved + backup_* from storage, export to JSON file, import from file, open selected as tabs.
 * Лимит closedSavedMax запрашивается у service worker (единый источник — service_worker.js).
 */

async function loadAll() {
  const raw = await chrome.storage.local.get(null);
  const closedAndSaved = Array.isArray(raw.closedAndSaved) ? raw.closedAndSaved : [];
  const backups = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('backup_') && Array.isArray(value)) backups[key.slice(7)] = value;
  }
  return { closedAndSaved, backups };
}

/** Рендер списка «Closed and saved» + показ/скрытие строки «Выбрать все» и привязка логики */
function renderClosed(listEl, items) {
  const selectAllRow = document.getElementById('selectAllRow');
  const selectAllCb = document.getElementById('selectAllClosed');
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<li class="empty">No closed-and-saved tabs.</li>';
    if (selectAllRow) selectAllRow.style.display = 'none';
    return;
  }
  if (selectAllRow) selectAllRow.style.display = 'flex';
  for (const item of items) {
    const li = document.createElement('li');
    li.dataset.url = item.url || '';
    const date = item.savedAt ? new Date(item.savedAt).toLocaleString() : '—';
    li.innerHTML = `
      <span class="checkbox-wrap">
        <input type="checkbox" class="cb-closed" data-url="${escapeAttr(item.url)}">
        <span class="checkbox-box" aria-hidden="true"></span>
      </span>
      <div class="item-content">
        <div class="item-title" title="${escapeAttr(item.title || item.url)}">${escapeHtml(item.title || item.url || '—')}</div>
        <div class="item-url" title="${escapeAttr(item.url)}">${escapeHtml(item.url || '')}</div>
      </div>
      <span class="item-meta">${escapeHtml(date)}</span>
    `;
    listEl.appendChild(li);
  }
  bindSelectAll(listEl, selectAllCb);
}

/** Связка чекбокса «Выбрать все» с чекбоксами строк: один клик выделяет/снимает все; при изменении строк обновляем состояние */
function bindSelectAll(listEl, selectAllCb) {
  if (!selectAllCb) return;
  const checkboxes = () => listEl.querySelectorAll('.cb-closed');
  const updateSelectAllState = () => {
    const cbs = checkboxes();
    const n = cbs.length;
    const checked = Array.from(cbs).filter((cb) => cb.checked).length;
    selectAllCb.checked = n > 0 && checked === n;
    selectAllCb.indeterminate = checked > 0 && checked < n;
  };
  selectAllCb.checked = false;
  selectAllCb.indeterminate = false;
  selectAllCb.removeEventListener('change', window.__selectAllHandler);
  window.__selectAllHandler = () => {
    const checked = selectAllCb.checked;
    checkboxes().forEach((cb) => { cb.checked = checked; });
  };
  selectAllCb.addEventListener('change', window.__selectAllHandler);
  listEl.addEventListener('change', (e) => {
    if (e.target.classList.contains('cb-closed')) updateSelectAllState();
  });
}

function renderBackups(listEl, backups) {
  listEl.innerHTML = '';
  const dates = Object.keys(backups).sort().reverse();
  if (!dates.length) {
    listEl.innerHTML = '<li class="empty">No backup dates.</li>';
    return;
  }
  for (const date of dates) {
    const items = backups[date];
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="checkbox-wrap">
        <input type="checkbox" class="cb-backup" data-date="${escapeAttr(date)}">
        <span class="checkbox-box" aria-hidden="true"></span>
      </span>
      <div class="item-content">
        <div class="item-title">${escapeHtml(date)}</div>
        <div class="item-url">${items.length} tab(s)</div>
      </div>
      <span class="item-meta"></span>
    `;
    listEl.appendChild(li);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
function escapeAttr(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function refresh() {
  const data = await loadAll();
  window.__backupsCache = data;
  renderClosed(document.getElementById('closedList'), data.closedAndSaved);
  renderBackups(document.getElementById('backupList'), data.backups);
}

function getSelectedUrls() {
  const urls = [];
  document.querySelectorAll('.cb-closed:checked').forEach((cb) => {
    const u = cb.dataset.url;
    if (u) urls.push(u);
  });
  document.querySelectorAll('.cb-backup:checked').forEach((cb) => {
    const date = cb.dataset.date;
    if (!date) return;
    const backupData = window.__backupsCache?.backups?.[date];
    if (Array.isArray(backupData)) backupData.forEach((item) => item.url && urls.push(item.url));
  });
  return [...new Set(urls)];
}

async function openSelected() {
  const urls = getSelectedUrls();
  if (!urls.length) return alert('Select at least one item.');
  for (const url of urls) {
    try { await chrome.tabs.create({ url }); } catch (e) { console.warn(e); }
  }
}

/** Открыть все страницы из «Closed and saved» в новых вкладках; после открытия — очистить историю. */
async function openAll() {
  const items = window.__backupsCache?.closedAndSaved;
  if (!Array.isArray(items) || !items.length) return alert('No closed-and-saved tabs.');
  const urls = items.map((x) => x.url).filter(Boolean);
  if (!urls.length) return alert('No URLs to open.');
  for (const url of urls) {
    try { await chrome.tabs.create({ url }); } catch (e) { console.warn(e); }
  }
  await chrome.storage.local.set({ closedAndSaved: [] });
  if (window.__backupsCache) window.__backupsCache.closedAndSaved = [];
  await refresh();
}

function exportData() {
  const data = {
    closedAndSaved: window.__backupsCache?.closedAndSaved ?? [],
    backups: window.__backupsCache?.backups ?? {},
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `tab-hibernate-backup-${new Date().toISOString().slice(0, 10)}.json`;
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}

async function importData(file) {
  const text = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Read failed'));
    r.readAsText(file, 'UTF-8');
  });
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    alert('Invalid JSON file.');
    return;
  }
  const existing = await loadAll();
  const maxClosed = window.__closedSavedMax ?? 2000;
  const closedAndSaved = [...(Array.isArray(data.closedAndSaved) ? data.closedAndSaved : []), ...existing.closedAndSaved].slice(0, maxClosed);
  const backups = { ...existing.backups };
  if (data.backups && typeof data.backups === 'object') {
    for (const [date, list] of Object.entries(data.backups)) {
      if (!Array.isArray(list)) continue;
      const key = `backup_${date}`;
      const current = backups[date] || [];
      const seen = new Set(current.map((x) => x.url));
      for (const item of list) {
        if (item && item.url && !seen.has(item.url)) {
          current.push({ url: item.url, title: item.title || item.url, ts: item.ts || Date.now() });
          seen.add(item.url);
        }
      }
      backups[date] = current;
    }
  }
  const toSet = { closedAndSaved };
  for (const [date, list] of Object.entries(backups)) toSet[`backup_${date}`] = list;
  await chrome.storage.local.set(toSet);
  window.__backupsCache = { closedAndSaved, backups };
  await refresh();
  alert('Import done.');
}

async function init() {
  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getConstants' }, resolve);
    });
    if (res && typeof res.closedSavedMax === 'number') {
      window.__closedSavedMax = res.closedSavedMax;
    } else {
      window.__closedSavedMax = 2000;
    }
  } catch (e) {
    window.__closedSavedMax = 2000;
  }
  document.getElementById('exportBtn').addEventListener('click', () => exportData());
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importData(f);
    e.target.value = '';
  });
  document.getElementById('openSelected').addEventListener('click', openSelected);
  document.getElementById('openAllBtn').addEventListener('click', openAll);
  refresh();
  setInterval(refresh, 3000);
}

init();
