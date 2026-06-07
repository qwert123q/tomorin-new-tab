const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVqK3wAAAABJRU5ErkJggg==';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function svgBuffer(size) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}" fill="#fff"/>
      <path d="M${size * 0.2} ${size * 0.58}c${size * 0.08}-${size * 0.2} ${size * 0.32}-${size * 0.2} ${size * 0.4} 0" fill="none" stroke="#1683ff" stroke-width="${size * 0.1}" stroke-linecap="round"/>
    </svg>
  `);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(({ tiny, large }) => {
    const tinyBytes = Uint8Array.from(atob(tiny), char => char.charCodeAt(0));
    const largeBytes = Uint8Array.from(atob(large), char => char.charCodeAt(0));
    window.fetch = async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://cloud.tencent.com/apple-touch-icon.png') {
        return new Response(largeBytes, {
          status: 200,
          headers: { 'Content-Type': 'image/svg+xml' },
        });
      }
      if (url.includes('cloud.tencent.com')) {
        return new Response(tinyBytes, {
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
        id: 'tencent-cloud',
        title: '腾讯云',
        url: 'https://cloud.tencent.com',
        size: 'small',
        iconId: 'tencent-cloud',
        iconUrl: 'https://icons.duckduckgo.com/ip3/cloud.tencent.com.ico',
        order: 0,
      }],
      settings: {
        currentPage: 0,
        wallpaper: { type: 'none' },
        iconDensity: 'small',
      },
    }));
  }, {
    tiny: tinyPngBase64,
    large: svgBuffer(180).toString('base64'),
  });

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('tomorin-new-tab', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('wallpapers')) db.createObjectStore('wallpapers');
        if (!db.objectStoreNames.contains('icons')) db.createObjectStore('icons', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise((resolve, reject) => {
      const tx = db.transaction('icons', 'readwrite');
      tx.objectStore('icons').put({
        id: 'tencent-cloud',
        blob: new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVqK3wAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))], { type: 'image/png' }),
        sourceUrl: 'https://icons.duckduckgo.com/ip3/cloud.tencent.com.ico',
        width: 1,
        height: 1,
        updatedAt: Date.now(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('tomorin-new-tab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction('icons', 'readonly');
      const request = tx.objectStore('icons').get('tencent-cloud');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return record?.sourceUrl === 'https://cloud.tencent.com/apple-touch-icon.png';
  });

  const record = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('tomorin-new-tab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction('icons', 'readonly');
      const request = tx.objectStore('icons').get('tencent-cloud');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return {
      sourceUrl: record.sourceUrl,
      width: record.width,
      height: record.height,
      type: record.blob.type,
    };
  });

  assert(record.width >= 128 && record.height >= 128, `refreshed icon should be high resolution, got ${record.width}x${record.height}`);
  console.log(JSON.stringify(record, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
