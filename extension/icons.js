/*
 * Finds the sharpest icon for a website and turns it into a 256 px tile.
 *
 * Every candidate is downloaded and decoded so its real size is known; the
 * largest square one wins. The picture is shown the way the site drew it:
 * empty transparent margins are trimmed, filled shapes (rounded squares,
 * circles) fill the tile, transparent logos stay transparent. Nothing is
 * drawn behind them. Sites with no usable icon get a coloured letter tile.
 */
(function (root) {
  'use strict';

  const { normalizeUrl, siteOrigin, hostnameFromUrl, isHttpUrl } = root.TomorinCore;

  const PIPELINE = 4;
  const TILE = 256;
  const FETCH_TIMEOUT_MS = 7000;
  const PAGE_TIMEOUT_MS = 8000;
  const MAX_ICON_BYTES = 5 * 1024 * 1024;
  const SHARP_ENOUGH = 120;
  const SMALL_ICON = 64;
  const LETTER_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";
  const LETTER_PALETTE = [
    ['#5B9BFF', '#2F64F0'],
    ['#8B7CFF', '#5444DD'],
    ['#C07BFF', '#8640DB'],
    ['#FF7FAE', '#E0447E'],
    ['#FF8A73', '#E14B3D'],
    ['#FFAA55', '#EC6F21'],
    ['#45D49A', '#14A36A'],
    ['#3FD4C8', '#0E9A98'],
    ['#55C3F7', '#1D86D9'],
    ['#F7BE4F', '#E58A0F'],
  ];
  const SOURCE_BONUS = {
    'apple-touch': 30,
    manifest: 20,
    'page-icon': 8,
    tile: 4,
    'well-known': 0,
    chosen: 0,
    google: -6,
    duckduckgo: -10,
    chrome: -20,
    'brand-image': -30,
    'brand-logo': -40,
    'manifest-maskable': -70,
  };

  const hasChromeRuntime = Boolean(root.chrome?.runtime?.getURL);
  let chromeDefaultIconHash = null;

  // ---------------------------------------------------------- fetching

  async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { credentials: 'omit', ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function absoluteUrl(value, base) {
    if (!value) return '';
    try {
      const url = new URL(value, base).toString();
      return isHttpUrl(url) ? url : '';
    } catch {
      return '';
    }
  }

  function relValues(element) {
    return String(element.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  function declaredSize(sizes, url = '') {
    const declared = String(sizes || '').split(/\s+/).map(size => {
      if (/^any$/i.test(size)) return 512;
      const match = size.match(/^(\d+)x(\d+)$/i);
      return match ? Math.min(Number(match[1]), Number(match[2])) : 0;
    });
    const fromName = [...String(url).matchAll(/(?:^|[/_-])(\d{2,4})(?:x(\d{2,4}))?(?=[_.\-?]|$)/gi)]
      .map(match => Number(match[1]))
      .filter(size => size >= 16 && size <= 1024);
    return Math.max(0, ...declared, ...fromName);
  }

  // A server error, a timeout status, or a body that stops halfway may work
  // next time; a 404 means the picture is not there.
  function isTemporaryStatus(status) {
    return status >= 500 || status === 408 || status === 429;
  }

  function noteFailure(context) {
    if (context) context.failures += 1;
  }

  async function pageCandidates(pageUrl, { includeBrand = false, context = null } = {}) {
    let response;
    try {
      response = await fetchWithTimeout(pageUrl, { cache: 'force-cache' }, PAGE_TIMEOUT_MS);
    } catch {
      noteFailure(context);
      return [];
    }
    if (context) context.responses += 1;
    if (!response.ok) {
      if (isTemporaryStatus(response.status)) noteFailure(context);
      return [];
    }
    const type = response.headers.get('content-type') || '';
    if (type && !/html|xml/i.test(type)) return [];

    let html = '';
    try {
      html = (await response.text()).slice(0, 2_000_000);
    } catch {
      noteFailure(context);
      return [];
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pageBase = response.url || pageUrl;
    const base = absoluteUrl(doc.querySelector('base[href]')?.getAttribute('href'), pageBase) || pageBase;
    const out = [];

    for (const link of doc.querySelectorAll('link[rel][href]')) {
      const rels = relValues(link);
      const url = absoluteUrl(link.getAttribute('href'), base);
      if (!url) continue;
      const size = declaredSize(link.getAttribute('sizes'), url);
      if (rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed')) {
        out.push({ url, source: 'apple-touch', declared: size || 180 });
      } else if (rels.includes('icon') || rels.includes('fluid-icon')) {
        out.push({ url, source: 'page-icon', declared: size || (/\.svg(\?|$)/i.test(url) ? 512 : 32) });
      }
    }

    const tileImage = doc.querySelector('meta[name="msapplication-TileImage" i][content]');
    const tileUrl = absoluteUrl(tileImage?.getAttribute('content'), base);
    if (tileUrl) out.push({ url: tileUrl, source: 'tile', declared: declaredSize('', tileUrl) || 144 });

    if (includeBrand) {
      const imageKeys = new Set(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src', 'image']);
      for (const meta of doc.querySelectorAll('meta[content]')) {
        const keys = ['property', 'name', 'itemprop'].map(name => String(meta.getAttribute(name) || '').trim().toLowerCase());
        if (!keys.some(key => imageKeys.has(key))) continue;
        const url = absoluteUrl(meta.getAttribute('content'), base);
        if (url) out.push({ url, source: 'brand-image', declared: 256 });
      }
      [...doc.querySelectorAll('img[src]')]
        .filter(img => /\blogo\b|brand|favicon|app-icon/.test(`${img.getAttribute('alt') || ''} ${img.getAttribute('class') || ''} ${img.getAttribute('id') || ''} ${img.getAttribute('src') || ''}`.toLowerCase()))
        .slice(0, 4)
        .forEach(img => {
          const url = absoluteUrl(img.getAttribute('src'), base);
          if (url) out.push({ url, source: 'brand-logo', declared: 128 });
        });
    }

    const manifestLink = [...doc.querySelectorAll('link[rel][href]')].find(link => relValues(link).includes('manifest'));
    const manifestUrl = absoluteUrl(manifestLink?.getAttribute('href'), base);
    if (manifestUrl) out.push(...await manifestCandidates(manifestUrl, context));
    return out;
  }

  async function manifestCandidates(manifestUrl, context = null) {
    let response;
    try {
      response = await fetchWithTimeout(manifestUrl, { cache: 'force-cache' });
    } catch {
      noteFailure(context);
      return [];
    }
    if (!response.ok) {
      if (isTemporaryStatus(response.status)) noteFailure(context);
      return [];
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      noteFailure(context);
      return [];
    }
    try {
      const manifest = JSON.parse(text);
      if (!Array.isArray(manifest?.icons)) return [];
      return manifest.icons.flatMap(icon => {
        const url = absoluteUrl(icon?.src, response.url || manifestUrl);
        if (!url) return [];
        const purposes = String(icon.purpose || 'any').toLowerCase().split(/\s+/);
        const maskableOnly = purposes.includes('maskable') && !purposes.includes('any');
        return [{ url, source: maskableOnly ? 'manifest-maskable' : 'manifest', declared: declaredSize(icon.sizes, url) || 192 }];
      });
    } catch {
      return [];
    }
  }

  function wellKnownCandidates(origin) {
    return [
      { url: new URL('/apple-touch-icon.png', origin).toString(), source: 'apple-touch', declared: 180 },
      { url: new URL('/apple-touch-icon-precomposed.png', origin).toString(), source: 'apple-touch', declared: 180 },
    ];
  }

  function googleCandidate(origin) {
    const url = new URL('https://t3.gstatic.com/faviconV2');
    url.searchParams.set('client', 'SOCIAL');
    url.searchParams.set('type', 'FAVICON');
    url.searchParams.set('fallback_opts', 'TYPE,SIZE,URL');
    url.searchParams.set('url', origin);
    url.searchParams.set('size', '256');
    return { url: url.toString(), source: 'google', declared: 128 };
  }

  function fallbackCandidates(origin, host) {
    const list = [
      { url: new URL('/favicon.ico', origin).toString(), source: 'well-known', declared: 32 },
      { url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`, source: 'duckduckgo', declared: 32 },
    ];
    if (hasChromeRuntime) {
      const url = new URL(root.chrome.runtime.getURL('/_favicon/'));
      url.searchParams.set('pageUrl', origin);
      url.searchParams.set('size', '64');
      list.push({ url: url.toString(), source: 'chrome', declared: 16 });
    }
    return list;
  }

  function mobileOrigin(host) {
    if (!host || /^m\./i.test(host) || /^(\d+\.){3}\d+$/.test(host) || host === 'localhost') return '';
    const base = host.replace(/^www\./i, '');
    if (!base.includes('.')) return '';
    return `https://m.${base}/`;
  }

  // ---------------------------------------------------------- decoding

  function sniffType(bytes, headerType, url) {
    const header = String(headerType || '').split(';', 1)[0].trim().toLowerCase();
    const starts = (...values) => values.every((value, index) => bytes[index] === value);
    if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (starts(0x47, 0x49, 0x46)) return 'image/gif';
    if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
    if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'image/avif';
    const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || header === 'image/svg+xml' || /\.svg(\?|#|$)/i.test(url)) {
      return head.includes('<svg') ? 'image/svg+xml' : '';
    }
    if (head.startsWith('<!doctype') || head.startsWith('<html')) return '';
    return header.startsWith('image/') ? header : '';
  }

  async function decodeBlob(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      return null;
    }
    const isSvg = blob.type === 'image/svg+xml';
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (isSvg && (!width || !height)) {
      width = 512;
      height = 512;
    }
    if (!width || !height) {
      URL.revokeObjectURL(url);
      return null;
    }
    return { img, objectUrl: url, width, height, isSvg };
  }

  function release(evaluated) {
    for (const item of evaluated) {
      if (item?.objectUrl) URL.revokeObjectURL(item.objectUrl);
      if (item) item.objectUrl = '';
    }
  }

  function rasterOf(item) {
    if (!item.isSvg) return { source: item.img, width: item.width, height: item.height };
    const ratio = item.img.naturalWidth && item.img.naturalHeight ? item.img.naturalWidth / item.img.naturalHeight : 1;
    const width = ratio >= 1 ? 512 : Math.max(1, Math.round(512 * ratio));
    const height = ratio >= 1 ? Math.max(1, Math.round(512 / ratio)) : 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(item.img, 0, 0, width, height);
    return { source: canvas, width, height };
  }

  // Pixel facts used to decide how the tile is drawn.
  function analyze(raster) {
    const n = 64;
    const canvas = document.createElement('canvas');
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(raster.source, 0, 0, n, n);
    const { data } = ctx.getImageData(0, 0, n, n);
    const alphaAt = (x, y) => data[(y * n + x) * 4 + 3];
    const region = (x0, y0, w, h) => {
      let sum = 0;
      for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) sum += alphaAt(x, y);
      return sum / (w * h);
    };
    const half = n / 2;
    const corner = Math.min(region(0, 0, 3, 3), region(n - 3, 0, 3, 3), region(0, n - 3, 3, 3), region(n - 3, n - 3, 3, 3));
    const edges = Math.min(region(half - 2, 0, 4, 2), region(half - 2, n - 2, 4, 2), region(0, half - 2, 2, 4), region(n - 2, half - 2, 2, 4));

    let minX = n;
    let minY = n;
    let maxX = -1;
    let maxY = -1;
    let lumSum = 0;
    let lumWeight = 0;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const offset = (y * n + x) * 4;
        const alpha = data[offset + 3];
        if (alpha > 24) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        if (alpha > 128) {
          lumSum += ((0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255) * alpha;
          lumWeight += alpha;
        }
      }
    }

    const ring = [];
    for (let i = 0; i < n; i += 1) ring.push([i, 0], [i, n - 1], [0, i], [n - 1, i]);
    let r = 0;
    let g = 0;
    let b = 0;
    for (const [x, y] of ring) {
      const offset = (y * n + x) * 4;
      r += data[offset];
      g += data[offset + 1];
      b += data[offset + 2];
    }
    r /= ring.length;
    g /= ring.length;
    b /= ring.length;
    let spread = 0;
    for (const [x, y] of ring) {
      const offset = (y * n + x) * 4;
      spread += Math.abs(data[offset] - r) + Math.abs(data[offset + 1] - g) + Math.abs(data[offset + 2] - b);
    }

    // Inside the visible part: a rounded square or a circle is almost entirely
    // filled and reaches its own edges; a logo with see-through parts is not.
    // Measured on the mostly-opaque pixels, so the blurred rim of a scaled-up
    // small favicon does not count as empty space.
    let solid = false;
    let coreMinX = n;
    let coreMinY = n;
    let coreMaxX = -1;
    let coreMaxY = -1;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if (alphaAt(x, y) > 128) {
          coreMinX = Math.min(coreMinX, x);
          coreMinY = Math.min(coreMinY, y);
          coreMaxX = Math.max(coreMaxX, x);
          coreMaxY = Math.max(coreMaxY, y);
        }
      }
    }
    if (coreMaxX >= 0) {
      const boxW = coreMaxX - coreMinX + 1;
      const boxH = coreMaxY - coreMinY + 1;
      let filled = 0;
      for (let y = coreMinY; y <= coreMaxY; y += 1) {
        for (let x = coreMinX; x <= coreMaxX; x += 1) if (alphaAt(x, y) > 128) filled += 1;
      }
      const at = (x, y) => alphaAt(Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y)));
      const midX = Math.round((coreMinX + coreMaxX) / 2);
      const midY = Math.round((coreMinY + coreMaxY) / 2);
      const insetX = Math.max(1, Math.round(boxW * 0.1));
      const insetY = Math.max(1, Math.round(boxH * 0.1));
      const reachesEdges = [at(midX, coreMinY + insetY), at(midX, coreMaxY - insetY), at(coreMinX + insetX, midY), at(coreMaxX - insetX, midY)]
        .every(alpha => alpha > 160);
      solid = boxW >= 8 && boxH >= 8 && reachesEdges && filled / (boxW * boxH) >= 0.72;
    }
    const core = coreMaxX < 0 ? null : { x: coreMinX / n, y: coreMinY / n, w: (coreMaxX - coreMinX + 1) / n, h: (coreMaxY - coreMinY + 1) / n };

    // 8x8 average-hash over the picture flattened on white: the same design
    // at two sizes gives nearly the same bits.
    const cells = [];
    const tint = [0, 0, 0];
    for (let cy = 0; cy < 8; cy += 1) {
      for (let cx = 0; cx < 8; cx += 1) {
        let sum = 0;
        for (let y = cy * 8; y < cy * 8 + 8; y += 1) {
          for (let x = cx * 8; x < cx * 8 + 8; x += 1) {
            const offset = (y * n + x) * 4;
            const alpha = data[offset + 3] / 255;
            const gray = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
            sum += gray * alpha + 255 * (1 - alpha);
            for (let channel = 0; channel < 3; channel += 1) tint[channel] += data[offset + channel] * alpha + 255 * (1 - alpha);
          }
        }
        cells.push(sum / 64);
      }
    }
    const mean = cells.reduce((total, value) => total + value, 0) / cells.length;
    const fingerprint = cells.map(value => (value > mean ? '1' : '0')).join('');

    return {
      fingerprint,
      tint: tint.map(value => value / (n * n)),
      solid,
      core,
      corner,
      edges,
      bbox: maxX < 0 ? null : { x: minX / n, y: minY / n, w: (maxX - minX + 1) / n, h: (maxY - minY + 1) / n },
      lum: lumWeight ? lumSum / lumWeight : 0,
      edgeUniform: spread / ring.length < 24,
    };
  }

  function effectiveSize(item) {
    if (item.isSvg) return 200;
    const size = Math.min(item.width, item.height);
    return item.source === 'chrome' ? Math.min(size, 32) : size;
  }

  function scoreOf(item) {
    if (!item?.stats?.bbox) return -Infinity;
    if (!item.isSvg && Math.max(item.width, item.height) / Math.min(item.width, item.height) > 1.25) return -Infinity;
    const size = effectiveSize(item);
    if (size < 16) return -Infinity;
    return Math.min(size, 256) + (SOURCE_BONUS[item.source] || 0) + (item.mobile ? -3 : 0);
  }

  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function isChromeDefaultIcon(bytes) {
    if (!hasChromeRuntime) return false;
    if (!chromeDefaultIconHash) {
      const url = new URL(root.chrome.runtime.getURL('/_favicon/'));
      url.searchParams.set('pageUrl', 'https://tomorin-default-icon.invalid/');
      url.searchParams.set('size', '64');
      chromeDefaultIconHash = fetch(url.toString())
        .then(response => response.arrayBuffer())
        .then(buffer => sha256Hex(buffer))
        .catch(() => '');
    }
    const expected = await chromeDefaultIconHash;
    return Boolean(expected) && expected === await sha256Hex(bytes);
  }

  async function evaluate(candidate, context = null) {
    let response;
    try {
      response = await fetchWithTimeout(candidate.url, { cache: 'force-cache' });
    } catch {
      noteFailure(context);
      return null;
    }
    if (context) context.responses += 1;
    if (!response.ok) {
      if (isTemporaryStatus(response.status)) noteFailure(context);
      return null;
    }

    let bytes;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      noteFailure(context);
      return null;
    }
    if (!bytes.length || bytes.length > MAX_ICON_BYTES) return null;
    if (candidate.source === 'chrome' && await isChromeDefaultIcon(bytes)) return null;

    const type = sniffType(bytes, response.headers.get('content-type'), candidate.url);
    if (!type) return null;
    const blob = new Blob([bytes], { type });
    const decoded = await decodeBlob(blob);
    if (!decoded) return null;

    const item = { ...candidate, ...decoded, blob };
    try {
      item.stats = analyze(rasterOf(item));
    } catch {
      release([item]);
      return null;
    }
    item.score = scoreOf(item);
    return item;
  }

  async function evaluateAll(candidates, context = null, limit = 6) {
    const seen = new Set();
    const queue = candidates.filter(candidate => {
      if (!candidate?.url || seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    });
    const results = [];
    let index = 0;
    const worker = async () => {
      while (index < queue.length) {
        const candidate = queue[index];
        index += 1;
        const result = await evaluate(candidate, context).catch(() => null);
        if (result) results.push(result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
    return results;
  }

  function hamming(a = '', b = '') {
    let distance = Math.abs(a.length - b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) distance += 1;
    return distance;
  }

  // Same shape and roughly the same colours: one design at two sizes.
  function sameDesign(a, b) {
    const colour = Math.hypot(a.tint[0] - b.tint[0], a.tint[1] - b.tint[1], a.tint[2] - b.tint[2]);
    return hamming(a.fingerprint, b.fingerprint) <= 6 && colour < 48;
  }

  function best(evaluated) {
    return evaluated.filter(item => item.score > -Infinity).sort((a, b) => b.score - a.score)[0] || null;
  }

  // -------------------------------------------------------- composing

  // How much of the tile a small picture may take. A favicon that is only a
  // few pixels wide would turn to mush if stretched across the whole tile.
  function frameRatio(item) {
    const size = effectiveSize(item);
    if (item.isSvg || size >= 96) return 0.64;
    if (size >= 48) return 0.58;
    if (size >= 32) return 0.54;
    return 0.5;
  }

  function logoRatio(item) {
    const size = effectiveSize(item);
    if (item.isSvg || size >= 64) return 0.84;
    if (size >= 48) return 0.8;
    if (size >= 32) return 0.74;
    return 0.66;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/png');
    });
  }

  // Fills the tile around the box so the favicon's own colours carry on to the
  // tile edge: right next to it they repeat its outermost pixels, so there is
  // no edge; further out they soften, so specks along its border do not turn
  // into stripes.
  function extendEdges(ctx, box) {
    const image = ctx.getImageData(0, 0, TILE, TILE);
    const { data } = image;
    // Scaling can leave the box's outermost pixels partly see-through.
    const x0 = box.x + 1;
    const y0 = box.y + 1;
    const x1 = box.x + box.w - 2;
    const y1 = box.y + box.h - 2;
    const distance = (x, y) => Math.max(x0 - x, x - x1, y0 - y, y - y1);
    for (let y = 0; y < TILE; y += 1) {
      const sy = Math.min(y1, Math.max(y0, y));
      for (let x = 0; x < TILE; x += 1) {
        if (distance(x, y) <= 0) continue;
        const from = (sy * TILE + Math.min(x1, Math.max(x0, x))) * 4;
        const to = (y * TILE + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) data[to + channel] = data[from + channel];
      }
    }
    const soft = blurred(data, 10);
    for (let y = 0; y < TILE; y += 1) {
      for (let x = 0; x < TILE; x += 1) {
        const away = distance(x, y);
        if (away <= 0) continue;
        const mix = Math.min(1, away / 12);
        const at = (y * TILE + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          data[at + channel] = Math.round(data[at + channel] + (soft[at + channel] - data[at + channel]) * mix);
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  // Box blur run twice each way (close to a Gaussian). Past the tile edge the
  // nearest pixel repeats, so the edge stays opaque.
  function blurred(pixels, radius) {
    let from = Float32Array.from(pixels);
    let to = new Float32Array(pixels.length);
    for (let pass = 0; pass < 4; pass += 1) {
      const across = pass % 2 === 0;
      for (let line = 0; line < TILE; line += 1) {
        const index = step => {
          const along = Math.min(TILE - 1, Math.max(0, step));
          return (across ? line * TILE + along : along * TILE + line) * 4;
        };
        for (let channel = 0; channel < 4; channel += 1) {
          let sum = 0;
          for (let step = -radius; step <= radius; step += 1) sum += from[index(step) + channel];
          for (let step = 0; step < TILE; step += 1) {
            to[index(step) + channel] = sum / (radius * 2 + 1);
            sum += from[index(step + radius + 1) + channel] - from[index(step - radius) + channel];
          }
        }
      }
      [from, to] = [to, from];
    }
    return from;
  }

  async function compose(item) {
    const raster = rasterOf(item);
    const stats = item.stats || analyze(raster);
    const small = !item.isSvg && effectiveSize(item) < SMALL_ICON;
    const canvas = document.createElement('canvas');
    canvas.width = TILE;
    canvas.height = TILE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    let kind;
    if (stats.corner > 230 && small && stats.edgeUniform) {
      // A small favicon on a plain square: drawn smaller it is far less blurred
      // than stretched. The space around it repeats the favicon's own outer
      // pixels, so a gradient or a slightly uneven colour shows no edge.
      kind = 'full';
      const scale = (TILE * frameRatio(item)) / Math.max(raster.width, raster.height);
      const w = Math.round(raster.width * scale);
      const h = Math.round(raster.height * scale);
      const x = Math.round((TILE - w) / 2);
      const y = Math.round((TILE - h) / 2);
      ctx.drawImage(raster.source, x, y, w, h);
      extendEdges(ctx, { x, y, w, h });
    } else if (stats.corner > 230) {
      kind = 'full';
      const scale = Math.max(TILE / raster.width, TILE / raster.height);
      const w = raster.width * scale;
      const h = raster.height * scale;
      ctx.drawImage(raster.source, (TILE - w) / 2, (TILE - h) / 2, w, h);
    } else {
      // Trim the empty transparent margin, then let a filled shape take the
      // whole tile and give a see-through logo a little room. No background.
      kind = stats.solid ? 'shape' : 'logo';
      // A filled shape is cut at its solid outline so it reaches the tile edge;
      // a logo keeps its soft edges.
      const box = (stats.solid ? stats.core : stats.bbox) || { x: 0, y: 0, w: 1, h: 1 };
      const pad = stats.solid ? 0 : 1 / 64;
      const sx = Math.max(0, (box.x - pad) * raster.width);
      const sy = Math.max(0, (box.y - pad) * raster.height);
      const sw = Math.min(raster.width - sx, (box.w + pad * 2) * raster.width);
      const sh = Math.min(raster.height - sy, (box.h + pad * 2) * raster.height);
      const target = stats.solid ? TILE : TILE * logoRatio(item);
      const scale = target / Math.max(sw, sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(raster.source, sx, sy, sw, sh, (TILE - dw) / 2, (TILE - dh) / 2, dw, dh);
    }

    return { blob: await canvasToBlob(canvas), kind };
  }

  async function finish(winner, evaluated) {
    try {
      if (!winner) return null;
      const { blob, kind } = await compose(winner);
      return { blob, kind, sourceUrl: winner.url, width: winner.width, height: winner.height, pipeline: PIPELINE };
    } finally {
      release(evaluated);
    }
  }

  // ------------------------------------------------------------ public

  // Best automatic icon for a site. `reachable` is false when no request got
  // any answer (offline); either way callers retry later instead of giving up.
  async function resolveBest(siteUrl) {
    const target = normalizeUrl(siteUrl);
    const origin = siteOrigin(target);
    const context = { responses: 0, failures: 0 };
    let host = '';
    try {
      host = new URL(target).hostname;
    } catch {
      return { result: null, reachable: true, complete: true };
    }

    const pagePromise = pageCandidates(target, { context });
    let evaluated = await evaluateAll([...wellKnownCandidates(origin), googleCandidate(origin)], context);
    const declared = (await pagePromise).sort((a, b) => b.declared - a.declared).slice(0, 8);
    evaluated = evaluated.concat(await evaluateAll(declared, context));

    if (effectiveSize(best(evaluated) || { width: 0, height: 0 }) < SHARP_ENOUGH) {
      evaluated = evaluated.concat(await evaluateAll(fallbackCandidates(origin, host), context));
    }

    const mobile = mobileOrigin(host);
    if (mobile && (best(evaluated)?.score || 0) < SMALL_ICON + 8) {
      const mobilePage = (await pageCandidates(mobile, { context })).sort((a, b) => b.declared - a.declared).slice(0, 6);
      const mobileEvaluated = await evaluateAll([...mobilePage, googleCandidate(mobile)].map(candidate => ({ ...candidate, mobile: true })), context);
      mobileEvaluated.forEach(item => { item.score = scoreOf(item); });
      evaluated = evaluated.concat(mobileEvaluated);
    }

    const result = await finish(best(evaluated), evaluated);
    // `complete` is false when some requests failed, so a better icon may exist.
    return { result, reachable: context.responses > 0, complete: context.failures === 0 };
  }

  // Icon from one specific address the user picked. `complete` is false when
  // the request failed, so the caller tries again later.
  async function resolveFromUrl(iconUrl) {
    const context = { responses: 0, failures: 0 };
    const evaluated = await evaluateAll([{ url: iconUrl, source: 'chosen', declared: 0 }], context);
    const item = evaluated[0];
    const result = await finish(item && item.stats?.bbox ? item : null, evaluated);
    return { result, complete: context.failures === 0 };
  }

  // Every usable icon for the edit dialog, sharpest first, already drawn as tiles.
  async function listChoices(siteUrl) {
    const target = normalizeUrl(siteUrl);
    const origin = siteOrigin(target);
    let host = '';
    try {
      host = new URL(target).hostname;
    } catch {
      return [];
    }
    const page = await pageCandidates(target, { includeBrand: true });
    const declared = page.filter(item => !item.source.startsWith('brand')).sort((a, b) => b.declared - a.declared).slice(0, 8);
    const brand = page.filter(item => item.source.startsWith('brand')).slice(0, 3);
    const evaluated = await evaluateAll([
      ...declared,
      ...wellKnownCandidates(origin),
      googleCandidate(origin),
      ...fallbackCandidates(origin, host),
      ...brand,
    ]);
    const usable = [];
    for (const item of evaluated.filter(entry => entry.score > -Infinity).sort((a, b) => b.score - a.score)) {
      const duplicate = usable.some(kept => sameDesign(kept.stats, item.stats));
      if (!duplicate) usable.push(item);
      if (usable.length >= 8) break;
    }
    const choices = [];
    for (const item of usable) {
      try {
        const { blob, kind } = await compose(item);
        choices.push({ url: item.url, source: item.source, width: item.width, height: item.height, isSvg: item.isSvg, blob, kind, pipeline: PIPELINE });
      } catch {
        // Skip pictures the canvas cannot draw.
      }
    }
    release(evaluated);
    return choices;
  }

  async function normalizeUpload(file) {
    const decoded = await decodeBlob(file);
    if (!decoded) throw new Error('Unable to load icon');
    try {
      const raster = rasterOf(decoded);
      const canvas = document.createElement('canvas');
      canvas.width = TILE;
      canvas.height = TILE;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const scale = Math.min(TILE / raster.width, TILE / raster.height);
      const w = Math.max(1, Math.round(raster.width * scale));
      const h = Math.max(1, Math.round(raster.height * scale));
      ctx.drawImage(raster.source, Math.round((TILE - w) / 2), Math.round((TILE - h) / 2), w, h);
      return await canvasToBlob(canvas);
    } finally {
      URL.revokeObjectURL(decoded.objectUrl);
    }
  }

  // ----------------------------------------------------- letter tiles

  function letterGlyph(title, url) {
    const text = String(title || '').trim() || hostnameFromUrl(url) || '?';
    const first = Array.from(text)[0] || '?';
    return /[a-z]/i.test(first) ? first.toUpperCase() : first;
  }

  function hashText(text) {
    let hash = 5381;
    for (const char of String(text)) hash = ((hash << 5) + hash + char.codePointAt(0)) >>> 0;
    return hash;
  }

  function escapeXml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  }

  const letterCache = new Map();

  function letterTile(title, url) {
    const glyph = letterGlyph(title, url);
    const seed = hostnameFromUrl(url) || String(title || '');
    const key = `${glyph}|${seed}`;
    if (letterCache.has(key)) return letterCache.get(key);

    const [from, to] = LETTER_PALETTE[hashText(seed) % LETTER_PALETTE.length];
    const wide = /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿＀-￯]/.test(glyph);
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">',
      '<defs>',
      `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`,
      '<radialGradient id="h" cx="0.28" cy="0.18" r="0.95"><stop offset="0" stop-color="#ffffff" stop-opacity="0.24"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>',
      '</defs>',
      '<rect width="256" height="256" fill="url(#g)"/>',
      '<rect width="256" height="256" fill="url(#h)"/>',
      `<text x="128" y="128" dy="${wide ? '0.37em' : '0.355em'}" text-anchor="middle" font-family="${LETTER_FONT}" font-size="${wide ? 112 : 124}" font-weight="600" fill="#ffffff">${escapeXml(glyph)}</text>`,
      '</svg>',
    ].join('');
    const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    letterCache.set(key, dataUrl);
    return dataUrl;
  }

  root.TomorinIcons = {
    PIPELINE,
    resolveBest,
    resolveFromUrl,
    listChoices,
    normalizeUpload,
    letterTile,
    sha256Hex,
  };
})(self);
