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

  const backup = {
    version: 'v2',
    backupType: 'local',
    data: {
      site: {
        sites: [[
          { name: 'Example Docs', target: 'https://docs.example.com/', bgImage: 'docs.png' },
          { name: 'Example App', target: 'https://app.example.com/dashboard', bgColor: '#ffffff' },
          { name: 'GitHub Duplicate', target: 'https://github.com/', bgImage: 'github.png' },
        ]],
      },
    },
  };

  await page.setInputFiles('#importInput', {
    name: 'sample.infinity',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  await page.waitForFunction(() => document.querySelectorAll('.shortcut-card').length === 7);
  const titles = await page.$$eval('.shortcut-title', nodes => nodes.map(node => node.textContent.trim()));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tomorinNewTabState')));
  const urls = stored.shortcuts.map(item => item.url);

  assert(stored.shortcuts.length === 7, `expected 7 shortcuts, got ${stored.shortcuts.length}`);
  assert(titles.includes('Example Docs'), 'should import Infinity backup site');
  assert(titles.includes('Example App'), 'should import another Infinity backup site');
  assert(titles.filter(title => title === 'GitHub').length === 1, 'should dedupe existing GitHub shortcut');
  assert(urls.includes('https://docs.example.com/'), 'should store imported docs URL');
  assert(urls.includes('https://app.example.com/dashboard'), 'should store imported app URL');

  console.log(JSON.stringify({
    count: stored.shortcuts.length,
    titles,
    importedUrls: urls.filter(url => url.includes('example.com')),
  }, null, 2));

  await browser.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
