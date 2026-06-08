const path = require('path');
const { chromium } = require('playwright');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const pageUrl = `file://${path.resolve(__dirname, '../extension/index.html')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.addInitScript(() => {
    window.__TOMORIN_DISABLE_AUTO_ICON_CACHE = true;
    if (sessionStorage.getItem('__tomorinSeeded')) return;
    sessionStorage.setItem('__tomorinSeeded', '1');
    localStorage.setItem('tomorinNewTabState', JSON.stringify({
      shortcuts: Array.from({ length: 40 }, (_, index) => ({
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
  assert(cardCount === 32, `first page should hold 32 shortcuts in a 4x8 layout, got ${cardCount}`);

  const dotCount = await page.$$eval('.page-dot', dots => dots.length);
  assert(dotCount === 2, `40 shortcuts should paginate into 2 pages with a 4x8 layout, got ${dotCount}`);

  const metrics = await page.evaluate(() => {
    const searchBox = document.querySelector('.search-box').getBoundingClientRect();
    const content = document.querySelector('.content').getBoundingClientRect();
    const first = document.querySelector('.shortcut-card:nth-child(1)').getBoundingClientRect();
    const second = document.querySelector('.shortcut-card:nth-child(2)').getBoundingClientRect();
    const ninth = document.querySelector('.shortcut-card:nth-child(9)').getBoundingClientRect();
    const thirtySecond = document.querySelector('.shortcut-card:nth-child(32)').getBoundingClientRect();
    const pageStyle = getComputedStyle(document.querySelector('.shortcut-page'));
    const settingsMenu = document.querySelector('.settings-menu').getBoundingClientRect();
    const settingsTriggerStyle = getComputedStyle(document.querySelector('.settings-trigger'));
    const settingsPanelStyle = getComputedStyle(document.querySelector('.settings-panel'));
    return {
      searchTop: searchBox.top,
      searchHeight: searchBox.height,
      contentTop: content.top,
      horizontalPitch: second.left - first.left,
      secondRowLeftDelta: Math.abs(ninth.left - first.left),
      thirtySecondBottom: thirtySecond.bottom,
      columnGap: pageStyle.columnGap,
      gridColumns: pageStyle.gridTemplateColumns.split(' ').length,
      settingsMenuWidth: settingsMenu.width,
      settingsTriggerFontSize: settingsTriggerStyle.fontSize,
      settingsTriggerBorderWidth: settingsTriggerStyle.borderTopWidth,
      settingsTriggerBackground: settingsTriggerStyle.backgroundColor,
      settingsTriggerShadow: settingsTriggerStyle.boxShadow,
      settingsTriggerBackdropFilter: settingsTriggerStyle.backdropFilter,
      settingsPanelOpacity: settingsPanelStyle.opacity,
      settingsPanelPointerEvents: settingsPanelStyle.pointerEvents,
    };
  });

  assert(metrics.searchTop < 96, `search should move upward, got top ${metrics.searchTop}`);
  assert(metrics.searchHeight <= 62, `search box should be smaller, got height ${metrics.searchHeight}`);
  assert(metrics.horizontalPitch <= 120, `shortcut horizontal spacing should be tighter, got pitch ${metrics.horizontalPitch}`);
  assert(metrics.gridColumns === 8, `shortcut grid should keep 8 columns, got ${metrics.gridColumns}`);
  assert(metrics.secondRowLeftDelta <= 1, `new rows should start at the left edge, got delta ${metrics.secondRowLeftDelta}`);
  assert(metrics.thirtySecondBottom < 640, `32nd shortcut should stay comfortably in the first viewport, got ${metrics.thirtySecondBottom}`);
  assert(metrics.settingsMenuWidth <= 64, `collapsed settings should only show a small gear, got width ${metrics.settingsMenuWidth}`);
  assert(parseFloat(metrics.settingsTriggerFontSize) >= 22, `settings gear should fill the round button, got font size ${metrics.settingsTriggerFontSize}`);
  assert(metrics.settingsTriggerBorderWidth === '0px', `settings gear should not have a circular border, got ${metrics.settingsTriggerBorderWidth}`);
  assert(metrics.settingsTriggerBackground === 'rgba(0, 0, 0, 0)', `settings gear should be transparent, got ${metrics.settingsTriggerBackground}`);
  assert(metrics.settingsTriggerShadow === 'none', `settings gear should not have a circular shadow, got ${metrics.settingsTriggerShadow}`);
  assert(metrics.settingsTriggerBackdropFilter === 'none', `settings gear should not blur through a circular backdrop, got ${metrics.settingsTriggerBackdropFilter}`);
  assert(metrics.settingsPanelOpacity === '0', `settings panel should be hidden until hover/focus, got opacity ${metrics.settingsPanelOpacity}`);
  assert(metrics.settingsPanelPointerEvents === 'none', `hidden settings panel should not catch pointer events`);

  await page.click('.shortcut-card:nth-child(1)', { button: 'right' });
  const dialogOpen = await page.$eval('#shortcutDialog', dialog => dialog.open);
  const editMode = await page.$eval('.newtab-shell', shell => shell.classList.contains('edit-mode'));
  assert(editMode, 'right-clicking a shortcut should enter global edit mode');
  assert(!dialogOpen, 'right-clicking a shortcut should not open the edit dialog immediately');
  await page.click('[data-id="site-0"]');
  await page.waitForFunction(() => document.querySelector('#shortcutDialog').open);
  const editedTitle = await page.$eval('#shortcutTitle', input => input.value);
  assert(editedTitle === 'Site 0', `clicking a shortcut in edit mode should load it for editing, got ${editedTitle}`);

  console.log(JSON.stringify({ cardCount, dotCount, metrics }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
