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

async function dragToSlot(page, sourceId, slotIndex) {
  await page.evaluate(({ sourceId, slotIndex }) => {
    const activePage = document.querySelector('.shortcut-page.is-active');
    const source = activePage?.querySelector(`[data-id="${sourceId}"]`);
    const target = activePage?.querySelector(`[data-slot-index="${slotIndex}"]`);
    if (!source || !target) throw new Error('missing drag source or target slot');
    const data = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, { sourceId, slotIndex });
}

async function assertScrollSnapPager(page, expectedPage) {
  await page.waitForFunction(pageIndex => {
    const viewport = document.querySelector('.shortcut-viewport');
    return document.querySelector('.page-dot.active')?.dataset.page === String(pageIndex)
      && Math.abs(viewport.scrollLeft - viewport.clientWidth * pageIndex) <= 2;
  }, expectedPage, { timeout: 600 });
  const pager = await page.evaluate(() => {
    const viewport = document.querySelector('.shortcut-viewport');
    const pages = [...document.querySelectorAll('.shortcut-page')];
    return {
      hasViewport: Boolean(viewport),
      pageCount: pages.length,
      activePage: document.querySelector('.shortcut-page.is-active')?.dataset.page,
      hasTransitionLayer: Boolean(document.querySelector('.shortcut-transition')),
      scrollSnapType: viewport ? getComputedStyle(viewport).scrollSnapType : '',
      scrollLeft: viewport?.scrollLeft || 0,
      viewportWidth: viewport?.clientWidth || 0,
    };
  });
  assert(pager.hasViewport, 'shortcuts should render inside a horizontal scroll viewport');
  assert(pager.pageCount >= 2, `multi-page data should render multiple shortcut pages, got ${pager.pageCount}`);
  assert(pager.activePage === String(expectedPage), `active shortcut page should be ${expectedPage}, got ${pager.activePage}`);
  assert(!pager.hasTransitionLayer, 'scroll snap pagination should not use the temporary transition layer');
  assert(pager.scrollSnapType.includes('x'), `shortcut viewport should use horizontal scroll snap, got ${pager.scrollSnapType}`);
  assert(Math.abs(pager.scrollLeft - pager.viewportWidth * expectedPage) <= 2, `viewport should scroll to page ${expectedPage}, got ${JSON.stringify(pager)}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(() => {
    window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    localStorage.setItem('tomorinNewTabState', JSON.stringify({
      shortcuts: Array.from({ length: 34 }, (_, index) => ({
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
  await page.click('[data-id="site-0"]', { button: 'right' });
  await page.waitForSelector('[data-slot-index="31"]');

  const slotCount = await page.$$eval('.shortcut-page.is-active .shortcut-slot', slots => slots.length);
  assert(slotCount === 32, `edit mode should render 32 drop slots, got ${slotCount}`);
  await assertScrollSnapPager(page, 0);

  await page.evaluate(() => {
    document.querySelector('.shortcut-viewport').scrollLeft = document.querySelector('.shortcut-viewport').clientWidth;
    document.querySelector('.shortcut-viewport').dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await assertScrollSnapPager(page, 1);
  await page.evaluate(() => {
    document.querySelector('.shortcut-viewport').scrollLeft = 0;
    document.querySelector('.shortcut-viewport').dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await assertScrollSnapPager(page, 0);
  await page.evaluate(() => {
    const shell = document.querySelector('.newtab-shell');
    shell.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      changedTouches: [new Touch({ identifier: 1, target: shell, clientX: 420, clientY: 240 })],
    }));
    shell.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      changedTouches: [new Touch({ identifier: 1, target: shell, clientX: 220, clientY: 240 })],
    }));
  });
  await assertScrollSnapPager(page, 1);
  await page.evaluate(() => {
    const shell = document.querySelector('.newtab-shell');
    shell.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      changedTouches: [new Touch({ identifier: 2, target: shell, clientX: 220, clientY: 240 })],
    }));
    shell.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      changedTouches: [new Touch({ identifier: 2, target: shell, clientX: 420, clientY: 240 })],
    }));
  });
  await assertScrollSnapPager(page, 0);

  await dragToSlot(page, 'site-0', 5);
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('tomorinNewTabState'));
    return state.shortcuts.find(item => item.id === 'site-0')?.order === 5;
  });

  let order = await page.evaluate(() => (
    JSON.parse(localStorage.getItem('tomorinNewTabState')).shortcuts
      .sort((a, b) => a.order - b.order)
      .slice(0, 8)
      .map(item => item.id)
  ));
  assert(
    JSON.stringify(order) === JSON.stringify(['site-1', 'site-2', 'site-3', 'site-4', 'site-5', 'site-0', 'site-6', 'site-7']),
    `dragging into occupied slot should insert and shift later shortcuts, got ${order.join(',')}`,
  );

  await dragToSlot(page, 'site-0', 31);
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('tomorinNewTabState'));
    return state.shortcuts.find(item => item.id === 'site-0')?.order === 31;
  });

  const firstPageLast = await page.$$eval('.shortcut-page.is-active .shortcut-card', cards => cards.map(card => card.dataset.id).slice(-3));
  assert(
    JSON.stringify(firstPageLast) === JSON.stringify(['site-30', 'site-31', 'site-0']),
    `dragging to the last visible slot should place the shortcut at the end of page one, got ${firstPageLast.join(',')}`,
  );

  await page.click('[data-action="go-page"][data-page="1"]');
  await page.waitForFunction(() => document.querySelector('.page-dot.active')?.dataset.page === '1');
  await dragToSlot(page, 'site-33', 0);
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('tomorinNewTabState'));
    return state.shortcuts.find(item => item.id === 'site-33')?.order === 32;
  });

  const secondPageIds = await page.$$eval('.shortcut-page.is-active .shortcut-card', cards => cards.map(card => card.dataset.id));
  assert(
    JSON.stringify(secondPageIds.slice(0, 2)) === JSON.stringify(['site-33', 'site-32']),
    `dragging on page two should insert at that page slot and push later items, got ${secondPageIds.join(',')}`,
  );

  console.log(JSON.stringify({ slotCount, order, firstPageLast, secondPageIds }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
