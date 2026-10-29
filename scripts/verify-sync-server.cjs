const assert = require('assert/strict');
const crypto = require('crypto');
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

async function startServer(env) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tomorin-sync-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server/sync-server.js')], {
    env: { ...process.env, SYNC_HOST: '127.0.0.1', SYNC_PORT: String(port), SYNC_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url);
  return {
    url,
    dataDir,
    stderr: () => stderr,
    async stop() {
      child.kill('SIGTERM');
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stateWith(extra = {}) {
  return {
    schemaVersion: 2,
    shortcuts: [],
    tombstones: [],
    settings: { iconDensity: 'small', iconDensityAt: 0 },
    wallpaper: { hash: '', mime: '', size: 0, updatedAt: 0 },
    ...extra,
  };
}

async function declaredSizeUpload(url, password, hash, size) {
  return await new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/v2/blobs/${hash}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${encodeURIComponent(password)}`, 'Content-Type': 'image/jpeg', 'Content-Length': String(size) },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

(async () => {
  const password = 'tomorin 记得住的密码';
  const legacyToken = 'old-random-token';
  const server = await startServer({ SYNC_PASSWORD: password, SYNC_TOKEN: legacyToken });
  // The extension percent-encodes the password because headers cannot carry Chinese text.
  const auth = { Authorization: `Bearer ${encodeURIComponent(password)}` };
  const api = (pathname, options = {}) => fetch(`${server.url}${pathname}`, {
    ...options,
    headers: { ...auth, ...(options.headers || {}) },
  });

  try {
    const health = await (await fetch(`${server.url}/health`)).json();
    assert.equal(health.protocol, 2);
    assert.equal(health.capabilities.stateV2, true);

    const legacy = await fetch(`${server.url}/api/state`, { headers: auth });
    assert.equal(legacy.status, 410, 'old extensions should be told to update');

    assert.equal((await fetch(`${server.url}/api/v2/state`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/v2/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${server.url}/api/v2/state`, { headers: { Authorization: `Bearer ${legacyToken}` } })).status, 200, 'the old SYNC_TOKEN should keep working');

    const empty = await (await api('/api/v2/state')).json();
    assert.equal(empty.rev, 0);
    assert.deepEqual(empty.state.shortcuts, []);

    const missingPrecondition = await api('/api/v2/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stateWith()) });
    assert.equal(missingPrecondition.status, 428, 'writes must say which revision they are based on');

    const firstState = stateWith({ shortcuts: [{ id: 'a', title: 'A', url: 'https://a.example', pos: 'a0', editedAt: 1, movedAt: 1, createdAt: 1, futureField: 'kept' }] });
    const first = await api('/api/v2/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"0"' }, body: JSON.stringify(firstState) });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).rev, 1);

    const stale = await api('/api/v2/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"0"' }, body: JSON.stringify(stateWith()) });
    assert.equal(stale.status, 412, 'a write based on an old revision must be rejected');
    assert.equal((await stale.json()).rev, 1);

    const notModified = await api('/api/v2/state', { headers: { 'If-None-Match': '"1"' } });
    assert.equal(notModified.status, 304, 'unchanged state should answer 304');
    const current = await (await api('/api/v2/state')).json();
    assert.equal(current.state.shortcuts[0].futureField, 'kept', 'unknown fields should be stored as sent');

    const wallpaper = new Uint8Array(21 * 1024 * 1024);
    wallpaper.set([0xff, 0xd8, 0xff, 0xe0]);
    const wallpaperHash = sha256Hex(wallpaper);
    const withWallpaper = stateWith({ wallpaper: { hash: wallpaperHash, mime: 'image/jpeg', size: wallpaper.length, updatedAt: 5 } });

    const missing = await api('/api/v2/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"1"' }, body: JSON.stringify(withWallpaper) });
    assert.equal(missing.status, 409, 'state that points at an unknown picture should ask for the upload');
    assert.deepEqual((await missing.json()).missing, [wallpaperHash]);

    const wrongHash = await api(`/api/v2/blobs/${'0'.repeat(64)}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: wallpaper });
    assert.equal(wrongHash.status, 400, 'uploads must match their hash');

    const upload = await api(`/api/v2/blobs/${wallpaperHash}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: wallpaper });
    assert.equal(upload.status, 200);
    const again = await api(`/api/v2/blobs/${wallpaperHash}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: wallpaper });
    assert.equal((await again.json()).existed, true, 'uploading the same picture twice should be a no-op');

    const saved = await api('/api/v2/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '1' }, body: JSON.stringify(withWallpaper) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).rev, 2);

    const download = await api(`/api/v2/blobs/${wallpaperHash}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/jpeg');
    const downloaded = new Uint8Array(await download.arrayBuffer());
    assert.equal(sha256Hex(downloaded), wallpaperHash, 'downloaded picture should be identical');

    assert.equal((await api(`/api/v2/blobs/${'1'.repeat(64)}`)).status, 404);
    assert.equal(await declaredSizeUpload(server.url, password, '2'.repeat(64), 100 * 1024 * 1024 + 1), 413);
    const svg = await api(`/api/v2/blobs/${'3'.repeat(64)}`, { method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
    assert.equal(svg.status, 415);
  } finally {
    await server.stop();
  }

  const limited = await startServer({ SYNC_PASSWORD: 'right', SYNC_MAX_FAILURES_PER_IP: '3' });
  try {
    const tryWith = (secret, ip) => fetch(`${limited.url}/api/v2/state`, {
      headers: { Authorization: `Bearer ${secret}`, 'X-Forwarded-For': ip },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await tryWith('wrong', '203.0.113.7')).status, 401);
    assert.equal((await tryWith('right', '203.0.113.7')).status, 429, 'too many wrong passwords should pause sign-in from that address');
    assert.equal((await tryWith('right', '198.51.100.2')).status, 200, 'other addresses should not be blocked');
  } finally {
    await limited.stop();
  }

  console.log(JSON.stringify({
    legacy: '410',
    auth: 'password + legacy token, 401, rate limit 429',
    revisions: 'If-Match 428/412, If-None-Match 304',
    blobs: '409 missing, hash check, 21 MB round trip, 413, 415',
  }, null, 2));
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
