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
    localStorage.setItem('tomorinNewTabState', JSON.stringify({
      shortcuts: Array.from({ length: 6 }, (_, index) => ({
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

  const removedControls = await page.evaluate(() => ({
    editButton: Boolean(document.querySelector('[data-action="toggle-edit"]')),
    addButton: Boolean(document.querySelector('.toolbar [data-action="add-shortcut"]')),
    importInput: Boolean(document.querySelector('#importInput')),
  }));
  assert(!removedControls.editButton, 'settings gear should not contain edit shortcut control');
  assert(!removedControls.addButton, 'settings gear should not contain add shortcut control');
  assert(!removedControls.importInput, 'Infinity import input should be removed');

  await page.click('[data-id="site-0"]', { button: 'right' });
  await page.waitForFunction(() => document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  const rightClickState = await page.evaluate(() => ({
    dialogOpen: document.querySelector('#shortcutDialog').open,
    title: document.querySelector('#shortcutTitle').value,
    slotCount: document.querySelectorAll('.shortcut-slot').length,
    addSlotIndex: document.querySelector('[data-action="add-shortcut"]')?.closest('.shortcut-slot')?.dataset.slotIndex,
  }));
  assert(rightClickState.dialogOpen, 'right-clicking a shortcut should open the edit dialog');
  assert(rightClickState.title === 'Site 0', `right-click edit should load clicked shortcut, got ${rightClickState.title}`);
  assert(rightClickState.slotCount === 32, `global edit mode should render 32 slots, got ${rightClickState.slotCount}`);
  assert(rightClickState.addSlotIndex === '6', `add button should appear after the last shortcut at slot 6, got ${rightClickState.addSlotIndex}`);

  await page.click('[data-action="close-dialog"]');
  await page.waitForFunction(() => !document.querySelector('#shortcutDialog').open);
  await page.click('[data-action="add-shortcut"]');
  await page.waitForFunction(() => document.querySelector('#shortcutDialog').open);
  const addTitle = await page.$eval('#dialogTitle', node => node.textContent.trim());
  assert(addTitle === '添加网站', `clicking the plus slot should open add dialog, got ${addTitle}`);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#shortcutDialog').open);
  const stillEditingAfterDialogEsc = await page.$eval('.newtab-shell', shell => shell.classList.contains('edit-mode'));
  assert(stillEditingAfterDialogEsc, 'Escape should close an open dialog before exiting edit mode');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));

  await page.click('[data-id="site-1"]', { button: 'right' });
  await page.click('[data-action="close-dialog"]');
  await page.waitForFunction(() => document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  await page.click('[data-slot-index="7"]');
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));

  await page.click('[data-id="site-1"]', { button: 'right' });
  await page.click('[data-action="close-dialog"]');
  await page.waitForFunction(() => document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  await page.mouse.click(40, 40);
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));

  console.log(JSON.stringify({ removedControls, rightClickState, addTitle }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
