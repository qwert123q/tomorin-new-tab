const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;
const storageKey = 'tomorinNewTabState';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(key => {
    window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    const remotePayload = {
      schemaVersion: 1,
      updatedAt: 2000,
      shortcuts: [
        {
          id: 'remote-youtube',
          title: 'Remote YouTube',
          url: 'https://www.youtube.com',
          size: 'small',
          iconUrl: 'https://www.youtube.com/favicon.ico',
          order: 0,
          updatedAt: 2000,
        },
        {
          id: 'remote-site',
          title: 'Remote Site',
          url: 'https://example.com',
          size: 'small',
          iconUrl: '',
          order: 1,
          updatedAt: 2100,
        },
      ],
      deletedShortcuts: [],
      settings: { iconDensity: 'medium', searchEngine: 'bing' },
    };

    window.__syncCalls = [];
    window.fetch = async (input, options = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      window.__syncCalls.push({
        url,
        method: options.method || 'GET',
        authorization: options.headers?.Authorization,
        body: options.body || '',
      });

      if (url === 'http://sync.test:8787/health') {
        return new Response(JSON.stringify({
          ok: true,
          capabilities: { wallpaperSync: true, maxWallpaperBytes: 100 * 1024 * 1024 },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'http://sync.test:8787/api/wallpaper') {
        if ((options.method || 'GET') === 'GET') {
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url !== 'http://sync.test:8787/api/state') return new Response('', { status: 404 });

      if ((options.method || 'GET') === 'GET') {
        return new Response(JSON.stringify(remotePayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    localStorage.setItem(key, JSON.stringify({
      shortcuts: [{
        id: 'local-youtube',
        title: 'Local YouTube',
        url: 'https://www.youtube.com',
        size: 'small',
        order: 0,
        updatedAt: 1000,
      }],
      deletedShortcuts: [],
      settings: {
        currentPage: 0,
        wallpaper: { type: 'none' },
        iconDensity: 'small',
        searchEngine: 'default',
      },
      sync: {
        enabled: true,
        endpoint: 'http://sync.test:8787',
        token: 'secret-token',
        lastSyncAt: 0,
        pending: true,
        lastError: '',
      },
    }));
  }, storageKey);

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(key => {
    const state = JSON.parse(localStorage.getItem(key) || '{}');
    return state.sync?.pending === false
      && state.shortcuts?.some(item => item.id === 'remote-youtube')
      && state.shortcuts?.some(item => item.id === 'remote-site');
  }, storageKey);

  const result = await page.evaluate(key => ({
    state: JSON.parse(localStorage.getItem(key)),
    calls: window.__syncCalls,
    titles: [...document.querySelectorAll('.shortcut-title')].map(item => item.textContent),
  }), storageKey);

  assert(result.calls.some(call => call.method === 'GET'), 'sync should GET remote state');
  assert(result.calls.some(call => call.method === 'PUT'), 'sync should PUT merged state');
  assert(result.calls.every(call => call.authorization === 'Bearer secret-token'), 'sync should send bearer token');
  assert(result.state.settings.iconDensity === 'medium', 'sync should merge remote icon density');
  assert(result.state.settings.searchEngine === 'default', 'sync should keep search engine local-only');
  const putBody = JSON.parse(result.calls.find(call => call.method === 'PUT').body);
  assert(!('searchEngine' in putBody.settings), 'sync payload should not include local search engine');
  assert(result.state.shortcuts.length === 2, `expected 2 synced shortcuts, got ${result.state.shortcuts.length}`);
  assert(result.titles.includes('Remote YouTube'), 'page should render merged remote shortcut');

  await page.locator('.settings-trigger').hover();
  await page.locator('[data-action="open-sync-dialog"]').click();
  await page.locator('[data-action="toggle-sync-token"]').click();
  assert(await page.locator('#syncToken').getAttribute('type') === 'text', 'sync token should be revealable');
  assert(await page.locator('#syncToken').inputValue() === 'secret-token', 'revealed sync token should keep its value');
  await page.locator('[data-action="toggle-sync-token"]').click();
  assert(await page.locator('#syncToken').getAttribute('type') === 'password', 'sync token should be hideable again');

  await page.evaluate(async () => {
    const bytes = new Uint8Array(21 * 1024 * 1024);
    bytes.set([137, 80, 78, 71]);
    await saveWallpaperBlob(new Blob([bytes], { type: 'image/png' }));
  });
  await page.locator('[data-action="upload-sync-wallpaper"]').click();
  await page.waitForFunction(() => document.getElementById('wallpaperSyncStatus')?.textContent.includes('已上传'));
  await page.locator('[data-action="download-sync-wallpaper"]').click();
  await page.waitForFunction(() => document.getElementById('wallpaperSyncStatus')?.textContent.includes('已下载'));

  const wallpaperResult = await page.evaluate(() => ({
    calls: window.__syncCalls
      .filter(call => call.url.endsWith('/api/wallpaper'))
      .map(call => ({ method: call.method, authorization: call.authorization, size: call.body?.size || 0 })),
    wallpaperType: state.settings.wallpaper.type,
  }));
  assert(wallpaperResult.calls.some(call => call.method === 'PUT'), 'manual wallpaper sync should upload with PUT');
  assert(wallpaperResult.calls.some(call => call.method === 'GET'), 'manual wallpaper sync should download with GET');
  assert(wallpaperResult.calls.find(call => call.method === 'PUT').size > 20 * 1024 * 1024, 'wallpaper sync should accept files larger than 20 MB');
  assert(wallpaperResult.calls.every(call => call.authorization === 'Bearer secret-token'), 'wallpaper sync should send bearer token');
  assert(wallpaperResult.wallpaperType === 'uploaded', 'downloaded wallpaper should become the active local wallpaper');

  console.log(JSON.stringify({
    calls: result.calls.map(call => call.method),
    titles: result.titles,
    density: result.state.settings.iconDensity,
    searchEngine: result.state.settings.searchEngine,
    syncedSearchEngine: putBody.settings.searchEngine || null,
    wallpaperCalls: wallpaperResult.calls.map(call => call.method),
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
