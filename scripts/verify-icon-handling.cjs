const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function revealSettings(page) {
  await page.hover('.settings-trigger');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.settings-panel')).opacity === '1');
}

function tinyPngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVqK3wAAAABJRU5ErkJggg==',
    'base64',
  );
}

async function readIconRecord(page, id = 'deep-link') {
  return await page.evaluate(async shortcutId => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('tomorin-new-tab');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

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
    window.__TOMORIN_DISABLE_ICON_MIGRATION = true;
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    window.fetch = async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://icons.duckduckgo.com/ip3/tiktok.com.ico') {
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
  }, tinyPngBuffer().toString('base64'));
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  const initialSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  const iconBackground = await page.$eval('.shortcut-icon', icon => getComputedStyle(icon).backgroundColor);
  assert(
    iconBackground === 'rgba(0, 0, 0, 0)',
    `shortcut icon container should be transparent, got ${iconBackground}`,
  );
  assert(initialSrc === 'https://www.tiktok.com/apple-touch-icon.png', `should try high-resolution touch icon first, got ${initialSrc}`);

  await page.$eval('.shortcut-icon img', img => img.dispatchEvent(new Event('error')));
  const secondSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(
    secondSrc === 'https://www.tiktok.com/favicon-32x32.png',
    `should fallback to 32px favicon before remote services, got ${secondSrc}`,
  );

  await page.$eval('.shortcut-icon img', img => img.dispatchEvent(new Event('error')));
  const googleSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(googleSrc.includes('google.com/s2/favicons'), 'should fallback to Google favicon service');
  assert(googleSrc.includes('sz=128'), 'should request 128px Google favicon');

  await page.$eval('.shortcut-icon img', img => img.dispatchEvent(new Event('error')));
  const fallbackSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(fallbackSrc.includes('icons.duckduckgo.com/ip3/tiktok.com.ico'), 'should fallback to DuckDuckGo favicon');

  await revealSettings(page);
  await page.click('[data-action="toggle-edit"]');
  await page.click('.shortcut-card');
  const candidateCount = await page.$$eval('[data-action="select-icon"]', buttons => buttons.length);
  assert(candidateCount >= 4, `should render icon candidates, got ${candidateCount}`);

  await page.click('[data-icon-kind="duckduckgo"]');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => {
    const img = document.querySelector('.shortcut-icon img');
    return img && img.getAttribute('src') && img.getAttribute('src').startsWith('blob:');
  });

  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tomorinNewTabState')));
  let record = await readIconRecord(page);
  const selectedIconSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(
    stored.shortcuts[0].iconUrl.includes('icons.duckduckgo.com/ip3/tiktok.com.ico'),
    'should remember the selected remote icon source',
  );
  assert(stored.shortcuts[0].iconId === 'deep-link', 'should persist selected icon as a local icon id');
  assert(selectedIconSrc.startsWith('blob:'), `should render selected icon from local blob, got ${selectedIconSrc}`);
  assert(record?.sourceUrl.includes('icons.duckduckgo.com/ip3/tiktok.com.ico'), 'should cache selected icon blob locally');

  await page.click('.shortcut-card');
  await page.setInputFiles('#shortcutIconInput', {
    name: 'custom-icon.png',
    mimeType: 'image/png',
    buffer: tinyPngBuffer(),
  });
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => {
    const img = document.querySelector('.shortcut-icon img');
    return img && img.getAttribute('src') && img.getAttribute('src').startsWith('blob:');
  });

  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tomorinNewTabState')));
  record = await readIconRecord(page);
  assert(stored.shortcuts[0].iconId === 'deep-link', 'should persist uploaded custom icon as a local icon id');
  assert(!stored.shortcuts[0].customIcon, 'should not keep uploaded custom icon data in shortcut metadata');
  assert(record?.sourceUrl === 'custom', 'should replace cached icon with uploaded custom icon');

  console.log(JSON.stringify({
    initialSrc,
    iconBackground,
    secondSrc,
    googleSrc,
    fallbackSrc,
    candidateCount,
    selectedIconUrl: stored.shortcuts[0].iconUrl,
    selectedIconSrc,
    customIconSource: record.sourceUrl,
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
