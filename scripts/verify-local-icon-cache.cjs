const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVqK3wAAAABJRU5ErkJggg==';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tinyPngBuffer() {
  return Buffer.from(tinyPngBase64, 'base64');
}

async function installSeedState(page) {
  await page.addInitScript(() => {
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
  });
}

async function readStoredState(page) {
  return await page.evaluate(() => JSON.parse(localStorage.getItem('tomorinNewTabState')));
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

    if (!record?.blob) return null;
    return {
      id: record.id,
      sourceUrl: record.sourceUrl,
      type: record.blob.type,
      size: record.blob.size,
      updatedAt: record.updatedAt,
    };
  }, id);
}

async function countIconRecords(page) {
  return await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('tomorin-new-tab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!db.objectStoreNames.contains('icons')) {
      db.close();
      return 0;
    }

    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction('icons', 'readonly');
      const request = tx.objectStore('icons').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(base64 => {
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
  }, tinyPngBase64);

  await installSeedState(page);
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.click('[data-action="toggle-edit"]');
  await page.click('.shortcut-card');
  await page.click('[data-icon-kind="apple-touch"]');
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => {
    const raw = localStorage.getItem('tomorinNewTabState');
    if (!raw) return false;
    return JSON.parse(raw).shortcuts[0]?.iconId === 'deep-link';
  });

  let stored = await readStoredState(page);
  let record = await readIconRecord(page);
  assert(stored.shortcuts[0].iconId === 'deep-link', 'should persist selected icon as a local icon id');
  assert(record?.type === 'image/png', `should cache selected icon blob locally, got ${record?.type}`);
  assert(record.sourceUrl === 'https://www.tiktok.com/apple-touch-icon.png', 'should remember the selected icon source');

  await page.reload({ waitUntil: 'domcontentloaded' });
  const srcAfterReload = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(srcAfterReload.startsWith('blob:'), `should render saved shortcut icon from local blob, got ${srcAfterReload}`);

  await page.click('[data-action="toggle-edit"]');
  await page.click('.shortcut-card');
  await page.setInputFiles('#shortcutIconInput', {
    name: 'custom-icon.png',
    mimeType: 'image/png',
    buffer: tinyPngBuffer(),
  });
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => {
    const img = document.querySelector('.shortcut-icon img');
    return img && img.getAttribute('src')?.startsWith('blob:');
  });

  stored = await readStoredState(page);
  record = await readIconRecord(page);
  const countAfterReplace = await countIconRecords(page);
  assert(stored.shortcuts[0].iconId === 'deep-link', 'custom icon should keep the same local icon id');
  assert(!stored.shortcuts[0].customIcon, 'custom icon data should not be stored in shortcut metadata');
  assert(record?.sourceUrl === 'custom', 'custom upload should replace the cached icon record');
  assert(countAfterReplace === 1, `replacing an icon should not leave old icon records, got ${countAfterReplace}`);

  await page.click('.shortcut-card');
  await page.click('[data-action="delete-shortcut"]');
  await page.waitForFunction(() => document.querySelectorAll('.shortcut-card').length === 0);
  record = await readIconRecord(page);
  assert(record === null, 'deleting a shortcut should delete its cached icon');

  console.log(JSON.stringify({
    srcAfterReload,
    cachedIconType: 'image/png',
    countAfterReplace,
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
