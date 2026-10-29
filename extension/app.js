'use strict';

const core = globalThis.TomorinCore;
const iconKit = globalThis.TomorinIcons;
const { normalizeUrl, isHttpUrl, siteOrigin, hostnameFromUrl, urlKey } = core;

const STORAGE_KEY = 'tomorinNewTabState';
const BACKUP_KEY = 'tomorinNewTabBackup';
const DB_NAME = 'tomorin-new-tab';
const DB_VERSION = 3;
const WALLPAPER_STORE = 'wallpapers';
const ICON_STORE = 'icons';
const BLOB_STORE = 'blobs';
const LEGACY_WALLPAPER_ID = 'current';
const BLOB_PRUNE_AGE_MS = 10 * 60 * 1000;
const PAGE_CAPACITY = 32;
const PAGE_SCROLL_DURATION_MS = 45;
const DEFAULT_SHORTCUT_STAMP = 1700000000000;
const SYNC_REQUEST_TIMEOUT_MS = 10000;
const SYNC_BLOB_TIMEOUT_MS = 180000;
const SYNC_DEBOUNCE_MS = 700;
const SYNC_MIN_CHECK_INTERVAL_MS = 15000;
const SYNC_VISIBLE_CHECK_MS = 60000;
const MAX_WALLPAPER_BYTES = 100 * 1024 * 1024;
const ICON_RECHECK_SMALL_MS = 3 * 24 * 60 * 60 * 1000;
const ICON_RECHECK_MISSING_MS = 12 * 60 * 60 * 1000;
const ICON_RETRY_TRANSIENT_MS = 20 * 60 * 1000;
const ICON_SHARP_SIDE = 120;
const ICON_WORKERS = 3;
const DRAG_FLIP_DELAY_MS = 450;
const DRAG_FLIP_EDGE_PX = 12;
const BACKUP_DELETE_THRESHOLD = 3;
const SEARCH_ENGINES = new Set(['default', 'bing']);
const TAB_ID = crypto.randomUUID();

const DEFAULT_SHORTCUTS = [
  { title: 'YouTube', url: 'https://www.youtube.com', size: 'small' },
  { title: 'TikTok', url: 'https://www.tiktok.com', size: 'small' },
  { title: 'X', url: 'https://x.com', size: 'small' },
  { title: 'GitHub', url: 'https://github.com', size: 'small' },
  { title: 'Agoda', url: 'https://www.agoda.com', size: 'small' },
];

const hasChromeStorage = Boolean(globalThis.chrome?.storage?.local);
const hasChromeSearch = Boolean(globalThis.chrome?.search?.query);

const els = {
  body: document.body,
  shell: document.querySelector('.newtab-shell'),
  searchForm: document.getElementById('searchForm'),
  searchInput: document.getElementById('searchInput'),
  shortcutArea: document.querySelector('.shortcut-area'),
  shortcutViewport: document.getElementById('shortcutViewport'),
  shortcutPages: document.getElementById('shortcutPages'),
  emptyState: document.getElementById('emptyState'),
  pageDots: document.getElementById('pageDots'),
  settingsMenu: document.querySelector('.settings-menu'),
  densityButtons: [...document.querySelectorAll('[data-action="set-density"]')],
  searchEngineButtons: [...document.querySelectorAll('[data-action="set-search-engine"]')],
  wallpaperInput: document.getElementById('wallpaperInput'),
  syncDialog: document.getElementById('syncDialog'),
  syncForm: document.getElementById('syncForm'),
  syncMain: document.getElementById('syncMain'),
  syncChoice: document.getElementById('syncChoice'),
  syncEnabled: document.getElementById('syncEnabled'),
  syncEndpoint: document.getElementById('syncEndpoint'),
  syncPassword: document.getElementById('syncPassword'),
  syncStatusCard: document.getElementById('syncStatusCard'),
  syncStatus: document.getElementById('syncStatus'),
  syncDetail: document.getElementById('syncDetail'),
  syncChoiceSummary: document.getElementById('syncChoiceSummary'),
  restoreBackupButton: document.getElementById('restoreBackupButton'),
  dialog: document.getElementById('shortcutDialog'),
  shortcutForm: document.getElementById('shortcutForm'),
  dialogTitle: document.getElementById('dialogTitle'),
  titleInput: document.getElementById('shortcutTitle'),
  urlInput: document.getElementById('shortcutUrl'),
  iconInput: document.getElementById('shortcutIconInput'),
  iconOptions: document.getElementById('shortcutIconOptions'),
  deleteButton: document.getElementById('deleteShortcutButton'),
  toast: document.getElementById('toast'),
};

let state = defaultState();
let editMode = false;
let editingId = null;
let draggedId = null;
let activeDropSlot = null;
let dragFlip = null;
let activeWallpaperUrl = null;
let toastTimer = null;
let touchStartX = 0;
let movedShortcutId = null;
let pageScrollTimer = null;
let pageScrollAnimation = 0;
let suppressScrollState = false;
let writeCounter = 0;
let stateReady = false;
const earlyStates = [];

let dialogIcon = { choice: 'auto' };
let dialogChoices = [];
let dialogChoicesKey = '';
let dialogChoicesLoading = false;
let dialogUrlTimer = null;
const dialogObjectUrls = new Set();

const iconDisplay = new Map();
const iconQueue = [];
const iconQueued = new Set();
let iconWorkers = 0;

let syncTimer = null;
let syncRunning = false;
let currentSync = null;
let syncProgress = '';
let pendingChoice = null;

init();

// ------------------------------------------------------------------ setup

async function init() {
  // Listen before reading, so a save from another tab during startup is not missed.
  bindStorageListener();
  const loaded = await loadState();
  state = loaded.state;
  if (loaded.legacy) await finishLegacyMigration(loaded.legacy);
  await repairSvgIcons();
  await Promise.all([hydrateShortcutIcons(), applyWallpaper()]);
  bindEvents();
  render();
  stateReady = true;
  for (const value of earlyStates.splice(0)) await handleExternalState(value);
  queueStaleIcons();
  scheduleSync('startup');
}

function bindEvents() {
  els.searchForm.addEventListener('submit', handleSearch);
  document.addEventListener('click', handleDocumentClick);
  els.shortcutForm.addEventListener('submit', handleShortcutSubmit);
  els.syncForm.addEventListener('submit', handleSyncSubmit);
  els.wallpaperInput.addEventListener('change', handleWallpaperUpload);
  els.iconInput.addEventListener('change', handleShortcutIconUpload);
  els.urlInput.addEventListener('input', handleDialogUrlInput);
  els.titleInput.addEventListener('input', () => renderIconOptions());
  els.dialog.addEventListener('close', releaseDialogObjectUrls);
  document.addEventListener('keydown', handleKeydown);
  els.shortcutPages.addEventListener('dragstart', handleDragStart);
  els.shortcutPages.addEventListener('dragover', handleDragOver);
  document.addEventListener('dragover', handleDragFlip);
  // Let go outside the grid: nothing moves and the browser does nothing either.
  document.addEventListener('drop', event => {
    if (draggedId) event.preventDefault();
  });
  els.shortcutPages.addEventListener('drop', handleDrop);
  els.shortcutPages.addEventListener('dragend', handleDragEnd);
  els.shortcutPages.addEventListener('contextmenu', handleShortcutContextMenu);
  els.shortcutViewport.addEventListener('scroll', handleShortcutScroll, { passive: true });
  els.shell.addEventListener('wheel', handleShortcutWheel, { passive: true });
  els.shell.addEventListener('touchstart', handleTouchStart, { passive: true });
  els.shell.addEventListener('touchend', handleTouchEnd, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - (state.sync.lastCheckAt || 0) > SYNC_VISIBLE_CHECK_MS) scheduleSync('visible');
  });
  window.addEventListener('online', () => scheduleSync('online'));
}

// ------------------------------------------------------------------ state

function defaultState() {
  const keys = core.generateNKeysBetween(null, null, DEFAULT_SHORTCUTS.length);
  return {
    version: 2,
    shortcuts: DEFAULT_SHORTCUTS.map((item, index) => ({
      id: crypto.randomUUID(),
      title: item.title,
      url: item.url,
      size: item.size,
      icon: null,
      pos: keys[index],
      editedAt: DEFAULT_SHORTCUT_STAMP,
      movedAt: DEFAULT_SHORTCUT_STAMP,
      createdAt: DEFAULT_SHORTCUT_STAMP,
      order: index,
    })),
    tombstones: [],
    settings: {
      currentPage: 0,
      searchEngine: 'default',
      iconDensity: 'small',
      iconDensityAt: 0,
      wallpaper: wallpaperSetting(null),
    },
    sync: normalizeSyncConfig({}),
    clock: 0,
    pristine: true,
    generation: 0,
    replaced: null,
  };
}

function normalizeSyncConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const legacyToken = typeof source.token === 'string' ? source.token : '';
  return {
    enabled: Boolean(source.enabled),
    endpoint: normalizeSyncEndpoint(source.endpoint || ''),
    password: typeof source.password === 'string' ? source.password : legacyToken,
    rev: Number.isInteger(source.rev) && source.rev >= 0 ? source.rev : 0,
    linked: typeof source.linked === 'string' ? source.linked : '',
    dirty: source.dirty !== false,
    lastSyncAt: Number.isFinite(source.lastSyncAt) ? source.lastSyncAt : 0,
    lastCheckAt: Number.isFinite(source.lastCheckAt) ? source.lastCheckAt : 0,
    lastError: typeof source.lastError === 'string' ? source.lastError.slice(0, 160) : '',
  };
}

function wallpaperSetting(raw) {
  const wallpaper = core.normalizeWallpaper(raw);
  return { type: wallpaper.hash ? 'uploaded' : 'none', ...wallpaper };
}

function withOrder(list) {
  return list.map((item, index) => ({ ...item, order: index }));
}

function docFromState(source = state) {
  return core.normalizeDoc({
    shortcuts: source.shortcuts,
    tombstones: source.tombstones,
    settings: { iconDensity: source.settings.iconDensity, iconDensityAt: source.settings.iconDensityAt },
    wallpaper: source.settings.wallpaper,
  });
}

function stateWithDoc(base, doc) {
  const normalized = core.normalizeDoc(doc);
  return {
    ...base,
    shortcuts: withOrder(normalized.shortcuts),
    tombstones: normalized.tombstones,
    settings: {
      ...base.settings,
      iconDensity: normalized.settings.iconDensity,
      iconDensityAt: normalized.settings.iconDensityAt,
      wallpaper: wallpaperSetting(normalized.wallpaper),
    },
    clock: Math.max(base.clock || 0, core.maxTimestamp(normalized)),
  };
}

function normalizeLocalState(saved) {
  const base = {
    version: 2,
    shortcuts: [],
    tombstones: [],
    settings: {
      currentPage: Number.isFinite(saved.settings?.currentPage) ? saved.settings.currentPage : 0,
      searchEngine: normalizeSearchEngine(saved.settings?.searchEngine),
      iconDensity: 'small',
      iconDensityAt: 0,
      wallpaper: wallpaperSetting(null),
    },
    sync: normalizeSyncConfig(saved.sync),
    clock: Number.isFinite(saved.clock) ? saved.clock : 0,
    pristine: Boolean(saved.pristine),
    // Bumped when the shortcuts are replaced wholesale (first sync "use cloud"),
    // so other open tabs follow instead of merging the old list back in.
    generation: Number.isInteger(saved.generation) && saved.generation >= 0 ? saved.generation : 0,
    replaced: saved.replaced?.snapshot ? { generation: saved.replaced.generation, snapshot: core.normalizeDoc(saved.replaced.snapshot) } : null,
  };
  return stateWithDoc(base, {
    shortcuts: saved.shortcuts,
    tombstones: saved.tombstones,
    settings: { iconDensity: saved.settings?.iconDensity, iconDensityAt: saved.settings?.iconDensityAt },
    wallpaper: saved.settings?.wallpaper,
  });
}

// Version 1 stored a plain `order` number and bumped `updatedAt` whenever an
// icon was cached, which is why computers kept overwriting each other.
function migrateLegacyState(saved) {
  const list = saved.shortcuts
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.title && item.url)
    .sort((a, b) => (Number.isFinite(a.item.order) ? a.item.order : a.index) - (Number.isFinite(b.item.order) ? b.item.order : b.index))
    .map(({ item }) => item);
  const keys = core.generateNKeysBetween(null, null, list.length);
  const shortcuts = list.map((item, index) => {
    const at = Number.isFinite(item.updatedAt) && item.updatedAt > 0 ? item.updatedAt : DEFAULT_SHORTCUT_STAMP;
    return {
      id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
      title: item.title,
      url: item.url,
      size: item.size,
      icon: legacyIconChoice(item),
      pos: keys[index],
      editedAt: at,
      movedAt: at,
      createdAt: at,
    };
  });
  const oldSync = saved.sync || {};
  const base = normalizeLocalState({
    version: 2,
    settings: { currentPage: saved.settings?.currentPage, searchEngine: saved.settings?.searchEngine },
    // The old token keeps working as the password; the first sync with the
    // new server decides how this computer's copy joins the cloud copy.
    sync: { enabled: oldSync.enabled, endpoint: oldSync.endpoint, password: oldSync.token, rev: 0, linked: '', dirty: true },
  });
  const migrated = stateWithDoc(base, {
    shortcuts,
    tombstones: Array.isArray(saved.deletedShortcuts)
      ? saved.deletedShortcuts.map(item => ({ id: item?.id, deletedAt: item?.deletedAt }))
      : [],
    // A size chosen in version 1 beats an untouched default, not a later choice.
    settings: { iconDensity: saved.settings?.iconDensity, iconDensityAt: saved.settings?.iconDensity && saved.settings.iconDensity !== 'small' ? 1 : 0 },
    wallpaper: null,
  });
  migrated.pristine = looksLikeUntouchedDefaults(saved, list);
  return migrated;
}

function legacyIconChoice(item) {
  if (!isHttpUrl(item.iconUrl)) return null;
  return isAutomaticLegacySource(item.iconUrl, item.url) ? null : { type: 'url', url: item.iconUrl };
}

function isAutomaticLegacySource(iconUrl, siteUrl) {
  try {
    const origin = siteOrigin(siteUrl);
    const automatic = ['/favicon.ico', '/apple-touch-icon.png', '/favicon-32x32.png'].map(file => new URL(file, origin).toString());
    if (automatic.includes(iconUrl)) return true;
  } catch {
    // Fall through to the service check.
  }
  return /^https:\/\/(www\.google\.com\/s2\/favicons|icons\.duckduckgo\.com\/ip3\/|t\d\.gstatic\.com\/faviconV2)/.test(iconUrl);
}

// Only a version 1 install nobody ever changed counts as untouched: the five
// default sites in their order and size, no picked icons, nothing deleted.
function looksLikeUntouchedDefaults(saved, list) {
  if (list.length !== DEFAULT_SHORTCUTS.length) return false;
  if (Array.isArray(saved.deletedShortcuts) && saved.deletedShortcuts.length) return false;
  if (saved.settings?.wallpaper?.type === 'uploaded') return false;
  return list.every((item, index) => {
    const original = DEFAULT_SHORTCUTS[index];
    return urlKey(item.url) === urlKey(original.url)
      && item.title === original.title
      && (item.size || 'small') === original.size
      && !item.customIcon
      && !legacyIconChoice(item);
  });
}

async function loadState() {
  let saved = null;
  try {
    saved = hasChromeStorage
      ? (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
      : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.shortcuts)) return { state: defaultState(), legacy: null };
  if (saved.version === 2) return { state: normalizeLocalState(saved), legacy: null };
  try {
    return { state: migrateLegacyState(saved), legacy: saved };
  } catch {
    return { state: defaultState(), legacy: null };
  }
}

async function finishLegacyMigration(legacy) {
  let movedWallpaper = false;
  if (legacy.settings?.wallpaper?.type === 'uploaded') {
    const blob = await getLegacyWallpaper().catch(() => null);
    if (blob) {
      const hash = await iconKit.sha256Hex(await blob.arrayBuffer());
      const mime = blob.type || 'image/jpeg';
      await saveBlobRecord(hash, blob, mime);
      movedWallpaper = true;
      // A tiny timestamp: a wallpaper already in the cloud wins, an empty cloud gets this one.
      state.settings.wallpaper = wallpaperSetting({ hash, mime, size: blob.size, updatedAt: 1 });
    }
  }

  // Oldest first, so when two entries for one address were folded together the
  // most recently changed one's icon wins, like its title.
  const entries = (legacy.shortcuts || [])
    .filter(old => old?.url)
    .sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
  for (const old of entries) {
    const item = state.shortcuts.find(shortcut => shortcut.id === old.id)
      || state.shortcuts.find(shortcut => urlKey(shortcut.url) === urlKey(old.url));
    if (!item) continue;
    let blob = null;
    if (isImageDataUrl(old.customIcon)) {
      blob = dataUrlToBlob(old.customIcon);
    } else if (old.iconId) {
      const record = await getIconRecord(old.iconId).catch(() => null);
      if (record?.sourceUrl === 'custom' && record.blob) blob = record.blob;
    }
    if (!blob) {
      item.icon = legacyIconChoice(old);
      continue;
    }
    state.pristine = false;
    if (blob.type === 'image/svg+xml') {
      // Version 1 saved its letter placeholder as an SVG "upload".
      item.icon = { type: 'letter' };
      continue;
    }
    const mime = blob.type || 'image/png';
    const hash = await iconKit.sha256Hex(await blob.arrayBuffer());
    await saveBlobRecord(hash, blob, mime);
    item.icon = { type: 'blob', hash, mime };
  }

  await persistState();
  if (movedWallpaper) await deleteLegacyWallpaper().catch(() => {});
}

// Version 1 saved its letter placeholder as an SVG "upload", and early builds
// of this version migrated it as a picture. The sync server only keeps bitmap
// pictures, so such icons become letter tiles, which is what they showed.
async function repairSvgIcons() {
  let changed = false;
  for (const item of state.shortcuts) {
    if (item.icon?.type !== 'blob') continue;
    const record = item.icon.mime === 'image/svg+xml' ? null : await getBlobRecord(item.icon.hash).catch(() => null);
    if (item.icon.mime === 'image/svg+xml' || record?.blob?.type === 'image/svg+xml') {
      item.icon = { type: 'letter' };
      changed = true;
    }
  }
  if (!changed) return;
  state.sync.dirty = true;
  await persistState();
}

async function persistState() {
  state.shortcuts = withOrder(core.sortShortcuts(state.shortcuts));
  state.settings.currentPage = clampPage(state.settings.currentPage);
  writeCounter += 1;
  const snapshot = { ...state, writer: `${TAB_ID}:${writeCounter}` };
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }
}

// Saves a change to synced data and schedules a sync. A computer whose
// shortcuts were never touched simply takes the cloud copy on first sync.
async function commitChange({ touchesShortcuts = true } = {}) {
  if (touchesShortcuts) state.pristine = false;
  state.sync.dirty = true;
  await persistState();
  scheduleSync('change');
}

function nextStamp() {
  const value = Math.max(Date.now(), (state.clock || 0) + 1);
  state.clock = value;
  return value;
}

function bindStorageListener() {
  const receive = value => {
    if (!stateReady) earlyStates.push(value);
    else handleExternalState(value);
  };
  if (hasChromeStorage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) receive(changes[STORAGE_KEY].newValue);
    });
    return;
  }
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      receive(JSON.parse(event.newValue));
    } catch {
      // Ignore unreadable writes.
    }
  });
}

// Another new tab saved a change. Both copies are merged (the data merges
// without loss), and when this tab holds something the saved copy lacks, it is
// written back, so two tabs saving at the same moment never lose an edit.
async function handleExternalState(value) {
  if (!value || value.version !== 2) return;
  if (typeof value.writer === 'string' && value.writer.startsWith(`${TAB_ID}:`)) return;
  const previous = state;
  const incoming = normalizeLocalState(value);
  let next;
  let writeBack = false;

  if (incoming.generation > (previous.generation || 0)) {
    // Another tab replaced the shortcuts with the cloud copy: follow it, but
    // keep what this tab changed after the replaced copy was taken.
    const extra = incoming.replaced?.snapshot ? core.changesSince(incoming.replaced.snapshot, docFromState(previous)) : null;
    next = incoming;
    if (extra && !core.sameDoc(extra, {})) {
      const theirs = docFromState(incoming);
      const merged = core.mergeDocs(theirs, extra);
      writeBack = !core.sameDoc(merged, theirs);
      next = stateWithDoc(incoming, merged);
      if (writeBack) next.sync.dirty = true;
    }
  } else if (incoming.generation < (previous.generation || 0)) {
    // Written by a tab that had not seen the replacement yet: keep its new
    // edits, drop its old copy, and save the result.
    const extra = previous.replaced?.snapshot ? core.changesSince(previous.replaced.snapshot, docFromState(incoming)) : null;
    next = extra && !core.sameDoc(extra, {}) ? stateWithDoc(previous, core.mergeDocs(docFromState(previous), extra)) : previous;
    if (next !== previous) next.sync.dirty = true;
    writeBack = true;
  } else {
    const theirs = docFromState(incoming);
    const merged = core.mergeDocs(docFromState(previous), theirs);
    writeBack = !core.sameDoc(merged, theirs);
    next = stateWithDoc(incoming, merged);
    next.pristine = previous.pristine && incoming.pristine;
    next.clock = Math.max(previous.clock || 0, next.clock || 0);
    const mine = previous.sync;
    if (mine.endpoint === incoming.sync.endpoint && mine.lastSyncAt > incoming.sync.lastSyncAt) {
      next.sync = { ...next.sync, rev: mine.rev, linked: mine.linked, lastSyncAt: mine.lastSyncAt, lastError: mine.lastError };
    }
    next.sync.lastCheckAt = Math.max(mine.lastCheckAt || 0, incoming.sync.lastCheckAt || 0);
    if (writeBack) next.sync.dirty = true;
  }

  next.settings.currentPage = previous.settings.currentPage;
  state = next;
  // Another tab answered the first-sync question.
  if (pendingChoice && state.sync.linked === state.sync.endpoint) {
    pendingChoice = null;
    if (els.syncDialog.open) showSyncMain();
  }
  renderSyncAlert();
  if (writeBack) {
    await persistState();
    // This tab added what the saved copy lacked, so it also syncs it.
    scheduleSync('change');
  }
  await hydrateShortcutIcons();
  render();
  queueStaleIcons();
  if (previous.settings.wallpaper.hash !== state.settings.wallpaper.hash) await applyWallpaper();
  if (els.syncDialog.open) renderSyncStatus();
}

function orderedShortcuts() {
  return core.sortShortcuts(state.shortcuts);
}

// ---------------------------------------------------------------- paging

function pageCount() {
  return Math.max(1, Math.ceil(pageItemCount() / PAGE_CAPACITY));
}

function clampPage(page) {
  const count = Math.max(1, Math.ceil(pageItemCount() / PAGE_CAPACITY));
  return Math.max(0, Math.min(Number.isFinite(page) ? page : 0, count - 1));
}

function pageItemCount() {
  return state.shortcuts.length + (editMode ? 1 : 0);
}

function pageStartIndex(page) {
  return clampPage(page) * PAGE_CAPACITY;
}

function pageItems(page) {
  const start = pageStartIndex(page);
  return orderedShortcuts().slice(start, start + PAGE_CAPACITY);
}

function activeShortcutPage() {
  return els.shortcutPages.querySelector(`.shortcut-page[data-page="${state.settings.currentPage}"]`);
}

// -------------------------------------------------------------- rendering

function render() {
  state.settings.currentPage = clampPage(state.settings.currentPage);
  els.shell.classList.toggle('edit-mode', editMode);
  applyDensity();
  applySearchEngineControl();
  renderShortcuts();
  renderDots();
  els.emptyState.hidden = state.shortcuts.length > 0 || editMode;
  scrollToShortcutPage(state.settings.currentPage, { smooth: false });
  renderSyncAlert();
}

function applyDensity() {
  const density = state.settings.iconDensity || 'small';
  els.shell.classList.toggle('density-small', density === 'small');
  els.shell.classList.toggle('density-medium', density === 'medium');
  els.shell.classList.toggle('density-large', density === 'large');
  els.densityButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.density === density));
  });
}

function applySearchEngineControl() {
  const searchEngine = normalizeSearchEngine(state.settings.searchEngine);
  els.searchEngineButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.searchEngine === searchEngine));
  });
}

function renderShortcuts() {
  els.shortcutPages.style.setProperty('--page-columns', '8');
  els.shortcutPages.innerHTML = Array.from({ length: pageCount() }, (_, page) => {
    const active = page === state.settings.currentPage ? ' is-active' : '';
    return `<section class="shortcut-page${active}" data-page="${page}">${renderPageContent(page)}</section>`;
  }).join('');

  if (movedShortcutId) {
    const movedCard = activeShortcutPage()?.querySelector(`[data-id="${CSS.escape(movedShortcutId)}"]`);
    requestAnimationFrame(() => movedCard?.classList.add('moved-pop'));
    setTimeout(() => movedCard?.classList.remove('moved-pop'), 320);
    movedShortcutId = null;
  }
}

function updateActivePageState() {
  els.shortcutPages.querySelectorAll('.shortcut-page').forEach(page => {
    page.classList.toggle('is-active', page.dataset.page === String(state.settings.currentPage));
  });
  renderDots();
}

function renderPageContent(page) {
  const items = pageItems(page);
  if (!editMode) return items.map(renderShortcut).join('');
  const start = pageStartIndex(page);
  return Array.from({ length: PAGE_CAPACITY }, (_, index) => renderShortcutSlot(items[index], start + index, index)).join('');
}

function renderShortcutSlot(item, globalIndex, slotIndex) {
  if (!item && globalIndex === state.shortcuts.length) {
    return `
      <div class="shortcut-slot add-slot" data-global-index="${globalIndex}" data-slot-index="${slotIndex}">
        <button class="add-shortcut-tile" type="button" data-action="add-shortcut" title="添加网站" aria-label="添加网站">
          <span class="shortcut-icon add-shortcut-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13"/></svg>
          </span>
          <span class="shortcut-title">添加</span>
        </button>
      </div>
    `;
  }
  const size = item ? ` ${item.size}` : '';
  const empty = item ? '' : ' empty';
  return `
    <div class="shortcut-slot${size}${empty}" data-global-index="${globalIndex}" data-slot-index="${slotIndex}">
      ${item ? renderShortcut(item) : ''}
    </div>
  `;
}

function renderShortcut(item) {
  const id = escapeHtml(item.id);
  const title = escapeHtml(item.title);
  return `
    <div class="shortcut-card ${item.size}" role="link" tabindex="0" data-id="${id}" data-url="${escapeHtml(item.url)}" draggable="${editMode}" title="${title}">
      <span class="shortcut-icon">
        <img src="${escapeHtml(iconSrcFor(item))}" alt="" draggable="false" decoding="async">
        <button class="shortcut-remove" type="button" data-action="remove-shortcut" data-id="${id}" tabindex="${editMode ? 0 : -1}" aria-label="删除 ${title}" title="删除">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8"/></svg>
        </button>
      </span>
      <span class="shortcut-title">${title}</span>
    </div>
  `;
}

function renderDots() {
  const count = pageCount();
  if (count <= 1) {
    els.pageDots.innerHTML = '';
    return;
  }
  els.pageDots.innerHTML = Array.from({ length: count }, (_, index) => {
    const active = index === state.settings.currentPage ? ' active' : '';
    return `<button class="page-dot${active}" type="button" data-action="go-page" data-page="${index}" aria-label="第 ${index + 1} 页"></button>`;
  }).join('');
}

// ------------------------------------------------------------------ icons

function iconKeyFor(item) {
  if (item.icon?.type === 'letter') return 'letter';
  if (item.icon?.type === 'blob') return `blob:${item.icon.hash}`;
  if (item.icon?.type === 'url') return `url:${item.icon.url}`;
  return `auto:${urlKey(item.url)}`;
}

function iconSrcFor(item) {
  const key = iconKeyFor(item);
  if (key !== 'letter') {
    const shown = iconDisplay.get(item.id);
    if (shown && (shown.key === key || shown.interim)) return shown.url;
  }
  return iconKit.letterTile(item.title, item.url);
}

function setIconDisplay(id, key, blob, { interim = false } = {}) {
  const previous = iconDisplay.get(id);
  if (previous) URL.revokeObjectURL(previous.url);
  iconDisplay.set(id, { key, url: URL.createObjectURL(blob), interim });
}

function dropIconDisplay(id) {
  const previous = iconDisplay.get(id);
  if (previous) URL.revokeObjectURL(previous.url);
  iconDisplay.delete(id);
}

async function hydrateShortcutIcons() {
  const records = await getAllIconRecords().catch(() => []);
  const byId = new Map(records.map(record => [record.id, record]));
  const live = new Set(state.shortcuts.map(item => item.id));
  for (const id of [...iconDisplay.keys()]) if (!live.has(id)) dropIconDisplay(id);

  for (const item of state.shortcuts) {
    const key = iconKeyFor(item);
    const shown = iconDisplay.get(item.id);
    if (key === 'letter') {
      dropIconDisplay(item.id);
      continue;
    }
    if (shown?.key === key && !shown.interim) continue;

    if (item.icon?.type === 'blob') {
      const stored = await getBlobRecord(item.icon.hash).catch(() => null);
      if (stored?.blob) setIconDisplay(item.id, key, stored.blob);
      continue;
    }

    const record = byId.get(item.id);
    if (record && record.pipeline === iconKit.PIPELINE && record.key === key) {
      if (record.blob) setIconDisplay(item.id, key, record.blob);
      else if (!shown?.interim) dropIconDisplay(item.id);
    } else if (record?.blob && (record.pipeline ? record.key === key : legacyRecordMatches(record, item))) {
      // Drawn by an older version: keep showing it until it is redrawn.
      if (!shown) setIconDisplay(item.id, key, record.blob, { interim: true });
    } else if (shown && shown.key !== key) {
      dropIconDisplay(item.id);
    }
  }
}

// Version 1 pictures name their site in the source address (the site itself,
// or a favicon service asked about it); skip them once the address changed.
function legacyRecordMatches(record, item) {
  const host = hostnameFromUrl(item.url);
  if (!host) return false;
  let source = String(record.sourceUrl || '');
  try {
    source = decodeURIComponent(source);
  } catch {
    // Keep the raw address.
  }
  return source.toLowerCase().includes(host.toLowerCase());
}

function refreshIconElements(id) {
  const item = state.shortcuts.find(shortcut => shortcut.id === id);
  if (!item) return;
  const src = iconSrcFor(item);
  document.querySelectorAll(`.shortcut-card[data-id="${CSS.escape(id)}"] .shortcut-icon img`).forEach(img => {
    if (img.getAttribute('src') !== src) img.src = src;
  });
}

function iconResolverDisabled() {
  return Boolean(globalThis.__TOMORIN_DISABLE_AUTO_ICON_CACHE);
}

async function queueStaleIcons() {
  if (iconResolverDisabled()) return;
  const records = await getAllIconRecords().catch(() => []);
  const byId = new Map(records.map(record => [record.id, record]));
  const live = new Set(state.shortcuts.map(item => item.id));
  for (const record of records) {
    if (!live.has(record.id)) deleteIconRecord(record.id).catch(() => {});
  }
  const now = Date.now();
  for (const item of orderedShortcuts()) {
    const key = iconKeyFor(item);
    if (key === 'letter' || item.icon?.type === 'blob') continue;
    const record = byId.get(item.id);
    const current = record && record.pipeline === iconKit.PIPELINE && record.key === key;
    if (!current) {
      queueIcon(item.id);
      continue;
    }
    const age = now - (record.resolvedAt || 0);
    if (record.transient && age > transientRetryDelay(record.attempts)) queueIcon(item.id);
    else if (!record.blob && age > ICON_RECHECK_MISSING_MS) queueIcon(item.id);
    else if (record.blob && Math.min(record.width || 0, record.height || 0) < 64 && age > ICON_RECHECK_SMALL_MS) queueIcon(item.id);
  }
}

// 20 minutes, then 1 h, 3 h, 9 h … up to 3 days, so a favicon service that is
// never reachable from this network is not asked again every few minutes.
function transientRetryDelay(attempts = 1) {
  return Math.min(ICON_RETRY_TRANSIENT_MS * 3 ** Math.max(0, attempts - 1), ICON_RECHECK_SMALL_MS);
}

function queueIcon(id) {
  if (iconResolverDisabled() || iconQueued.has(id)) return;
  iconQueued.add(id);
  iconQueue.push(id);
  while (iconWorkers < ICON_WORKERS && iconQueue.length) {
    iconWorkers += 1;
    runIconWorker().finally(() => { iconWorkers -= 1; });
  }
}

async function runIconWorker() {
  while (iconQueue.length) {
    const id = iconQueue.shift();
    try {
      await resolveIcon(id);
    } catch {
      // A failed lookup only means the letter tile stays for now.
    } finally {
      iconQueued.delete(id);
    }
  }
}

// Looks up the picture for one shortcut. Only the local cache changes; the
// shortcut itself is untouched, so this never triggers a sync.
async function resolveIcon(id) {
  const item = state.shortcuts.find(shortcut => shortcut.id === id);
  if (!item) return;
  const key = iconKeyFor(item);
  if (key === 'letter' || item.icon?.type === 'blob') return;
  if (navigator.onLine === false) return;

  let result = null;
  let reachable = true;
  let complete = true;
  let retry = false;
  if (item.icon?.type === 'url') {
    const picked = await iconKit.resolveFromUrl(item.icon.url);
    result = picked.result;
    // The picked picture could not be fetched right now: show the automatic
    // one meanwhile and try the picked one again later.
    if (!result && !picked.complete) retry = true;
  }
  if (!result) {
    const found = await iconKit.resolveBest(item.url);
    result = found.result;
    reachable = found.reachable;
    complete = found.complete;
  }
  if (!result && !reachable) return;

  const latest = state.shortcuts.find(shortcut => shortcut.id === id);
  if (!latest || iconKeyFor(latest) !== key) return;
  await storeIconResult(id, key, result, { complete: complete && !retry, retry });
}

function iconSide(entry) {
  if (!entry?.blob) return -1;
  if (entry.kind === 'legacy') return 0;
  return Math.min(entry.width || 0, entry.height || 0);
}

async function storeIconResult(id, key, result, { complete = true, retry = false } = {}) {
  const existing = await getIconRecord(id).catch(() => null);
  const shown = iconDisplay.get(id);
  const sameTarget = existing?.blob && (existing.key === key || (shown?.interim && existing.pipeline !== iconKit.PIPELINE));
  // A lookup that found nothing, or was cut short, never replaces a picture
  // with a worse one (for example another tab finishing a slower lookup). A
  // tile drawn by an older version is only kept when nothing was found.
  const currentStyle = existing?.pipeline === iconKit.PIPELINE;
  if (sameTarget && (!result || (currentStyle && !complete && iconSide(existing) >= iconSide(result)))) {
    result = {
      blob: existing.blob,
      sourceUrl: existing.sourceUrl || '',
      width: existing.width || 0,
      height: existing.height || 0,
      kind: existing.pipeline ? existing.kind : 'legacy',
    };
  }
  // Some requests failed: a sharper icon may exist, so look again later.
  const transient = retry || (!complete && iconSide(result) < ICON_SHARP_SIDE);
  const attempts = transient ? ((existing?.key === key && existing.transient ? existing.attempts || 0 : 0) + 1) : 0;
  await saveIconRecord({
    id,
    key,
    pipeline: iconKit.PIPELINE,
    blob: result?.blob || null,
    sourceUrl: result?.sourceUrl || '',
    width: result?.width || 0,
    height: result?.height || 0,
    kind: result?.kind || 'letter',
    transient,
    attempts,
    resolvedAt: Date.now(),
  });
  if (result?.blob) setIconDisplay(id, key, result.blob);
  else dropIconDisplay(id);
  refreshIconElements(id);
}

// ---------------------------------------------------------------- search

async function handleSearch(event) {
  event.preventDefault();
  const raw = els.searchInput.value.trim();
  if (!raw) return;

  if (looksLikeUrl(raw)) {
    window.location.href = normalizeUrl(raw);
    return;
  }

  if (normalizeSearchEngine(state.settings.searchEngine) === 'bing') {
    window.location.href = searchUrl('bing', raw);
    return;
  }

  try {
    if (hasChromeSearch) {
      await chrome.search.query({ text: raw, disposition: 'CURRENT_TAB' });
    } else {
      window.location.href = searchUrl('google', raw);
    }
  } catch {
    window.location.href = searchUrl('google', raw);
  }
}

function searchUrl(engine, query) {
  const url = new URL(engine === 'bing' ? 'https://www.bing.com/search' : 'https://www.google.com/search');
  url.searchParams.set('q', query);
  return url.toString();
}

function looksLikeUrl(value) {
  if (/^https?:\/\//i.test(value)) return true;
  if (/\s/.test(value)) return false;
  return /^localhost(:\d+)?(\/|$)/i.test(value)
    || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(value)
    || /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(value);
}

function normalizeSearchEngine(searchEngine) {
  return SEARCH_ENGINES.has(searchEngine) ? searchEngine : 'default';
}

function searchEngineLabel(searchEngine) {
  return { default: '默认', bing: 'Bing' }[normalizeSearchEngine(searchEngine)];
}

async function setSearchEngine(searchEngine) {
  state.settings.searchEngine = normalizeSearchEngine(searchEngine);
  await persistState();
  applySearchEngineControl();
  showToast(`搜索：${searchEngineLabel(state.settings.searchEngine)}`);
}

// ---------------------------------------------------------------- clicks

async function handleDocumentClick(event) {
  const card = event.target.closest('.shortcut-card');
  const actionTarget = event.target.closest('[data-action]');

  if (editMode && card && !actionTarget) {
    event.preventDefault();
    openShortcutDialog(card.dataset.id);
    return;
  }

  if (!editMode && card && !actionTarget) {
    window.location.href = card.dataset.url;
    return;
  }

  if (!actionTarget) {
    if (editMode && shouldExitEditModeForClick(event)) exitEditMode();
    return;
  }

  const { action } = actionTarget.dataset;
  const handlers = {
    'add-shortcut': () => {
      if (editMode) event.preventDefault();
      openShortcutDialog();
    },
    'remove-shortcut': () => removeShortcut(actionTarget.dataset.id, { undoable: true }),
    'close-dialog': () => closeShortcutDialog(),
    'delete-shortcut': () => deleteEditingShortcut(),
    'select-icon': () => selectDialogIcon(actionTarget),
    'open-sync-dialog': () => openSyncDialog(),
    'close-sync-dialog': () => closeSyncDialog(),
    'toggle-sync-password': () => toggleSyncPasswordVisibility(actionTarget),
    'sync-now': () => syncNowFromDialog(),
    'sync-choice-confirm': () => confirmSyncChoice(),
    'sync-choice-later': () => showSyncMain(),
    'restore-backup': () => restoreBackup(actionTarget),
    'go-page': () => goToPage(Number(actionTarget.dataset.page)),
    'set-density': () => setDensity(actionTarget.dataset.density),
    'set-search-engine': () => setSearchEngine(actionTarget.dataset.searchEngine),
    'reset-wallpaper': () => resetWallpaper(),
  };
  await handlers[action]?.();
}

function shouldExitEditModeForClick(event) {
  // A target removed by another handler (for example the undo button) was not
  // a click on empty space.
  if (!event.target.isConnected) return false;
  return !els.dialog.open
    && !els.syncDialog.open
    && !event.target.closest('.settings-menu')
    && !event.target.closest('.shortcut-dialog')
    && !event.target.closest('.toast');
}

function handleShortcutContextMenu(event) {
  const card = event.target.closest('.shortcut-card');
  if (!card || event.target.closest('[data-action]')) return;
  event.preventDefault();
  enterEditMode();
}

function enterEditMode() {
  if (editMode) return;
  editMode = true;
  render();
}

function exitEditMode() {
  if (!editMode) return;
  editMode = false;
  draggedId = null;
  setActiveDropSlot(null);
  render();
}

function handleKeydown(event) {
  if (event.key === 'Escape' && els.dialog.open) {
    closeShortcutDialog();
    return;
  }
  if (event.key === 'Escape' && els.syncDialog.open) {
    closeSyncDialog();
    return;
  }
  if (event.key === 'Escape' && editMode) {
    exitEditMode();
    return;
  }

  const typing = event.target.closest?.('input, textarea, select, [contenteditable="true"]');
  const dialogOpen = els.dialog.open || els.syncDialog.open;
  if (!typing && !dialogOpen) {
    if (event.key === 'ArrowLeft') goToPage(state.settings.currentPage - 1);
    if (event.key === 'ArrowRight') goToPage(state.settings.currentPage + 1);
  }

  const focusedCard = document.activeElement?.closest?.('.shortcut-card');
  if (!focusedCard || dialogOpen || document.activeElement?.closest('[data-action]')) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (editMode) openShortcutDialog(focusedCard.dataset.id);
    else window.location.href = focusedCard.dataset.url;
  }
  if (editMode && (event.key === 'Delete' || event.key === 'Backspace')) {
    event.preventDefault();
    removeShortcut(focusedCard.dataset.id, { undoable: true });
  }
}

// ------------------------------------------------------------ shortcuts

async function setDensity(density) {
  if (!core.SIZES.includes(density)) return;
  state.settings.iconDensity = density;
  state.settings.iconDensityAt = nextStamp();
  await commitChange({ touchesShortcuts: false });
  render();
  showToast(`图标大小：${{ small: '小', medium: '中', large: '大' }[density]}`);
}

async function handleShortcutSubmit(event) {
  event.preventDefault();
  const title = core.cleanTitle(els.titleInput.value);
  const rawUrl = els.urlInput.value.trim();
  const size = els.shortcutForm.elements.shortcutSize.value;
  if (!title || !rawUrl) return;
  const url = normalizeUrl(rawUrl);
  if (!isHttpUrl(url)) {
    showToast('网址格式不正确');
    return;
  }

  const duplicate = state.shortcuts.find(item => item.id !== editingId && urlKey(item.url) === urlKey(url));
  if (duplicate) {
    showToast(`这个网址已经在收藏里了：${duplicate.title}`);
    return;
  }

  const icon = await dialogIconForSave();
  const previous = editingId ? state.shortcuts.find(item => item.id === editingId) : null;
  if (editingId && !previous) {
    showToast('这个网站已在别处被删除');
    closeShortcutDialog();
    return;
  }

  let saved;
  if (previous) {
    const changed = previous.title !== title || previous.url !== url || previous.size !== size
      || JSON.stringify(previous.icon || null) !== JSON.stringify(icon || null);
    if (urlKey(previous.url) !== urlKey(url)) {
      // The cached picture belongs to the old address.
      dropIconDisplay(previous.id);
      await deleteIconRecord(previous.id).catch(() => {});
    }
    saved = changed ? { ...previous, title, url, size, icon, editedAt: nextStamp() } : previous;
    state.shortcuts = state.shortcuts.map(item => (item.id === previous.id ? saved : item));
    if (changed) await commitChange();
    showToast(changed ? '已更新' : '没有改动');
  } else {
    const ordered = orderedShortcuts();
    const stamp = nextStamp();
    saved = {
      id: crypto.randomUUID(),
      title,
      url,
      size: core.SIZES.includes(size) ? size : 'small',
      icon,
      pos: core.keyBetween(ordered.length ? ordered[ordered.length - 1].pos : null, null),
      editedAt: stamp,
      movedAt: stamp,
      createdAt: stamp,
    };
    state.shortcuts.push(saved);
    await commitChange();
    state.settings.currentPage = pageCount() - 1;
    showToast('已添加');
  }

  await applyDialogIconToCache(saved);
  closeShortcutDialog();
  render();
  if (!iconResolverDisabled()) {
    const record = await getIconRecord(saved.id).catch(() => null);
    if (!record || record.key !== iconKeyFor(saved) || record.pipeline !== iconKit.PIPELINE) queueIcon(saved.id);
  }
}

async function removeShortcut(id, { undoable = false } = {}) {
  const item = state.shortcuts.find(shortcut => shortcut.id === id);
  if (!item) return;
  const card = activeShortcutPage()?.querySelector(`[data-id="${CSS.escape(id)}"]`);
  card?.classList.add('removing');
  await sleep(card ? 200 : 0);

  const iconRecord = await getIconRecord(id).catch(() => null);
  // Change and save in one step so a write from another tab cannot slip in between.
  state.shortcuts = state.shortcuts.filter(shortcut => shortcut.id !== id);
  state.tombstones = [...state.tombstones.filter(tomb => tomb.to || tomb.id !== id), { id, deletedAt: nextStamp() }];
  await commitChange();
  dropIconDisplay(id);
  await deleteIconRecord(id).catch(() => {});
  render();

  if (undoable) showToast(`已删除「${item.title}」`, { label: '撤销', run: () => restoreShortcut(item, iconRecord) });
  else showToast('已删除');
}

async function restoreShortcut(item, iconRecord) {
  if (state.shortcuts.some(shortcut => shortcut.id === item.id)) return;
  const duplicate = state.shortcuts.find(shortcut => urlKey(shortcut.url) === urlKey(item.url));
  if (duplicate) {
    showToast('这个网址已经重新添加过了');
    return;
  }
  state.tombstones = state.tombstones.filter(tomb => tomb.to || tomb.id !== item.id);
  state.shortcuts.push({ ...item, editedAt: nextStamp() });
  await commitChange();
  if (iconRecord) {
    await saveIconRecord(iconRecord).catch(() => {});
    if (iconRecord.blob) setIconDisplay(item.id, iconRecord.key || iconKeyFor(item), iconRecord.blob, { interim: !iconRecord.pipeline });
  }
  render();
  showToast('已恢复');
}

async function deleteEditingShortcut() {
  if (!editingId) return;
  const id = editingId;
  closeShortcutDialog();
  await removeShortcut(id);
}

function reorderShortcutToIndex(sourceId, targetIndex) {
  const ordered = orderedShortcuts();
  const from = ordered.findIndex(item => item.id === sourceId);
  if (from === -1 || !Number.isFinite(targetIndex)) return false;
  const rest = ordered.filter(item => item.id !== sourceId);
  const at = Math.max(0, Math.min(targetIndex, rest.length));
  if (at === from) return false;

  const plan = core.planInsert(rest, at);
  const stamp = nextStamp();
  const rekey = new Map(plan.rekey.map(entry => [entry.id, entry.pos]));
  state.shortcuts = withOrder(core.sortShortcuts(state.shortcuts.map(item => {
    if (item.id === sourceId) return { ...item, pos: plan.pos, movedAt: stamp };
    if (rekey.has(item.id)) return { ...item, pos: rekey.get(item.id), movedAt: stamp };
    return item;
  })));
  movedShortcutId = sourceId;
  return true;
}

// --------------------------------------------------------- edit dialog

function openShortcutDialog(id = null) {
  editingId = id;
  const item = id ? state.shortcuts.find(shortcut => shortcut.id === id) : null;
  els.dialogTitle.textContent = item ? '编辑网站' : '添加网站';
  els.titleInput.value = item?.title || '';
  els.urlInput.value = item?.url || '';
  els.shortcutForm.elements.shortcutSize.value = item?.size || 'small';
  els.iconInput.value = '';
  els.deleteButton.hidden = !item;
  dialogIcon = dialogIconFromItem(item);
  dialogChoices = [];
  dialogChoicesKey = '';
  dialogChoicesLoading = false;
  renderIconOptions();
  if (item) loadDialogChoices(item.url);
  if (item?.icon?.type === 'blob') loadDialogCustomPreview(item.icon);
  els.dialog.showModal();
  requestAnimationFrame(() => els.titleInput.focus());
}

function closeShortcutDialog() {
  editingId = null;
  dialogIcon = { choice: 'auto' };
  clearTimeout(dialogUrlTimer);
  els.iconInput.value = '';
  if (els.dialog.open) els.dialog.close();
  releaseDialogObjectUrls();
}

function releaseDialogObjectUrls() {
  for (const url of dialogObjectUrls) URL.revokeObjectURL(url);
  dialogObjectUrls.clear();
  dialogChoices = [];
  dialogChoicesKey = '';
  dialogChoicesLoading = false;
}

function dialogObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  dialogObjectUrls.add(url);
  return url;
}

function dialogIconFromItem(item) {
  const icon = item?.icon;
  if (icon?.type === 'url') return { choice: 'url', url: icon.url };
  if (icon?.type === 'letter') return { choice: 'letter' };
  if (icon?.type === 'blob') return { choice: 'blob', hash: icon.hash, mime: icon.mime, blob: null, preview: '' };
  return { choice: 'auto' };
}

async function loadDialogCustomPreview(icon) {
  const record = await getBlobRecord(icon.hash).catch(() => null);
  if (!record?.blob || dialogIcon.choice !== 'blob' || dialogIcon.hash !== icon.hash) return;
  dialogIcon.blob = record.blob;
  dialogIcon.preview = dialogObjectUrl(record.blob);
  renderIconOptions();
}

function handleDialogUrlInput() {
  clearTimeout(dialogUrlTimer);
  renderIconOptions();
  const value = els.urlInput.value.trim();
  if (!value) return;
  dialogUrlTimer = setTimeout(() => loadDialogChoices(normalizeUrl(value)), 500);
}

async function loadDialogChoices(url) {
  const key = urlKey(url);
  if (!key || key === dialogChoicesKey) return;
  dialogChoicesKey = key;
  dialogChoices = [];
  dialogChoicesLoading = true;
  renderIconOptions();
  let choices = [];
  try {
    choices = await iconKit.listChoices(url);
  } catch {
    choices = [];
  }
  if (dialogChoicesKey !== key || !els.dialog.open) return;
  dialogChoices = choices.map(choice => ({ ...choice, preview: dialogObjectUrl(choice.blob) }));
  dialogChoicesLoading = false;
  renderIconOptions();
}

function dialogPreviewItem() {
  const url = els.urlInput.value.trim() ? normalizeUrl(els.urlInput.value) : 'https://example.com';
  return { id: editingId || '', title: els.titleInput.value || hostnameFromUrl(url), url, icon: null };
}

function autoPreviewSrc(previewItem) {
  const existing = editingId ? state.shortcuts.find(item => item.id === editingId) : null;
  if (existing && urlKey(existing.url) === urlKey(previewItem.url)) {
    const shown = iconDisplay.get(existing.id);
    if (shown && (shown.key === `auto:${urlKey(existing.url)}` || shown.interim)) return shown.url;
  }
  const automatic = dialogChoices.find(choice => !choice.source.startsWith('brand'));
  return automatic ? automatic.preview : iconKit.letterTile(previewItem.title, previewItem.url);
}

function renderIconOptions() {
  const preview = dialogPreviewItem();
  const option = ({ choice, label, src, pressed, extra = '', title = label }) => `
    <button class="icon-option" type="button" data-action="select-icon" data-icon-choice="${choice}" aria-pressed="${pressed}" title="${escapeHtml(title)}" ${extra}>
      <span class="icon-option-tile"><img src="${escapeHtml(src)}" alt=""></span>
      <span class="icon-option-label">${escapeHtml(label)}</span>
    </button>
  `;

  const parts = [option({
    choice: 'auto',
    label: '自动',
    title: '自动选择最清晰的图标',
    src: autoPreviewSrc(preview),
    pressed: dialogIcon.choice === 'auto',
  })];

  // A picture picked earlier that is not among the current results.
  if (dialogIcon.choice === 'url' && !dialogChoices.some(choice => choice.url === dialogIcon.url)) {
    const shown = editingId ? iconDisplay.get(editingId) : null;
    parts.push(option({
      choice: 'url',
      label: '当前',
      title: dialogIcon.url,
      src: shown?.url || iconKit.letterTile(preview.title, preview.url),
      pressed: true,
      extra: `data-icon-url="${escapeHtml(dialogIcon.url)}" data-icon-kind="current"`,
    }));
  }

  dialogChoices.forEach(choice => {
    const size = choice.isSvg ? 'SVG' : `${Math.min(choice.width, choice.height)}px`;
    parts.push(option({
      choice: 'url',
      label: size,
      title: choice.url,
      src: choice.preview,
      pressed: dialogIcon.choice === 'url' && dialogIcon.url === choice.url,
      extra: `data-icon-url="${escapeHtml(choice.url)}" data-icon-kind="${escapeHtml(choice.source)}"`,
    }));
  });

  if (dialogChoicesLoading) {
    parts.push('<span class="icon-option is-loading" aria-hidden="true"><span class="icon-option-tile"></span><span class="icon-option-label">查找中</span></span>');
  }

  parts.push(option({
    choice: 'letter',
    label: '文字',
    title: '用名称首字做图标',
    src: iconKit.letterTile(preview.title, preview.url),
    pressed: dialogIcon.choice === 'letter',
  }));

  if (dialogIcon.choice === 'blob') {
    parts.push(option({
      choice: 'blob',
      label: '自定义',
      src: dialogIcon.preview || iconKit.letterTile(preview.title, preview.url),
      pressed: true,
    }));
  }

  parts.push(`
    <label class="icon-option upload-option" for="shortcutIconInput" title="上传图片作为图标">
      <span class="icon-option-tile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5V5.5m0 0L8 9.5m4-4l4 4M5.5 18.5h13"/></svg></span>
      <span class="icon-option-label">上传</span>
    </label>
  `);

  els.iconOptions.innerHTML = parts.join('');
}

function selectDialogIcon(button) {
  const choice = button.dataset.iconChoice;
  if (choice === 'url') dialogIcon = { choice: 'url', url: button.dataset.iconUrl };
  else if (choice === 'letter') dialogIcon = { choice: 'letter' };
  else if (choice === 'blob') return;
  else dialogIcon = { choice: 'auto' };
  renderIconOptions();
}

async function handleShortcutIconUpload(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件');
    return;
  }
  try {
    const blob = await iconKit.normalizeUpload(file);
    const hash = await iconKit.sha256Hex(await blob.arrayBuffer());
    dialogIcon = { choice: 'blob', hash, mime: 'image/png', blob, preview: dialogObjectUrl(blob) };
    renderIconOptions();
    showToast('图标已选择');
  } catch {
    showToast('图标处理失败');
  }
}

async function dialogIconForSave() {
  if (dialogIcon.choice === 'url' && isHttpUrl(dialogIcon.url)) return { type: 'url', url: dialogIcon.url };
  if (dialogIcon.choice === 'letter') return { type: 'letter' };
  if (dialogIcon.choice === 'blob' && dialogIcon.hash) {
    if (dialogIcon.blob) await saveBlobRecord(dialogIcon.hash, dialogIcon.blob, dialogIcon.mime || 'image/png');
    return { type: 'blob', hash: dialogIcon.hash, mime: dialogIcon.mime || 'image/png' };
  }
  return null;
}

// Use what the dialog already downloaded so the tile updates right away.
async function applyDialogIconToCache(item) {
  const key = iconKeyFor(item);
  if (key === 'letter') {
    dropIconDisplay(item.id);
    return;
  }
  if (item.icon?.type === 'blob') {
    const blob = dialogIcon.blob || (await getBlobRecord(item.icon.hash).catch(() => null))?.blob;
    if (blob) setIconDisplay(item.id, key, blob);
    return;
  }
  if (item.icon?.type === 'url') {
    const choice = dialogChoices.find(entry => entry.url === item.icon.url);
    if (choice) await storeIconResult(item.id, key, { ...choice, sourceUrl: choice.url });
    return;
  }
  const shown = iconDisplay.get(item.id);
  if (shown?.key === key) return;
  dropIconDisplay(item.id);
  // Automatic icon for a new or changed address: reuse the sharpest result the
  // dialog already found, unless it is small (the background lookup also tries
  // the mobile site in that case).
  const automatic = dialogChoices.find(choice => !choice.source.startsWith('brand'));
  if (automatic && dialogChoicesKey === urlKey(item.url) && (automatic.isSvg || Math.min(automatic.width, automatic.height) >= 64)) {
    await storeIconResult(item.id, key, { ...automatic, sourceUrl: automatic.url });
  }
}

// ------------------------------------------------------------ dragging

function handleDragStart(event) {
  const card = event.target.closest('.shortcut-card');
  if (!editMode || !card) {
    event.preventDefault();
    return;
  }
  draggedId = card.dataset.id;
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedId);
}

function handleDragOver(event) {
  if (!editMode || !draggedId) return;
  const slot = event.target.closest('.shortcut-slot');
  if (!slot) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  setActiveDropSlot(slot);
}

async function handleDrop(event) {
  if (!editMode || !draggedId) return;
  const target = event.target.closest('.shortcut-slot');
  if (!target) return;
  event.preventDefault();
  const moved = reorderShortcutToIndex(draggedId, Number(target.dataset.globalIndex));
  draggedId = null;
  setActiveDropSlot(null);
  if (moved) await commitChange();
  render();
}

// While dragging, holding the icon beside the grid or over a page dot turns
// the page, so a shortcut can be moved to any page.
function handleDragFlip(event) {
  if (!editMode || !draggedId) return;
  const target = dragFlipTarget(event);
  const current = state.settings.currentPage;
  els.shortcutArea.classList.toggle('flip-prev', target !== null && target < current);
  els.shortcutArea.classList.toggle('flip-next', target !== null && target > current);
  if (target === null) {
    dragFlip = null;
    return;
  }
  event.preventDefault();
  const now = performance.now();
  if (!dragFlip || dragFlip.page !== target) {
    dragFlip = { page: target, since: now };
    return;
  }
  if (now - dragFlip.since < DRAG_FLIP_DELAY_MS) return;
  dragFlip = null;
  goToPage(target);
}

function dragFlipTarget(event) {
  const current = state.settings.currentPage;
  const dot = event.target.closest?.('.page-dot');
  if (dot) {
    const page = Number(dot.dataset.page);
    return Number.isFinite(page) && page !== current ? page : null;
  }
  const viewport = els.shortcutViewport.getBoundingClientRect();
  if (event.clientY < viewport.top - 40 || event.clientY > viewport.bottom + 40) return null;
  const page = activeShortcutPage();
  const style = page ? getComputedStyle(page) : null;
  const gridLeft = viewport.left + (style ? parseFloat(style.paddingLeft) || 0 : 0);
  const gridRight = viewport.right - (style ? parseFloat(style.paddingRight) || 0 : 0);
  if (event.clientX < Math.max(viewport.left + DRAG_FLIP_EDGE_PX, gridLeft - 4)) return current > 0 ? current - 1 : null;
  if (event.clientX > Math.min(viewport.right - DRAG_FLIP_EDGE_PX, gridRight + 4)) return current < pageCount() - 1 ? current + 1 : null;
  return null;
}

function handleDragEnd() {
  draggedId = null;
  dragFlip = null;
  els.shortcutArea.classList.remove('flip-prev', 'flip-next');
  setActiveDropSlot(null);
  document.querySelectorAll('.shortcut-card.dragging').forEach(card => card.classList.remove('dragging'));
}

function setActiveDropSlot(slot) {
  if (activeDropSlot === slot) return;
  activeDropSlot?.classList.remove('drag-over');
  activeDropSlot = slot;
  activeDropSlot?.classList.add('drag-over');
}

// --------------------------------------------------------- page scroll

async function goToPage(page) {
  const nextPage = clampPage(page);
  if (nextPage === state.settings.currentPage) {
    scrollToShortcutPage(nextPage, { smooth: true });
    return;
  }
  state.settings.currentPage = nextPage;
  updateActivePageState();
  scrollToShortcutPage(nextPage, { smooth: true });
  await persistState();
}

function scrollToShortcutPage(page, { smooth = false } = {}) {
  const left = clampPage(page) * els.shortcutViewport.clientWidth;
  cancelAnimationFrame(pageScrollAnimation);
  pageScrollAnimation = 0;
  suppressScrollState = true;

  const startLeft = els.shortcutViewport.scrollLeft;
  const distance = left - startLeft;
  if (!smooth || Math.abs(distance) <= 2) {
    els.shortcutViewport.scrollLeft = left;
    requestAnimationFrame(() => {
      suppressScrollState = false;
    });
    return;
  }

  const startTime = performance.now();
  const animate = now => {
    const progress = Math.min(1, (now - startTime) / PAGE_SCROLL_DURATION_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    els.shortcutViewport.scrollLeft = startLeft + distance * eased;
    if (progress < 1) {
      pageScrollAnimation = requestAnimationFrame(animate);
      return;
    }
    els.shortcutViewport.scrollLeft = left;
    pageScrollAnimation = 0;
    suppressScrollState = false;
  };
  pageScrollAnimation = requestAnimationFrame(animate);
}

function handleShortcutScroll() {
  if (suppressScrollState) return;
  clearTimeout(pageScrollTimer);
  pageScrollTimer = setTimeout(async () => {
    const width = els.shortcutViewport.clientWidth || 1;
    const nextPage = clampPage(Math.round(els.shortcutViewport.scrollLeft / width));
    if (nextPage === state.settings.currentPage) return;
    state.settings.currentPage = nextPage;
    updateActivePageState();
    await persistState();
  }, 60);
}

function handleShortcutWheel(event) {
  if (shouldIgnorePageGesture(event)) return;
  if (event.target.closest('.shortcut-viewport')) return;
  if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  if (event.deltaX > 20) goToPage(state.settings.currentPage + 1);
  if (event.deltaX < -20) goToPage(state.settings.currentPage - 1);
}

function handleTouchStart(event) {
  if (shouldIgnorePageGesture(event)) return;
  if (event.target.closest('.shortcut-viewport')) return;
  touchStartX = event.changedTouches[0]?.clientX || 0;
}

function handleTouchEnd(event) {
  if (shouldIgnorePageGesture(event)) return;
  if (event.target.closest('.shortcut-viewport')) return;
  const endX = event.changedTouches[0]?.clientX || 0;
  const delta = endX - touchStartX;
  if (Math.abs(delta) < 60) return;
  goToPage(state.settings.currentPage + (delta < 0 ? 1 : -1));
}

function shouldIgnorePageGesture(event) {
  return els.dialog.open
    || els.syncDialog.open
    || Boolean(event.target.closest('.settings-menu, input, textarea, select'));
}

// ------------------------------------------------------------ wallpaper

async function handleWallpaperUpload(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件');
    return;
  }

  try {
    showToast('正在处理壁纸');
    const blob = await compressImage(file, 4096, 0.94);
    if (blob.size > MAX_WALLPAPER_BYTES) {
      showToast('壁纸超过 100 MB，无法同步');
      return;
    }
    const hash = await iconKit.sha256Hex(await blob.arrayBuffer());
    await saveBlobRecord(hash, blob, blob.type);
    state.settings.wallpaper = wallpaperSetting({ hash, mime: blob.type, size: blob.size, updatedAt: nextStamp() });
    await commitChange({ touchesShortcuts: false });
    await applyWallpaper();
    pruneLocalBlobs();
    showToast(syncConfigured() ? '壁纸已更新，正在同步' : '壁纸已更新');
  } catch {
    showToast('壁纸处理失败');
  }
}

async function resetWallpaper() {
  state.settings.wallpaper = wallpaperSetting({ hash: '', updatedAt: nextStamp() });
  await commitChange({ touchesShortcuts: false });
  await applyWallpaper();
  pruneLocalBlobs();
  showToast('壁纸已重置');
}

async function applyWallpaper() {
  if (activeWallpaperUrl) {
    URL.revokeObjectURL(activeWallpaperUrl);
    activeWallpaperUrl = null;
  }

  const blob = state.settings.wallpaper.hash ? await localBlob(state.settings.wallpaper.hash) : null;
  if (!blob) {
    els.body.classList.remove('has-wallpaper');
    els.body.style.removeProperty('--wallpaper-url');
    return;
  }

  activeWallpaperUrl = URL.createObjectURL(blob);
  els.body.style.setProperty('--wallpaper-url', `url("${activeWallpaperUrl}")`);
  els.body.classList.add('has-wallpaper');
}

function compressImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error('Unable to encode image'));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unable to load image'));
    };
    img.src = url;
  });
}

// ----------------------------------------------------------------- sync

class SyncError extends Error {}

function syncConfigured() {
  const sync = state.sync;
  return Boolean(sync.enabled && sync.endpoint && sync.password);
}

function normalizeSyncEndpoint(value) {
  const endpoint = String(value || '').trim().replace(/\/+$/, '');
  if (!endpoint) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

function scheduleSync(reason) {
  if (!syncConfigured()) return;
  clearTimeout(syncTimer);
  const delay = { startup: 600, busy: 3000 }[reason] ?? SYNC_DEBOUNCE_MS;
  syncTimer = setTimeout(async () => {
    const result = await runSync({ reason: reason === 'busy' ? 'change' : reason }).catch(() => null);
    // Another sync (in this tab or another one) was still running, for example
    // downloading a wallpaper: try again so this change is not left behind.
    if (result?.status === 'busy') scheduleSync('busy');
  }, delay);
}

async function runSync({ reason = 'manual', interactive = false, choice = null } = {}) {
  if (!syncConfigured()) return { status: 'disabled' };
  const recentlyChecked = Date.now() - (state.sync.lastCheckAt || 0) < SYNC_MIN_CHECK_INTERVAL_MS;
  if (!interactive && reason !== 'change' && !state.sync.dirty && recentlyChecked && !pendingChoice) return { status: 'skipped' };
  if (pendingChoice && !choice && !interactive) return { status: 'needs-choice' };
  return await withSyncLock(() => syncOnce({ interactive, choice }), { wait: interactive });
}

async function withSyncLock(task, { wait = false } = {}) {
  // A sync started from the dialog waits for a running one, then runs with
  // the settings just saved.
  while (currentSync) {
    if (!wait) return { status: 'busy' };
    await currentSync.catch(() => {});
  }
  const run = async () => {
    syncRunning = true;
    renderSyncStatus();
    try {
      return await task();
    } finally {
      syncRunning = false;
      syncProgress = '';
      renderSyncStatus();
    }
  };
  const locked = async () => {
    // One sync at a time across all open new tabs.
    if (navigator.locks?.request) {
      try {
        return await navigator.locks.request('tomorin-sync', wait ? {} : { ifAvailable: true }, lock => (lock ? run() : { status: 'busy' }));
      } catch (error) {
        if (error?.name !== 'SecurityError') throw error;
      }
    }
    return await run();
  };
  currentSync = locked();
  try {
    return await currentSync;
  } finally {
    currentSync = null;
  }
}

async function syncOnce({ interactive = false, choice = null } = {}) {
  // Every request of this run goes to the server it started with; if the
  // settings change meanwhile, the run stops and a new one starts.
  const target = { endpoint: state.sync.endpoint, password: state.sync.password };
  const endpoint = target.endpoint;
  const stale = () => state.sync.endpoint !== target.endpoint || state.sync.password !== target.password;
  // Taken once when "use cloud" is decided and kept across conflict retries,
  // so edits made during the first attempt are not mistaken for old data.
  let snapshot = null;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const firstSync = state.sync.linked !== endpoint;
      const knownRev = firstSync ? 0 : state.sync.rev;
      const remote = await fetchRemoteState(knownRev, target);
      if (stale()) return { status: 'stale' };
      // Edits made from now on must be newer than anything in the cloud copy.
      if (!remote.notModified) state.clock = Math.max(state.clock || 0, core.maxTimestamp(remote.doc));
      const localDoc = docFromState();

      if (remote.notModified && !state.sync.dirty) {
        const now = Date.now();
        state.sync = { ...state.sync, lastSyncAt: now, lastCheckAt: now, lastError: '' };
        await persistState();
        renderSyncAlert();
        await downloadMissingBlobs(docFromState(), target);
        return { status: 'ok' };
      }

      let result;
      let replace = false;
      const baseRev = remote.notModified ? knownRev : remote.rev;
      if (remote.notModified) {
        result = localDoc;
      } else if (firstSync) {
        const decision = choice || automaticFirstSyncChoice(localDoc, remote.doc);
        if (!decision) {
          pendingChoice = { summary: core.summarizeDifference(localDoc, remote.doc) };
          state.sync.lastCheckAt = Date.now();
          await persistState();
          announceSyncChoice(interactive);
          return { status: 'needs-choice' };
        }
        if (decision === 'cloud') {
          if (!snapshot) {
            snapshot = localDoc;
            if (core.hasContent(localDoc) && !state.pristine) await saveBackup(localDoc, '使用云端数据前');
          }
          result = core.adoptRemote(snapshot, remote.doc);
          replace = true;
        } else if (decision === 'local') {
          result = core.overrideRemote(localDoc, remote.doc, nextStamp());
        } else {
          result = core.mergeDocs(localDoc, remote.doc);
        }
      } else {
        result = core.mergeDocs(localDoc, remote.doc);
      }

      let rev = baseRev;
      if (remote.notModified || !core.sameDoc(result, remote.doc)) {
        if (stale()) return { status: 'stale' };
        const put = await putRemoteState(result, baseRev, target);
        if (put.conflict) continue;
        rev = put.rev;
      }
      if (stale()) return { status: 'stale' };

      if (!(await finishSync({ doc: result, rev, endpoint, replace, snapshot, stale }))) return { status: 'stale' };
      pendingChoice = null;
      // Use the state after merging: a wallpaper set during the request wins.
      await downloadMissingBlobs(docFromState(), target);
      return { status: 'ok' };
    }
    throw new SyncError('conflict');
  } catch (error) {
    state.sync.lastError = friendlySyncError(error);
    state.sync.lastCheckAt = Date.now();
    await persistState();
    renderSyncAlert();
    return { status: 'error', error };
  }
}

function automaticFirstSyncChoice(localDoc, remoteDoc) {
  if (!core.hasContent(remoteDoc)) return 'merge';
  if (state.pristine) return 'cloud';
  const signature = doc => doc.shortcuts.map(item => `${urlKey(item.url)}\u0001${item.title}\u0001${item.size}`).join('\u0002');
  return signature(localDoc) === signature(remoteDoc) ? 'merge' : null;
}

// Apply a synced document locally. Edits made while the request was in flight
// are merged in and synced on the next round.
async function finishSync({ doc, rev, endpoint, replace, snapshot = null, stale = () => false }) {
  if (!replace) {
    const current = docFromState();
    const preview = core.mergeDocs(current, doc);
    const remaining = new Set(preview.shortcuts.map(item => urlKey(item.url)));
    const removed = current.shortcuts.filter(item => !remaining.has(urlKey(item.url)));
    if (removed.length >= BACKUP_DELETE_THRESHOLD) await saveBackup(current, '同步删除多个网站前');
    if (stale()) return false;
  }

  // Merge and save without awaiting in between, so edits from other tabs that
  // arrived during the request are part of what gets saved.
  const before = docFromState();
  // "Use cloud" drops the old local copy, but not edits made since the choice
  // (for example in another tab while a wallpaper was uploading).
  const merged = replace
    ? core.mergeDocs(doc, snapshot ? core.changesSince(snapshot, before) : {})
    : core.mergeDocs(before, doc);
  const dirty = !core.sameDoc(merged, doc);
  const changed = !core.sameDoc(before, merged);
  const wallpaperBefore = state.settings.wallpaper.hash;
  state = stateWithDoc(state, merged);
  if (replace) {
    state.pristine = false;
    state.generation = (state.generation || 0) + 1;
    state.replaced = { generation: state.generation, snapshot: snapshot ? core.normalizeDoc(snapshot) : null };
  }
  const now = Date.now();
  state.sync = { ...state.sync, rev, linked: endpoint, dirty, lastSyncAt: now, lastCheckAt: now, lastError: '' };
  await persistState();
  if (changed) {
    await hydrateShortcutIcons();
    render();
    queueStaleIcons();
  } else {
    renderSyncAlert();
  }
  if (wallpaperBefore !== state.settings.wallpaper.hash) await applyWallpaper();
  if (dirty) scheduleSync('change');
  return true;
}

async function syncFetch(target, pathname, { method = 'GET', headers = {}, body = null, timeout = SYNC_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(`${target.endpoint}${pathname}`, {
      method,
      body,
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${encodeURIComponent(target.password)}`, ...headers },
    });
  } catch (error) {
    throw new SyncError(error?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

function responseError(response) {
  if (response.status === 401 || response.status === 403) return new SyncError('auth');
  if (response.status === 429) return new SyncError('rate-limited');
  if (response.status === 404 || response.status === 410) return new SyncError('server-outdated');
  if (response.status === 413) return new SyncError('too-large');
  return new SyncError(`HTTP ${response.status}`);
}

async function fetchRemoteState(knownRev, target) {
  const response = await syncFetch(target, '/api/v2/state', {
    headers: knownRev > 0 ? { 'If-None-Match': `"${knownRev}"` } : {},
  });
  if (response.status === 304) return { notModified: true };
  if (!response.ok) throw responseError(response);
  const payload = await response.json().catch(() => null);
  if (!payload || !Number.isInteger(payload.rev)) throw new SyncError('server-outdated');
  return { rev: payload.rev, doc: core.normalizeDoc(payload.state) };
}

async function putRemoteState(doc, rev, target) {
  for (let round = 0; round < 4; round += 1) {
    const response = await syncFetch(target, '/api/v2/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${rev}"` },
      body: JSON.stringify(doc),
    });
    if (response.ok) return { rev: (await response.json()).rev };
    if (response.status === 412) return { conflict: true };
    if (response.status === 409) {
      const payload = await response.json().catch(() => ({}));
      await uploadBlobs(Array.isArray(payload.missing) ? payload.missing : [], doc, target);
      continue;
    }
    throw responseError(response);
  }
  throw new SyncError('blob-upload');
}

async function uploadBlobs(hashes, doc, target) {
  const refs = new Map(core.blobRefs(doc).map(ref => [ref.hash, ref]));
  for (const hash of hashes) {
    const ref = refs.get(hash);
    const blob = await localBlob(hash);
    if (!blob) throw new SyncError('blob-missing');
    syncProgress = ref?.kind === 'wallpaper' ? `正在上传壁纸（${formatBytes(blob.size)}）…` : '正在上传图标…';
    renderSyncStatus();
    const response = await syncFetch(target, `/api/v2/blobs/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || ref?.mime || 'image/png' },
      body: blob,
      timeout: SYNC_BLOB_TIMEOUT_MS,
    });
    if (!response.ok) throw responseError(response);
  }
  syncProgress = '';
}

// Wallpapers and uploaded icons are stored by their hash, so a download can
// never overwrite a picture chosen meanwhile.
async function localBlob(hash) {
  const record = await getBlobRecord(hash).catch(() => null);
  if (record?.blob) return record.blob;
  // A wallpaper saved before pictures were stored by hash sits under one fixed
  // key; move it over if it is the one asked for.
  const legacy = await getLegacyWallpaper().catch(() => null);
  if (legacy && await iconKit.sha256Hex(await legacy.arrayBuffer()) === hash) {
    await saveBlobRecord(hash, legacy, legacy.type || 'image/jpeg');
    await deleteLegacyWallpaper().catch(() => {});
    return legacy;
  }
  return null;
}

// Forget pictures nothing refers to any more. Recent ones are kept: a picture
// may be saved a moment before the shortcut or wallpaper that uses it.
async function pruneLocalBlobs() {
  const backup = await readBackup();
  const records = await storeRequest(BLOB_STORE, 'readonly', store => store.getAll()).catch(() => []);
  const now = Date.now();
  for (const record of records || []) {
    if (now - (record.savedAt || 0) <= BLOB_PRUNE_AGE_MS) continue;
    // Checked against the state at this moment: it may have changed meanwhile.
    const used = new Set([
      ...core.blobRefs(docFromState()).map(ref => ref.hash),
      ...(backup ? core.blobRefs(backup.doc).map(ref => ref.hash) : []),
    ]);
    if (used.has(record.hash)) continue;
    await storeRequest(BLOB_STORE, 'readwrite', store => store.delete(record.hash)).catch(() => {});
  }
}

async function fetchBlob(hash, mime, target) {
  const response = await syncFetch(target, `/api/v2/blobs/${hash}`, { timeout: SYNC_BLOB_TIMEOUT_MS });
  if (response.status === 404) throw new SyncError('blob-missing');
  if (!response.ok) throw responseError(response);
  const buffer = await response.arrayBuffer();
  if (await iconKit.sha256Hex(buffer) !== hash) throw new SyncError('blob-corrupt');
  return new Blob([buffer], { type: mime || response.headers.get('content-type') || 'application/octet-stream' });
}

async function downloadMissingBlobs(doc, target) {
  try {
    if (doc.wallpaper.hash && !(await getBlobRecord(doc.wallpaper.hash).catch(() => null))) {
      syncProgress = '正在下载壁纸…';
      renderSyncStatus();
      const blob = await fetchBlob(doc.wallpaper.hash, doc.wallpaper.mime, target);
      await saveBlobRecord(doc.wallpaper.hash, blob, doc.wallpaper.mime);
      if (state.settings.wallpaper.hash === doc.wallpaper.hash) await applyWallpaper();
    }

    let iconsChanged = false;
    for (const ref of core.blobRefs(doc).filter(entry => entry.kind === 'icon')) {
      if (await getBlobRecord(ref.hash).catch(() => null)) continue;
      syncProgress = '正在下载图标…';
      renderSyncStatus();
      const blob = await fetchBlob(ref.hash, ref.mime, target);
      await saveBlobRecord(ref.hash, blob, ref.mime);
      iconsChanged = true;
    }
    if (iconsChanged) {
      await hydrateShortcutIcons();
      state.shortcuts.forEach(item => refreshIconElements(item.id));
    }
    pruneLocalBlobs();
  } catch (error) {
    state.sync.lastError = friendlySyncError(error);
    await persistState();
  } finally {
    syncProgress = '';
  }
}

function friendlySyncError(error) {
  const code = error?.message || '';
  return {
    auth: '同步密码不正确',
    'rate-limited': '密码错误次数太多，请 15 分钟后再试',
    'server-outdated': '同步服务器需要更新到新版本',
    network: '连不上同步服务器',
    timeout: '同步服务器响应超时',
    'too-large': '文件太大，服务器拒绝了上传（检查 Nginx 的 client_max_body_size）',
    'blob-missing': '云端缺少一张图片，请在原电脑上重新同步',
    'blob-corrupt': '下载的图片已损坏',
    conflict: '多台设备同时在同步，请稍后再试',
  }[code] || String(code || '网络不可用').slice(0, 120);
}

async function saveBackup(doc, reason) {
  const backup = { savedAt: Date.now(), reason, count: doc.shortcuts.length, doc };
  if (hasChromeStorage) await chrome.storage.local.set({ [BACKUP_KEY]: backup });
  else localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
}

async function readBackup() {
  try {
    const backup = hasChromeStorage
      ? (await chrome.storage.local.get(BACKUP_KEY))[BACKUP_KEY]
      : JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null');
    return backup?.doc ? backup : null;
  } catch {
    return null;
  }
}

async function clearBackup() {
  if (hasChromeStorage) await chrome.storage.local.remove(BACKUP_KEY);
  else localStorage.removeItem(BACKUP_KEY);
}

// Sites in the backup that are missing now. Restoring only adds them back and
// never removes anything, so it is safe on any computer.
function missingFromBackup(backup) {
  const ids = new Set(state.shortcuts.map(item => item.id));
  const keys = new Set(state.shortcuts.map(item => urlKey(item.url)));
  // Ids folded into another shortcut (same website) are not missing.
  const folded = new Set(state.tombstones.filter(tomb => tomb.to).map(tomb => tomb.id));
  return core.normalizeDoc(backup.doc).shortcuts
    .filter(item => !ids.has(item.id) && !folded.has(item.id) && !keys.has(urlKey(item.url)));
}

async function restoreBackup(button) {
  const backup = await readBackup();
  if (!backup) return;
  const missing = missingFromBackup(backup);
  if (!missing.length) {
    await clearBackup();
    renderBackupButton();
    showToast('没有需要恢复的网站');
    return;
  }
  if (button.dataset.confirming !== 'true') {
    button.dataset.confirming = 'true';
    button.textContent = `再点一次，加回 ${missing.length} 个网站`;
    setTimeout(() => {
      if (button.isConnected && button.dataset.confirming === 'true') renderBackupButton();
    }, 5000);
    return;
  }
  const stamp = nextStamp();
  const revived = new Set(missing.map(item => item.id));
  state.tombstones = state.tombstones.filter(tomb => tomb.to || !revived.has(tomb.id));
  state.shortcuts.push(...missing.map(item => ({ ...item, editedAt: stamp, movedAt: stamp })));
  await commitChange();
  await clearBackup();
  await hydrateShortcutIcons();
  render();
  queueStaleIcons();
  renderBackupButton();
  showToast(`已加回 ${missing.length} 个网站`);
}

// ------------------------------------------------------------ sync dialog

function openSyncDialog() {
  const sync = state.sync;
  els.syncEnabled.checked = Boolean(sync.enabled);
  els.syncEndpoint.value = sync.endpoint || '';
  els.syncPassword.value = sync.password || '';
  resetSyncPasswordVisibility();
  if (pendingChoice) showSyncChoice();
  else showSyncMain();
  renderSyncStatus();
  renderBackupButton();
  els.syncDialog.showModal();
  if (!pendingChoice) requestAnimationFrame(() => (sync.endpoint ? els.syncPassword : els.syncEndpoint).focus());
}

function closeSyncDialog() {
  resetSyncPasswordVisibility();
  if (els.syncDialog.open) els.syncDialog.close();
}

function showSyncMain() {
  els.syncMain.hidden = false;
  els.syncChoice.hidden = true;
}

function showSyncChoice() {
  if (!pendingChoice) return;
  const { summary } = pendingChoice;
  els.syncChoiceSummary.textContent = `云端有 ${summary.remoteCount} 个网站，本机有 ${summary.localCount} 个，其中 ${summary.common} 个相同。第一次同步，请选一下怎么处理：`;
  document.getElementById('choiceCloudDetail').textContent = summary.localOnly
    ? `本机改成和云端一样；只在本机的 ${summary.localOnly} 个会被移除（可以恢复）。适合新电脑或不常用的电脑。`
    : '本机改成和云端一样。适合新电脑或不常用的电脑。';
  document.getElementById('choiceMergeDetail').textContent = `两边的网站都保留，共 ${summary.mergedCount} 个，同一网址只留一个。`;
  document.getElementById('choiceLocalDetail').textContent = summary.remoteOnly
    ? `云端和其他电脑都改成本机这 ${summary.localCount} 个；只在云端的 ${summary.remoteOnly} 个会被移除。适合主力电脑。`
    : `云端和其他电脑都改成本机这 ${summary.localCount} 个。适合主力电脑。`;
  const preferred = summary.localOnly === 0 ? 'cloud' : 'merge';
  els.syncForm.querySelectorAll('input[name="syncChoice"]').forEach(input => {
    input.checked = input.value === preferred;
  });
  els.syncMain.hidden = true;
  els.syncChoice.hidden = false;
}

function announceSyncChoice(interactive) {
  renderSyncAlert();
  if (els.syncDialog.open) {
    showSyncChoice();
    renderSyncStatus();
  } else if (!interactive) {
    showToast('同步需要你确认一次', { label: '去处理', run: () => openSyncDialog() });
  }
}

async function confirmSyncChoice() {
  const choice = els.syncForm.querySelector('input[name="syncChoice"]:checked')?.value;
  if (!choice) return;
  pendingChoice = null;
  showSyncMain();
  const result = await runSync({ interactive: true, choice });
  renderSyncStatus();
  if (result.status === 'ok') {
    showToast({ cloud: '已改成云端数据', merge: '已合并两边的收藏', local: '已用本机数据覆盖云端' }[choice]);
    closeSyncDialog();
  }
}

function syncFieldsFromDialog() {
  const endpoint = normalizeSyncEndpoint(els.syncEndpoint.value);
  const password = els.syncPassword.value;
  const enabled = Boolean(els.syncEnabled.checked);
  const serverChanged = endpoint !== state.sync.endpoint;
  state.sync = {
    ...state.sync,
    enabled,
    endpoint,
    password,
    lastError: '',
    ...(serverChanged ? { rev: 0, linked: '', dirty: true, lastSyncAt: 0 } : {}),
  };
  if (serverChanged) pendingChoice = null;
  return { enabled, endpoint, password };
}

async function handleSyncSubmit(event) {
  event.preventDefault();
  const { enabled, endpoint, password } = syncFieldsFromDialog();
  if (enabled && (!endpoint || !password)) {
    await persistState();
    renderSyncStatus('请填写服务器地址和同步密码', 'error');
    return;
  }
  await persistState();
  if (!enabled) {
    showToast('同步已关闭');
    renderSyncAlert();
    closeSyncDialog();
    return;
  }
  await syncFromDialog();
}

async function syncNowFromDialog() {
  const { endpoint, password } = syncFieldsFromDialog();
  state.sync.enabled = true;
  els.syncEnabled.checked = true;
  if (!endpoint || !password) {
    await persistState();
    renderSyncStatus('请填写服务器地址和同步密码', 'error');
    return;
  }
  await persistState();
  await syncFromDialog();
}

async function syncFromDialog() {
  const result = await runSync({ interactive: true });
  renderSyncStatus();
  renderBackupButton();
  if (result.status === 'ok') {
    showToast('同步完成');
    closeSyncDialog();
  }
}

function resetSyncPasswordVisibility() {
  els.syncPassword.type = 'password';
  const button = document.querySelector('[data-action="toggle-sync-password"]');
  if (!button) return;
  button.textContent = '显示';
  button.setAttribute('aria-pressed', 'false');
}

function toggleSyncPasswordVisibility(button) {
  const visible = els.syncPassword.type === 'text';
  els.syncPassword.type = visible ? 'password' : 'text';
  button.textContent = visible ? '显示' : '隐藏';
  button.setAttribute('aria-pressed', String(!visible));
}

function renderSyncStatus(message = '', tone = '') {
  if (!els.syncStatus) return;
  const sync = state.sync;
  let title;
  let detail = '';
  let statusTone = tone || 'idle';

  if (message) {
    title = message;
  } else if (syncRunning) {
    title = '正在同步…';
    detail = syncProgress;
    statusTone = 'busy';
  } else if (!sync.enabled) {
    title = '未开启';
    detail = '开启后，收藏、排序、图标和壁纸会在你的电脑之间自动保持一致。';
  } else if (!sync.endpoint || !sync.password) {
    title = '请填写服务器地址和同步密码';
    statusTone = 'error';
  } else if (pendingChoice) {
    title = '需要你确认一次';
    detail = '本机和云端的收藏不一样。';
    statusTone = 'attention';
  } else if (sync.lastError) {
    title = '同步失败';
    detail = sync.lastError;
    statusTone = 'error';
  } else if (sync.lastSyncAt) {
    title = '已同步';
    const wallpaper = state.settings.wallpaper.hash ? ' · 壁纸已同步' : '';
    detail = `${formatRelativeTime(sync.lastSyncAt)} · 收藏 ${state.shortcuts.length} 个${wallpaper}`;
    statusTone = 'ok';
  } else {
    title = '尚未同步';
    detail = '点保存后会连接服务器并完成第一次同步。';
  }

  els.syncStatus.textContent = title;
  els.syncDetail.textContent = detail;
  els.syncDetail.hidden = !detail;
  els.syncStatusCard.dataset.tone = statusTone;
}

async function renderBackupButton() {
  const backup = await readBackup();
  const button = els.restoreBackupButton;
  if (!button) return;
  const missing = backup ? missingFromBackup(backup) : [];
  button.hidden = missing.length === 0;
  button.dataset.confirming = 'false';
  if (missing.length) button.textContent = `找回 ${formatTime(backup.savedAt)} ${backup.reason}的 ${missing.length} 个网站`;
}

function renderSyncAlert() {
  const needsAttention = Boolean(pendingChoice) || Boolean(state.sync.enabled && state.sync.lastError);
  els.settingsMenu.dataset.alert = String(needsAttention);
}

// ------------------------------------------------------------- IndexedDB

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WALLPAPER_STORE)) db.createObjectStore(WALLPAPER_STORE);
      if (!db.objectStoreNames.contains(ICON_STORE)) db.createObjectStore(ICON_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'hash' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withObjectStore(storeName, mode, callback) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      callback(store, resolve, reject);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function storeRequest(storeName, mode, run) {
  return withObjectStore(storeName, mode, (store, resolve, reject) => {
    const request = run(store);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

// Version 1 kept a single wallpaper under one key; read during migration and
// removed once it is stored by its hash.
function getLegacyWallpaper() {
  return storeRequest(WALLPAPER_STORE, 'readonly', store => store.get(LEGACY_WALLPAPER_ID));
}

function deleteLegacyWallpaper() {
  return storeRequest(WALLPAPER_STORE, 'readwrite', store => store.delete(LEGACY_WALLPAPER_ID));
}

function saveIconRecord(record) {
  return storeRequest(ICON_STORE, 'readwrite', store => store.put(record));
}

function getIconRecord(id) {
  return storeRequest(ICON_STORE, 'readonly', store => store.get(id));
}

async function getAllIconRecords() {
  return (await storeRequest(ICON_STORE, 'readonly', store => store.getAll())) || [];
}

function deleteIconRecord(id) {
  return storeRequest(ICON_STORE, 'readwrite', store => store.delete(id));
}

function saveBlobRecord(hash, blob, mime) {
  return storeRequest(BLOB_STORE, 'readwrite', store => store.put({ hash, blob, mime, size: blob.size, savedAt: Date.now() }));
}

function getBlobRecord(hash) {
  return storeRequest(BLOB_STORE, 'readonly', store => store.get(hash));
}

// ------------------------------------------------------------- utilities

function showToast(message, action = null) {
  els.toast.replaceChildren(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', event => {
      event.stopPropagation();
      hideToast();
      action.run();
    });
    els.toast.append(button);
  }
  els.toast.classList.toggle('has-action', Boolean(action));
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 8000 : 1800);
}

function hideToast() {
  els.toast.classList.remove('visible', 'has-action');
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRelativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return formatTime(timestamp);
}

function isImageDataUrl(value) {
  return typeof value === 'string'
    && (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value) || /^data:image\/svg\+xml,/i.test(value));
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error('Invalid data URL');
  const type = match[1] || 'image/png';
  const encoded = match[3] || '';
  const binary = match[2] ? atob(encoded) : decodeURIComponent(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}
