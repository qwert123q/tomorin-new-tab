'use strict';

const STORAGE_KEY = 'tomorinNewTabState';
const DB_NAME = 'tomorin-new-tab';
const DB_VERSION = 2;
const WALLPAPER_STORE = 'wallpapers';
const ICON_STORE = 'icons';
const WALLPAPER_ID = 'current';
const PAGE_CAPACITY = 40;
const SYNC_SCHEMA_VERSION = 1;
const SYNC_STARTUP_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SYNC_REQUEST_TIMEOUT_MS = 3500;
const SYNC_DEBOUNCE_MS = 900;
const DEFAULT_SHORTCUT_UPDATED_AT = 1700000000000;

const DEFAULT_SHORTCUTS = [
  { title: 'YouTube', url: 'https://www.youtube.com', size: 'small' },
  { title: 'TikTok', url: 'https://www.tiktok.com', size: 'small' },
  { title: 'X', url: 'https://x.com', size: 'small' },
  { title: 'GitHub', url: 'https://github.com', size: 'small' },
  { title: 'Agoda', url: 'https://www.agoda.com', size: 'small' },
];

const DEFAULT_STATE = {
  shortcuts: DEFAULT_SHORTCUTS.map((item, index) => ({
    id: crypto.randomUUID(),
    title: item.title,
    url: item.url,
    size: item.size,
    order: index,
    updatedAt: DEFAULT_SHORTCUT_UPDATED_AT,
  })),
  deletedShortcuts: [],
  settings: {
    currentPage: 0,
    wallpaper: { type: 'none' },
    iconDensity: 'small',
  },
  sync: {
    enabled: false,
    endpoint: '',
    token: '',
    lastSyncAt: 0,
    pending: false,
    lastError: '',
  },
};

const hasChromeStorage = Boolean(globalThis.chrome?.storage?.local);
const hasChromeRuntime = Boolean(globalThis.chrome?.runtime?.getURL);
const hasChromeSearch = Boolean(globalThis.chrome?.search?.query);

const els = {
  body: document.body,
  shell: document.querySelector('.newtab-shell'),
  searchForm: document.getElementById('searchForm'),
  searchInput: document.getElementById('searchInput'),
  shortcutPage: document.getElementById('shortcutPage'),
  emptyState: document.getElementById('emptyState'),
  pageDots: document.getElementById('pageDots'),
  toolbar: document.querySelector('.toolbar'),
  densityButtons: [...document.querySelectorAll('[data-action="set-density"]')],
  wallpaperInput: document.getElementById('wallpaperInput'),
  importInput: document.getElementById('importInput'),
  syncDialog: document.getElementById('syncDialog'),
  syncForm: document.getElementById('syncForm'),
  syncEnabled: document.getElementById('syncEnabled'),
  syncEndpoint: document.getElementById('syncEndpoint'),
  syncToken: document.getElementById('syncToken'),
  syncStatus: document.getElementById('syncStatus'),
  dialog: document.getElementById('shortcutDialog'),
  shortcutForm: document.getElementById('shortcutForm'),
  dialogTitle: document.getElementById('dialogTitle'),
  titleInput: document.getElementById('shortcutTitle'),
  urlInput: document.getElementById('shortcutUrl'),
  iconInput: document.getElementById('shortcutIconInput'),
  iconPreview: document.getElementById('shortcutIconPreview'),
  iconCandidates: document.getElementById('shortcutIconCandidates'),
  clearIconButton: document.getElementById('clearShortcutIconButton'),
  deleteButton: document.getElementById('deleteShortcutButton'),
  toast: document.getElementById('toast'),
};

let state = structuredClone(DEFAULT_STATE);
let editMode = false;
let editingId = null;
let draggedId = null;
let activeWallpaperUrl = null;
let toastTimer = null;
let touchStartX = 0;
let movedShortcutId = null;
let pendingCustomIcon = '';
let pendingIconUrl = '';
let pendingIconCleared = false;
let pendingOriginalUrl = '';
let syncTimer = null;
let syncInFlight = false;
const activeIconUrls = new Map();
const iconCacheInFlight = new Set();
const pageIconCandidateCache = new Map();
const pageIconCandidateRequests = new Map();

init();

async function init() {
  state = await loadState();
  await hydrateShortcutIcons();
  await applyWallpaper();
  bindEvents();
  render();
  if (!globalThis.__TOMORIN_DISABLE_AUTO_ICON_CACHE) cacheMissingShortcutIcons();
  scheduleSync('startup');
}

function bindEvents() {
  els.searchForm.addEventListener('submit', handleSearch);
  document.addEventListener('click', handleDocumentClick);
  els.shortcutForm.addEventListener('submit', handleShortcutSubmit);
  els.syncForm.addEventListener('submit', handleSyncSubmit);
  els.wallpaperInput.addEventListener('change', handleWallpaperUpload);
  els.importInput.addEventListener('change', handleInfinityImport);
  els.iconInput.addEventListener('change', handleShortcutIconUpload);
  els.iconCandidates.addEventListener('error', handleIconCandidateError, true);
  els.urlInput.addEventListener('input', () => {
    if (!pendingCustomIcon) {
      pendingIconUrl = '';
      pendingIconCleared = true;
      renderIconPreview();
    }
  });
  els.titleInput.addEventListener('input', () => {
    if (!pendingCustomIcon) {
      renderIconPreview();
    }
  });
  els.shortcutPage.addEventListener('load', handleShortcutIconLoad, true);
  els.shortcutPage.addEventListener('error', handleShortcutIconError, true);
  document.addEventListener('keydown', handleKeydown);
  els.shortcutPage.addEventListener('dragstart', handleDragStart);
  els.shortcutPage.addEventListener('dragover', handleDragOver);
  els.shortcutPage.addEventListener('drop', handleDrop);
  els.shortcutPage.addEventListener('dragend', handleDragEnd);
  els.shortcutPage.addEventListener('contextmenu', handleShortcutContextMenu);
  els.shortcutPage.addEventListener('wheel', handleShortcutWheel, { passive: true });
  els.shortcutPage.addEventListener('touchstart', handleTouchStart, { passive: true });
  els.shortcutPage.addEventListener('touchend', handleTouchEnd, { passive: true });
}

async function loadState() {
  try {
    const saved = hasChromeStorage
      ? (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
      : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || !Array.isArray(saved.shortcuts)) return structuredClone(DEFAULT_STATE);
    return normalizeState(saved);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function normalizeState(saved) {
  const deletedShortcuts = normalizeDeletedShortcuts(saved.deletedShortcuts);
  const shortcuts = saved.shortcuts
    .filter(item => item && item.title && item.url)
    .map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      title: String(item.title).slice(0, 80),
      url: normalizeUrl(String(item.url)),
      size: ['small', 'medium', 'large'].includes(item.size) ? item.size : 'small',
      iconId: typeof item.iconId === 'string' && item.iconId ? item.iconId : '',
      customIcon: isImageDataUrl(item.customIcon) ? item.customIcon : '',
      iconUrl: isHttpUrl(item.iconUrl) ? item.iconUrl : '',
      order: Number.isFinite(item.order) ? item.order : index,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : DEFAULT_SHORTCUT_UPDATED_AT,
    }))
    .filter(item => !isShortcutDeleted(item, deletedShortcuts))
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({ ...item, order: index }));

  const settings = {
    currentPage: Number.isFinite(saved.settings?.currentPage) ? saved.settings.currentPage : 0,
    wallpaper: saved.settings?.wallpaper?.type === 'uploaded'
      ? { type: 'uploaded' }
      : { type: 'none' },
    iconDensity: ['small', 'medium', 'large'].includes(saved.settings?.iconDensity)
      ? saved.settings.iconDensity
      : 'small',
  };

  const sync = {
    enabled: Boolean(saved.sync?.enabled),
    endpoint: normalizeSyncEndpoint(saved.sync?.endpoint || ''),
    token: typeof saved.sync?.token === 'string' ? saved.sync.token : '',
    lastSyncAt: Number.isFinite(saved.sync?.lastSyncAt) ? saved.sync.lastSyncAt : 0,
    pending: Boolean(saved.sync?.pending),
    lastError: typeof saved.sync?.lastError === 'string' ? saved.sync.lastError.slice(0, 160) : '',
  };

  return { shortcuts, deletedShortcuts, settings, sync };
}

function normalizeDeletedShortcuts(deletedShortcuts) {
  if (!Array.isArray(deletedShortcuts)) return [];
  return deletedShortcuts
    .filter(item => item && typeof item.id === 'string' && item.id)
    .map(item => ({
      id: item.id,
      url: typeof item.url === 'string' ? normalizeUrl(item.url) : '',
      deletedAt: Number.isFinite(item.deletedAt) ? item.deletedAt : Date.now(),
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, 300);
}

function isShortcutDeleted(item, deletedShortcuts = state.deletedShortcuts || []) {
  const tombstone = deletedShortcuts.find(deleted => (
    deleted.id === item.id || (deleted.url && shortcutUrlKey(deleted.url) === shortcutUrlKey(item.url))
  ));
  return Boolean(tombstone && tombstone.deletedAt >= (item.updatedAt || 0));
}

async function saveState(options = {}) {
  state.shortcuts = orderedShortcuts().map((item, index) => ({ ...item, order: index }));
  state.deletedShortcuts = normalizeDeletedShortcuts(state.deletedShortcuts);
  state.settings.currentPage = clampPage(state.settings.currentPage);
  await persistState(state);
  if (options.sync !== false) scheduleSync('save');
}

async function persistState(nextState) {
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [STORAGE_KEY]: nextState });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  }
}

function orderedShortcuts() {
  return [...state.shortcuts].sort((a, b) => a.order - b.order);
}

function pageCount() {
  return Math.max(1, Math.ceil(state.shortcuts.length / PAGE_CAPACITY));
}

function clampPage(page) {
  return clampPageForCount(page, state.shortcuts.length);
}

function clampPageForCount(page, shortcutCount) {
  const count = Math.max(1, Math.ceil(shortcutCount / PAGE_CAPACITY));
  return Math.max(0, Math.min(page, count - 1));
}

function currentPageItems() {
  const page = clampPage(state.settings.currentPage);
  const start = page * PAGE_CAPACITY;
  return orderedShortcuts().slice(start, start + PAGE_CAPACITY);
}

function render() {
  state.settings.currentPage = clampPage(state.settings.currentPage);
  els.shell.classList.toggle('edit-mode', editMode);
  applyDensity();
  renderShortcuts();
  renderDots();
  els.emptyState.hidden = state.shortcuts.length > 0;
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

function renderShortcuts() {
  const items = currentPageItems();
  els.shortcutPage.style.setProperty('--page-columns', '8');
  els.shortcutPage.innerHTML = items.map(renderShortcut).join('');

  if (movedShortcutId) {
    const movedCard = els.shortcutPage.querySelector(`[data-id="${movedShortcutId}"]`);
    requestAnimationFrame(() => movedCard?.classList.add('moved-pop'));
    setTimeout(() => movedCard?.classList.remove('moved-pop'), 320);
    movedShortcutId = null;
  }
}

function handleShortcutContextMenu(event) {
  const card = event.target.closest('.shortcut-card');
  if (!card || event.target.closest('[data-action]')) return;
  event.preventDefault();
  openShortcutDialog(card.dataset.id);
}

function renderShortcut(item) {
  const title = escapeHtml(item.title);
  const url = escapeHtml(item.url);
  const iconSources = iconSourceList(item);
  const favicon = iconSources[0];
  const fallbacks = escapeHtml(JSON.stringify(iconSources.slice(1)));
  const draggable = editMode ? 'true' : 'false';

  return `
    <div class="shortcut-card ${item.size}" role="link" tabindex="0" data-id="${item.id}" data-url="${url}" draggable="${draggable}" title="${title}">
      <span class="shortcut-icon">
        <img src="${favicon}" alt="" loading="lazy" data-fallbacks="${fallbacks}" data-fallback-index="0">
      </span>
      <span class="shortcut-title">${title}</span>
      <button class="edit-chip" type="button" data-action="edit-shortcut" data-id="${item.id}" title="编辑 ${title}">✎</button>
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

function iconSourceList(item) {
  const sources = [];
  const direct = directFaviconUrls(item.url);
  if (item.iconId && activeIconUrls.has(item.iconId)) sources.push(activeIconUrls.get(item.iconId));
  if (isImageDataUrl(item.customIcon)) sources.push(item.customIcon);
  if (isHttpUrl(item.iconUrl)) sources.push(item.iconUrl);
  sources.push(direct.appleTouch);
  sources.push(direct.png32);
  sources.push(highResolutionFaviconUrl(item.url));
  if (hasChromeRuntime) sources.push(chromeFaviconUrl(item.url, 128));
  sources.push(duckDuckGoFaviconUrl(item.url));
  sources.push(direct.ico);
  sources.push(placeholderIcon(item.title));
  return [...new Set(sources.filter(Boolean))];
}

function iconCandidatesForUrl(url, title = '', pageCandidates = []) {
  const direct = directFaviconUrls(url);
  const candidates = [
    ...pageCandidates,
    { kind: 'apple-touch', url: direct.appleTouch },
    { kind: 'png32', url: direct.png32 },
    { kind: 'google', url: highResolutionFaviconUrl(url) },
    { kind: 'duckduckgo', url: duckDuckGoFaviconUrl(url) },
    { kind: 'favicon', url: direct.ico },
    { kind: 'fallback', url: placeholderIcon(title || hostnameFromUrl(url)) },
  ];

  if (hasChromeRuntime) {
    candidates.splice(3, 0, { kind: 'chrome', url: chromeFaviconUrl(url, 128) });
  }

  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate.url || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function highResolutionFaviconUrl(url) {
  const favicon = new URL('https://www.google.com/s2/favicons');
  favicon.searchParams.set('domain_url', siteOrigin(url));
  favicon.searchParams.set('sz', '128');
  return favicon.toString();
}

function chromeFaviconUrl(url, size) {
  if (!hasChromeRuntime) {
    return '';
  }

  const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
  favicon.searchParams.set('pageUrl', siteOrigin(url));
  favicon.searchParams.set('size', String(size));
  return favicon.toString();
}

function duckDuckGoFaviconUrl(url) {
  const host = hostnameFromUrl(url);
  return host ? `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico` : '';
}

function directFaviconUrls(url) {
  const origin = siteOrigin(url);
  return {
    ico: new URL('/favicon.ico', origin).toString(),
    appleTouch: new URL('/apple-touch-icon.png', origin).toString(),
    png32: new URL('/favicon-32x32.png', origin).toString(),
  };
}

function placeholderIcon(title) {
  const letter = cleanShortcutTitle(title).charAt(0).toUpperCase() || '?';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect width="128" height="128" rx="32" fill="#eef2f6"/>
      <text x="64" y="78" text-anchor="middle" font-family="Arial, sans-serif" font-size="56" font-weight="700" fill="#475467">${escapeSvg(letter)}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function handleSearch(event) {
  event.preventDefault();
  const raw = els.searchInput.value.trim();
  if (!raw) return;

  if (looksLikeUrl(raw)) {
    window.location.href = normalizeUrl(raw);
    return;
  }

  try {
    if (hasChromeSearch) {
      await chrome.search.query({ text: raw, disposition: 'CURRENT_TAB' });
    } else {
      window.location.href = `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    }
  } catch {
    window.location.href = `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  }
}

function looksLikeUrl(value) {
  if (/^https?:\/\//i.test(value)) return true;
  if (/\s/.test(value)) return false;
  return /^localhost(:\d+)?(\/|$)/i.test(value)
    || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(value)
    || /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$)/i.test(value);
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function siteOrigin(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    return `${parsed.origin}/`;
  } catch {
    return normalizeUrl(url);
  }
}

async function handleDocumentClick(event) {
  const card = event.target.closest('.shortcut-card');
  if (editMode && card && !event.target.closest('[data-action]')) {
    event.preventDefault();
    openShortcutDialog(card.dataset.id);
    return;
  }

  if (!editMode && card && !event.target.closest('[data-action]')) {
    window.location.href = card.dataset.url;
    return;
  }

  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;

  const { action } = actionTarget.dataset;
  if (action === 'toggle-edit') {
    editMode = !editMode;
    actionTarget.classList.toggle('active', editMode);
    showToast(editMode ? '进入编辑模式' : '退出编辑模式');
    render();
    return;
  }

  if (action === 'add-shortcut') {
    openShortcutDialog();
    return;
  }

  if (action === 'edit-shortcut') {
    event.preventDefault();
    openShortcutDialog(actionTarget.dataset.id);
    return;
  }

  if (action === 'close-dialog') {
    closeShortcutDialog();
    return;
  }

  if (action === 'open-sync-dialog') {
    openSyncDialog();
    return;
  }

  if (action === 'close-sync-dialog') {
    closeSyncDialog();
    return;
  }

  if (action === 'sync-now') {
    await syncNowFromDialog();
    return;
  }

  if (action === 'delete-shortcut') {
    await deleteEditingShortcut();
    return;
  }

  if (action === 'clear-shortcut-icon') {
    pendingCustomIcon = '';
    pendingIconUrl = '';
    pendingIconCleared = true;
    renderIconPreview();
    return;
  }

  if (action === 'select-icon') {
    const selectedIcon = actionTarget.dataset.iconUrl || '';
    pendingCustomIcon = isImageDataUrl(selectedIcon) ? selectedIcon : '';
    pendingIconUrl = pendingCustomIcon ? '' : selectedIcon;
    pendingIconCleared = false;
    renderIconPreview();
    return;
  }

  if (action === 'go-page') {
    await goToPage(Number(actionTarget.dataset.page));
    return;
  }

  if (action === 'set-density') {
    await setDensity(actionTarget.dataset.density);
    return;
  }

  if (action === 'reset-wallpaper') {
    await resetWallpaper();
  }
}

async function setDensity(density) {
  if (!['small', 'medium', 'large'].includes(density)) return;
  state.settings.iconDensity = density;
  await saveState();
  render();
  showToast(`图标大小：${densityLabel(density)}`);
}

function densityLabel(density) {
  return { small: '小', medium: '中', large: '大' }[density] || '小';
}

function openShortcutDialog(id = null) {
  editingId = id;
  const item = id ? state.shortcuts.find(shortcut => shortcut.id === id) : null;
  els.dialogTitle.textContent = item ? '编辑网站' : '添加网站';
  els.titleInput.value = item?.title || '';
  els.urlInput.value = item?.url || '';
  const size = item?.size || 'small';
  els.shortcutForm.elements.shortcutSize.value = size;
  pendingCustomIcon = item?.customIcon || '';
  pendingIconUrl = item?.iconUrl || '';
  pendingIconCleared = false;
  pendingOriginalUrl = item?.url || '';
  els.iconInput.value = '';
  renderIconPreview();
  els.deleteButton.hidden = !item;
  els.dialog.showModal();
  requestAnimationFrame(() => els.titleInput.focus());
}

function closeShortcutDialog() {
  editingId = null;
  pendingCustomIcon = '';
  pendingIconUrl = '';
  pendingIconCleared = false;
  pendingOriginalUrl = '';
  els.iconInput.value = '';
  els.dialog.close();
}

function openSyncDialog() {
  const sync = state.sync || {};
  els.syncEnabled.checked = Boolean(sync.enabled);
  els.syncEndpoint.value = sync.endpoint || '';
  els.syncToken.value = sync.token || '';
  renderSyncStatus();
  els.syncDialog.showModal();
  requestAnimationFrame(() => els.syncEndpoint.focus());
}

function closeSyncDialog() {
  els.syncDialog.close();
}

async function handleSyncSubmit(event) {
  event.preventDefault();
  state.sync = {
    ...(state.sync || {}),
    enabled: Boolean(els.syncEnabled.checked),
    endpoint: normalizeSyncEndpoint(els.syncEndpoint.value),
    token: els.syncToken.value.trim(),
    pending: true,
    lastError: '',
  };
  await persistState(state);
  renderSyncStatus();
  showToast(state.sync.enabled ? '同步设置已保存' : '同步已关闭');
  closeSyncDialog();
  scheduleSync('manual');
}

async function syncNowFromDialog() {
  state.sync = {
    ...(state.sync || {}),
    enabled: Boolean(els.syncEnabled.checked),
    endpoint: normalizeSyncEndpoint(els.syncEndpoint.value),
    token: els.syncToken.value.trim(),
    pending: true,
    lastError: '',
  };
  await persistState(state);
  renderSyncStatus('正在同步');
  await syncStateNow({ force: true });
  renderSyncStatus();
}

function renderSyncStatus(override = '') {
  if (!els.syncStatus) return;
  if (override) {
    els.syncStatus.textContent = override;
    return;
  }

  const sync = state.sync || {};
  if (!sync.enabled) {
    els.syncStatus.textContent = '未启用。启用后只同步收藏网站元数据和图标来源，不上传壁纸或图标图片。';
    return;
  }

  if (!sync.endpoint || !sync.token) {
    els.syncStatus.textContent = '请填写服务器地址和访问令牌。';
    return;
  }

  if (sync.lastError) {
    els.syncStatus.textContent = `上次失败：${sync.lastError}`;
    return;
  }

  if (sync.pending) {
    els.syncStatus.textContent = '有本地修改待同步。';
    return;
  }

  els.syncStatus.textContent = sync.lastSyncAt
    ? `上次同步：${new Date(sync.lastSyncAt).toLocaleString()}`
    : '尚未同步。';
}

async function handleShortcutSubmit(event) {
  event.preventDefault();
  const title = els.titleInput.value.trim();
  const url = normalizeUrl(els.urlInput.value);
  const size = els.shortcutForm.elements.shortcutSize.value;

  if (!title || !url) return;

  showToast('正在保存');
  const now = Date.now();

  if (editingId) {
    const previous = state.shortcuts.find(shortcut => shortcut.id === editingId);
    const next = await prepareShortcutForSave({
      ...previous,
      id: editingId,
      title,
      url,
      size,
      updatedAt: now,
    }, previous);
    state.shortcuts = state.shortcuts.map(item => (
      item.id === editingId ? next : item
    ));
    showToast('已更新');
  } else {
    const id = crypto.randomUUID();
    const next = await prepareShortcutForSave({
      id,
      title,
      url,
      size,
      order: state.shortcuts.length,
      updatedAt: now,
    }, null);
    state.shortcuts.push(next);
    state.settings.currentPage = pageCount() - 1;
    showToast('已添加');
  }

  await saveState();
  closeShortcutDialog();
  render();
}

function normalizeShortcutForSave(item) {
  const next = { ...item };
  if (typeof next.iconId !== 'string' || !next.iconId) delete next.iconId;
  if (!isImageDataUrl(next.customIcon)) delete next.customIcon;
  if (!isHttpUrl(next.iconUrl)) delete next.iconUrl;
  if (next.iconId) delete next.customIcon;
  if (next.customIcon) delete next.iconUrl;
  return next;
}

async function prepareShortcutForSave(item, previous) {
  const next = normalizeShortcutForSave({
    ...item,
    iconId: previous?.iconId || '',
    iconUrl: previous?.iconUrl || '',
    customIcon: previous?.customIcon || '',
  });
  const urlChanged = !previous || previous.url !== item.url;

  delete next.customIcon;

  if (pendingCustomIcon) {
    const blob = dataUrlToBlob(pendingCustomIcon);
    await saveIconRecord(next.id, blob, 'custom');
    setActiveIconUrl(next.id, blob);
    next.iconId = next.id;
    delete next.iconUrl;
    return normalizeShortcutForSave(next);
  }

  const candidates = iconCandidatesForUrl(next.url, next.title);
  const automaticCandidateUrls = candidates
    .filter(candidate => candidate.kind !== 'fallback')
    .map(candidate => candidate.url);
  const selectedSources = pendingIconUrl ? [pendingIconUrl, ...automaticCandidateUrls] : [];
  const automaticSources = (!previous || urlChanged || pendingIconCleared)
    ? automaticCandidateUrls
    : [];
  const sourceUrls = [...new Set([...selectedSources, ...automaticSources].filter(Boolean))];

  if (sourceUrls.length) {
    const cached = await cacheFirstAvailableIcon(next.id, sourceUrls);
    if (cached) {
      next.iconId = next.id;
      next.iconUrl = isHttpUrl(cached.sourceUrl) ? cached.sourceUrl : '';
      return normalizeShortcutForSave(next);
    }
  }

  if (previous?.iconId && !pendingIconCleared && !urlChanged) {
    next.iconId = previous.iconId;
    if (isHttpUrl(previous.iconUrl)) next.iconUrl = previous.iconUrl;
    return normalizeShortcutForSave(next);
  }

  await deleteIconRecord(next.id);
  delete next.iconId;
  delete next.iconUrl;
  return normalizeShortcutForSave(next);
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
    pendingCustomIcon = await imageFileToIconDataUrl(file, 256);
    pendingIconUrl = '';
    pendingIconCleared = false;
    renderIconPreview();
    showToast('图标已选择');
  } catch {
    showToast('图标处理失败');
  }
}

function renderIconPreview() {
  const url = els.urlInput.value ? normalizeUrl(els.urlInput.value) : 'https://example.com';
  renderIconCandidates(url);

  if (pendingCustomIcon) {
    els.iconPreview.innerHTML = `<img src="${escapeHtml(pendingCustomIcon)}" alt="">`;
    els.clearIconButton.hidden = false;
    return;
  }

  const existing = editingId ? state.shortcuts.find(shortcut => shortcut.id === editingId) : null;
  const existingIconUrl = existing?.iconId && activeIconUrls.get(existing.iconId);
  const canUseExisting = existingIconUrl && !pendingIconCleared && url === pendingOriginalUrl;
  const previewUrl = pendingIconUrl || (canUseExisting ? existingIconUrl : iconCandidatesForUrl(url, els.titleInput.value, pageIconCandidatesForUrl(url))[0]?.url);
  els.iconPreview.innerHTML = `<img src="${escapeHtml(previewUrl)}" alt="">`;
  els.clearIconButton.hidden = !(pendingIconUrl || canUseExisting);
}

function renderIconCandidates(url) {
  const title = els.titleInput.value || hostnameFromUrl(url);
  requestPageIconCandidates(url);
  const candidates = iconCandidatesForUrl(url, title, pageIconCandidatesForUrl(url));
  els.iconCandidates.innerHTML = candidates.map(candidate => {
    const selected = !pendingCustomIcon && pendingIconUrl === candidate.url;
    return `
      <button class="icon-candidate" type="button" data-action="select-icon" data-icon-kind="${candidate.kind}" data-icon-url="${escapeHtml(candidate.url)}" aria-pressed="${selected}" title="${candidate.kind}">
        <img src="${escapeHtml(candidate.url)}" alt="" loading="lazy">
      </button>
    `;
  }).join('');
}

function pageIconCandidatesForUrl(url) {
  return pageIconCandidateCache.get(iconCandidateCacheKey(url)) || [];
}

function requestPageIconCandidates(url) {
  const key = iconCandidateCacheKey(url);
  if (!key || pageIconCandidateCache.has(key) || pageIconCandidateRequests.has(key)) return;

  const request = discoverPageIconCandidates(url)
    .then(candidates => {
      pageIconCandidateCache.set(key, candidates);
      if (els.urlInput.value && iconCandidateCacheKey(els.urlInput.value) === key && !pendingCustomIcon) {
        renderIconPreview();
      }
    })
    .catch(() => {
      pageIconCandidateCache.set(key, []);
    })
    .finally(() => {
      pageIconCandidateRequests.delete(key);
    });

  pageIconCandidateRequests.set(key, request);
}

async function discoverPageIconCandidates(url) {
  const pageUrl = normalizeUrl(url);
  const response = await fetch(pageUrl, {
    cache: 'force-cache',
    credentials: 'omit',
  });
  if (!response.ok) return [];

  const html = await response.text();
  const document = new DOMParser().parseFromString(html, 'text/html');
  const candidates = [
    ...declaredIconCandidatesFromDocument(document, response.url || pageUrl),
    ...brandIconCandidatesFromDocument(document, response.url || pageUrl),
  ];
  const manifestUrls = [...document.querySelectorAll('link[rel]')]
    .filter(link => relValues(link.rel).includes('manifest'))
    .map(link => absoluteIconUrl(link.getAttribute('href'), response.url || pageUrl))
    .filter(Boolean);

  for (const manifestUrl of manifestUrls.slice(0, 2)) {
    candidates.push(...await declaredIconCandidatesFromManifest(manifestUrl));
  }

  return uniqueIconCandidates(candidates)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map(({ kind, url }) => ({ kind, url }))
    .slice(0, 8);
}

function declaredIconCandidatesFromDocument(document, baseUrl) {
  return [...document.querySelectorAll('link[rel][href]')]
    .flatMap(link => {
      const rels = relValues(link.rel);
      const isIcon = rels.includes('icon')
        || rels.includes('apple-touch-icon')
        || rels.includes('apple-touch-icon-precomposed')
        || rels.includes('mask-icon');
      if (!isIcon) return [];

      const url = absoluteIconUrl(link.getAttribute('href'), baseUrl);
      if (!url) return [];

      const size = largestDeclaredIconSize(link.getAttribute('sizes'), url);
      const appleWeight = rels.some(rel => rel.startsWith('apple-touch-icon')) ? 2000 : 0;
      const maskWeight = rels.includes('mask-icon') ? -500 : 0;
      return [{ kind: 'page-icon', url, score: 1000 + appleWeight + maskWeight + size }];
    });
}

function brandIconCandidatesFromDocument(document, baseUrl) {
  const metaCandidates = [...document.querySelectorAll('meta[content]')]
    .flatMap(meta => {
      const key = `${meta.getAttribute('property') || ''} ${meta.getAttribute('name') || ''} ${meta.getAttribute('itemprop') || ''}`.toLowerCase();
      const isBrandImage = /\bog:image(?::url)?\b|twitter:image|(^|\s)image($|\s)|msapplication-tileimage/.test(key);
      if (!isBrandImage) return [];

      const url = absoluteIconUrl(meta.getAttribute('content'), baseUrl);
      if (!url) return [];
      return [{ kind: 'brand-image', url, score: 3600 + largestDeclaredIconSize('', url) }];
    });

  const logoCandidates = [...document.querySelectorAll('img[src]')]
    .filter(img => {
      const marker = `${img.getAttribute('alt') || ''} ${img.getAttribute('class') || ''} ${img.getAttribute('id') || ''} ${img.getAttribute('src') || ''}`.toLowerCase();
      return /\blogo\b|brand|favicon|app-icon/.test(marker);
    })
    .slice(0, 6)
    .flatMap(img => {
      const url = absoluteIconUrl(img.getAttribute('src'), baseUrl);
      if (!url) return [];
      const declaredSize = Math.max(Number(img.getAttribute('width')) || 0, Number(img.getAttribute('height')) || 0);
      return [{ kind: 'brand-logo', url, score: 3000 + Math.max(declaredSize, largestDeclaredIconSize('', url)) }];
    });

  return [...metaCandidates, ...logoCandidates];
}

async function declaredIconCandidatesFromManifest(manifestUrl) {
  try {
    const response = await fetch(manifestUrl, {
      cache: 'force-cache',
      credentials: 'omit',
    });
    if (!response.ok) return [];

    const manifest = await response.json();
    if (!Array.isArray(manifest.icons)) return [];

    return manifest.icons.flatMap(icon => {
      const url = absoluteIconUrl(icon.src, manifestUrl);
      if (!url) return [];
      return [{ kind: 'manifest-icon', url, score: 1500 + largestDeclaredIconSize(icon.sizes, url) }];
    });
  } catch {
    return [];
  }
}

function uniqueIconCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate.url || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function relValues(rel) {
  return String(rel || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function absoluteIconUrl(value, baseUrl) {
  if (!value) return '';
  try {
    const url = new URL(value, baseUrl).toString();
    return isFetchableIconUrl(url) ? url : '';
  } catch {
    return '';
  }
}

function largestDeclaredIconSize(sizes, url = '') {
  const declared = String(sizes || '')
    .split(/\s+/)
    .map(size => {
      const match = size.match(/^(\d+)x(\d+)$/i);
      return match ? Math.max(Number(match[1]), Number(match[2])) : 0;
    });
  const fromName = [...String(url).matchAll(/(?:^|[_-])(\d{2,4})x(\d{2,4})(?=[_.-])/gi)]
    .map(match => Math.max(Number(match[1]), Number(match[2])));
  const singleSizeFromName = [...String(url).matchAll(/(?:^|[_-])(\d{2,4})(?=[_.-])/gi)]
    .map(match => Number(match[1]));
  return Math.max(0, ...declared, ...fromName, ...singleSizeFromName);
}

function handleIconCandidateError(event) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement)) return;

  const button = img.closest('[data-action="select-icon"]');
  if (!button || !els.iconCandidates.contains(button)) return;

  if (pendingIconUrl === button.dataset.iconUrl) {
    pendingIconUrl = '';
    renderIconPreview();
    return;
  }

  button.remove();
}

function handleShortcutIconError(event) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.shortcut-icon')) return;

  const fallbacks = parseIconFallbacks(img.dataset.fallbacks);
  const index = Number.parseInt(img.dataset.fallbackIndex || '0', 10);
  const next = fallbacks[index];
  if (!next) return;

  img.dataset.fallbackIndex = String(index + 1);
  img.src = next;
}

function handleShortcutIconLoad(event) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.shortcut-icon')) return;
  cacheDisplayedShortcutIcon(img);
}

async function cacheDisplayedShortcutIcon(img) {
  const card = img.closest('.shortcut-card');
  const id = card?.dataset.id || '';
  const sourceUrl = img.currentSrc || img.getAttribute('src') || '';
  if (!id || !isFetchableIconUrl(sourceUrl)) return;

  const item = state.shortcuts.find(shortcut => shortcut.id === id);
  if (!item) return;
  if (item.iconId === id && activeIconUrls.has(id) && item.iconUrl === sourceUrl) return;

  const cacheKey = `${id}:${sourceUrl}`;
  if (iconCacheInFlight.has(cacheKey)) return;

  iconCacheInFlight.add(cacheKey);
  try {
    const blob = await iconSourceToBlob(sourceUrl);
    await saveIconRecord(id, blob, sourceUrl);
    setActiveIconUrl(id, blob);

    const target = state.shortcuts.find(shortcut => shortcut.id === id);
    if (!target) return;
    target.iconId = id;
    target.iconUrl = isHttpUrl(sourceUrl) ? sourceUrl : '';
    target.updatedAt = Date.now();
    delete target.customIcon;
    await saveState();
  } catch {
    // The browser may display an image that cannot be fetched by script; keep using the visible source.
  } finally {
    iconCacheInFlight.delete(cacheKey);
  }
}

function parseIconFallbacks(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item) : [];
  } catch {
    return [];
  }
}

function imageFileToIconDataUrl(file, canvasSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvasSize;
      canvas.height = canvasSize;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvasSize, canvasSize);

      const scale = Math.min(canvasSize / img.width, canvasSize / img.height);
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const x = Math.round((canvasSize - width) / 2);
      const y = Math.round((canvasSize - height) / 2);
      ctx.drawImage(img, x, y, width, height);

      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unable to load icon'));
    };
    img.src = url;
  });
}

async function deleteEditingShortcut() {
  if (!editingId) return;
  const idToDelete = editingId;
  const previous = state.shortcuts.find(item => item.id === idToDelete);
  closeShortcutDialog();
  const card = els.shortcutPage.querySelector(`[data-id="${idToDelete}"]`);
  card?.classList.add('removing');
  await sleep(card ? 220 : 0);
  state.shortcuts = state.shortcuts.filter(item => item.id !== idToDelete);
  rememberDeletedShortcut(previous);
  await deleteIconRecord(idToDelete);
  await saveState();
  showToast('已删除');
  render();
}

async function goToPage(page) {
  const nextPage = clampPage(page);
  if (nextPage === state.settings.currentPage) return;
  els.shortcutPage.classList.add('switching');
  await sleep(120);
  state.settings.currentPage = nextPage;
  await saveState({ sync: false });
  render();
  requestAnimationFrame(() => els.shortcutPage.classList.remove('switching'));
}

function handleKeydown(event) {
  if (event.key === 'Escape' && els.dialog.open) closeShortcutDialog();
  if (event.key === 'ArrowLeft' && !els.dialog.open) goToPage(state.settings.currentPage - 1);
  if (event.key === 'ArrowRight' && !els.dialog.open) goToPage(state.settings.currentPage + 1);

  const focusedCard = document.activeElement?.closest?.('.shortcut-card');
  if (!editMode && focusedCard && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    window.location.href = focusedCard.dataset.url;
  }
}

function handleShortcutWheel(event) {
  if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  if (event.deltaX > 20) goToPage(state.settings.currentPage + 1);
  if (event.deltaX < -20) goToPage(state.settings.currentPage - 1);
}

function handleTouchStart(event) {
  touchStartX = event.changedTouches[0]?.clientX || 0;
}

function handleTouchEnd(event) {
  const endX = event.changedTouches[0]?.clientX || 0;
  const delta = endX - touchStartX;
  if (Math.abs(delta) < 60) return;
  goToPage(state.settings.currentPage + (delta < 0 ? 1 : -1));
}

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
  const card = event.target.closest('.shortcut-card');
  if (!card || card.dataset.id === draggedId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

async function handleDrop(event) {
  if (!editMode || !draggedId) return;
  const target = event.target.closest('.shortcut-card');
  if (!target || target.dataset.id === draggedId) return;
  event.preventDefault();

  reorderShortcuts(draggedId, target.dataset.id);
  draggedId = null;
  await saveState();
  render();
}

function handleDragEnd() {
  draggedId = null;
  document.querySelectorAll('.shortcut-card.dragging').forEach(card => card.classList.remove('dragging'));
}

function reorderShortcuts(sourceId, targetId) {
  const ordered = orderedShortcuts();
  const from = ordered.findIndex(item => item.id === sourceId);
  const to = ordered.findIndex(item => item.id === targetId);
  if (from === -1 || to === -1) return;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const now = Date.now();
  state.shortcuts = ordered.map((item, index) => ({ ...item, order: index, updatedAt: now }));
  movedShortcutId = sourceId;
}

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
    await saveWallpaperBlob(blob);
    state.settings.wallpaper = { type: 'uploaded' };
    await saveState({ sync: false });
    await applyWallpaper();
    showToast('壁纸已更新');
  } catch {
    showToast('壁纸处理失败');
  }
}

async function handleInfinityImport(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const raw = await file.text();
    const payload = parseJsonLike(raw);
    const imported = extractInfinityShortcuts(payload);
    if (!imported.length) {
      showToast('没有找到可导入的网站');
      return;
    }

    const existingUrls = new Set(state.shortcuts.map(item => shortcutUrlKey(item.url)));
    const additions = imported.filter(item => {
      const key = shortcutUrlKey(item.url);
      if (!key || existingUrls.has(key)) return false;
      existingUrls.add(key);
      return true;
    });

    if (!additions.length) {
      showToast('这些网站已在列表中');
      return;
    }

    state.shortcuts.push(...additions.map((item, index) => ({
      id: crypto.randomUUID(),
      title: item.title,
      url: item.url,
      size: 'small',
      order: state.shortcuts.length + index,
      updatedAt: Date.now(),
    })));
    state.settings.currentPage = pageCount() - 1;
    await saveState();
    render();
    showToast(`已导入 ${additions.length} 个网站`);
  } catch {
    showToast('导入失败，请选择 Infinity 备份 JSON');
  }
}

function parseJsonLike(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function extractInfinityShortcuts(payload) {
  const candidates = [];
  const seenObjects = new WeakSet();

  function visit(value, path = '') {
    const parsed = parseNestedJson(value);
    if (parsed !== value) {
      visit(parsed, path);
      return;
    }

    if (!value || typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    addShortcutCandidate(value, path, candidates);
    Object.entries(value).forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key));
  }

  visit(payload);

  const byUrl = new Map();
  candidates.forEach(item => {
    const key = shortcutUrlKey(item.url);
    if (!key || byUrl.has(key)) return;
    byUrl.set(key, item);
  });
  return [...byUrl.values()];
}

function parseNestedJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function addShortcutCandidate(item, path, candidates) {
  const rawUrl = item.target || item.url || item.href || item.link;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return;
  if (/^(infinity|chrome|data|javascript):/i.test(rawUrl.trim())) return;

  const url = normalizeUrl(rawUrl);
  if (!/^https?:\/\//i.test(url)) return;

  const title = cleanShortcutTitle(
    item.name || item.title || item.bgText || item.text || hostnameFromUrl(url)
  );
  if (!title) return;

  const score = shortcutCandidateScore(item, path);
  if (score < 2) return;

  candidates.push({ title, url, score });
}

function shortcutCandidateScore(item, path) {
  let score = 0;
  if (typeof item.name === 'string' || typeof item.title === 'string') score += 1;
  if (typeof item.target === 'string') score += 2;
  if (typeof item.url === 'string') score += 1;
  if ('bgImage' in item || 'bgColor' in item || 'src' in item || 'showText' in item) score += 1;
  if (/store-site|infinity-icons|sites|icons/i.test(path)) score += 2;
  return score;
}

function cleanShortcutTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function shortcutUrlKey(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    parsed.hash = '';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function rememberDeletedShortcut(shortcut) {
  if (!shortcut?.id) return;
  state.deletedShortcuts = normalizeDeletedShortcuts([
    ...(state.deletedShortcuts || []),
    {
      id: shortcut.id,
      url: shortcut.url || '',
      deletedAt: Date.now(),
    },
  ]);
}

function iconCandidateCacheKey(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeSyncEndpoint(value) {
  const endpoint = String(value || '').trim().replace(/\/+$/, '');
  if (!endpoint) return '';
  try {
    const url = new URL(endpoint);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

function shouldSync(reason) {
  const sync = state.sync || {};
  if (!sync.enabled || !sync.endpoint || !sync.token) return false;
  if (reason !== 'startup') return true;
  if (sync.pending) return true;
  return Date.now() - (sync.lastSyncAt || 0) > SYNC_STARTUP_MIN_INTERVAL_MS;
}

function scheduleSync(reason) {
  if (!shouldSync(reason)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncStateNow({ force: reason === 'manual' }).catch(() => {});
  }, reason === 'startup' ? 1200 : SYNC_DEBOUNCE_MS);
}

async function syncStateNow({ force = false } = {}) {
  if (syncInFlight || !shouldSync(force ? 'manual' : 'save')) return;
  syncInFlight = true;

  try {
    const sync = state.sync;
    const remote = await syncRequest('GET', sync.endpoint, sync.token);
    const beforePayload = exportSyncPayload(state);
    const mergeChanged = await applyRemoteSyncPayload(remote);
    if (mergeChanged) {
      state.settings.currentPage = clampPage(state.settings.currentPage);
      await persistState(state);
      await hydrateShortcutIcons();
      render();
    }

    const nextPayload = exportSyncPayload(state);
    if (sync.pending || !sameSyncPayload(beforePayload, remote) || !sameSyncPayload(nextPayload, remote)) {
      await syncRequest('PUT', sync.endpoint, sync.token, nextPayload);
    }

    state.sync = {
      ...state.sync,
      pending: false,
      lastError: '',
      lastSyncAt: Date.now(),
    };
    await persistState(state);
    if (force) showToast('同步完成');
  } catch (error) {
    state.sync = {
      ...(state.sync || {}),
      pending: true,
      lastError: friendlySyncError(error),
    };
    await persistState(state);
    if (force) showToast('同步失败');
  } finally {
    syncInFlight = false;
  }
}

async function syncRequest(method, endpoint, token, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint}/api/state`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : null,
    });

    if (response.status === 401 || response.status === 403) throw new Error('token');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return method === 'GET' ? await response.json() : null;
  } finally {
    clearTimeout(timer);
  }
}

function exportSyncPayload(sourceState) {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    updatedAt: Date.now(),
    shortcuts: orderedShortcutsFrom(sourceState.shortcuts).map(item => ({
      id: item.id,
      title: item.title,
      url: item.url,
      size: ['small', 'medium', 'large'].includes(item.size) ? item.size : 'small',
      iconUrl: isHttpUrl(item.iconUrl) ? item.iconUrl : '',
      order: Number.isFinite(item.order) ? item.order : 0,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : DEFAULT_SHORTCUT_UPDATED_AT,
    })),
    deletedShortcuts: normalizeDeletedShortcuts(sourceState.deletedShortcuts),
    settings: {
      iconDensity: ['small', 'medium', 'large'].includes(sourceState.settings?.iconDensity)
        ? sourceState.settings.iconDensity
        : 'small',
    },
  };
}

async function applyRemoteSyncPayload(payload) {
  if (!payload || payload.schemaVersion !== SYNC_SCHEMA_VERSION || !Array.isArray(payload.shortcuts)) {
    return false;
  }

  let changed = false;
  const localById = new Map(state.shortcuts.map(item => [item.id, item]));
  const localByUrl = new Map(state.shortcuts.map(item => [shortcutUrlKey(item.url), item]).filter(([, item]) => item));
  const nextShortcuts = [...state.shortcuts];
  const remoteDeleted = normalizeDeletedShortcuts(payload.deletedShortcuts);

  for (const deleted of remoteDeleted) {
    const index = nextShortcuts.findIndex(item => (
      item.id === deleted.id || (deleted.url && shortcutUrlKey(item.url) === shortcutUrlKey(deleted.url))
    ));
    if (index === -1) continue;
    if (deleted.deletedAt >= (nextShortcuts[index].updatedAt || 0)) {
      await deleteIconRecord(nextShortcuts[index].id);
      nextShortcuts.splice(index, 1);
      changed = true;
    }
  }

  for (const remote of payload.shortcuts) {
    const remoteItem = normalizeSyncShortcut(remote);
    if (!remoteItem || isShortcutDeleted(remoteItem, remoteDeleted)) continue;
    const local = localById.get(remoteItem.id) || localByUrl.get(shortcutUrlKey(remoteItem.url));
    const tombstone = [...remoteDeleted, ...(state.deletedShortcuts || [])].find(deleted => (
      deleted.id === remoteItem.id || (deleted.url && shortcutUrlKey(deleted.url) === shortcutUrlKey(remoteItem.url))
    ));
    if (tombstone && tombstone.deletedAt >= remoteItem.updatedAt) continue;

    if (!local) {
      nextShortcuts.push(remoteItem);
      changed = true;
      continue;
    }

    if (remoteItem.updatedAt >= (local.updatedAt || 0)) {
      const index = nextShortcuts.findIndex(item => item.id === local.id);
      const merged = mergeRemoteShortcut(remoteItem, local);
      if (index !== -1 && JSON.stringify(nextShortcuts[index]) !== JSON.stringify(merged)) {
        if (local.id !== merged.id) await deleteIconRecord(local.id);
        nextShortcuts[index] = merged;
        changed = true;
      }
    }
  }

  const mergedDeleted = mergeDeletedShortcuts(state.deletedShortcuts, remoteDeleted);
  if (JSON.stringify(mergedDeleted) !== JSON.stringify(state.deletedShortcuts || [])) {
    state.deletedShortcuts = mergedDeleted;
    changed = true;
  }

  const remoteDensity = payload.settings?.iconDensity;
  if (['small', 'medium', 'large'].includes(remoteDensity) && state.settings.iconDensity !== remoteDensity) {
    state.settings.iconDensity = remoteDensity;
    changed = true;
  }

  if (changed) {
    state.shortcuts = orderedShortcutsFrom(nextShortcuts)
      .filter(item => !isShortcutDeleted(item, state.deletedShortcuts))
      .map((item, index) => ({ ...item, order: index }));
  }

  return changed;
}

function normalizeSyncShortcut(item) {
  if (!item || typeof item.id !== 'string' || !item.id || !item.title || !item.url) return null;
  return normalizeShortcutForSave({
    id: item.id,
    title: String(item.title).slice(0, 80),
    url: normalizeUrl(String(item.url)),
    size: ['small', 'medium', 'large'].includes(item.size) ? item.size : 'small',
    iconUrl: isHttpUrl(item.iconUrl) ? item.iconUrl : '',
    order: Number.isFinite(item.order) ? item.order : 0,
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : DEFAULT_SHORTCUT_UPDATED_AT,
  });
}

function mergeRemoteShortcut(remote, local) {
  const sameIconSource = !remote.iconUrl || remote.iconUrl === local.iconUrl;
  return normalizeShortcutForSave({
    ...remote,
    iconId: sameIconSource ? local.iconId : '',
    iconUrl: remote.iconUrl || local.iconUrl || '',
  });
}

function mergeDeletedShortcuts(localDeleted = [], remoteDeleted = []) {
  const byId = new Map();
  for (const item of normalizeDeletedShortcuts([...localDeleted, ...remoteDeleted])) {
    const key = item.id;
    const previous = byId.get(key);
    if (!previous || item.deletedAt > previous.deletedAt) byId.set(key, item);
  }
  return [...byId.values()].sort((a, b) => b.deletedAt - a.deletedAt).slice(0, 300);
}

function orderedShortcutsFrom(shortcuts) {
  return [...(shortcuts || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function sameSyncPayload(left, right) {
  if (!right || right.schemaVersion !== SYNC_SCHEMA_VERSION) return false;
  const comparable = payload => JSON.stringify({
    schemaVersion: payload.schemaVersion,
    shortcuts: orderedShortcutsFrom(payload.shortcuts).map(item => ({
      id: item.id,
      title: item.title,
      url: item.url,
      size: item.size,
      iconUrl: item.iconUrl || '',
      order: item.order || 0,
      updatedAt: item.updatedAt || DEFAULT_SHORTCUT_UPDATED_AT,
    })),
    deletedShortcuts: normalizeDeletedShortcuts(payload.deletedShortcuts),
    settings: { iconDensity: payload.settings?.iconDensity || 'small' },
  });
  return comparable(left) === comparable(right);
}

function friendlySyncError(error) {
  if (error?.name === 'AbortError') return '服务器响应超时';
  if (error?.message === 'token') return '令牌不正确';
  return String(error?.message || '网络不可用').slice(0, 120);
}

function isImageDataUrl(value) {
  return typeof value === 'string'
    && (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value) || /^data:image\/svg\+xml,/i.test(value));
}

function isFetchableIconUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'chrome-extension:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeSvg(value) {
  return String(value).replace(/[&<>]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
  }[char]));
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

async function applyWallpaper() {
  if (activeWallpaperUrl) {
    URL.revokeObjectURL(activeWallpaperUrl);
    activeWallpaperUrl = null;
  }

  if (state.settings.wallpaper.type !== 'uploaded') {
    els.body.classList.remove('has-wallpaper');
    els.body.style.removeProperty('--wallpaper-url');
    return;
  }

  const blob = await getWallpaperBlob();
  if (!blob) {
    state.settings.wallpaper = { type: 'none' };
    await saveState({ sync: false });
    els.body.classList.remove('has-wallpaper');
    els.body.style.removeProperty('--wallpaper-url');
    return;
  }

  activeWallpaperUrl = URL.createObjectURL(blob);
  els.body.style.setProperty('--wallpaper-url', `url("${activeWallpaperUrl}")`);
  els.body.classList.add('has-wallpaper');
}

async function resetWallpaper() {
  await deleteWallpaperBlob();
  state.settings.wallpaper = { type: 'none' };
  await saveState({ sync: false });
  await applyWallpaper();
  showToast('壁纸已重置');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WALLPAPER_STORE)) db.createObjectStore(WALLPAPER_STORE);
      if (!db.objectStoreNames.contains(ICON_STORE)) db.createObjectStore(ICON_STORE, { keyPath: 'id' });
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

async function withWallpaperStore(mode, callback) {
  return await withObjectStore(WALLPAPER_STORE, mode, callback);
}

async function saveWallpaperBlob(blob) {
  await withWallpaperStore('readwrite', (store, resolve, reject) => {
    const request = store.put(blob, WALLPAPER_ID);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getWallpaperBlob() {
  return await withWallpaperStore('readonly', (store, resolve, reject) => {
    const request = store.get(WALLPAPER_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteWallpaperBlob() {
  await withWallpaperStore('readwrite', (store, resolve, reject) => {
    const request = store.delete(WALLPAPER_ID);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function hydrateShortcutIcons() {
  const ids = new Set(state.shortcuts.map(item => item.iconId).filter(Boolean));
  for (const id of activeIconUrls.keys()) {
    if (!ids.has(id)) revokeActiveIconUrl(id);
  }

  await Promise.all([...ids].map(async id => {
    if (activeIconUrls.has(id)) return;
    const record = await getIconRecord(id);
    if (record?.blob) setActiveIconUrl(id, record.blob);
  }));
}

async function cacheMissingShortcutIcons() {
  let changed = false;
  for (const item of state.shortcuts) {
    if (item.iconId) continue;
    const sources = iconCandidatesForUrl(item.url, item.title)
      .filter(candidate => candidate.kind !== 'fallback')
      .map(candidate => candidate.url);
    const cached = await cacheFirstAvailableIcon(item.id, sources);
    if (!cached) continue;
    item.iconId = item.id;
    item.iconUrl = isHttpUrl(cached.sourceUrl) ? cached.sourceUrl : '';
    item.updatedAt = Date.now();
    changed = true;
  }

  if (changed) {
    await saveState();
    render();
  }
}

async function cacheFirstAvailableIcon(id, sourceUrls) {
  for (const sourceUrl of sourceUrls) {
    try {
      const blob = await iconSourceToBlob(sourceUrl);
      await saveIconRecord(id, blob, sourceUrl);
      setActiveIconUrl(id, blob);
      return { sourceUrl, blob };
    } catch {
      // Try the next candidate; favicon endpoints are often inconsistent.
    }
  }
  return null;
}

async function iconSourceToBlob(sourceUrl) {
  if (isImageDataUrl(sourceUrl)) return dataUrlToBlob(sourceUrl);
  if (!isFetchableIconUrl(sourceUrl)) throw new Error('Unsupported icon source');

  const response = await fetch(sourceUrl, {
    cache: 'force-cache',
    credentials: 'omit',
  });
  if (!response.ok) throw new Error(`Icon request failed: ${response.status}`);

  const blob = await response.blob();
  if (!blob.size) throw new Error('Empty icon response');
  if (blob.type.startsWith('image/')) return blob;

  return new Blob([await blob.arrayBuffer()], { type: guessImageType(sourceUrl) });
}

function guessImageType(url) {
  if (/\.svg(\?|#|$)/i.test(url)) return 'image/svg+xml';
  if (/\.ico(\?|#|$)/i.test(url)) return 'image/x-icon';
  if (/\.jpe?g(\?|#|$)/i.test(url)) return 'image/jpeg';
  if (/\.webp(\?|#|$)/i.test(url)) return 'image/webp';
  return 'image/png';
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error('Invalid data URL');

  const type = match[1] || 'image/png';
  const encoded = match[3] || '';
  const binary = match[2] ? atob(encoded) : decodeURIComponent(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

function setActiveIconUrl(id, blob) {
  revokeActiveIconUrl(id);
  activeIconUrls.set(id, URL.createObjectURL(blob));
}

function revokeActiveIconUrl(id) {
  const url = activeIconUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  activeIconUrls.delete(id);
}

async function saveIconRecord(id, blob, sourceUrl) {
  await withObjectStore(ICON_STORE, 'readwrite', (store, resolve, reject) => {
    const request = store.put({
      id,
      blob,
      sourceUrl,
      updatedAt: Date.now(),
    });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getIconRecord(id) {
  return await withObjectStore(ICON_STORE, 'readonly', (store, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteIconRecord(id) {
  revokeActiveIconUrl(id);
  await withObjectStore(ICON_STORE, 'readwrite', (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 1800);
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
