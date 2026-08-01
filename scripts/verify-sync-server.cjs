const assert = require('assert/strict');
const fs = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('sync server did not become ready');
}

async function requestWithDeclaredSize(url, token, size) {
  return await new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/wallpaper`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'image/png',
        'Content-Length': String(size),
      },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

(async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tomorin-sync-test-'));
  const port = await freePort();
  const token = 'wallpaper-test-token';
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/sync-server.js')], {
    env: {
      ...process.env,
      SYNC_HOST: '127.0.0.1',
      SYNC_PORT: String(port),
      SYNC_TOKEN: token,
      SYNC_DATA_FILE: path.join(tempDir, 'state.json'),
      SYNC_WALLPAPER_FILE: path.join(tempDir, 'wallpaper.bin'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth(url);
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.capabilities.wallpaperSync, true);
    assert.equal(health.capabilities.maxWallpaperBytes, 100 * 1024 * 1024);
    const unauthorized = await fetch(`${url}/api/wallpaper`);
    assert.equal(unauthorized.status, 401);

    const wallpaper = new Uint8Array(21 * 1024 * 1024);
    wallpaper.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const upload = await fetch(`${url}/api/wallpaper`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'image/png',
      },
      body: wallpaper,
    });
    assert.equal(upload.status, 200);

    const download = await fetch(`${url}/api/wallpaper`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), wallpaper);

    const tooLarge = await requestWithDeclaredSize(url, token, 100 * 1024 * 1024 + 1);
    assert.equal(tooLarge, 413);

    const state = await fetch(`${url}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).schemaVersion, 1);

    console.log(JSON.stringify({ wallpaper: '21 MB PUT/GET', capability: '100 MB', oversized: '413', authorization: 'verified', state: 'GET' }, null, 2));
  } finally {
    child.kill('SIGTERM');
    await fs.rm(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
