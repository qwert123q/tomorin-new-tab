// Icon cache: pictures from version 1 keep showing until a sharper one is
// found (and are never replaced by a letter), custom uploads are migrated,
// reloads use the cache without network requests, and failed lookups retry.
const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(page, predicate, message, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(predicate)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(message);
}

const legacyState = {
  shortcuts: [
    { id: 'kept', title: 'Kept', url: 'https://kept.example', size: 'small', order: 0, iconId: 'kept', iconUrl: 'https://kept.example/favicon.ico', updatedAt: 1000 },
    { id: 'sharper', title: 'Sharper', url: 'https://sharper.example', size: 'small', order: 1, iconId: 'sharper', iconUrl: 'https://sharper.example/favicon.ico', updatedAt: 1001 },
    { id: 'mine', title: 'Mine', url: 'https://mine.example', size: 'small', order: 2, iconId: 'mine', updatedAt: 1002 },
    { id: 'flaky', title: 'Flaky', url: 'https://flaky.example', size: 'small', order: 3, updatedAt: 1003 },
    // The same address twice; only the second one had an uploaded icon.
    { id: 'dupe-a', title: 'Dupe', url: 'https://dupe.example', size: 'small', order: 4, updatedAt: 1004 },
    { id: 'dupe-b', title: 'Dupe again', url: 'https://dupe.example/', size: 'small', order: 5, iconId: 'dupe-b', updatedAt: 1005 },
    // Older copy with an upload, newer copy with a picked icon address.
    { id: 'pick-a', title: 'Picked', url: 'https://picked.example', size: 'small', order: 7, iconId: 'pick-a', updatedAt: 1007 },
    { id: 'pick-b', title: 'Picked newer', url: 'https://picked.example/', size: 'small', order: 8, iconUrl: 'https://cdn.picked.example/logo-512.png', updatedAt: 1008 },
    // Version 1 stored its letter placeholder as an SVG "custom" icon.
    { id: 'lettered', title: 'Lettered', url: 'https://lettered.example', size: 'small', order: 6, iconId: 'lettered', updatedAt: 1006 },
  ],
  deletedShortcuts: [],
  settings: { currentPage: 0, wallpaper: { type: 'none' }, iconDensity: 'small' },
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', error => console.error(`page error: ${error.message}`));

  await page.addInitScript(() => {
    if (sessionStorage.getItem('__prepare')) window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    window.__fetches = [];
    window.fetch = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url).href;
      window.__fetches.push(url);
      if (url === 'https://sharper.example/apple-touch-icon.png') {
        const canvas = new OffscreenCanvas(180, 180);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ff9500';
        ctx.fillRect(0, 0, 180, 180);
        return new Response(await canvas.convertToBlob({ type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (url === 'https://redraw.example/favicon.ico') {
        const canvas = new OffscreenCanvas(32, 32);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0a84ff';
        ctx.fillRect(0, 0, 32, 32);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(10, 10, 12, 12);
        return new Response(await canvas.convertToBlob({ type: 'image/png' }), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (url.startsWith('https://flaky.example/')) throw new TypeError('Failed to fetch');
      return new Response('', { status: 404 });
    };
  });

  // Write version 1 data the way the old extension left it.
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => sessionStorage.setItem('__prepare', '1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(async state => {
    const blobOf = async color => {
      const canvas = new OffscreenCanvas(16, 16);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 16, 16);
      return await canvas.convertToBlob({ type: 'image/png' });
    };
    await saveIconRecord({ id: 'kept', blob: await blobOf('#ff0000'), sourceUrl: 'https://kept.example/favicon.ico', updatedAt: 1 });
    await saveIconRecord({ id: 'sharper', blob: await blobOf('#00ff00'), sourceUrl: 'https://sharper.example/favicon.ico', updatedAt: 1 });
    await saveIconRecord({ id: 'mine', blob: await blobOf('#0000ff'), sourceUrl: 'custom', updatedAt: 1 });
    await saveIconRecord({ id: 'dupe-b', blob: await blobOf('#ff00ff'), sourceUrl: 'custom', updatedAt: 1 });
    await saveIconRecord({ id: 'pick-a', blob: await blobOf('#00ffff'), sourceUrl: 'custom', updatedAt: 1 });
    await saveIconRecord({ id: 'lettered', blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><text x="64" y="78">L</text></svg>'], { type: 'image/svg+xml' }), sourceUrl: 'custom', updatedAt: 1 });
    localStorage.setItem('tomorinNewTabState', JSON.stringify(state));
    sessionStorage.removeItem('__prepare');
  }, legacyState);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shortcut-card');
  const firstPaint = await page.$$eval('.shortcut-card img', images => images.map(img => img.getAttribute('src').slice(0, 5)));
  assert(firstPaint.slice(0, 3).every(src => src === 'blob:'), `old pictures should show right away, got ${firstPaint}`);

  await waitUntil(page, async () => (await getAllIconRecords()).filter(record => record.pipeline).length >= 3 && iconQueue.length === 0 && iconWorkers === 0, 'icons should be looked up again');
  const after = await page.evaluate(async () => {
    const records = Object.fromEntries((await getAllIconRecords()).map(record => [record.id, record]));
    const mine = state.shortcuts.find(item => item.id === 'mine');
    const dupe = state.shortcuts.filter(item => item.url.startsWith('https://dupe.example'));
    return {
      dupe: dupe.map(item => ({ id: item.id, icon: item.icon?.type })),
      lettered: state.shortcuts.find(item => item.id === 'lettered').icon,
      picked: state.shortcuts.filter(item => item.url.startsWith('https://picked.example')).map(item => ({ title: item.title, icon: item.icon })),
      kept: { kind: records.kept.kind, hasBlob: Boolean(records.kept.blob) },
      sharper: { kind: records.sharper.kind, source: records.sharper.sourceUrl, width: records.sharper.width },
      flaky: { transient: records.flaky?.transient, kind: records.flaky?.kind },
      mineIcon: mine.icon,
      mineStored: mine.icon?.type === 'blob' ? Boolean(await getBlobRecord(mine.icon.hash)) : false,
      srcs: Object.fromEntries([...document.querySelectorAll('.shortcut-card')].map(card => [card.dataset.id, card.querySelector('img').getAttribute('src').slice(0, 5)])),
    };
  });
  assert(after.kept.kind === 'legacy' && after.kept.hasBlob, `an old picture must not be replaced by a letter, got ${JSON.stringify(after.kept)}`);
  assert(after.srcs.kept === 'blob:', 'the old picture should still be shown');
  assert(after.sharper.source === 'https://sharper.example/apple-touch-icon.png' && after.sharper.width === 180, 'a sharper icon should replace the old one');
  assert(after.mineIcon?.type === 'blob' && after.mineStored, 'a custom upload from version 1 should become a synced picture');
  assert(after.flaky.transient === true, 'a lookup with network errors should be retried soon');
  assert(after.dupe.length === 1 && after.dupe[0].icon === 'blob', `a folded duplicate should keep its uploaded icon, got ${JSON.stringify(after.dupe)}`);
  assert(after.lettered?.type === 'letter', `an SVG placeholder from version 1 should become a letter tile, got ${JSON.stringify(after.lettered)}`);
  assert(after.picked.length === 1 && after.picked[0].title === 'Picked newer' && after.picked[0].icon?.type === 'url',
    `the newest copy's icon choice should win with its title, got ${JSON.stringify(after.picked)}`);

  // Pictures a backup still needs survive cleanup, and ids folded into
  // another shortcut are not offered as missing sites.
  const cleanup = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const hash = await TomorinIcons.sha256Hex(await blob.arrayBuffer());
    await storeRequest('blobs', 'readwrite', store => store.put({ hash, blob, mime: 'image/png', size: blob.size, savedAt: 1 }));
    const survivor = state.shortcuts[0];
    await saveBackup(core.normalizeDoc({ shortcuts: [
      { id: 'only-in-backup', title: 'Backup only', url: 'https://backup-only.example', icon: { type: 'blob', hash, mime: 'image/png' }, pos: 'a0', editedAt: 1, movedAt: 1, createdAt: 1 },
      { ...survivor, id: 'folded-copy', url: 'https://folded-old.example' },
    ] }), 'test');
    state.tombstones = [...state.tombstones, { id: 'folded-copy', to: survivor.id }];
    await pruneLocalBlobs();
    return {
      kept: Boolean(await getBlobRecord(hash)),
      missing: missingFromBackup(await readBackup()).map(item => item.id),
    };
  });
  assert(cleanup.kept, 'cleanup must keep an uploaded icon that only the backup uses');
  assert(JSON.stringify(cleanup.missing) === JSON.stringify(['only-in-backup']), `folded ids must not be offered for restore, got ${cleanup.missing}`);

  // Only a version 1 install nobody changed counts as untouched.
  const untouched = await page.evaluate(() => {
    const defaults = [['YouTube', 'https://www.youtube.com'], ['TikTok', 'https://www.tiktok.com'], ['X', 'https://x.com'], ['GitHub', 'https://github.com'], ['Agoda', 'https://www.agoda.com']];
    const legacy = list => ({ shortcuts: list.map(([title, url, size = 'small'], order) => ({ id: `d${order}`, title, url, size, order })), settings: {} });
    return {
      fresh: migrateLegacyState(legacy(defaults)).pristine,
      reordered: migrateLegacyState(legacy([defaults[1], defaults[0], ...defaults.slice(2)])).pristine,
      resized: migrateLegacyState(legacy([[...defaults[0], 'large'], ...defaults.slice(1)])).pristine,
      deleted: migrateLegacyState({ ...legacy(defaults), deletedShortcuts: [{ id: 'old', deletedAt: 5 }] }).pristine,
    };
  });
  assert(untouched.fresh === true, 'the untouched default list should take the cloud copy silently');
  assert(!untouched.reordered && !untouched.resized && !untouched.deleted, `changed defaults must count as real data, got ${JSON.stringify(untouched)}`);

  // A reload uses the cache and makes no icon requests.
  await page.evaluate(() => { window.__fetches.length = 0; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const reload = await page.evaluate(() => ({
    fetches: window.__fetches.filter(url => !url.startsWith('https://flaky.example/')),
    srcs: [...document.querySelectorAll('.shortcut-card img')].map(img => img.getAttribute('src').slice(0, 5)),
  }));
  assert(reload.fetches.length === 0, `cached icons should not be fetched again, got ${reload.fetches.join(', ')}`);
  assert(reload.srcs.slice(0, 3).every(src => src === 'blob:'), 'cached icons should render from local copies');

  // Deleting a shortcut removes its cached picture.
  await page.click('[data-id="sharper"]', { button: 'right' });
  await page.click('[data-id="sharper"] [data-action="remove-shortcut"]', { force: true });
  await waitUntil(page, async () => !(await getIconRecord('sharper')), 'deleted shortcut should drop its cached icon');


  // An SVG placeholder that an early build migrated as a picture becomes a
  // letter tile on the next start, so it cannot block syncing.
  await page.evaluate(async () => {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'], { type: 'image/svg+xml' });
    const hash = await TomorinIcons.sha256Hex(await svg.arrayBuffer());
    await saveBlobRecord(hash, svg, 'image/svg+xml');
    state.shortcuts[0].icon = { type: 'blob', hash, mime: 'image/svg+xml' };
    await persistState();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shortcut-card');
  const repaired = await page.evaluate(() => ({ icon: state.shortcuts[0].icon, dirty: state.sync.dirty }));
  assert(repaired.icon?.type === 'letter', `an SVG picture icon should become a letter tile, got ${JSON.stringify(repaired.icon)}`);

  // Tiles drawn by version 3 stay, except small favicons drawn on one flat
  // colour, which could show an edge around the favicon: those are redrawn.
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(256, 256);
    canvas.getContext('2d').fillRect(0, 0, 256, 256);
    const tile = await canvas.convertToBlob({ type: 'image/png' });
    for (const [id, width] of [['redraw', 32], ['keep-v3', 180]]) {
      const stamp = nextStamp();
      const item = { id, title: id, url: `https://${id}.example`, size: 'small', icon: null, pos: core.keyBetween(orderedShortcuts().at(-1).pos, null), editedAt: stamp, movedAt: stamp, createdAt: stamp };
      state.shortcuts.push(item);
      await saveIconRecord({ id, key: iconKeyFor(item), pipeline: 3, blob: tile, sourceUrl: `https://${id}.example/favicon.ico`, width, height: width, kind: 'full', transient: false, attempts: 0, resolvedAt: Date.now() });
    }
    await persistState();
    window.__fetches.length = 0;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitUntil(page, async () => (await getIconRecord('redraw'))?.pipeline === TomorinIcons.PIPELINE && iconQueue.length === 0 && iconWorkers === 0, 'a small favicon tile from version 3 should be drawn again');
  const versionThree = await page.evaluate(async () => {
    const pick = record => ({ pipeline: record.pipeline, kind: record.kind, width: record.width, source: record.sourceUrl });
    return { redraw: pick(await getIconRecord('redraw')), keep: pick(await getIconRecord('keep-v3')), fetches: window.__fetches };
  });
  assert(versionThree.redraw.kind === 'full' && versionThree.redraw.width === 32 && versionThree.redraw.source === 'https://redraw.example/favicon.ico',
    `the small favicon should be drawn again, got ${JSON.stringify(versionThree.redraw)}`);
  assert(versionThree.keep.pipeline === 3, `other version 3 tiles should be kept, got ${JSON.stringify(versionThree.keep)}`);
  assert(!versionThree.fetches.some(url => url.includes('keep-v3.example')), 'kept tiles must not be looked up again');

  console.log(JSON.stringify({ firstPaint, after, reloadFetches: reload.fetches.length, versionThree: { redraw: versionThree.redraw.pipeline, keep: versionThree.keep.pipeline } }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
