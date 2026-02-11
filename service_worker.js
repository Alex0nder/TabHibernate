/**
 * Tab Hibernate — Service Worker (MV3)
 * Управляет таймером неактивности, режимами suspend (discard/placeholder) и бэкапами вкладок.
 * Состояние переживает sleep/restart за счёт chrome.storage и chrome.alarms.
 */

const ALARM_CHECK_NAME = 'tabHibernateCheck';
const ALARM_CHECK_PERIOD_MINUTES = 1;
const INACTIVITY_MINUTES = 5;
const SUSPENDED_PAGE_PATH = '/suspended.html';

// ——— Хранение последней активности по tabId (в памяти + синхронизация при сообщениях)
// При перезапуске SW восстанавливаем из storage только при первом запросе активности.
let lastActivityByTab = new Map();

async function getStoredState() {
  const raw = await chrome.storage.local.get(['lastActivityByTab', 'settings', 'suspendedToday', 'suspendedTodayDate']);
  if (raw.lastActivityByTab && typeof raw.lastActivityByTab === 'object') {
    lastActivityByTab = new Map(Object.entries(raw.lastActivityByTab));
  }
  return raw;
}

async function persistLastActivity() {
  const obj = Object.fromEntries(lastActivityByTab);
  await chrome.storage.local.set({ lastActivityByTab: obj });
}

function getExtensionOrigin() {
  return chrome.runtime.getURL('').replace(/\/$/, '');
}

function isSuspendedPlaceholderUrl(url) {
  const origin = getExtensionOrigin();
  return url && url.startsWith(origin) && url.includes('suspended.html');
}

/**
 * Таб нельзя суспендить: активный, закреплённый, со звуком, системный, инкогнито, уже placeholder.
 * ВАЖНО: Discard и Placeholder оба приводят к выгрузке страницы. Несохранённые формы и состояние
 * SPA (например, ввод в полях, несохранённые черновики) будут потеряны — это ограничение Chrome API.
 */
async function isTabEligibleForSuspend(tab) {
  if (!tab || !tab.id) return false;
  if (tab.active) return false;
  if (tab.pinned) return false;
  if (tab.audible) return false;
  if (tab.incognito) return false;
  const u = (tab.url || '').toLowerCase();
  if (u.startsWith('chrome://') || u.startsWith('chrome-extension://')) return false;
  if (isSuspendedPlaceholderUrl(tab.url)) return false; // избегаем рекурсии и повторного suspend
  return true;
}

/** Достаём настройки из storage (с дефолтами). */
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    enabled: settings?.enabled !== false,
    timeoutMinutes: settings?.timeoutMinutes ?? INACTIVITY_MINUTES,
    mode: (settings?.mode === 'placeholder' ? 'placeholder' : 'discard'),
    ...settings,
  };
}

/** Обновляем счётчик "приостановлено сегодня" (по календарной дате). */
async function incrementSuspendedToday() {
  const today = new Date().toISOString().slice(0, 10);
  const { suspendedToday = 0, suspendedTodayDate } = await chrome.storage.local.get(['suspendedToday', 'suspendedTodayDate']);
  const count = suspendedTodayDate === today ? suspendedToday + 1 : 1;
  await chrome.storage.local.set({ suspendedToday: count, suspendedTodayDate: today });
}

/** Единая точка: пометить таб как активный по действию пользователя. */
function markTabActive(tabId) {
  const now = Date.now();
  lastActivityByTab.set(tabId, now);
  persistLastActivity(); // fire-and-forget
}

/** Проверка: прошло ли timeout минут с последней активности. */
function isTabInactive(tabId, timeoutMinutes) {
  const last = lastActivityByTab.get(tabId);
  if (last == null) return true; // никогда не видели активность — считаем неактивным после таймаута
  return (Date.now() - last) >= timeoutMinutes * 60 * 1000;
}

/** Режим Discard: сбрасываем таб через Chrome API. */
async function suspendDiscard(tabId) {
  try {
    await chrome.tabs.discard(tabId);
    await incrementSuspendedToday();
    return true;
  } catch (e) {
    console.warn('[TabHibernate] discard failed', tabId, e);
    return false;
  }
}

/** Режим Placeholder: сохраняем url+title, редирект на suspended.html; страница сама восстановит по кнопке. */
async function suspendPlaceholder(tabId, url, title) {
  const origin = getExtensionOrigin();
  const restoreKey = `suspended_${tabId}`;
  await chrome.storage.local.set({
    [restoreKey]: { url: url || '', title: title || '', tabId },
  });
  const params = new URLSearchParams({ tabId: String(tabId) });
  const suspendedUrl = `${origin}${SUSPENDED_PAGE_PATH}?${params.toString()}`;
  try {
    await chrome.tabs.update(tabId, { url: suspendedUrl });
    await incrementSuspendedToday();
    return true;
  } catch (e) {
    console.warn('[TabHibernate] placeholder redirect failed', tabId, e);
    await chrome.storage.local.remove(restoreKey);
    return false;
  }
}

/** Собрать все табы, подходящие под бэкап (то же правило, что и для suspend, но без учёта времени). */
async function getEligibleTabsForBackup() {
  const tabs = await chrome.tabs.query({});
  const eligible = [];
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    const u = (tab.url || '').toLowerCase();
    if (u.startsWith('chrome://') || u.startsWith('chrome-extension://')) continue;
    if (tab.incognito) continue;
    eligible.push({ id: tab.id, url: tab.url, title: tab.title || tab.url });
  }
  return eligible;
}

/** Создать или получить папку закладок "Tab Backup / YYYY-MM-DD" (родитель "Tab Backup", дочерняя — дата). */
async function getOrCreateBackupFolder() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];

  const findFolder = (nodes, title) => {
    if (!nodes) return null;
    for (const n of nodes) {
      if (n.title === title) return n;
      const inChild = findFolder(n.children, title);
      if (inChild) return inChild;
    }
    return null;
  };

  let tabBackupRoot = findFolder(root.children, 'Tab Backup');
  if (!tabBackupRoot) {
    const created = await chrome.bookmarks.create({ parentId: root.id, title: 'Tab Backup' });
    tabBackupRoot = { id: created.id, children: [] };
  }
  const dateFolder = findFolder([tabBackupRoot], dateStr) || (tabBackupRoot.children && tabBackupRoot.children.find((c) => c.title === dateStr));
  if (dateFolder && dateFolder.id) return dateFolder.id;
  const created = await chrome.bookmarks.create({ parentId: tabBackupRoot.id, title: dateStr });
  return created.id;
}

/** Бэкап: закладки + JSON в storage; дубликаты URL в одной пачке пропускаем. */
async function runBackup(source = 'manual') {
  const tabs = await getEligibleTabsForBackup();
  const seen = new Set();
  const unique = tabs.filter((t) => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });
  if (unique.length === 0) return { count: 0, folderId: null };

  const folderId = await getOrCreateBackupFolder();
  for (const t of unique) {
    try {
      await chrome.bookmarks.create({ parentId: folderId, title: (t.title || t.url).slice(0, 255), url: t.url });
    } catch (e) {
      console.warn('[TabHibernate] bookmark create failed', t.url, e);
    }
  }

  const backupKey = `backup_${new Date().toISOString().slice(0, 10)}`;
  const existing = await chrome.storage.local.get(backupKey);
  const list = existing[backupKey] || [];
  const existingUrls = new Set(list.map((x) => x.url));
  for (const t of unique) {
    if (!existingUrls.has(t.url)) {
      list.push({ url: t.url, title: t.title || t.url, ts: Date.now() });
      existingUrls.add(t.url);
    }
  }
  await chrome.storage.local.set({ [backupKey]: list });
  return { count: unique.length, folderId };
}

/** Основная проверка по будильнику: суспенд неактивных и при необходимости бэкап. */
async function onAlarmCheck() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const tabs = await chrome.tabs.query({});
  const toBackup = [];
  for (const tab of tabs) {
    if (!(await isTabEligibleForSuspend(tab))) continue;
    if (!isTabInactive(tab.id, settings.timeoutMinutes)) continue;

    if (settings.mode === 'discard') {
      const ok = await suspendDiscard(tab.id);
      if (ok) toBackup.push({ url: tab.url, title: tab.title });
    } else {
      const ok = await suspendPlaceholder(tab.id, tab.url, tab.title);
      if (ok) toBackup.push({ url: tab.url, title: tab.title });
    }
  }

  if (toBackup.length > 0) {
    const seen = new Set();
    const unique = toBackup.filter((t) => {
      if (seen.has(t.url)) return false;
      seen.add(t.url);
      return true;
    });
    const folderId = await getOrCreateBackupFolder();
    for (const t of unique) {
      try {
        await chrome.bookmarks.create({
          parentId: folderId,
          title: (t.title || t.url).slice(0, 255),
          url: t.url,
        });
      } catch (e) {
        console.warn('[TabHibernate] backup bookmark failed', e);
      }
    }
    const backupKey = `backup_${new Date().toISOString().slice(0, 10)}`;
    const existing = await chrome.storage.local.get(backupKey);
    const list = existing[backupKey] || [];
    const existingUrls = new Set(list.map((x) => x.url));
    for (const t of unique) {
      if (!existingUrls.has(t.url)) {
        list.push({ url: t.url, title: t.title || t.url, ts: Date.now() });
        existingUrls.add(t.url);
      }
    }
    await chrome.storage.local.set({ [backupKey]: list });
  }
}

/** При установке/старте создаём alarm и выставляем начальную активность для открытых табов. */
async function ensureAlarm() {
  try {
    await chrome.alarms.create(ALARM_CHECK_NAME, { periodInMinutes: ALARM_CHECK_PERIOD_MINUTES });
  } catch (e) {
    console.warn('[TabHibernate] alarm create', e);
  }
}

async function initOnStartup() {
  await getStoredState();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  for (const tab of tabs) {
    if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      lastActivityByTab.set(tab.id, now);
    }
  }
  await persistLastActivity();
  await ensureAlarm();
}

chrome.runtime.onStartup.addListener(initOnStartup);
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    settings: {
      enabled: true,
      timeoutMinutes: INACTIVITY_MINUTES,
      mode: 'discard',
    },
  });
  await initOnStartup();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_CHECK_NAME) onAlarmCheck();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  markTabActive(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.audible !== undefined || changeInfo.pinned !== undefined) {
    lastActivityByTab.set(tabId, Date.now());
    persistLastActivity();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastActivityByTab.delete(tabId);
  persistLastActivity();
  chrome.storage.local.remove(`suspended_${tabId}`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'activity') {
    const tabId = sender.tab?.id;
    if (tabId) markTabActive(tabId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'getRestoreData') {
    const tabId = msg.tabId;
    chrome.storage.local.get(`suspended_${tabId}`).then((data) => {
      const key = `suspended_${tabId}`;
      sendResponse(data[key] || null);
    });
    return true;
  }
  if (msg.type === 'backupNow') {
    runBackup('manual').then(sendResponse);
    return true;
  }
  if (msg.type === 'getStats') {
    chrome.storage.local.get(['suspendedToday', 'suspendedTodayDate']).then((data) => {
      const today = new Date().toISOString().slice(0, 10);
      const count = data.suspendedTodayDate === today ? (data.suspendedToday || 0) : 0;
      sendResponse({ suspendedToday: count });
    });
    return true;
  }
  if (msg.type === 'clearRestoreData') {
    if (msg.tabId) chrome.storage.local.remove(`suspended_${msg.tabId}`);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Инициализация при первом запуске SW (после sleep)
initOnStartup();
