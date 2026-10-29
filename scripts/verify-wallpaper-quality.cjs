const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wallpaperSvgBuffer() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2304" viewBox="0 0 4096 2304">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0f766e"/>
          <stop offset="1" stop-color="#f59e0b"/>
        </linearGradient>
      </defs>
      <rect width="4096" height="2304" fill="url(#g)"/>
      <g fill="rgba(255,255,255,0.32)">
        ${Array.from({ length: 48 }, (_, index) => {
          const x = (index % 12) * 360 + 90;
          const y = Math.floor(index / 12) * 520 + 120;
          return `<circle cx="${x}" cy="${y}" r="42"/>`;
        }).join('')}
      </g>
    </svg>
  `;
  return Buffer.from(svg);
}

// Wallpapers are stored by their hash, like uploaded icons.
async function readWallpaperInfo(page) {
  return await page.evaluate(async () => {
    const hash = JSON.parse(localStorage.getItem('tomorinNewTabState') || '{}').settings?.wallpaper?.hash;
    if (!hash) return null;
    const record = await getBlobRecord(hash);
    if (!record?.blob) return null;

    const url = URL.createObjectURL(record.blob);
    const image = new Image();
    const dimensions = await new Promise((resolve, reject) => {
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = reject;
      image.src = url;
    });
    URL.revokeObjectURL(url);
    return { type: record.blob.type, ...dimensions };
  });
}

async function waitForWallpaperInfo(page) {
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('tomorinNewTabState');
    if (!raw) return false;
    try {
      return JSON.parse(raw).settings?.wallpaper?.type === 'uploaded';
    } catch {
      return false;
    }
  }, null, { timeout: 8000 });

  const info = await readWallpaperInfo(page);
  if (!info) throw new Error('wallpaper was not written to IndexedDB');
  return info;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('tomorin-new-tab');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = resolve;
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const overlayBlur = await page.$eval('.wallpaper-overlay', overlay => (
    getComputedStyle(overlay).backdropFilter || getComputedStyle(overlay).webkitBackdropFilter || 'none'
  ));
  assert(overlayBlur === 'none', `wallpaper overlay should not blur the wallpaper, got ${overlayBlur}`);

  await page.setInputFiles('#wallpaperInput', {
    name: 'wallpaper.svg',
    mimeType: 'image/svg+xml',
    buffer: wallpaperSvgBuffer(),
  });

  const info = await waitForWallpaperInfo(page);

  assert(Math.max(info.width, info.height) >= 3840, `wallpaper should keep a near-4K long edge, got ${info.width}x${info.height}`);

  // A wallpaper left under the old fixed key (saved before pictures were
  // stored by hash) is still shown, and moved to the hash store.
  const moved = await page.evaluate(async () => {
    const hash = state.settings.wallpaper.hash;
    const record = await getBlobRecord(hash);
    await storeRequest('wallpapers', 'readwrite', store => store.put(record.blob, 'current'));
    await storeRequest('blobs', 'readwrite', store => store.delete(hash));
    return hash;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('has-wallpaper'), null, { timeout: 8000 });
  const after = await page.evaluate(async hash => ({
    inHashStore: Boolean(await getBlobRecord(hash)),
    oldKey: Boolean(await storeRequest('wallpapers', 'readonly', store => store.get('current'))),
  }), moved);
  assert(after.inHashStore && !after.oldKey, `the old wallpaper should move to the hash store, got ${JSON.stringify(after)}`);

  console.log(JSON.stringify({ overlayBlur, wallpaper: info }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
