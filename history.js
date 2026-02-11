/**
 * History page: list closedAndSaved + backup_* from storage, export to JSON file, import from file, open selected as tabs.
 */

const CLOSED_SAVED_MAX = 2000;

async function loadAll() {
  const raw = await chrome.storage.local.get(null);
  const closedAndSaved = Array.isArray(raw.closedAndSaved) ? raw.closedAndSaved : [];
  const backups = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('backup_') && Array.isArray(value)) backups[key.slice(7)] = value;
  }
  return { closedAndSaved, backups };
}

function renderClosed(listEl, items) {
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<li class="empty">No closed-and-saved tabs.</li>';
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.dataset.url = item.url || '';
    const date = item.savedAt ? new Date(item.savedAt).toLocaleString() : '—';
    li.innerHTML = `
      <input type="checkbox" class="cb-closed" data-url="${escapeAttr(item.url)}">
      <div>
        <div class="item-title" title="${escapeAttr(item.title || item.url)}">${escapeHtml(item.title || item.url || '—')}</div>
        <div class="item-url" title="${escapeAttr(item.url)}">${escapeHtml(item.url || '')}</div>
      </div>
      <span class="item-meta">${escapeHtml(date)}</span>
    `;
    listEl.appendChild(li);
  }
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
      <input type="checkbox" class="cb-backup" data-date="${escapeAttr(date)}">
      <div>
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
  const closedAndSaved = [...(Array.isArray(data.closedAndSaved) ? data.closedAndSaved : []), ...existing.closedAndSaved].slice(0, CLOSED_SAVED_MAX);
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

function init() {
  document.getElementById('exportBtn').addEventListener('click', () => exportData());
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importData(f);
    e.target.value = '';
  });
  document.getElementById('openSelected').addEventListener('click', openSelected);
  refresh();
  setInterval(refresh, 3000);
}

init();
