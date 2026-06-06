const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tinyPngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVqK3wAAAABJRU5ErkJggg==',
    'base64',
  );
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
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
  await page.reload({ waitUntil: 'domcontentloaded' });

  const initialSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(initialSrc.includes('google.com/s2/favicons'), 'should prefer high-resolution Google favicon service');
  assert(initialSrc.includes('sz=128'), 'should request 128px favicon');
  assert(
    decodeURIComponent(initialSrc).includes('domain_url=https://www.tiktok.com/'),
    `should request favicon by site origin, got ${initialSrc}`,
  );

  await page.$eval('.shortcut-icon img', img => img.dispatchEvent(new Event('error')));
  const fallbackSrc = await page.$eval('.shortcut-icon img', img => img.getAttribute('src'));
  assert(fallbackSrc.includes('icons.duckduckgo.com/ip3/tiktok.com.ico'), 'should fallback to DuckDuckGo favicon');

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
    return img && img.getAttribute('src') && img.getAttribute('src').startsWith('data:image/');
  });

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tomorinNewTabState')));
  assert(stored.shortcuts[0].customIcon.startsWith('data:image/'), 'should persist uploaded custom icon');

  console.log(JSON.stringify({
    initialSrc,
    fallbackSrc,
    customIconPrefix: stored.shortcuts[0].customIcon.slice(0, 32),
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
