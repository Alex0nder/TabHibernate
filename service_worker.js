/**
 * Tab Hibernate — Service Worker (MV3)
 * Управляет таймером неактивности, режимами suspend (discard/placeholder) и бэкапами вкладок.
 * Состояние переживает sleep/restart за счёт chrome.storage и chrome.alarms.
 */

const ALARM_CHECK_NAME = 'tabHibernateCheck';
const ALARM_CHECK_PERIOD_MINUTES = 1;
const INACTIVITY_MINUTES = 5;

// ——— Хранение последней активности по tabId (в памяти + синхронизация при сообщениях)
// После сна SW память пуста — восстанавливаем из storage в начале onAlarmCheck.
let lastActivityByTab = new Map();
let lastPersistTime = 0;
const PERSIST_THROTTLE_MS = 4000;

async function getStoredState() {
  const raw = await chrome.storage.local.get(['lastActivityByTab', 'settings', 'suspendedToday', 'suspendedTodayDate']);
  if (raw.lastActivityByTab && typeof raw.lastActivityByTab === 'object') {
    const now = Date.now();
    lastActivityByTab = new Map(
      Object.entries(raw.lastActivityByTab)
        .map(([k, v]) => {
          const id = Number(k);
          const ts = typeof v === 'number' && !Number.isNaN(v) && v > 0 ? v : now;
          return [id, ts];
        })
        .filter(([id]) => !Number.isNaN(id))
    );
  }
  return raw;
}

async function persistLastActivity() {
  const now = Date.now();
  if (now - lastPersistTime < PERSIST_THROTTLE_MS) return;
  lastPersistTime = now;
  try {
    const obj = Object.fromEntries(
      [...lastActivityByTab.entries()].map(([k, v]) => [String(k), v])
    );
    await chrome.storage.local.set({ lastActivityByTab: obj });
  } catch (e) {
    console.warn('[TabHibernate] persistLastActivity failed', e);
  }
}

/** Проверка по полному URL текущего расширения (для своих редиректов). */
function isSuspendedPlaceholderUrl(url) {
  const base = chrome.runtime.getURL('suspended.html');
  return url && url.startsWith(base.split('?')[0]);
}

/** Определяет заглушку по пути и tabId — работает и после обновления расширения,
 * когда вкладки ещё открыты со старым chrome-extension://OLD_ID/suspended.html. */
function isPlaceholderTabUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.pathname.endsWith('suspended.html') && u.searchParams.has('tabId');
  } catch (e) {
    return false;
  }
}

/**
 * Таб нельзя суспендить: активный, закреплённый, со звуком, системный, инкогнито, уже placeholder.
 * allowActive: при true разрешает суспендить активную вкладку (кнопка «Остановить текущую»).
 * ВАЖНО: Discard и Placeholder оба приводят к выгрузке страницы. Несохранённые формы и состояние
 * SPA будут потеряны — это ограничение Chrome API.
 */
async function isTabEligibleForSuspend(tab, { allowActive = false } = {}) {
  if (!tab || !tab.id) return false;
  if (tab.active && !allowActive) return false;
  if (tab.pinned) return false;
  if (tab.audible) return false;
  if (tab.incognito) return false;
  const u = (tab.url || '').toLowerCase();
  if (u.startsWith('chrome://') || u.startsWith('chrome-extension://')) return false;
  if (isSuspendedPlaceholderUrl(tab.url) || isPlaceholderTabUrl(tab.url)) return false; // уже заглушка (в т.ч. со старым ID после обновления)
  return true;
}

/** Достаём настройки из storage (дефолты не перезаписываются undefined из storage). */
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  return {
    enabled: s.enabled !== false,
    timeoutMinutes: s.timeoutMinutes != null ? Number(s.timeoutMinutes) || INACTIVITY_MINUTES : INACTIVITY_MINUTES,
    mode: s.mode === 'placeholder' ? 'placeholder' : 'discard',
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

/** Проверка: прошло ли timeout минут с последней активности.
 * Вкладки без записи (новые или не успевшие попасть в storage) не считаем неактивными —
 * иначе при пробуждении SW по будильнику они суспендились бы «слишком рано». */
function isTabInactive(tabId, timeoutMinutes) {
  const last = lastActivityByTab.get(tabId);
  if (last == null) return false; // неизвестная вкладка — не суспендим
  return (Date.now() - last) >= timeoutMinutes * 60 * 1000;
}

/** Режим Discard: сбрасываем таб через Chrome API. */
async function suspendDiscard(tabId) {
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    return false;
  }
  try {
    await chrome.tabs.discard(tabId);
    await incrementSuspendedToday();
    return true;
  } catch (e) {
    console.warn('[TabHibernate] discard failed', tabId, e);
    return false;
  }
}

/** URL можно сохранить и восстановить (не пустой, не about:blank). */
function hasRestorableUrl(url) {
  const u = (url || '').trim();
  return u.length > 0 && u !== 'about:blank' && !u.startsWith('about:');
}

/** Режим Placeholder: сохраняем url+title, редирект на suspended.html.
 * В query добавляем fallback-параметр u (URL), чтобы при потере storage заглушка могла восстановить. */
const PLACEHOLDER_URL_PARAM_MAX = 1800;

async function suspendPlaceholder(tabId, url, title) {
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    return false;
  }
  const safeUrl = url || '';
  const restoreKey = `suspended_${tabId}`;
  await chrome.storage.local.set({
    [restoreKey]: { url: safeUrl, title: title || '', tabId },
  });
  const params = new URLSearchParams({ tabId: String(tabId) });
  if (safeUrl && encodeURIComponent(safeUrl).length <= PLACEHOLDER_URL_PARAM_MAX) {
    params.set('u', safeUrl);
  }
  const suspendedUrl = chrome.runtime.getURL('suspended.html') + '?' + params.toString();
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
  if (unique.length === 0) return { count: 0, folderId: null, folderPath: null };

  const dateStr = new Date().toISOString().slice(0, 10);
  const folderId = await getOrCreateBackupFolder();
  const folderPath = `Tab Backup / ${dateStr}`;

  for (const t of unique) {
    try {
      await chrome.bookmarks.create({ parentId: folderId, title: (t.title || t.url).slice(0, 255), url: t.url });
    } catch (e) {
      console.warn('[TabHibernate] bookmark create failed', t.url, e);
    }
  }

  const backupKey = `backup_${dateStr}`;
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
  return { count: unique.length, folderId, folderPath };
}

/** Удаляем из lastActivityByTab записи по закрытым вкладкам, чтобы не раздувать storage. */
async function pruneStaleTabIds() {
  try {
    const tabs = await chrome.tabs.query({});
    const ids = new Set(tabs.map((t) => t.id));
    let changed = false;
    for (const id of lastActivityByTab.keys()) {
      if (!ids.has(id)) {
        lastActivityByTab.delete(id);
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ lastActivityByTab: Object.fromEntries(lastActivityByTab) });
  } catch (e) {
    console.warn('[TabHibernate] pruneStaleTabIds failed', e);
  }
}

/** Ручная приостановка всех подходящих вкладок (без учёта таймаута неактивности). */
async function runSuspendAllNow() {
  await getStoredState();
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const toBackup = [];
  let suspended = 0;
  for (const tab of tabs) {
    if (!(await isTabEligibleForSuspend(tab))) continue;
    if (settings.mode === 'placeholder' && !hasRestorableUrl(tab.url)) continue;
    if (settings.mode === 'discard') {
      const ok = await suspendDiscard(tab.id);
      if (ok) {
        toBackup.push({ url: tab.url, title: tab.title });
        suspended++;
      }
    } else {
      const ok = await suspendPlaceholder(tab.id, tab.url, tab.title);
      if (ok) {
        toBackup.push({ url: tab.url, title: tab.title });
        suspended++;
      }
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
  return { suspended };
}

/** Закрыть подходящие вкладки и сохранить их URL в closedAndSaved (лимит CLOSED_SAVED_MAX). */
const CLOSED_SAVED_MAX = 2000;
async function runCloseAndSaveAll() {
  const tabs = await chrome.tabs.query({});
  const toSave = [];
  const idsToClose = [];
  for (const tab of tabs) {
    if (!(await isTabEligibleForSuspend(tab))) continue;
    toSave.push({ url: tab.url || '', title: (tab.title || tab.url || '').slice(0, 512), savedAt: Date.now() });
    idsToClose.push(tab.id);
  }
  if (toSave.length === 0) return { closed: 0 };
  const { closedAndSaved = [] } = await chrome.storage.local.get('closedAndSaved');
  const merged = [...toSave.reverse(), ...closedAndSaved].slice(0, CLOSED_SAVED_MAX);
  await chrome.storage.local.set({ closedAndSaved: merged });
  for (const id of idsToClose) {
    try { await chrome.tabs.remove(id); } catch (e) { console.warn('[TabHibernate] tab remove failed', id, e); }
  }
  return { closed: idsToClose.length };
}

/** Restore all tabs that are currently showing the suspended placeholder.
 * Сначала пробуем storage; если данных нет — восстанавливаем по fallback-параметру u в URL заглушки. */
async function runRestoreAllSuspended() {
  const tabs = await chrome.tabs.query({});
  let restored = 0;
  for (const tab of tabs) {
    if (!tab.url || !tab.id || !isPlaceholderTabUrl(tab.url)) continue;
    try {
      const u = new URL(tab.url);
      const tabIdParam = u.searchParams.get('tabId');
      const tid = tabIdParam ? parseInt(tabIdParam, 10) : null;
      if (tid == null) continue;
      const key = `suspended_${tid}`;
      const data = await chrome.storage.local.get(key);
      const item = data[key];
      let restoreUrl = item && item.url ? item.url : null;
      if (!restoreUrl) {
        const fallback = u.searchParams.get('u');
        if (fallback && (fallback.startsWith('http://') || fallback.startsWith('https://'))) restoreUrl = fallback;
      }
      if (restoreUrl) {
        await chrome.tabs.update(tab.id, { url: restoreUrl });
        await chrome.storage.local.remove(key);
        restored++;
      }
    } catch (e) {
      console.warn('[TabHibernate] restore tab failed', tab.id, e);
    }
  }
  return { restored };
}

/** Основная проверка по будильнику: суспенд неактивных и при необходимости бэкап. */
async function onAlarmCheck() {
  try {
    await chrome.storage.local.set({ lastAlarmRun: Date.now() });
    await ensureAlarm();

    await getStoredState();
    await pruneStaleTabIds();

    const settings = await getSettings();
    if (!settings.enabled) return;

    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    let needPersist = false;
    for (const tab of tabs) {
      if (tab.id && !lastActivityByTab.has(tab.id)) {
        lastActivityByTab.set(tab.id, now);
        needPersist = true;
      }
    }
    if (needPersist) await persistLastActivity();

    const toBackup = [];
    for (const tab of tabs) {
      if (!(await isTabEligibleForSuspend(tab))) continue;
      if (!isTabInactive(tab.id, settings.timeoutMinutes)) continue;
      if (settings.mode === 'placeholder' && !hasRestorableUrl(tab.url)) continue;

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
  } catch (e) {
    console.warn('[TabHibernate] onAlarmCheck failed', e);
  }
}

/** Создаём/обновляем периодический alarm — вызывать при старте и после каждой проверки. */
async function ensureAlarm() {
  try {
    await chrome.alarms.create(ALARM_CHECK_NAME, { periodInMinutes: ALARM_CHECK_PERIOD_MINUTES });
  } catch (e) {
    console.warn('[TabHibernate] alarm create', e);
  }
}

async function initOnStartup() {
  await ensureAlarm();
  await getStoredState();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  for (const tab of tabs) {
    if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      lastActivityByTab.set(tab.id, now);
    }
  }
  await persistLastActivity();
}

chrome.runtime.onStartup.addListener(initOnStartup);
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    settings: {
      enabled: true,
      timeoutMinutes: INACTIVITY_MINUTES,
      mode: 'placeholder',
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

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id) markTabActive(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastActivityByTab.delete(tabId);
  persistLastActivity();
  chrome.storage.local.remove(`suspended_${tabId}`);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const safeSend = (value) => {
    try {
      sendResponse(value);
    } catch (e) {
      console.warn('[TabHibernate] sendResponse failed', e);
    }
  };
  if (msg.type === 'activity') {
    const tabId = sender.tab?.id;
    if (tabId) markTabActive(tabId);
    safeSend({ ok: true });
    return true;
  }
  if (msg.type === 'getRestoreData') {
    const tabId = msg.tabId;
    chrome.storage.local.get(`suspended_${tabId}`).then((data) => {
      const key = `suspended_${tabId}`;
      safeSend(data[key] || null);
    }).catch((e) => {
      console.warn('[TabHibernate] getRestoreData failed', e);
      safeSend(null);
    });
    return true;
  }
  if (msg.type === 'backupNow') {
    runBackup('manual').then((res) => safeSend(res)).catch((e) => {
      console.warn('[TabHibernate] backupNow failed', e);
      safeSend({ count: 0, error: String(e.message) });
    });
    return true;
  }
  if (msg.type === 'getStats') {
    chrome.storage.local.get(['suspendedToday', 'suspendedTodayDate']).then((data) => {
      const today = new Date().toISOString().slice(0, 10);
      const count = data.suspendedTodayDate === today ? (data.suspendedToday || 0) : 0;
      safeSend({ suspendedToday: count });
    }).catch((e) => {
      console.warn('[TabHibernate] getStats failed', e);
      safeSend({ suspendedToday: 0 });
    });
    return true;
  }
  if (msg.type === 'getStatus') {
    Promise.all([
      chrome.storage.local.get(['suspendedToday', 'suspendedTodayDate', 'lastAlarmRun']),
      getEligibleTabsForBackup(),
    ]).then(([data, eligibleTabs]) => {
      const today = new Date().toISOString().slice(0, 10);
      const suspendedToday = data.suspendedTodayDate === today ? (data.suspendedToday || 0) : 0;
      safeSend({
        suspendedToday,
        lastAlarmRun: data.lastAlarmRun || 0,
        eligibleTabCount: eligibleTabs.length,
      });
    }).catch((e) => {
      console.warn('[TabHibernate] getStatus failed', e);
      safeSend({ suspendedToday: 0, lastAlarmRun: 0, eligibleTabCount: 0 });
    });
    return true;
  }
  if (msg.type === 'clearRestoreData') {
    if (msg.tabId) chrome.storage.local.remove(`suspended_${msg.tabId}`);
    safeSend({ ok: true });
    return true;
  }
  if (msg.type === 'suspendCurrentTab') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return safeSend({ ok: false, reason: 'No active tab' });
        if (!(await isTabEligibleForSuspend(tab, { allowActive: true }))) {
          const reason = tab.pinned ? 'Tab is pinned' : tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')
            ? 'System page cannot be suspended' : 'Cannot suspend this tab';
          return safeSend({ ok: false, reason });
        }
        const settings = await getSettings();
        if (settings.mode === 'placeholder' && !hasRestorableUrl(tab.url)) {
          return safeSend({ ok: false, reason: 'Cannot suspend: page has no restorable URL' });
        }
        const ok = settings.mode === 'discard'
          ? await suspendDiscard(tab.id)
          : await suspendPlaceholder(tab.id, tab.url, tab.title);
        safeSend({ ok });
      } catch (e) {
        console.warn('[TabHibernate] suspendCurrentTab failed', e);
        safeSend({ ok: false, reason: String(e.message) });
      }
    })();
    return true;
  }
  if (msg.type === 'suspendAllNow') {
    runSuspendAllNow().then((res) => safeSend(res)).catch((e) => {
      console.warn('[TabHibernate] suspendAllNow failed', e);
      safeSend({ suspended: 0, error: String(e.message) });
    });
    return true;
  }
  if (msg.type === 'restoreAllSuspended') {
    runRestoreAllSuspended().then((res) => safeSend(res)).catch((e) => {
      console.warn('[TabHibernate] restoreAllSuspended failed', e);
      safeSend({ restored: 0, error: String(e.message) });
    });
    return true;
  }
  if (msg.type === 'closeAndSaveAll') {
    runCloseAndSaveAll().then((res) => safeSend(res)).catch((e) => {
      console.warn('[TabHibernate] closeAndSaveAll failed', e);
      safeSend({ closed: 0, error: String(e.message) });
    });
    return true;
  }
  return false;
});

// Инициализация при первом запуске SW (после sleep)
initOnStartup();
