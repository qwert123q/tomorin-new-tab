/*
 * Tomorin New Tab shared data model.
 *
 * Every device keeps a full copy of the shortcut list. Two copies are combined
 * with `mergeDocs`, which gives the same result no matter which device runs it
 * or in which order copies arrive:
 *
 * - each shortcut has an id, an edit time for its content (title, url, size,
 *   icon) and a move time for its position; the newer value wins per part, so
 *   a rename on one computer and a move on another both survive;
 * - positions are fractional keys, so moving one shortcut never touches the
 *   others;
 * - deletes leave a tombstone so stale devices cannot bring a shortcut back;
 * - two shortcuts with the same address are folded into one.
 *
 * Runs in the extension page (window.TomorinCore) and in Node (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TomorinCore = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const SCHEMA_VERSION = 2;
  const SIZES = ['small', 'medium', 'large'];
  const MAX_SHORTCUTS = 3000;
  const MAX_TOMBSTONES = 5000;
  const BLOB_HASH_RE = /^[0-9a-f]{64}$/;
  const POS_RE = /^[0-9A-Za-z]{1,200}$/;
  const EMPTY_WALLPAPER = Object.freeze({ hash: '', mime: '', size: 0, updatedAt: 0 });

  // ---------------------------------------------------------------- URLs

  function normalizeUrl(value) {
    const trimmed = String(value || '').trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^localhost(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
    return `https://${trimmed}`;
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

  function siteOrigin(url) {
    try {
      return `${new URL(normalizeUrl(url)).origin}/`;
    } catch {
      return normalizeUrl(url);
    }
  }

  function hostnameFromUrl(url) {
    try {
      return new URL(normalizeUrl(url)).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  // Two addresses with the same key are treated as the same website.
  function urlKey(url) {
    try {
      const parsed = new URL(normalizeUrl(url));
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '').toLowerCase();
    } catch {
      return String(url || '').trim().toLowerCase();
    }
  }

  // ------------------------------------------------- fractional indexing
  // Order keys from rocicorp/fractional-indexing (CC0-1.0), based on
  // https://observablehq.com/@dgreensp/implementing-fractional-indexing
  // Keys compare with plain `<`, never localeCompare.

  const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const SMALLEST_INTEGER = `A${DIGITS[0].repeat(26)}`;

  function midpoint(a, b) {
    const zero = DIGITS[0];
    if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
    if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) throw new Error('trailing zero');
    if (b) {
      let n = 0;
      while ((a[n] || zero) === b[n]) n += 1;
      if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
    const digitA = a ? DIGITS.indexOf(a[0]) : 0;
    const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
    if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
    if (b && b.length > 1) return b.slice(0, 1);
    return DIGITS[digitA] + midpoint(a.slice(1), null);
  }

  function integerLength(head) {
    if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
    if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
    throw new Error(`invalid order key head: ${head}`);
  }

  function validateInteger(int) {
    if (int.length !== integerLength(int[0])) throw new Error(`invalid integer part: ${int}`);
  }

  function integerPart(key) {
    const length = integerLength(key[0]);
    if (length > key.length) throw new Error(`invalid order key: ${key}`);
    return key.slice(0, length);
  }

  function validateOrderKey(key) {
    if (key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
    const int = integerPart(key);
    if (key.slice(int.length).slice(-1) === DIGITS[0]) throw new Error(`invalid order key: ${key}`);
  }

  function incrementInteger(x) {
    validateInteger(x);
    const [head, ...digits] = x.split('');
    let carry = true;
    for (let i = digits.length - 1; carry && i >= 0; i -= 1) {
      const d = DIGITS.indexOf(digits[i]) + 1;
      if (d === DIGITS.length) {
        digits[i] = DIGITS[0];
      } else {
        digits[i] = DIGITS[d];
        carry = false;
      }
    }
    if (!carry) return head + digits.join('');
    if (head === 'Z') return `a${DIGITS[0]}`;
    if (head === 'z') return null;
    const next = String.fromCharCode(head.charCodeAt(0) + 1);
    if (next > 'a') digits.push(DIGITS[0]);
    else digits.pop();
    return next + digits.join('');
  }

  function decrementInteger(x) {
    validateInteger(x);
    const [head, ...digits] = x.split('');
    let borrow = true;
    for (let i = digits.length - 1; borrow && i >= 0; i -= 1) {
      const d = DIGITS.indexOf(digits[i]) - 1;
      if (d === -1) {
        digits[i] = DIGITS.slice(-1);
      } else {
        digits[i] = DIGITS[d];
        borrow = false;
      }
    }
    if (!borrow) return head + digits.join('');
    if (head === 'a') return `Z${DIGITS.slice(-1)}`;
    if (head === 'A') return null;
    const next = String.fromCharCode(head.charCodeAt(0) - 1);
    if (next < 'Z') digits.push(DIGITS.slice(-1));
    else digits.pop();
    return next + digits.join('');
  }

  function generateKeyBetween(a, b) {
    if (a !== null) validateOrderKey(a);
    if (b !== null) validateOrderKey(b);
    if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
    if (a === null) {
      if (b === null) return `a${DIGITS[0]}`;
      const ib = integerPart(b);
      const fb = b.slice(ib.length);
      if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
      if (ib < b) return ib;
      const result = decrementInteger(ib);
      if (result === null) throw new Error('cannot decrement any more');
      return result;
    }
    if (b === null) {
      const ia = integerPart(a);
      const next = incrementInteger(ia);
      return next === null ? ia + midpoint(a.slice(ia.length), null) : next;
    }
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ia === ib) return ia + midpoint(fa, fb);
    const next = incrementInteger(ia);
    if (next === null) throw new Error('cannot increment any more');
    if (next < b) return next;
    return ia + midpoint(fa, null);
  }

  function generateNKeysBetween(a, b, n) {
    if (n <= 0) return [];
    if (n === 1) return [generateKeyBetween(a, b)];
    if (b === null) {
      let key = generateKeyBetween(a, b);
      const result = [key];
      for (let i = 0; i < n - 1; i += 1) {
        key = generateKeyBetween(key, b);
        result.push(key);
      }
      return result;
    }
    if (a === null) {
      let key = generateKeyBetween(a, b);
      const result = [key];
      for (let i = 0; i < n - 1; i += 1) {
        key = generateKeyBetween(a, key);
        result.push(key);
      }
      return result.reverse();
    }
    const mid = Math.floor(n / 2);
    const key = generateKeyBetween(a, b);
    return [
      ...generateNKeysBetween(a, key, mid),
      key,
      ...generateNKeysBetween(key, b, n - mid - 1),
    ];
  }

  function isValidPos(key) {
    if (typeof key !== 'string' || !POS_RE.test(key)) return false;
    try {
      validateOrderKey(key);
      return true;
    } catch {
      return false;
    }
  }

  // A key between a and b with a short random tail, so two computers that
  // add a shortcut at the same spot at the same time almost never collide.
  function keyBetween(a = null, b = null, random = Math.random) {
    const base = generateKeyBetween(a, b);
    let tail = '';
    for (let i = 0; i < 3; i += 1) tail += DIGITS[Math.floor(random() * DIGITS.length) % DIGITS.length];
    if (tail.endsWith(DIGITS[0])) tail = `${tail.slice(0, -1)}1`;
    const candidate = base + tail;
    if ((a === null || a < candidate) && (b === null || candidate < b) && isValidPos(candidate)) return candidate;
    return base;
  }

  function compareText(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function compareShortcuts(x, y) {
    return compareText(x.pos, y.pos) || compareText(x.id, y.id);
  }

  function sortShortcuts(list) {
    return [...list].sort(compareShortcuts);
  }

  // Position for an item inserted at `index` of a sorted list that does not
  // contain it. Equal neighbour keys are rare; when they happen the items after
  // the insertion point get fresh keys too.
  function planInsert(list, index, random = Math.random) {
    const at = Math.max(0, Math.min(index, list.length));
    const prev = at > 0 ? list[at - 1].pos : null;
    const next = at < list.length ? list[at].pos : null;
    if (prev === null || next === null || prev < next) {
      return { pos: keyBetween(prev, next, random), rekey: [] };
    }
    let end = at;
    while (end < list.length && !(list[end].pos > prev)) end += 1;
    const upper = end < list.length ? list[end].pos : null;
    const keys = generateNKeysBetween(prev, upper, end - at + 1);
    return {
      pos: keys[0],
      rekey: list.slice(at, end).map((item, offset) => ({ id: item.id, pos: keys[offset + 1] })),
    };
  }

  // -------------------------------------------------------- normalizing

  function arrayOf(value) {
    return Array.isArray(value) ? value : [];
  }

  function stamp(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  function cleanTitle(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function normalizeMime(value) {
    const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
    return /^image\/[a-z0-9.+-]{1,60}$/.test(mime) ? mime : 'image/png';
  }

  function normalizeIcon(icon) {
    if (!icon || typeof icon !== 'object') return null;
    if (icon.type === 'url' && isHttpUrl(icon.url) && icon.url.length <= 2000) return { type: 'url', url: icon.url };
    if (icon.type === 'blob' && BLOB_HASH_RE.test(icon.hash)) return { type: 'blob', hash: icon.hash, mime: normalizeMime(icon.mime) };
    if (icon.type === 'letter') return { type: 'letter' };
    return null;
  }

  function normalizeShortcut(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 120) : '';
    const title = cleanTitle(raw.title);
    const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!id || !title || !rawUrl) return null;
    const url = normalizeUrl(rawUrl).slice(0, 2000);
    if (!isHttpUrl(url)) return null;
    return {
      id,
      title,
      url,
      size: SIZES.includes(raw.size) ? raw.size : 'small',
      icon: normalizeIcon(raw.icon),
      pos: isValidPos(raw.pos) ? raw.pos : '',
      editedAt: stamp(raw.editedAt),
      movedAt: stamp(raw.movedAt),
      createdAt: stamp(raw.createdAt),
    };
  }

  // Two kinds of entries: a delete `{ id, deletedAt }`, and a link
  // `{ id, to }` saying both ids are the same website (folded duplicates).
  function normalizeTombstone(raw) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null;
    const id = raw.id.trim().slice(0, 120);
    const to = typeof raw.to === 'string' ? raw.to.trim().slice(0, 120) : '';
    if (to && to !== id) return { id, to };
    return { id, deletedAt: stamp(raw.deletedAt) };
  }

  function normalizeSyncedSettings(raw) {
    const density = raw && SIZES.includes(raw.iconDensity) ? raw.iconDensity : 'small';
    return { iconDensity: density, iconDensityAt: stamp(raw?.iconDensityAt) };
  }

  function normalizeWallpaper(raw) {
    if (!raw || typeof raw !== 'object') return { ...EMPTY_WALLPAPER };
    const hash = BLOB_HASH_RE.test(raw.hash) ? raw.hash : '';
    return {
      hash,
      mime: hash ? normalizeMime(raw.mime) : '',
      size: hash ? Math.max(0, Math.round(Number(raw.size) || 0)) : 0,
      updatedAt: stamp(raw.updatedAt),
    };
  }

  // ------------------------------------------------------------ merging

  function contentSignature(item) {
    return JSON.stringify([item.title, item.url, item.size, item.icon]);
  }

  function pickNewer(x, y, field, signature) {
    if (x[field] !== y[field]) return x[field] > y[field] ? x : y;
    return signature(x) >= signature(y) ? x : y;
  }

  function earliest(a, b) {
    if (!a) return b;
    if (!b) return a;
    return Math.min(a, b);
  }

  function mergeItem(x, y) {
    const content = pickNewer(x, y, 'editedAt', contentSignature);
    const place = pickNewer(x, y, 'movedAt', item => item.pos);
    return {
      id: x.id,
      title: content.title,
      url: content.url,
      size: content.size,
      icon: content.icon ? { ...content.icon } : null,
      pos: place.pos,
      editedAt: content.editedAt,
      movedAt: place.movedAt,
      createdAt: earliest(x.createdAt, y.createdAt),
    };
  }

  function lastTouched(item) {
    return Math.max(item.editedAt, item.movedAt);
  }

  function compareSurvivor(a, b) {
    const ca = a.createdAt || Number.MAX_SAFE_INTEGER;
    const cb = b.createdAt || Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return compareText(a.id, b.id);
  }

  function placeUnpositioned(list) {
    const placed = list.filter(item => item.pos);
    const loose = list.filter(item => !item.pos).sort(compareSurvivor);
    if (!loose.length) return list;
    const last = placed.length ? placed[placed.length - 1].pos : null;
    const keys = generateNKeysBetween(last, null, loose.length);
    return [...placed, ...loose.map((item, index) => ({ ...item, pos: keys[index] }))];
  }

  function compareEntries(a, b) {
    return compareText(a.id, b.id) || compareText(a.to || '', b.to || '');
  }

  function capEntries(deletes, links) {
    const keptDeletes = [...deletes]
      .sort((a, b) => (b.deletedAt - a.deletedAt) || compareText(a.id, b.id))
      .slice(0, MAX_TOMBSTONES);
    return [...keptDeletes, ...[...links].sort(compareEntries).slice(0, MAX_TOMBSTONES)].sort(compareEntries);
  }

  // Shortcuts for the same website, on any computer, are one shortcut: the
  // oldest id represents them, content and position each take the newest
  // value among them, and a delete of any of them deletes the website unless
  // one of them was changed afterwards. Links remember which ids belong
  // together, so edits made elsewhere on a folded copy are never lost.
  function normalizeDoc(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const items = new Map();
    for (const entry of arrayOf(source.shortcuts).slice(0, MAX_SHORTCUTS * 2)) {
      const item = normalizeShortcut(entry);
      if (!item) continue;
      const previous = items.get(item.id);
      items.set(item.id, previous ? mergeItem(previous, item) : item);
    }

    const deletes = new Map();
    const links = [];
    for (const entry of arrayOf(source.tombstones)) {
      const tomb = normalizeTombstone(entry);
      if (!tomb) continue;
      if (tomb.to) links.push(tomb);
      else if (!deletes.has(tomb.id) || deletes.get(tomb.id) < tomb.deletedAt) deletes.set(tomb.id, tomb.deletedAt);
    }

    const parent = new Map();
    const find = id => {
      let root = id;
      while (parent.has(root)) root = parent.get(root);
      let node = id;
      while (parent.has(node)) {
        const next = parent.get(node);
        if (next !== root) parent.set(node, root);
        node = next;
      }
      return root;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return false;
      if (ra < rb) parent.set(rb, ra);
      else parent.set(ra, rb);
      return true;
    };
    for (const link of links) union(link.id, link.to);

    let groups;
    let live;
    for (;;) {
      groups = new Map();
      for (const item of items.values()) {
        const root = find(item.id);
        if (!groups.has(root)) groups.set(root, { members: [], deletedAt: -1 });
        groups.get(root).members.push(item);
      }
      for (const [id, at] of deletes) {
        const group = groups.get(find(id));
        if (group && at > group.deletedAt) group.deletedAt = at;
      }
      live = [];
      for (const group of groups.values()) {
        group.members.sort(compareSurvivor);
        let merged = group.members[0];
        for (const other of group.members.slice(1)) merged = mergeItem(merged, { ...other, id: merged.id });
        group.merged = merged;
        if (group.deletedAt >= 0 && group.deletedAt >= lastTouched(merged)) continue;
        live.push(merged);
      }
      // Live shortcuts that point at the same address become one.
      const byUrl = new Map();
      let folded = false;
      for (const item of live) {
        const key = urlKey(item.url);
        const other = byUrl.get(key);
        if (other) folded = union(other.id, item.id) || folded;
        else byUrl.set(key, item);
      }
      if (!folded) break;
    }

    const linkOut = new Map();
    const linkTo = id => {
      const group = groups.get(find(id));
      return group ? group.merged.id : find(id);
    };
    for (const group of groups.values()) {
      for (const member of group.members) if (member.id !== group.merged.id) linkOut.set(member.id, group.merged.id);
    }
    for (const link of links) {
      for (const id of [link.id, link.to]) {
        const target = linkTo(id);
        if (target !== id && !linkOut.has(id)) linkOut.set(id, target);
      }
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      shortcuts: placeUnpositioned(sortShortcuts(live)).slice(0, MAX_SHORTCUTS),
      tombstones: capEntries(
        [...deletes].map(([id, deletedAt]) => ({ id, deletedAt })),
        [...linkOut].map(([id, to]) => ({ id, to })),
      ),
      settings: normalizeSyncedSettings(source.settings),
      wallpaper: normalizeWallpaper(source.wallpaper),
    };
  }

  function pickSettings(a, b) {
    if (a.iconDensityAt !== b.iconDensityAt) return a.iconDensityAt > b.iconDensityAt ? a : b;
    return SIZES.indexOf(a.iconDensity) >= SIZES.indexOf(b.iconDensity) ? a : b;
  }

  function pickWallpaper(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
    return a.hash >= b.hash ? a : b;
  }

  function mergeDocs(a, b) {
    const x = normalizeDoc(a);
    const y = normalizeDoc(b);
    return normalizeDoc({
      shortcuts: [...x.shortcuts, ...y.shortcuts],
      tombstones: [...x.tombstones, ...y.tombstones],
      settings: pickSettings(x.settings, y.settings),
      wallpaper: pickWallpaper(x.wallpaper, y.wallpaper),
    });
  }

  // First sync choice "use cloud": this device takes the cloud copy as is.
  function adoptRemote(local, remote) {
    const x = normalizeDoc(local);
    const y = normalizeDoc(remote);
    const cloudHasWallpaper = Boolean(y.wallpaper.hash || y.wallpaper.updatedAt);
    return normalizeDoc({
      shortcuts: y.shortcuts,
      tombstones: y.tombstones,
      settings: y.settings.iconDensityAt ? y.settings : x.settings,
      wallpaper: cloudHasWallpaper ? y.wallpaper : x.wallpaper,
    });
  }

  // First sync choice "use this device": the cloud and every other device end
  // up with this device's shortcuts. `now` must be newer than anything seen.
  function overrideRemote(local, remote, now) {
    const x = normalizeDoc(local);
    const y = normalizeDoc(remote);
    const localIds = new Set(x.shortcuts.map(item => item.id));
    const tombstones = [...x.tombstones, ...y.tombstones];
    // One tick before the local copy's new time: a cloud shortcut linked to a
    // local one (same website) stays, every other cloud shortcut goes.
    for (const item of y.shortcuts) {
      if (!localIds.has(item.id)) tombstones.push({ id: item.id, deletedAt: now - 1 });
    }
    return normalizeDoc({
      shortcuts: x.shortcuts.map(item => ({ ...item, editedAt: now, movedAt: now })),
      tombstones: tombstones.filter(tomb => tomb.to || !localIds.has(tomb.id)),
      settings: { ...x.settings, iconDensityAt: now },
      wallpaper: x.wallpaper.hash ? { ...x.wallpaper, updatedAt: now } : y.wallpaper,
    });
  }

  // The parts of `after` that are newer than `before`: edits made while a
  // request was in flight, kept when the rest of the local copy is replaced.
  // Only newer values count, so an out-of-date copy never looks like an edit.
  function changesSince(before, after) {
    const x = normalizeDoc(before);
    const y = normalizeDoc(after);
    const prior = new Map(x.shortcuts.map(item => [item.id, item]));
    const priorLinks = new Map(x.tombstones.filter(tomb => tomb.to).map(tomb => [tomb.id, tomb.to]));
    const priorDeletes = new Map(x.tombstones.filter(tomb => !tomb.to).map(tomb => [tomb.id, tomb.deletedAt]));
    const shortcuts = [];
    for (const item of y.shortcuts) {
      const old = prior.get(item.id) || prior.get(priorLinks.get(item.id));
      if (!old) {
        const deletedAt = priorDeletes.get(item.id);
        if (deletedAt === undefined || deletedAt < lastTouched(item)) shortcuts.push(item);
        continue;
      }
      const contentNewer = item.editedAt > old.editedAt;
      const placeNewer = item.movedAt > old.movedAt;
      // Only the newer part may win against the other copy.
      if (contentNewer || placeNewer) {
        shortcuts.push({ ...item, editedAt: contentNewer ? item.editedAt : 0, movedAt: placeNewer ? item.movedAt : 0 });
      }
    }
    return normalizeDoc({
      shortcuts,
      tombstones: y.tombstones.filter(tomb => (tomb.to
        ? priorLinks.get(tomb.id) !== tomb.to
        : !(priorDeletes.get(tomb.id) >= tomb.deletedAt))),
      settings: y.settings.iconDensityAt > x.settings.iconDensityAt ? y.settings : null,
      wallpaper: y.wallpaper.updatedAt > x.wallpaper.updatedAt ? y.wallpaper : null,
    });
  }

  function canonicalDoc(doc) {
    const d = normalizeDoc(doc);
    return JSON.stringify([
      d.shortcuts.map(item => [item.id, item.title, item.url, item.size, item.icon, item.pos, item.editedAt, item.movedAt, item.createdAt]),
      d.tombstones.map(tomb => [tomb.id, tomb.deletedAt ?? null, tomb.to ?? null]),
      [d.settings.iconDensity, d.settings.iconDensityAt],
      [d.wallpaper.hash, d.wallpaper.mime, d.wallpaper.size, d.wallpaper.updatedAt],
    ]);
  }

  function sameDoc(a, b) {
    return canonicalDoc(a) === canonicalDoc(b);
  }

  function maxTimestamp(doc) {
    const d = normalizeDoc(doc);
    let max = Math.max(d.settings.iconDensityAt, d.wallpaper.updatedAt);
    for (const item of d.shortcuts) max = Math.max(max, item.editedAt, item.movedAt, item.createdAt);
    for (const tomb of d.tombstones) max = Math.max(max, tomb.deletedAt || 0);
    return max;
  }

  function hasContent(doc) {
    const d = normalizeDoc(doc);
    return d.shortcuts.length > 0 || d.tombstones.length > 0 || Boolean(d.wallpaper.hash);
  }

  function summarizeDifference(local, remote) {
    const localKeys = new Set(normalizeDoc(local).shortcuts.map(item => urlKey(item.url)));
    const remoteKeys = new Set(normalizeDoc(remote).shortcuts.map(item => urlKey(item.url)));
    let common = 0;
    for (const key of localKeys) if (remoteKeys.has(key)) common += 1;
    return {
      localCount: localKeys.size,
      remoteCount: remoteKeys.size,
      common,
      localOnly: localKeys.size - common,
      remoteOnly: remoteKeys.size - common,
      mergedCount: localKeys.size + remoteKeys.size - common,
    };
  }

  function blobRefs(doc) {
    const d = normalizeDoc(doc);
    const refs = new Map();
    if (d.wallpaper.hash) refs.set(d.wallpaper.hash, { hash: d.wallpaper.hash, mime: d.wallpaper.mime, kind: 'wallpaper' });
    for (const item of d.shortcuts) {
      if (item.icon?.type === 'blob' && !refs.has(item.icon.hash)) {
        refs.set(item.icon.hash, { hash: item.icon.hash, mime: item.icon.mime, kind: 'icon' });
      }
    }
    return [...refs.values()];
  }

  return {
    SCHEMA_VERSION,
    SIZES,
    BLOB_HASH_RE,
    normalizeUrl,
    isHttpUrl,
    siteOrigin,
    hostnameFromUrl,
    urlKey,
    cleanTitle,
    generateKeyBetween,
    generateNKeysBetween,
    keyBetween,
    isValidPos,
    sortShortcuts,
    compareShortcuts,
    planInsert,
    normalizeIcon,
    normalizeShortcut,
    normalizeDoc,
    normalizeWallpaper,
    normalizeSyncedSettings,
    mergeDocs,
    adoptRemote,
    overrideRemote,
    changesSince,
    canonicalDoc,
    sameDoc,
    maxTimestamp,
    hasContent,
    summarizeDifference,
    blobRefs,
  };
});
