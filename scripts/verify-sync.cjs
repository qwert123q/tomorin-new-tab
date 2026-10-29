// End-to-end sync: a real sync server and several isolated browser profiles
// acting as different computers.
const assert = require('assert/strict');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;
const storageKey = 'tomorinNewTabState';
const password = '我的 同步密码 2026';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tomorin-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/sync-server.js')], {
    env: { ...process.env, SYNC_HOST: '127.0.0.1', SYNC_PORT: String(port), SYNC_PASSWORD: password, SYNC_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      // Starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return {
    url,
    async state() {
      const response = await fetch(`${url}/api/v2/state`, { headers: { Authorization: `Bearer ${encodeURIComponent(password)}` } });
      return await response.json();
    },
    async stop() {
      child.kill('SIGTERM');
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

function legacyShortcut(id, title, url, order, updatedAt = 1000 + order) {
  return { id, title, url, size: 'small', order, updatedAt };
}

async function newComputer(browser, seed = null, { resolveIcons = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Keep the test offline: websites answer 404, only the local sync server is real.
  await context.route(/^https:\/\//, route => route.fulfill({ status: 404, body: '' }));
  await context.addInitScript(({ key, value, resolve }) => {
    if (!resolve) window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    if (value && !localStorage.getItem('__seeded')) {
      localStorage.setItem('__seeded', '1');
      localStorage.setItem(key, JSON.stringify(value));
    }
  }, { key: storageKey, value: seed, resolve: resolveIcons });
  const page = await context.newPage();
  page.on('pageerror', error => console.error(`page error: ${error.message}`));
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
const titlesOf = async page => (await stored(page)).shortcuts.sort((a, b) => a.order - b.order).map(item => item.title);
const serverTitles = async server => (await server.state()).state.shortcuts
  .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : (a.id < b.id ? -1 : 1)))
  .map(item => item.title);
const syncNow = page => page.evaluate(async () => (await runSync({ interactive: true })).status);

async function waitFor(check, message, timeout = 10000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await check();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${message} (last value: ${JSON.stringify(last)})`);
}

async function dragToSlot(page, sourceId, slotIndex) {
  await page.evaluate(({ sourceId, slotIndex }) => {
    const activePage = document.querySelector('.shortcut-page.is-active');
    const source = activePage.querySelector(`[data-id="${sourceId}"]`);
    const target = activePage.querySelector(`[data-slot-index="${slotIndex}"]`);
    const data = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, { sourceId, slotIndex });
}

// Make a tab miss other tabs' saves until released, the way a slow storage
// event would. The app's listener calls handleExternalState by name.
function holdTabUpdates() {
  window.__heldStates = [];
  window.__deliverState = handleExternalState;
  handleExternalState = value => { window.__heldStates.push(value); };
}

async function releaseTabUpdates() {
  handleExternalState = window.__deliverState;
  for (const value of window.__heldStates) await handleExternalState(value);
}

function wallpaperSvg() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g"><stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/></svg>`);
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const report = {};

  try {
    // 1. The main computer upgrades from version 1 with its old token saved. The
    //    new server is empty, so its shortcuts become the cloud copy.
    const main = await newComputer(browser, {
      shortcuts: [
        legacyShortcut('gh', 'GitHub', 'https://github.com', 0),
        legacyShortcut('bili', '哔哩哔哩', 'https://www.bilibili.com', 1),
        legacyShortcut('ctrip', '携程网', 'https://www.ctrip.com', 2),
        legacyShortcut('zhihu', '知乎', 'https://www.zhihu.com', 3),
      ],
      deletedShortcuts: [],
      settings: { currentPage: 0, wallpaper: { type: 'none' }, iconDensity: 'small', searchEngine: 'bing' },
      sync: { enabled: true, endpoint: server.url, token: password, lastSyncAt: 0, pending: true, lastError: '' },
    });
    await waitFor(async () => (await server.state()).rev >= 1, 'main computer should upload to the empty server');
    assert.deepEqual(await serverTitles(server), ['GitHub', '哔哩哔哩', '携程网', '知乎']);
    const mainState = await stored(main.page);
    assert.equal(mainState.version, 2, 'old data should be migrated');
    assert.equal(mainState.sync.linked, server.url);
    assert.equal(mainState.settings.searchEngine, 'bing', 'search engine stays a local choice');
    assert.ok(!('searchEngine' in (await server.state()).state.settings), 'search engine should not be synced');

    // 2. A brand-new computer: type the address and the password, nothing else.
    //    It takes the cloud copy instead of pushing its five default sites.
    const laptop = await newComputer(browser);
    await laptop.page.hover('.settings-trigger');
    await laptop.page.click('[data-action="open-sync-dialog"]');
    await laptop.page.check('#syncEnabled');
    await laptop.page.fill('#syncEndpoint', server.url);
    await laptop.page.fill('#syncPassword', password);
    await laptop.page.click('#syncForm button[type="submit"]');
    await waitFor(async () => !(await laptop.page.$eval('#syncDialog', dialog => dialog.open)), 'sync dialog should close after a successful first sync');
    assert.deepEqual(await titlesOf(laptop.page), ['GitHub', '哔哩哔哩', '携程网', '知乎'], 'new computer should show the cloud shortcuts');
    assert.deepEqual(await serverTitles(server), ['GitHub', '哔哩哔哩', '携程网', '知乎'], 'default sites must not leak into the cloud');
    report.freshComputer = 'adopted cloud copy, defaults not uploaded';

    // 3. Add a site on the laptop; the main computer gets it at the end.
    await laptop.page.click('[data-id="gh"]', { button: 'right' });
    await laptop.page.click('[data-action="add-shortcut"]');
    await laptop.page.fill('#shortcutTitle', '豆瓣');
    await laptop.page.fill('#shortcutUrl', 'douban.com');
    await laptop.page.click('#shortcutForm button[type="submit"]');
    await waitFor(async () => (await serverTitles(server)).includes('豆瓣'), 'new site should reach the server');
    assert.equal(await syncNow(main.page), 'ok');
    assert.deepEqual(await titlesOf(main.page), ['GitHub', '哔哩哔哩', '携程网', '知乎', '豆瓣']);

    // 4. Move on one computer and rename on the other before either syncs:
    //    both changes survive.
    await main.page.evaluate(() => { globalThis.__holdSync = scheduleSync; scheduleSync = () => {}; });
    await laptop.page.evaluate(() => { globalThis.__holdSync = scheduleSync; scheduleSync = () => {}; });
    await main.page.click('[data-id="gh"]', { button: 'right' });
    await dragToSlot(main.page, 'ctrip', 0);
    await laptop.page.click('[data-id="zhihu"]');
    await laptop.page.fill('#shortcutTitle', '知乎日报');
    await laptop.page.click('#shortcutForm button[type="submit"]');
    const concurrent = await Promise.all([syncNow(main.page), syncNow(laptop.page)]);
    assert.deepEqual(concurrent, ['ok', 'ok'], 'simultaneous syncs should both succeed (one retries after a conflict)');
    await syncNow(main.page);
    await syncNow(laptop.page);
    const expected = ['携程网', 'GitHub', '哔哩哔哩', '知乎日报', '豆瓣'];
    assert.deepEqual(await titlesOf(main.page), expected, 'main computer should have the move and the rename');
    assert.deepEqual(await titlesOf(laptop.page), expected, 'laptop should have the move and the rename');
    assert.deepEqual(await serverTitles(server), expected);
    await main.page.evaluate(() => { scheduleSync = globalThis.__holdSync; });
    await laptop.page.evaluate(() => { scheduleSync = globalThis.__holdSync; });
    report.concurrentEdits = expected.join(' / ');

    // 5. Delete with the badge, then undo; both reach the other computer.
    // The edit-mode wiggle keeps the badge moving; hovering pauses it for people.
  await laptop.page.click('[data-id="bili"] [data-action="remove-shortcut"]', { force: true });
    await waitFor(async () => !(await serverTitles(server)).includes('哔哩哔哩'), 'delete should reach the server');
    await syncNow(main.page);
    assert.ok(!(await titlesOf(main.page)).includes('哔哩哔哩'), 'delete should reach the main computer');
    await laptop.page.click('.toast-action');
    await waitFor(async () => (await serverTitles(server)).includes('哔哩哔哩'), 'undo should reach the server');
    await syncNow(main.page);
    assert.deepEqual(await titlesOf(main.page), expected, 'undo should restore the site in its old place');
    await laptop.page.keyboard.press('Escape');

    // 6. Icon density follows the most recent change.
    await main.page.hover('.settings-trigger');
    await main.page.click('[data-action="set-density"][data-density="large"]');
    await waitFor(async () => (await server.state()).state.settings.iconDensity === 'large', 'density should sync');
    await syncNow(laptop.page);
    assert.equal((await stored(laptop.page)).settings.iconDensity, 'large');

    // 7. Wallpaper: set it once and every computer downloads it automatically.
    await main.page.setInputFiles('#wallpaperInput', { name: 'wall.svg', mimeType: 'image/svg+xml', buffer: wallpaperSvg() });
    await waitFor(async () => Boolean((await server.state()).state.wallpaper?.hash), 'wallpaper should be uploaded', 20000);
    const wallpaperHash = (await server.state()).state.wallpaper.hash;
    await syncNow(laptop.page);
    const laptopWallpaper = await laptop.page.evaluate(async () => ({
      hash: state.settings.wallpaper.hash,
      stored: Boolean(await getBlobRecord(state.settings.wallpaper.hash)),
      active: document.body.classList.contains('has-wallpaper'),
    }));
    assert.equal(laptopWallpaper.hash, wallpaperHash, 'laptop should use the same wallpaper');
    assert.ok(laptopWallpaper.stored, 'laptop should download the wallpaper picture');
    assert.ok(laptopWallpaper.active, 'downloaded wallpaper should be shown');
    report.wallpaper = `${wallpaperHash.slice(0, 12)}… copied to the laptop`;

    // 8. A custom uploaded icon travels too.
    await main.page.click('[data-id="gh"]', { button: 'right' });
    await main.page.click('[data-id="gh"]');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8Dwn4GBgYGJAQoAAPQhAwF2k1UpAAAAAElFTkSuQmCC', 'base64');
    await main.page.setInputFiles('#shortcutIconInput', { name: 'icon.png', mimeType: 'image/png', buffer: png });
    await main.page.waitForSelector('[data-icon-choice="blob"][aria-pressed="true"]');
    await main.page.click('#shortcutForm button[type="submit"]');
    await waitFor(async () => (await server.state()).state.shortcuts.find(item => item.id === 'gh')?.icon?.type === 'blob', 'custom icon should sync');
    await syncNow(laptop.page);
    const laptopIcon = await laptop.page.evaluate(async () => {
      const item = state.shortcuts.find(shortcut => shortcut.id === 'gh');
      return { stored: Boolean(await getBlobRecord(item.icon.hash)), src: document.querySelector('[data-id="gh"] img').getAttribute('src') };
    });
    assert.ok(laptopIcon.stored, 'laptop should download the custom icon');
    assert.ok(laptopIcon.src.startsWith('blob:'), 'laptop should show the custom icon');

    // 9. Two tabs on one computer stay consistent: a stale tab must not undo
    //    a change made in the other one.
    const secondTab = await laptop.context.newPage();
    await secondTab.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await laptop.page.evaluate(() => { scheduleSync = () => {}; });
    await secondTab.evaluate(() => { scheduleSync = () => {}; });
    await secondTab.click('[data-id="gh"]', { button: 'right' });
    await secondTab.click('[data-action="add-shortcut"]');
    await secondTab.fill('#shortcutTitle', 'V2EX');
    await secondTab.fill('#shortcutUrl', 'v2ex.com');
    await secondTab.click('#shortcutForm button[type="submit"]');
    await waitFor(async () => laptop.page.evaluate(() => state.shortcuts.some(item => item.title === 'V2EX')), 'the other tab should see the new site');
    await laptop.page.hover('.settings-trigger');
    await laptop.page.click('[data-action="set-density"][data-density="medium"]');
    assert.ok((await titlesOf(secondTab)).includes('V2EX'), 'a change in one tab must not be overwritten by another tab');

    // Both tabs save before either has seen the other's change.
    await secondTab.evaluate(holdTabUpdates);
    const addRacer = (page, id) => page.evaluate(racer => {
      const last = orderedShortcuts().at(-1);
      const stamp = nextStamp();
      state.shortcuts.push({ id: racer, title: racer, url: `https://${racer}.example`, size: 'small', icon: null, pos: core.keyBetween(last.pos, null), editedAt: stamp, movedAt: stamp, createdAt: stamp });
      return commitChange();
    }, id);
    await addRacer(laptop.page, 'race-a');
    await addRacer(secondTab, 'race-b');
    await secondTab.evaluate(releaseTabUpdates);
    await waitFor(async () => {
      const saved = await titlesOf(laptop.page);
      const memory = await Promise.all([laptop.page, secondTab].map(tab => tab.evaluate(() => state.shortcuts.map(item => item.title))));
      return saved.includes('race-a') && saved.includes('race-b')
        && memory.every(titles => titles.includes('race-a') && titles.includes('race-b'));
    }, 'edits saved at the same moment in two tabs should both be kept');
    report.simultaneousTabs = 'both edits kept';
    await secondTab.close();
    await laptop.page.evaluate(() => { scheduleSync = globalThis.__holdSync; });
    assert.equal(await syncNow(laptop.page), 'ok');

    // 10. Icon lookups only touch the local cache: no sync traffic, no new revision.
    const revBefore = (await server.state()).rev;
    const iconComputer = await newComputer(browser, null, { resolveIcons: true });
    await iconComputer.context.route(/^https:\/\//, route => {
      const url = route.request().url();
      if (url.endsWith('/apple-touch-icon.png')) {
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#0a84ff"/></svg>' });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await iconComputer.page.hover('.settings-trigger');
    await iconComputer.page.click('[data-action="open-sync-dialog"]');
    await iconComputer.page.check('#syncEnabled');
    await iconComputer.page.fill('#syncEndpoint', server.url);
    await iconComputer.page.fill('#syncPassword', password);
    await iconComputer.page.click('#syncForm button[type="submit"]');
    await waitFor(async () => iconComputer.page.evaluate(async () => (await getAllIconRecords()).length >= state.shortcuts.filter(item => item.icon?.type !== 'blob').length), 'icons should be looked up', 30000);
    await iconComputer.page.waitForTimeout(1500);
    assert.equal((await server.state()).rev, revBefore, 'looking up icons must not create sync revisions');
    report.iconLookups = 'no sync writes';

    // 11. An old computer with different shortcuts joins: it must ask first.
    const oldComputer = await newComputer(browser, {
      shortcuts: [
        legacyShortcut('gh-old', 'GitHub', 'https://github.com', 0, 99999),
        legacyShortcut('weibo', '微博', 'https://weibo.com', 1, 99999),
      ],
      deletedShortcuts: [],
      settings: { currentPage: 0, wallpaper: { type: 'none' }, iconDensity: 'small' },
      sync: { enabled: true, endpoint: server.url, token: password, lastSyncAt: 0, pending: true, lastError: '' },
    });
    await oldComputer.page.waitForSelector('.toast.visible .toast-action');
    const untouched = await serverTitles(server);
    assert.ok(!untouched.includes('微博'), 'nothing may be uploaded before the choice');
    const cloudCount = untouched.length;
    await oldComputer.page.click('.toast-action');
    await oldComputer.page.waitForSelector('#syncChoice:not([hidden])');
    const summary = await oldComputer.page.$eval('#syncChoiceSummary', node => node.textContent);
    assert.ok(summary.includes(`云端有 ${cloudCount} 个网站`) && summary.includes('本机有 2 个'), `choice should explain the difference, got ${summary}`);
    // A second tab adds a site that the tab answering the question has not
    // seen yet; it must survive the switch to the cloud copy.
    const oldTab2 = await oldComputer.context.newPage();
    await oldTab2.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await oldTab2.waitForSelector('.shortcut-card');
    await oldComputer.page.evaluate(holdTabUpdates);
    await oldTab2.evaluate(() => {
      const stamp = nextStamp();
      state.shortcuts.push({ id: 'during-choice', title: '选择期间添加', url: 'https://during-choice.example', size: 'small', icon: null, pos: core.keyBetween(orderedShortcuts().at(-1).pos, null), editedAt: stamp, movedAt: stamp, createdAt: stamp });
      return commitChange();
    });
    await oldComputer.page.check('input[name="syncChoice"][value="cloud"]');
    await oldComputer.page.click('[data-action="sync-choice-confirm"]');
    await waitFor(async () => !(await oldComputer.page.$eval('#syncDialog', dialog => dialog.open)), 'choice should finish the sync');
    await oldComputer.page.evaluate(releaseTabUpdates);
    await waitFor(async () => {
      const tabs = await Promise.all([oldComputer.page, oldTab2].map(tab => tab.evaluate(() => state.shortcuts.map(item => item.title))));
      return (await serverTitles(server)).includes('选择期间添加') && tabs.every(titles => titles.includes('选择期间添加'));
    }, 'a site added in another tab during the choice should be kept and synced');
    await oldTab2.close();
    assert.deepEqual(await titlesOf(oldComputer.page), await serverTitles(server), 'old computer should now match the cloud');
    assert.ok(!(await serverTitles(server)).includes('微博'), 'choosing the cloud copy must not upload old sites');

    // The site that only existed there can be brought back from the backup.
    await oldComputer.page.hover('.settings-trigger');
    await oldComputer.page.click('[data-action="open-sync-dialog"]');
    await oldComputer.page.waitForSelector('#restoreBackupButton:not([hidden])');
    await oldComputer.page.click('#restoreBackupButton');
    await oldComputer.page.click('#restoreBackupButton');
    await waitFor(async () => (await serverTitles(server)).includes('微博'), 'restored site should sync');
    assert.equal((await serverTitles(server)).length, cloudCount + 2, 'restoring adds back only the missing site');
    report.firstSyncChoice = 'asked, cloud copy taken, 微博 recovered from backup';

    // 12. Wrong password: a clear message, nothing changes.
    await laptop.page.hover('.settings-trigger');
    await laptop.page.click('[data-action="open-sync-dialog"]');
    await laptop.page.fill('#syncPassword', 'wrong password');
    await laptop.page.click('#syncForm button[type="submit"]');
    await waitFor(async () => (await laptop.page.$eval('#syncDetail', node => node.textContent)).includes('密码不正确'), 'wrong password should be reported');
    assert.ok(await laptop.page.$eval('#syncDialog', dialog => dialog.open), 'dialog stays open on errors');
    await laptop.page.fill('#syncPassword', password);
    await laptop.page.click('#syncForm button[type="submit"]');
    await waitFor(async () => !(await laptop.page.$eval('#syncDialog', dialog => dialog.open)), 'the right password should sync again');

    // 13. A change made while a big wallpaper is still downloading is synced
    //    afterwards without any further action.
    await main.page.setInputFiles('#wallpaperInput', { name: 'wall2.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(wallpaperSvg().toString().replace('#1d4ed8', '#be185d')) });
    await waitFor(async () => (await server.state()).state.wallpaper?.hash && (await server.state()).state.wallpaper.hash !== wallpaperHash, 'second wallpaper should upload', 20000);
    await laptop.context.route(/\/api\/v2\/blobs\//, async route => {
      await new Promise(resolve => setTimeout(resolve, 2500));
      await route.continue();
    });
    await laptop.page.evaluate(() => { runSync({ interactive: true }); });
    await laptop.page.waitForTimeout(600);
    await laptop.page.evaluate(() => {
      const stamp = nextStamp();
      state.shortcuts.push({ id: 'during-download', title: '下载期间添加', url: 'https://during.example', size: 'small', icon: null, pos: core.keyBetween(orderedShortcuts().at(-1).pos, null), editedAt: stamp, movedAt: stamp, createdAt: stamp });
      return commitChange();
    });
    await waitFor(async () => (await serverTitles(server)).includes('下载期间添加'), 'a change made during a download should sync by itself', 15000);
    await laptop.context.unroute(/\/api\/v2\/blobs\//);
    report.changeDuringDownload = 'synced after the download';

    // 14. Switching to another server while a sync is in flight: the old run
    //    must not write this computer's copy to the new server.
    const otherServer = await startServer();
    try {
      const otherRequests = [];
      await laptop.context.route(`${otherServer.url}/**`, route => {
        const request = route.request();
        otherRequests.push({ path: new URL(request.url()).pathname, method: request.method(), ifMatch: request.headers()['if-match'] || '', ifNoneMatch: request.headers()['if-none-match'] || '' });
        return route.continue();
      });
      await laptop.context.route(`${server.url}/api/v2/state`, async route => {
        if (route.request().method() === 'GET') await new Promise(resolve => setTimeout(resolve, 1500));
        await route.continue();
      });
      await laptop.page.evaluate(() => {
        const stamp = nextStamp();
        state.shortcuts.push({ id: 'before-switch', title: '切换前添加', url: 'https://switch.example', size: 'small', icon: null, pos: core.keyBetween(orderedShortcuts().at(-1).pos, null), editedAt: stamp, movedAt: stamp, createdAt: stamp });
        state.sync.dirty = true;
        persistState();
        runSync({ reason: 'change' });
      });
      await laptop.page.waitForTimeout(300);
      await laptop.page.hover('.settings-trigger');
      await laptop.page.click('[data-action="open-sync-dialog"]');
      await laptop.page.fill('#syncEndpoint', otherServer.url);
      await laptop.page.click('#syncForm button[type="submit"]');
      await waitFor(async () => (await stored(laptop.page)).sync.linked === otherServer.url, 'laptop should link to the new server');
      const stateRequests = otherRequests.filter(request => request.path === '/api/v2/state');
      assert.ok(stateRequests.length > 0 && stateRequests[0].method === 'GET' && !stateRequests[0].ifNoneMatch, `the new server must first be read as a first sync, got ${JSON.stringify(otherRequests)}`);
      assert.ok(stateRequests.every(request => request.method !== 'PUT' || request.ifMatch === '"0"'), `no write based on the old server's revision, got ${JSON.stringify(otherRequests)}`);
      report.serverSwitch = otherRequests.map(request => `${request.method} ${request.path.replace('/api/v2/', '')}`).join(' → ');
    } finally {
      await otherServer.stop();
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await server.stop();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
