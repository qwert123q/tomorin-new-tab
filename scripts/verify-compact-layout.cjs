const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function shortcut(index) {
  return {
    id: `site-${index}`,
    title: `Site ${index}`,
    url: `https://site-${index}.example.com`,
    size: 'small',
    order: index,
  };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(() => {
    window.__TOMORIN_DISABLE_ICON_MIGRATION = true;
    if (sessionStorage.getItem('__tomorinSeeded')) return;
    sessionStorage.setItem('__tomorinSeeded', '1');
    localStorage.setItem('tomorinNewTabState', JSON.stringify({
      shortcuts: Array.from({ length: 30 }, (_, index) => ({
        id: `site-${index}`,
        title: `Site ${index}`,
        url: `https://site-${index}.example.com`,
        size: 'small',
        order: index,
      })),
      settings: {
        currentPage: 0,
        wallpaper: { type: 'none' },
        iconDensity: 'small',
      },
    }));
  });

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  const tabCount = await page.$$eval('.search-tabs span', nodes => nodes.length);
  assert(tabCount === 0, `search category words should be removed, got ${tabCount}`);

  const cardCount = await page.$$eval('.shortcut-card', cards => cards.length);
  assert(cardCount === 30, `first page should hold all 30 shortcuts, got ${cardCount}`);

  const dotCount = await page.$$eval('.page-dot', dots => dots.length);
  assert(dotCount === 0, `pagination should disappear when 30 shortcuts fit on one page, got ${dotCount}`);

  const metrics = await page.evaluate(() => {
    const searchBox = document.querySelector('.search-box').getBoundingClientRect();
    const content = document.querySelector('.content').getBoundingClientRect();
    const first = document.querySelector('.shortcut-card:nth-child(1)').getBoundingClientRect();
    const second = document.querySelector('.shortcut-card:nth-child(2)').getBoundingClientRect();
    const pageStyle = getComputedStyle(document.querySelector('.shortcut-page'));
    return {
      searchTop: searchBox.top,
      searchHeight: searchBox.height,
      contentTop: content.top,
      horizontalPitch: second.left - first.left,
      columnGap: pageStyle.columnGap,
    };
  });

  assert(metrics.searchTop < 96, `search should move upward, got top ${metrics.searchTop}`);
  assert(metrics.searchHeight <= 62, `search box should be smaller, got height ${metrics.searchHeight}`);
  assert(metrics.horizontalPitch <= 120, `shortcut horizontal spacing should be tighter, got pitch ${metrics.horizontalPitch}`);

  console.log(JSON.stringify({ cardCount, dotCount, metrics }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
