const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVqK3wAAAABJRU5ErkJggg==';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readIconRecord(page, id = 'deep-link') {
  return await page.evaluate(async shortcutId => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('tomorin-new-tab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!db.objectStoreNames.contains('icons')) {
      db.close();
      return null;
    }

    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction('icons', 'readonly');
      const request = tx.objectStore('icons').get(shortcutId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();

    return record ? {
      id: record.id,
      sourceUrl: record.sourceUrl,
      type: record.blob.type,
      size: record.blob.size,
    } : null;
  }, id);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(base64 => {
    window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    window.__iconFetchCount = 0;
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    window.fetch = async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://www.tiktok.com/apple-touch-icon.png') {
        window.__iconFetchCount += 1;
        return new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`unexpected icon fetch: ${url}`);
    };

    if (sessionStorage.getItem('__tomorinSeeded')) return;
    sessionStorage.setItem('__tomorinSeeded', '1');
    localStorage.setItem('tomorinNewTabState', JSON.stringify({
      shortcuts: [{
        id: 'deep-link',
        title: 'Deep Link',
        url: 'https://www.tiktok.com/foryou?lang=es',
        size: 'small',
        order: 0,
      }],
      settings: {
        currentPage: 0,
        wallpaper: { type: 'none' },
        iconDensity: 'small',
      },
    }));
  }, tinyPngBase64);

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  const displayedSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(displayedSrc === 'https://www.tiktok.com/apple-touch-icon.png', `expected remote icon first, got ${displayedSrc}`);

  await page.$eval('.shortcut-icon img', img => img.dispatchEvent(new Event('load')));
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('tomorinNewTabState');
    if (!raw) return false;
    return JSON.parse(raw).shortcuts[0]?.iconId === 'deep-link';
  });

  const record = await readIconRecord(page);
  assert(record?.sourceUrl === displayedSrc, 'displayed remote icon should be cached locally');
  const fetchCount = await page.evaluate(() => window.__iconFetchCount);
  assert(fetchCount === 1, `should fetch displayed icon once for local caching, got ${fetchCount}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const srcAfterReload = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(srcAfterReload.startsWith('blob:'), `cached icon should render from local blob after reload, got ${srcAfterReload}`);

  console.log(JSON.stringify({
    displayedSrc,
    srcAfterReload,
    fetchCount,
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
