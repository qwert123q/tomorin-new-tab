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

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });

  const page = await browser.newPage({ viewport: { width: 2048, height: 1116 } });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const labels = await page.$$eval('[data-action="set-density"]', buttons => (
    buttons.map(button => button.textContent.trim())
  ));
  assert(JSON.stringify(labels) === JSON.stringify(['小', '中', '大']), 'density buttons should be 小/中/大');

  const activeAtStart = await page.$eval('[data-action="set-density"][aria-pressed="true"]', button => button.dataset.density);
  assert(activeAtStart === 'small', 'default density should be small');

  const readIconWidth = () => page.$eval('.shortcut-icon', icon => parseFloat(getComputedStyle(icon).width));
  const smallWidth = await readIconWidth();

  await revealSettings(page);
  await page.click('[data-action="set-density"][data-density="medium"]');
  const mediumWidth = await readIconWidth();
  assert(mediumWidth > smallWidth, `medium width ${mediumWidth} should be greater than small width ${smallWidth}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const persisted = await page.$eval('[data-action="set-density"][aria-pressed="true"]', button => button.dataset.density);
  assert(persisted === 'medium', 'selected density should persist after reload');

  await revealSettings(page);
  await page.click('[data-action="set-density"][data-density="large"]');
  const largeWidth = await readIconWidth();
  assert(largeWidth > mediumWidth, `large width ${largeWidth} should be greater than medium width ${mediumWidth}`);

  const viewports = [
    { name: 'compact-scaled', width: 1024, height: 640, columns: 8 },
    { name: 'hd-laptop', width: 1280, height: 720, columns: 8 },
    { name: '14-inch', width: 1366, height: 768, columns: 8 },
    { name: 'mac-13', width: 1440, height: 900, columns: 8 },
    { name: 'win-scaled', width: 1536, height: 864, columns: 8 },
    { name: 'full-hd', width: 1920, height: 1080, columns: 8 },
    { name: 'qhd', width: 2560, height: 1440, columns: 8 },
    { name: 'narrow', width: 390, height: 844, columns: 4 },
  ];
  const responsive = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const metrics = await page.evaluate(() => {
      const shortcutPage = document.querySelector('.shortcut-page');
      const icon = document.querySelector('.shortcut-icon').getBoundingClientRect();
      const pageRect = shortcutPage.getBoundingClientRect();
      return {
        bodyWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        columns: getComputedStyle(shortcutPage).gridTemplateColumns.split(' ').length,
        iconWidth: icon.width,
        pageBottom: pageRect.bottom,
      };
    });
    assert(metrics.bodyScrollWidth === metrics.bodyWidth, `${viewport.name} should not overflow horizontally`);
    assert(metrics.columns === viewport.columns, `${viewport.name} should use ${viewport.columns} columns`);
    assert(metrics.iconWidth === largeWidth, `${viewport.name} should preserve the selected icon size`);
    if (viewport.width > 760) {
      assert(metrics.pageBottom <= viewport.height, `${viewport.name} shortcut page should fit vertically`);
    }
    responsive.push({ name: viewport.name, ...metrics });
  }

  console.log(JSON.stringify({
    labels,
    widths: { small: smallWidth, medium: mediumWidth, large: largeWidth },
    persisted,
    responsive,
  }, null, 2));

  await browser.close();
})().catch(async error => {
  console.error(error.message);
  process.exit(1);
});
