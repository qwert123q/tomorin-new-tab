#!/usr/bin/env node
'use strict';

/*
 * Tomorin New Tab sync server (protocol v2). No dependencies.
 *
 * - One JSON document holds every shortcut, their order, deletions, the icon
 *   density and which wallpaper is active. Each write must name the revision it
 *   was based on (If-Match), so two computers can never silently overwrite each
 *   other: the slower one gets 412, merges, and tries again.
 * - Wallpapers and uploaded icons are stored as files named by their SHA-256,
 *   so a picture is uploaded once and only downloaded by devices missing it.
 * - Sign in with SYNC_PASSWORD (something you can remember) or the older
 *   SYNC_TOKEN. Repeated wrong passwords are rate limited.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.SYNC_PORT || 8787);
const HOST = process.env.SYNC_HOST || '0.0.0.0';
const SECRETS = [process.env.SYNC_PASSWORD, process.env.SYNC_TOKEN]
  .filter(secret => typeof secret === 'string' && secret.length > 0);
const DATA_DIR = process.env.SYNC_DATA_DIR
  || (process.env.SYNC_DATA_FILE ? path.dirname(process.env.SYNC_DATA_FILE) : path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state-v2.json');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const BLOB_GRACE_MS = 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = Number(process.env.SYNC_MAX_FAILURES_PER_IP || 10);
const MAX_FAILURES_TOTAL = Number(process.env.SYNC_MAX_FAILURES_TOTAL || 100);
const HASH_RE = /^[0-9a-f]{64}$/;
const LEGACY_PATHS = new Set(['/api/state', '/api/wallpaper']);

if (!SECRETS.length) {
  console.error('Set SYNC_PASSWORD (or the older SYNC_TOKEN) before starting the sync server.');
  process.exit(1);
}

const secretDigests = SECRETS.map(sha256);
let stateRecord = null;
let stateLoading = null;
let writeQueue = Promise.resolve();
const failuresByIp = new Map();
const failuresTotal = { count: 0, resetAt: 0 };

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        protocol: 2,
        capabilities: { stateV2: true, blobs: true, wallpaperSync: true, maxBlobBytes: MAX_BLOB_BYTES },
      });
      return;
    }

    if (LEGACY_PATHS.has(pathname)) {
      sendJson(res, 410, { error: 'client_outdated', message: 'Update Tomorin New Tab to use this sync server.' });
      return;
    }

    if (!pathname.startsWith('/api/v2/')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const ip = clientIp(req);
    const retryAfter = rateLimitedFor(ip);
    if (retryAfter) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfter / 1000)));
      sendJson(res, 429, { error: 'too_many_attempts' });
      return;
    }
    if (!isAuthorized(req)) {
      recordFailure(ip);
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (pathname === '/api/v2/state') {
      if (req.method === 'GET') return await handleGetState(req, res);
      if (req.method === 'PUT') return await handlePutState(req, res);
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const blobMatch = /^\/api\/v2\/blobs\/([^/]+)$/.exec(pathname);
    if (blobMatch) {
      const hash = blobMatch[1];
      if (!HASH_RE.test(hash)) throw httpError(400, 'invalid_hash');
      if (req.method === 'GET') return await handleGetBlob(res, hash);
      if (req.method === 'PUT') return await handlePutBlob(req, res, hash);
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'server_error' : error.message, ...(error.extra || {}) });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tomorin New Tab sync server (v2) listening on ${HOST}:${PORT}, data in ${DATA_DIR}`);
});

// ------------------------------------------------------------- state

async function handleGetState(req, res) {
  const record = await readStateRecord();
  const etag = `"${record.rev}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-store');
  if (record.rev > 0 && parseRevision(req.headers['if-none-match']) === record.rev) {
    res.writeHead(304);
    res.end();
    return;
  }
  sendJson(res, 200, { rev: record.rev, state: record.state || emptyState() });
}

async function handlePutState(req, res) {
  const expected = parseRevision(req.headers['if-match']);
  if (expected === null) throw httpError(428, 'if_match_required');
  const state = validateState(await readJsonBody(req));

  await serialized(async () => {
    const current = await readStateRecord();
    if (expected !== current.rev) throw httpError(412, 'conflict', { rev: current.rev });

    const refs = blobRefs(state);
    const missing = [];
    for (const hash of refs) {
      if (!(await fileExists(blobPath(hash)))) missing.push(hash);
    }
    if (missing.length) throw httpError(409, 'missing_blobs', { missing });

    const record = { rev: current.rev + 1, savedAt: Date.now(), state };
    await writeFileAtomic(STATE_FILE, `${JSON.stringify(record)}\n`);
    stateRecord = record;
    res.setHeader('ETag', `"${record.rev}"`);
    sendJson(res, 200, { ok: true, rev: record.rev });
  });
  // Runs in the write queue, so no state write can land while it deletes.
  serialized(collectGarbage).catch(error => console.error('blob cleanup failed', error));
}

// Requests arriving right after a restart share one read of the file, so a
// slow read can never replace a newer revision written in the meantime.
function readStateRecord() {
  if (stateRecord) return stateRecord;
  if (!stateLoading) {
    stateLoading = loadStateFile()
      .then(record => {
        if (!stateRecord) stateRecord = record;
        return stateRecord;
      })
      .finally(() => {
        stateLoading = null;
      });
  }
  return stateLoading;
}

async function loadStateFile() {
  try {
    const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    return {
      rev: Number.isInteger(parsed.rev) && parsed.rev >= 0 ? parsed.rev : 0,
      savedAt: Number(parsed.savedAt) || 0,
      state: parsed.state && typeof parsed.state === 'object' ? parsed.state : null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { rev: 0, savedAt: 0, state: null };
  }
}

function emptyState() {
  return {
    schemaVersion: 2,
    shortcuts: [],
    tombstones: [],
    settings: { iconDensity: 'small', iconDensityAt: 0 },
    wallpaper: { hash: '', mime: '', size: 0, updatedAt: 0 },
  };
}

// The extension validates every field when it reads the document, so the
// server only checks the outline and keeps unknown fields for future versions.
function validateState(payload) {
  if (!payload || typeof payload !== 'object' || payload.schemaVersion !== 2) throw httpError(400, 'invalid_state');
  if (!Array.isArray(payload.shortcuts) || !Array.isArray(payload.tombstones)) throw httpError(400, 'invalid_state');
  if (payload.shortcuts.length > 3000 || payload.tombstones.length > 10000) throw httpError(400, 'state_too_large');
  if (payload.wallpaper && typeof payload.wallpaper !== 'object') throw httpError(400, 'invalid_state');
  return payload;
}

function blobRefs(state) {
  const refs = new Set();
  if (HASH_RE.test(state.wallpaper?.hash || '')) refs.add(state.wallpaper.hash);
  for (const item of state.shortcuts) {
    if (item && item.icon && item.icon.type === 'blob' && HASH_RE.test(item.icon.hash || '')) refs.add(item.icon.hash);
  }
  return [...refs];
}

function parseRevision(value) {
  const match = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function serialized(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

// -------------------------------------------------------------- blobs

function blobPath(hash) {
  return path.join(BLOB_DIR, hash);
}

function blobMetaPath(hash) {
  return path.join(BLOB_DIR, `${hash}.json`);
}

async function handleGetBlob(res, hash) {
  const file = blobPath(hash);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'blob_not_found');
    throw error;
  }
  let mime = 'application/octet-stream';
  try {
    mime = normalizeImageType(JSON.parse(await fsp.readFile(blobMetaPath(hash), 'utf8')).mime);
  } catch {
    // Missing metadata only loses the content type; the extension knows it anyway.
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  await pipeline(fs.createReadStream(file), res);
}

async function handlePutBlob(req, res, hash) {
  const mime = normalizeImageType(req.headers['content-type']);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BLOB_BYTES) throw httpError(413, 'payload_too_large');

  await fsp.mkdir(BLOB_DIR, { recursive: true });
  if (await fileExists(blobPath(hash))) {
    req.resume();
    await fsp.utimes(blobPath(hash), new Date(), new Date()).catch(() => {});
    sendJson(res, 200, { ok: true, existed: true });
    return;
  }

  const temp = path.join(BLOB_DIR, `${hash}.${process.pid}.${Date.now()}.tmp`);
  const digest = crypto.createHash('sha256');
  let size = 0;
  try {
    const out = fs.createWriteStream(temp, { mode: 0o600 });
    await pipeline(req, async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_BLOB_BYTES) throw httpError(413, 'payload_too_large');
        digest.update(chunk);
        yield chunk;
      }
    }, out);
    if (!size) throw httpError(400, 'empty_blob');
    if (digest.digest('hex') !== hash) throw httpError(400, 'hash_mismatch');
    await writeFileAtomic(blobMetaPath(hash), `${JSON.stringify({ mime, size, savedAt: Date.now() })}\n`);
    await fsp.rename(temp, blobPath(hash));
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
  sendJson(res, 200, { ok: true, size });
}

function normalizeImageType(value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]{1,60}$/.test(type) || type === 'image/svg+xml') throw httpError(415, 'unsupported_type');
  return type;
}

// Remove pictures no longer used by the document. Runs between state writes;
// recent files are kept so an upload a client is about to reference survives.
async function collectGarbage() {
  const current = await readStateRecord();
  const keep = new Set(current.state ? blobRefs(current.state) : []);
  const names = await fsp.readdir(BLOB_DIR).catch(() => []);
  const now = Date.now();
  for (const name of names) {
    const hash = name.slice(0, 64);
    if (keep.has(hash)) continue;
    const file = path.join(BLOB_DIR, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > BLOB_GRACE_MS) await fsp.rm(file, { force: true });
  }
}

// --------------------------------------------------------------- auth

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// The extension percent-encodes the password so it may contain Chinese or
// spaces; plain tokens sent by older tools still match as they are.
function isAuthorized(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!match) return false;
  const raw = match[1].trim();
  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // Not percent-encoded.
  }
  return candidates.some(value => {
    const provided = sha256(value);
    return secretDigests.some(secret => crypto.timingSafeEqual(provided, secret));
  });
}

function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (loopback && process.env.SYNC_TRUST_PROXY !== '0') {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return peer;
}

function rateLimitedFor(ip) {
  const now = Date.now();
  if (failuresTotal.resetAt <= now) {
    failuresTotal.count = 0;
    failuresTotal.resetAt = now + FAILURE_WINDOW_MS;
  }
  if (failuresTotal.count >= MAX_FAILURES_TOTAL) return failuresTotal.resetAt - now;
  const entry = failuresByIp.get(ip);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.count >= MAX_FAILURES_PER_IP ? entry.resetAt - now : 0;
}

function recordFailure(ip) {
  const now = Date.now();
  failuresTotal.count += 1;
  const entry = failuresByIp.get(ip);
  if (!entry || entry.resetAt <= now) failuresByIp.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  else entry.count += 1;
  if (failuresByIp.size > 5000) {
    for (const [key, value] of failuresByIp) if (value.resetAt <= now) failuresByIp.delete(key);
  }
}

// ------------------------------------------------------------ helpers

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,If-Match,If-None-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag,Retry-After');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function httpError(statusCode, message, extra = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.extra = extra;
  return error;
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_STATE_BYTES) throw httpError(413, 'payload_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_STATE_BYTES) throw httpError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, contents, { mode: 0o600 });
  await fsp.rename(temp, file);
}
