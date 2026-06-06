'use strict';

const STORAGE_KEY = 'tomorinNewTabState';
const DB_NAME = 'tomorin-new-tab';
const DB_VERSION = 1;
const WALLPAPER_STORE = 'wallpapers';
const WALLPAPER_ID = 'current';
const PAGE_CAPACITY = 24;

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
  })),
  settings: {
    currentPage: 0,
    wallpaper: { type: 'none' },
    iconDensity: 'small',
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
  dialog: document.getElementById('shortcutDialog'),
  shortcutForm: document.getElementById('shortcutForm'),
  dialogTitle: document.getElementById('dialogTitle'),
  titleInput: document.getElementById('shortcutTitle'),
  urlInput: document.getElementById('shortcutUrl'),
  iconInput: document.getElementById('shortcutIconInput'),
  iconPreview: document.getElementById('shortcutIconPreview'),
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

init();

async function init() {
  state = await loadState();
  await applyWallpaper();
  bindEvents();
  render();
}

function bindEvents() {
  els.searchForm.addEventListener('submit', handleSearch);
  document.addEventListener('click', handleDocumentClick);
  els.shortcutForm.addEventListener('submit', handleShortcutSubmit);
  els.wallpaperInput.addEventListener('change', handleWallpaperUpload);
  els.importInput.addEventListener('change', handleInfinityImport);
  els.iconInput.addEventListener('change', handleShortcutIconUpload);
  els.urlInput.addEventListener('input', () => {
    if (!pendingCustomIcon) renderIconPreview();
  });
  els.shortcutPage.addEventListener('error', handleShortcutIconError, true);
  document.addEventListener('keydown', handleKeydown);
  els.shortcutPage.addEventListener('dragstart', handleDragStart);
  els.shortcutPage.addEventListener('dragover', handleDragOver);
  els.shortcutPage.addEventListener('drop', handleDrop);
  els.shortcutPage.addEventListener('dragend', handleDragEnd);
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
  const shortcuts = saved.shortcuts
    .filter(item => item && item.title && item.url)
    .map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      title: String(item.title).slice(0, 80),
      url: normalizeUrl(String(item.url)),
      size: ['small', 'medium', 'large'].includes(item.size) ? item.size : 'small',
      customIcon: isImageDataUrl(item.customIcon) ? item.customIcon : '',
      order: Number.isFinite(item.order) ? item.order : index,
    }))
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

  return { shortcuts, settings };
}

async function saveState() {
  state.shortcuts = orderedShortcuts().map((item, index) => ({ ...item, order: index }));
  state.settings.currentPage = clampPage(state.settings.currentPage);
  await persistState(state);
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
  const columns = Math.min(8, Math.max(1, items.length));
  els.shortcutPage.style.setProperty('--page-columns', String(columns));
  els.shortcutPage.innerHTML = items.map(renderShortcut).join('');

  if (movedShortcutId) {
    const movedCard = els.shortcutPage.querySelector(`[data-id="${movedShortcutId}"]`);
    requestAnimationFrame(() => movedCard?.classList.add('moved-pop'));
    setTimeout(() => movedCard?.classList.remove('moved-pop'), 320);
    movedShortcutId = null;
  }
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
  if (isImageDataUrl(item.customIcon)) sources.push(item.customIcon);
  sources.push(highResolutionFaviconUrl(item.url));
  if (hasChromeRuntime) sources.push(chromeFaviconUrl(item.url, 128));
  sources.push(duckDuckGoFaviconUrl(item.url));
  sources.push(placeholderIcon(item.title));
  return [...new Set(sources.filter(Boolean))];
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

  if (action === 'delete-shortcut') {
    await deleteEditingShortcut();
    return;
  }

  if (action === 'clear-shortcut-icon') {
    pendingCustomIcon = '';
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
  els.iconInput.value = '';
  renderIconPreview();
  els.deleteButton.hidden = !item;
  els.dialog.showModal();
  requestAnimationFrame(() => els.titleInput.focus());
}

function closeShortcutDialog() {
  editingId = null;
  pendingCustomIcon = '';
  els.iconInput.value = '';
  els.dialog.close();
}

async function handleShortcutSubmit(event) {
  event.preventDefault();
  const title = els.titleInput.value.trim();
  const url = normalizeUrl(els.urlInput.value);
  const size = els.shortcutForm.elements.shortcutSize.value;

  if (!title || !url) return;

  if (editingId) {
    state.shortcuts = state.shortcuts.map(item => (
      item.id === editingId ? normalizeShortcutForSave({ ...item, title, url, size, customIcon: pendingCustomIcon }) : item
    ));
    showToast('已更新');
  } else {
    state.shortcuts.push(normalizeShortcutForSave({
      id: crypto.randomUUID(),
      title,
      url,
      size,
      customIcon: pendingCustomIcon,
      order: state.shortcuts.length,
    }));
    state.settings.currentPage = pageCount() - 1;
    showToast('已添加');
  }

  await saveState();
  closeShortcutDialog();
  render();
}

function normalizeShortcutForSave(item) {
  const next = { ...item };
  if (!isImageDataUrl(next.customIcon)) delete next.customIcon;
  return next;
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
    renderIconPreview();
    showToast('图标已选择');
  } catch {
    showToast('图标处理失败');
  }
}

function renderIconPreview() {
  if (pendingCustomIcon) {
    els.iconPreview.innerHTML = `<img src="${escapeHtml(pendingCustomIcon)}" alt="">`;
    els.clearIconButton.hidden = false;
    return;
  }

  const url = els.urlInput.value ? normalizeUrl(els.urlInput.value) : 'https://example.com';
  els.iconPreview.innerHTML = `<img src="${escapeHtml(highResolutionFaviconUrl(url))}" alt="">`;
  els.clearIconButton.hidden = true;
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
  closeShortcutDialog();
  const card = els.shortcutPage.querySelector(`[data-id="${idToDelete}"]`);
  card?.classList.add('removing');
  await sleep(card ? 220 : 0);
  state.shortcuts = state.shortcuts.filter(item => item.id !== idToDelete);
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
  await saveState();
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
  state.shortcuts = ordered.map((item, index) => ({ ...item, order: index }));
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
    const blob = await compressImage(file, 2560, 0.86);
    await saveWallpaperBlob(blob);
    state.settings.wallpaper = { type: 'uploaded' };
    await saveState();
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
    })));
    await saveState();
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

function isImageDataUrl(value) {
  return typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
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
    await saveState();
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
  await saveState();
  await applyWallpaper();
  showToast('壁纸已重置');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WALLPAPER_STORE)) db.createObjectStore(WALLPAPER_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withWallpaperStore(mode, callback) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(WALLPAPER_STORE, mode);
      const store = tx.objectStore(WALLPAPER_STORE);
      callback(store, resolve, reject);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
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
