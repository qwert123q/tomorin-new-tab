// Icon choice: the sharpest square icon wins, small favicons get room without a
// visible edge,
// sites without icons get a letter tile, and the edit dialog offers every
// distinct option.
const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tinyPngBuffer() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVqK3wAAAABJRU5ErkJggg==', 'base64');
}

// Polls from Node because waitForFunction does not await async predicates.
async function waitUntil(page, predicate, arg, message, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(predicate, arg)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(message);
}

async function waitForRecords(page, count) {
  await waitUntil(page, async expected => (await getAllIconRecords()).length >= expected && iconQueue.length === 0 && iconWorkers === 0, count, `expected ${count} icon records`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', error => console.error(`page error: ${error.message}`));

  await page.addInitScript(() => {
    window.__fetches = [];
    const png = async (width, height, { background = '#0a84ff', mark = '#ffffff', transparent = false } = {}) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!transparent) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }
      ctx.fillStyle = mark;
      ctx.fillRect(width * 0.3, height * 0.3, width * 0.4, height * 0.4);
      return await canvas.convertToBlob({ type: 'image/png' });
    };
    const html = body => new Response(`<!doctype html><html><head>${body}</head><body></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html' } });
    const image = blob => new Response(blob, { status: 200, headers: { 'Content-Type': 'image/png' } });
    window.fetch = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url).href;
      window.__fetches.push(url);
      if (url === 'https://www.tiktok.com/foryou?lang=es') {
        return html(`
          <link rel="icon" type="image/png" href="/declared-32.png">
          <link rel="apple-touch-icon" sizes="180x180" href="/declared-180.png">
          <link rel="manifest" href="/manifest.json">
          <meta property="og:image" content="/brand-wide.png">
          <meta name="twitter:image:alt" content="Not a url">
        `);
      }
      if (url === 'https://www.tiktok.com/manifest.json') {
        return new Response(JSON.stringify({ icons: [
          { src: '/icon-512.png', sizes: '512x512' },
          { src: '/icon-192.png', sizes: '192x192' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://www.tiktok.com/declared-32.png') return image(await png(32, 32, { background: '#34c759' }));
      if (url === 'https://www.tiktok.com/declared-180.png') return image(await png(180, 180, { background: '#ff2d55' }));
      if (url === 'https://www.tiktok.com/icon-512.png') return image(await png(512, 512, { background: '#111111' }));
      if (url === 'https://www.tiktok.com/icon-192.png') return image(await png(192, 192, { background: '#111111' }));
      if (url === 'https://www.tiktok.com/brand-wide.png') return image(await png(1200, 630));
      if (url === 'https://tiny.example/') return html('<link rel="icon" href="/favicon-16.png">');
      if (url === 'https://tiny.example/favicon-16.png') return image(await png(16, 16, { transparent: true, mark: '#1d4ed8' }));
      if (url === 'https://boat.example/') return html('<link rel="icon" href="/favicon-32.png">');
      if (url === 'https://boat.example/favicon-32.png') {
        // A small opaque favicon whose blue gets darker towards the bottom.
        const canvas = new OffscreenCanvas(32, 32);
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 32);
        gradient.addColorStop(0, '#6fb9ff');
        gradient.addColorStop(1, '#52a6fa');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 32, 32);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(10, 11, 13, 9);
        return image(await canvas.convertToBlob({ type: 'image/png' }));
      }
      if (url === 'https://ring.example/') return html('<link rel="apple-touch-icon" href="/ring.png">');
      if (url === 'https://ring.example/ring.png') {
        // A see-through logo: a thick ring on a transparent background.
        const canvas = new OffscreenCanvas(180, 180);
        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = '#e11d48';
        ctx.lineWidth = 24;
        ctx.beginPath();
        ctx.arc(90, 90, 56, 0, Math.PI * 2);
        ctx.stroke();
        return image(await canvas.convertToBlob({ type: 'image/png' }));
      }
      return new Response('', { status: 404 });
    };

    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    const item = (id, title, url, pos) => ({ id, title, url, size: 'small', icon: null, pos, editedAt: 5, movedAt: 5, createdAt: 5 });
    localStorage.setItem('tomorinNewTabState', JSON.stringify({
      version: 2,
      shortcuts: [
        item('tt', 'TikTok', 'https://www.tiktok.com/foryou?lang=es', 'a0'),
        item('tiny', 'Tiny', 'https://tiny.example', 'a1'),
        item('none', '没有图标', 'https://none.example', 'a2'),
        item('ring', 'Ring', 'https://ring.example', 'a3'),
        item('boat', 'Boat', 'https://boat.example', 'a4'),
      ],
      tombstones: [],
      settings: { currentPage: 0, searchEngine: 'default', iconDensity: 'small', iconDensityAt: 0, wallpaper: { type: 'none' } },
      sync: { enabled: false },
      clock: 5,
      pristine: false,
    }));
  });

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await waitForRecords(page, 5);

  const resolved = await page.evaluate(async () => {
    const records = Object.fromEntries((await getAllIconRecords()).map(record => [record.id, record]));
    const pixels = async (blob, points) => {
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return { size: `${bitmap.width}x${bitmap.height}`, points: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) };
    };
    return {
      tt: { source: records.tt.sourceUrl, width: records.tt.width, kind: records.tt.kind, ...(await pixels(records.tt.blob, [[4, 4]])) },
      tiny: { width: records.tiny.width, kind: records.tiny.kind, ...(await pixels(records.tiny.blob, [[24, 128], [128, 128]])) },
      none: { blob: records.none.blob, kind: records.none.kind },
      ring: { kind: records.ring.kind, ...(await pixels(records.ring.blob, [[4, 4], [128, 128], [128, 45]])) },
      boat: { width: records.boat.width, kind: records.boat.kind, ...(await pixels(records.boat.blob, Array.from({ length: 256 }, (_, y) => [70, y]))) },
      srcs: Object.fromEntries([...document.querySelectorAll('.shortcut-card')].map(card => [card.dataset.id, card.querySelector('img').getAttribute('src')])),
      stamps: state.shortcuts.map(item => `${item.editedAt}/${item.movedAt}`),
      fetches: window.__fetches,
    };
  });

  assert(resolved.tt.source === 'https://www.tiktok.com/icon-512.png', `the 512px manifest icon should win, got ${resolved.tt.source}`);
  assert(resolved.tt.kind === 'full' && resolved.tt.size === '256x256', `opaque icons should fill a 256px tile, got ${resolved.tt.kind} ${resolved.tt.size}`);
  // Nothing is drawn behind icons: a filled shape on a transparent margin is
  // trimmed and fills the tile, a see-through logo stays see-through.
  assert(resolved.tiny.kind === 'shape' && resolved.tiny.width === 16, `a filled favicon should fill the tile, got ${resolved.tiny.kind} ${resolved.tiny.width}`);
  const [tinyCorner, tinyCenter] = resolved.tiny.points;
  assert(tinyCorner[3] > 230 && tinyCorner[2] > 150 && tinyCorner[0] < 120, `the trimmed shape should reach the tile edge without a frame, got ${tinyCorner}`);
  assert(tinyCenter[2] > 150 && tinyCenter[0] < 120, `the shape should fill the middle, got ${tinyCenter}`);
  const [ringCorner, ringHole, ringStroke] = resolved.ring.points;
  assert(resolved.ring.kind === 'logo', `a see-through logo should stay a logo, got ${resolved.ring.kind}`);
  assert(ringCorner[3] === 0 && ringHole[3] === 0, `no background may be added behind a transparent logo, got corner ${ringCorner} hole ${ringHole}`);
  assert(ringStroke[3] > 200 && ringStroke[0] > 180, `the logo itself should be drawn, got ${ringStroke}`);
  // A small favicon is drawn smaller, and the space around it continues its own
  // colours: walking down the tile there is no sudden step at its edges.
  assert(resolved.boat.kind === 'full' && resolved.boat.width === 32, `a small opaque favicon should fill the tile, got ${resolved.boat.kind} ${resolved.boat.width}`);
  const boatColumn = resolved.boat.points;
  const steps = boatColumn.slice(1).map((point, index) => point.slice(0, 3).reduce((sum, value, channel) => sum + Math.abs(value - boatColumn[index][channel]), 0));
  const boatStep = Math.max(...steps);
  assert(boatStep <= 6, `a small favicon must not show an edge around it, largest colour step ${boatStep} at y=${steps.indexOf(boatStep)}`);
  assert(boatColumn.every(point => point[3] === 255), 'the tile around a small favicon should be opaque');
  assert(boatColumn[0][0] - boatColumn[255][0] > 20, `the colour above and below the favicon should follow its gradient, got ${boatColumn[0]} and ${boatColumn[255]}`);
  assert(resolved.none.blob === null && resolved.none.kind === 'letter', 'sites without icons should record a letter tile');
  assert(resolved.srcs.none.startsWith('data:image/svg+xml') && decodeURIComponent(resolved.srcs.none).includes('没'), 'letter tile should use the first character of the name');
  assert(resolved.srcs.tt.startsWith('blob:') && resolved.srcs.tiny.startsWith('blob:'), 'found icons should render from the local cache');
  assert(resolved.stamps.every(value => value === '5/5'), `icon lookups must not touch the shortcuts, got ${resolved.stamps}`);
  assert(!resolved.fetches.some(url => url.includes('Not%20a%20url') || url.includes('Not a url')), 'alt text must not be fetched as an image');
  assert(resolved.fetches.some(url => url.startsWith('https://m.tiny.example/')), 'small icons should also try the mobile site');

  // Edit dialog: every distinct square option, sharpest first.
  await page.click('[data-id="tt"]', { button: 'right' });
  await page.click('[data-id="tt"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-icon-choice="url"]').length >= 2 && !dialogChoicesLoading, null, { timeout: 15000 });
  const options = await page.$$eval('#shortcutIconOptions .icon-option', nodes => nodes.map(node => ({
    choice: node.dataset.iconChoice || 'upload',
    label: node.querySelector('.icon-option-label').textContent,
    url: node.dataset.iconUrl || '',
    pressed: node.getAttribute('aria-pressed'),
  })));
  const labels = options.map(option => option.label);
  assert(options[0].choice === 'auto' && options[0].pressed === 'true', 'automatic should be the default choice');
  assert(labels.includes('512px') && labels.includes('180px') && labels.includes('32px'), `dialog should list each size, got ${labels.join(',')}`);
  assert(!labels.includes('192px'), 'the same design at another size should be listed once');
  assert(!options.some(option => option.url.endsWith('brand-wide.png')), 'wide banners are not icons');
  assert(labels.includes('文字') && labels.includes('上传'), 'letter and upload options should be offered');

  await page.click('[data-icon-url="https://www.tiktok.com/declared-180.png"]');
  await page.click('#shortcutForm button[type="submit"]');
  await waitUntil(page, async () => (await getIconRecord('tt'))?.sourceUrl === 'https://www.tiktok.com/declared-180.png', null, 'picked icon should be cached');
  const picked = await page.evaluate(() => ({ icon: state.shortcuts.find(item => item.id === 'tt').icon, editedAt: state.shortcuts.find(item => item.id === 'tt').editedAt }));
  assert(picked.icon?.type === 'url' && picked.icon.url.endsWith('/declared-180.png'), 'a picked icon should be saved with the shortcut');
  assert(picked.editedAt > 5, 'picking an icon is an edit');

  await page.click('[data-id="tt"]');
  await page.setInputFiles('#shortcutIconInput', { name: 'icon.png', mimeType: 'image/png', buffer: tinyPngBuffer() });
  await page.waitForSelector('[data-icon-choice="blob"][aria-pressed="true"]');
  await page.click('#shortcutForm button[type="submit"]');
  await page.waitForFunction(() => state.shortcuts.find(item => item.id === 'tt').icon?.type === 'blob');
  const custom = await page.evaluate(async () => {
    const icon = state.shortcuts.find(item => item.id === 'tt').icon;
    return { stored: Boolean(await getBlobRecord(icon.hash)), src: document.querySelector('[data-id="tt"] img').getAttribute('src') };
  });
  assert(custom.stored && custom.src.startsWith('blob:'), 'uploaded icons should be stored by hash and shown');

  await page.click('[data-id="tt"]');
  await page.click('[data-icon-choice="letter"]');
  await page.click('#shortcutForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('[data-id="tt"] img').getAttribute('src').startsWith('data:image/svg+xml'));

  await page.click('[data-action="add-shortcut"]');
  await page.fill('#shortcutTitle', 'Again');
  await page.fill('#shortcutUrl', 'www.tiktok.com/foryou?lang=es');
  await page.click('#shortcutForm button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已经在收藏里了'));
  assert(await page.$eval('#shortcutDialog', dialog => dialog.open), 'a duplicate address should keep the dialog open');

  console.log(JSON.stringify({
    sharpest: `${resolved.tt.source.split('/').pop()} (${resolved.tt.kind})`,
    smallFavicon: `${resolved.tiny.width}px ${resolved.tiny.kind}, no frame`,
    smallOpaqueFavicon: `${resolved.boat.width}px ${resolved.boat.kind}, largest step ${boatStep}`,
    transparentLogo: resolved.ring.kind,
    noIcon: 'letter tile',
    dialog: labels.join(' '),
  }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
