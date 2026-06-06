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

  await page.click('[data-action="set-density"][data-density="medium"]');
  const mediumWidth = await readIconWidth();
  assert(mediumWidth > smallWidth, `medium width ${mediumWidth} should be greater than small width ${smallWidth}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const persisted = await page.$eval('[data-action="set-density"][aria-pressed="true"]', button => button.dataset.density);
  assert(persisted === 'medium', 'selected density should persist after reload');

  await page.click('[data-action="set-density"][data-density="large"]');
  const largeWidth = await readIconWidth();
  assert(largeWidth > mediumWidth, `large width ${largeWidth} should be greater than medium width ${mediumWidth}`);

  console.log(JSON.stringify({
    labels,
    widths: { small: smallWidth, medium: mediumWidth, large: largeWidth },
    persisted,
  }, null, 2));

  await browser.close();
})().catch(async error => {
  console.error(error.message);
  process.exit(1);
});
