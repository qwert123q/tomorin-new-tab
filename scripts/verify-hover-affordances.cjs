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

async function afterContent(page, selector) {
  return page.$eval(selector, element => getComputedStyle(element, '::after').content);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(() => {
    window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    localStorage.clear();
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  const shortcutCursor = await page.$eval('.shortcut-card', card => getComputedStyle(card).cursor);
  assert(shortcutCursor === 'pointer', `shortcut cursor should be pointer, got ${shortcutCursor}`);

  await revealSettings(page);

  await page.hover('[data-action="open-sync-dialog"]');
  const syncTooltip = await afterContent(page, '[data-action="open-sync-dialog"]');
  assert(syncTooltip.includes('同步'), `sync tooltip should mention 同步, got ${syncTooltip}`);

  await page.hover('[data-tooltip="更换壁纸"]');
  const wallpaperTooltip = await afterContent(page, '[data-tooltip="更换壁纸"]');
  assert(wallpaperTooltip.includes('壁纸'), `wallpaper tooltip should mention 壁纸, got ${wallpaperTooltip}`);

  console.log(JSON.stringify({
    shortcutCursor,
    syncTooltip,
    wallpaperTooltip,
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
