const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;
const storageKey = 'tomorinNewTabState';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function revealSettings(page) {
  await page.hover('.settings-trigger');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.settings-panel')).opacity === '1');
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.route('https://www.bing.com/search**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Bing Search</title>',
  }));
  await page.addInitScript(key => {
    window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    window.__searchQueries = [];
    window.chrome = {
      search: {
        query: async options => {
          window.__searchQueries.push(options);
        },
      },
    };
    localStorage.removeItem(key);
  }, storageKey);

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  await revealSettings(page);
  const labels = await page.$$eval('[data-action="set-search-engine"]', buttons => (
    buttons.map(button => button.textContent.trim())
  ));
  assert(JSON.stringify(labels) === JSON.stringify(['默认', 'Bing']), `search engine buttons should be 默认/Bing, got ${labels.join(',')}`);

  const activeAtStart = await page.$eval('[data-action="set-search-engine"][aria-pressed="true"]', button => button.dataset.searchEngine);
  assert(activeAtStart === 'default', `default search engine should be browser default, got ${activeAtStart}`);

  await page.fill('#searchInput', 'tomorin default');
  await page.press('#searchInput', 'Enter');
  await page.waitForFunction(() => window.__searchQueries.length === 1);
  const defaultQuery = await page.evaluate(() => window.__searchQueries[0]);
  assert(defaultQuery.text === 'tomorin default', `browser default search should receive query text, got ${JSON.stringify(defaultQuery)}`);
  assert(defaultQuery.disposition === 'CURRENT_TAB', 'browser default search should open in current tab');

  await revealSettings(page);
  await page.click('[data-action="set-search-engine"][data-search-engine="bing"]');
  const persisted = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.searchEngine, storageKey);
  assert(persisted === 'bing', `selected search engine should persist as bing, got ${persisted}`);

  await page.fill('#searchInput', 'tomorin bing');
  await page.press('#searchInput', 'Enter');
  await page.waitForURL('https://www.bing.com/search?q=tomorin+bing', { waitUntil: 'domcontentloaded' });

  console.log(JSON.stringify({
    labels,
    defaultQuery,
    persisted,
    finalUrl: page.url(),
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
