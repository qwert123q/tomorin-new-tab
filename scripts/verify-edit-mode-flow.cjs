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
  await page.waitForSelector('.shortcut-card');

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

  await page.waitForTimeout(200);
  const badgeState = await page.evaluate(() => {
    const badges = Array.from(document.querySelectorAll('.shortcut-remove'));
    return {
      count: badges.length,
      visibleCount: badges.filter(badge => getComputedStyle(badge).opacity === '1').length,
      clickable: badges.every(badge => getComputedStyle(badge).pointerEvents === 'auto'),
      // The badge sits on the corner and leaves the picture itself uncovered.
      onCorner: badges.every(badge => {
        const box = badge.getBoundingClientRect();
        const icon = badge.closest('.shortcut-icon').getBoundingClientRect();
        return box.left + box.width / 2 <= icon.left + 4 && box.top + box.height / 2 <= icon.top + 4;
      }),
      centerClear: badges.every(badge => {
        const icon = badge.closest('.shortcut-icon').getBoundingClientRect();
        const hit = document.elementFromPoint(icon.left + icon.width / 2, icon.top + icon.height / 2);
        return hit?.tagName === 'IMG';
      }),
      oldMarkers: document.querySelectorAll('.shortcut-edit-marker').length,
      editBar: Boolean(document.querySelector('#editBar, .edit-bar')),
    };
  });
  assert(badgeState.count === 6, `edit mode should show one remove badge per shortcut, got ${badgeState.count}`);
  assert(badgeState.visibleCount === 6, `remove badges should be visible in edit mode, got ${badgeState.visibleCount}`);
  assert(badgeState.clickable, 'remove badges should be clickable in edit mode');
  assert(badgeState.onCorner, 'remove badges should sit on the top-left corner of the icon');
  assert(badgeState.centerClear, 'nothing should be drawn over the middle of an icon in edit mode');
  assert(badgeState.oldMarkers === 0, 'the old pencil overlay should be gone');
  assert(!badgeState.editBar, 'edit mode should not show a hint bar; clicking outside the icons finishes editing');

  const addTile = await page.evaluate(() => {
    const lastIcon = document.querySelector('[data-id="site-5"] .shortcut-icon').getBoundingClientRect();
    const plus = document.querySelector('.add-shortcut-icon');
    const box = plus.getBoundingClientRect();
    const style = getComputedStyle(plus);
    return {
      iconCenterY: lastIcon.top + lastIcon.height / 2,
      addCenterY: box.top + box.height / 2,
      // Layout size: the wiggle rotation makes bounding boxes slightly larger.
      sameSize: plus.offsetWidth === document.querySelector('[data-id="site-5"] .shortcut-icon').offsetWidth
        && plus.offsetHeight === document.querySelector('[data-id="site-5"] .shortcut-icon').offsetHeight,
      borderStyle: style.borderTopStyle,
      frosted: (style.backdropFilter || '').includes('blur'),
      label: document.querySelector('.add-shortcut-tile .shortcut-title')?.textContent,
    };
  });
  assert(
    Math.abs(addTile.iconCenterY - addTile.addCenterY) <= 0.5,
    `add shortcut tile should align with shortcut icons, got ${JSON.stringify(addTile)}`,
  );
  assert(addTile.sameSize, 'the add tile should be the same size as the icons');
  assert(addTile.borderStyle !== 'dashed', 'the add tile should not use a dashed box');
  assert(addTile.frosted, 'the add tile should be a frosted square');
  assert(addTile.label === '添加', `the add tile should be labelled like a shortcut, got ${addTile.label}`);

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

  // The remove badge deletes right away and offers an undo.
  await page.click('[data-id="site-2"] [data-action="remove-shortcut"]');
  await page.waitForFunction(() => !document.querySelector('[data-id="site-2"]'));
  await page.waitForSelector('.toast.visible .toast-action');
  const undoLabel = await page.$eval('.toast-action', node => node.textContent);
  assert(undoLabel === '撤销', `deleting should offer 撤销, got ${undoLabel}`);
  await page.click('.toast-action');
  await page.waitForSelector('[data-id="site-2"]');
  const restoredOrder = await page.$$eval('.shortcut-card', cards => cards.map(card => card.dataset.id));
  assert(restoredOrder[2] === 'site-2', `undo should put the site back in its place, got ${restoredOrder.join(',')}`);
  assert(await page.$eval('.newtab-shell', shell => shell.classList.contains('edit-mode')), 'undo should keep edit mode open');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  const hiddenBadges = await page.$$eval(
    '.shortcut-remove',
    badges => badges.every(badge => getComputedStyle(badge).opacity === '0' && getComputedStyle(badge).pointerEvents === 'none'),
  );
  assert(hiddenBadges, 'remove badges should be hidden and inert after exiting edit mode');

  await page.click('[data-id="site-1"]', { button: 'right' });
  await page.waitForFunction(() => document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  await page.click('[data-slot-index="7"]');
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));

  await page.click('[data-id="site-1"]', { button: 'right' });
  await page.waitForFunction(() => document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));
  await page.mouse.click(40, 40);
  await page.waitForFunction(() => !document.querySelector('.newtab-shell')?.classList.contains('edit-mode'));

  console.log(JSON.stringify({ removedControls, rightClickState, badgeState, addTile, addTitle }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
