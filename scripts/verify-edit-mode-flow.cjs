const path = require('path');
const fs = require('fs');
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

  const normalShortcutGeometry = await page.$$eval('.shortcut-card', cards => cards.map(card => {
    const icon = card.querySelector('.shortcut-icon');
    const title = card.querySelector('.shortcut-title');
    const cardRect = card.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      id: card.dataset.id,
      cardHeight: cardRect.height,
      iconCenterX: iconRect.left + iconRect.width / 2,
      iconCenterY: iconRect.top + iconRect.height / 2,
      titleCenterX: titleRect.left + titleRect.width / 2,
      titleCenterY: titleRect.top + titleRect.height / 2,
    };
  }));

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
  assert(!rightClickState.dialogOpen, 'right-clicking a shortcut should enter global edit mode without opening an item dialog');
  assert(rightClickState.slotCount === 32, `global edit mode should render 32 slots, got ${rightClickState.slotCount}`);
  assert(rightClickState.addSlotIndex === '6', `add button should appear after the last shortcut at slot 6, got ${rightClickState.addSlotIndex}`);

  const editMarkerState = await page.evaluate(() => {
    const markers = Array.from(document.querySelectorAll('.shortcut-edit-marker'));
    return {
      count: markers.length,
      visibleCount: markers.filter(marker => getComputedStyle(marker).opacity === '1').length,
      pointerSafe: markers.every(marker => getComputedStyle(marker).pointerEvents === 'none'),
      transparent: markers.every(marker => {
        const style = getComputedStyle(marker);
        return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow === 'none';
      }),
      text: markers[0]?.textContent.trim(),
    };
  });
  assert(editMarkerState.count === 6, `edit mode should render one marker per shortcut, got ${editMarkerState.count}`);
  assert(editMarkerState.visibleCount === 6, `edit markers should be visible in edit mode, got ${editMarkerState.visibleCount}`);
  assert(editMarkerState.pointerSafe, 'edit markers should not intercept shortcut pointer events');
  assert(editMarkerState.transparent, 'edit markers should be transparent without a button-like background');
  assert(editMarkerState.text === '✎', `edit marker should use a small edit icon, got ${editMarkerState.text}`);

  await page.addStyleTag({ content: '.edit-mode .shortcut-card .shortcut-icon { animation: none !important; transform: none !important; }' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const editShortcutGeometry = await page.$$eval('.shortcut-card', cards => cards.map(card => {
    const icon = card.querySelector('.shortcut-icon');
    const title = card.querySelector('.shortcut-title');
    const cardRect = card.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      id: card.dataset.id,
      cardHeight: cardRect.height,
      iconCenterX: iconRect.left + iconRect.width / 2,
      iconCenterY: iconRect.top + iconRect.height / 2,
      titleCenterX: titleRect.left + titleRect.width / 2,
      titleCenterY: titleRect.top + titleRect.height / 2,
    };
  }));
  const maxEditShift = normalShortcutGeometry.reduce((maxShift, normal, index) => {
    const edit = editShortcutGeometry[index];
    assert(edit?.id === normal.id, `edit geometry should preserve shortcut order, got ${edit?.id} after ${normal.id}`);
    return Math.max(
      maxShift,
      Math.abs(edit.cardHeight - normal.cardHeight),
      Math.abs(edit.iconCenterX - normal.iconCenterX),
      Math.abs(edit.iconCenterY - normal.iconCenterY),
      Math.abs(edit.titleCenterX - normal.titleCenterX),
      Math.abs(edit.titleCenterY - normal.titleCenterY),
    );
  }, 0);
  assert(maxEditShift <= 0.5, `edit mode should not shift shortcut icon/title geometry, max shift ${maxEditShift.toFixed(2)}px`);
  const cssText = fs.readFileSync(path.resolve(__dirname, '../extension/style.css'), 'utf8');
  const wiggleStart = cssText.indexOf('@keyframes shortcut-wiggle');
  const wiggleEnd = cssText.indexOf('@keyframes shortcut-pop', wiggleStart);
  const wiggleRule = cssText.slice(wiggleStart, wiggleEnd);
  assert(wiggleStart !== -1 && wiggleEnd !== -1, 'shortcut wiggle keyframes should exist');
  assert(!wiggleRule.includes('translate'), 'shortcut wiggle animation should not translate icons away from their normal center');

  await page.click('[data-id="site-0"]');
  await page.waitForFunction(() => document.querySelector('#shortcutDialog').open);
  const selectedTitle = await page.$eval('#shortcutTitle', node => node.value);
  assert(selectedTitle === 'Site 0', `clicking a shortcut in edit mode should choose it for editing, got ${selectedTitle}`);
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
  const hiddenEditMarkers = await page.$$eval(
    '.shortcut-edit-marker',
    markers => markers.every(marker => getComputedStyle(marker).opacity === '0'),
  );
  assert(hiddenEditMarkers, 'edit markers should be hidden after exiting edit mode');

  await page.click('[data-id="site-1"]', { button: 'right' });
  await page.waitForFunction(() => document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  await page.click('[data-slot-index="7"]');
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));

  await page.click('[data-id="site-1"]', { button: 'right' });
  await page.waitForFunction(() => document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  await page.mouse.click(40, 40);
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));

  console.log(JSON.stringify({ removedControls, rightClickState, addTitle }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
