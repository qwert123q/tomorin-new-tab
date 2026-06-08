#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.SYNC_PORT || 8787);
const HOST = process.env.SYNC_HOST || '0.0.0.0';
const TOKEN = process.env.SYNC_TOKEN || '';
const DATA_FILE = process.env.SYNC_DATA_FILE || path.join(__dirname, 'data', 'state.json');
const MAX_BODY_BYTES = 256 * 1024;
const EMPTY_STATE = {
  schemaVersion: 1,
  updatedAt: 0,
  shortcuts: [],
  deletedShortcuts: [],
  settings: { iconDensity: 'small' },
};

if (!TOKEN) {
  console.error('SYNC_TOKEN is required.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.url === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!req.url?.startsWith('/api/state')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET') {
      sendJson(res, 200, await readState());
      return;
    }

    if (req.method === 'PUT') {
      const payload = validateState(await readJsonBody(req));
      await writeState(payload);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { error: status === 500 ? 'server_error' : error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tomorin New Tab sync server listening on ${HOST}:${PORT}`);
});

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  return header === `Bearer ${TOKEN}`;
}

async function readState() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return validateState(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return EMPTY_STATE;
    throw error;
  }
}

async function writeState(payload) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, DATA_FILE);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('payload_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}

function validateState(payload) {
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.shortcuts)) {
    const error = new Error('invalid_state');
    error.statusCode = 400;
    throw error;
  }

  return {
    schemaVersion: 1,
    updatedAt: Number.isFinite(payload.updatedAt) ? payload.updatedAt : Date.now(),
    shortcuts: payload.shortcuts
      .filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.url === 'string')
      .slice(0, 500)
      .map((item, index) => ({
        id: item.id.slice(0, 120),
        title: item.title.slice(0, 80),
        url: item.url.slice(0, 500),
        size: ['small', 'medium', 'large'].includes(item.size) ? item.size : 'small',
        iconUrl: typeof item.iconUrl === 'string' ? item.iconUrl.slice(0, 1000) : '',
        order: Number.isFinite(item.order) ? item.order : index,
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      })),
    deletedShortcuts: Array.isArray(payload.deletedShortcuts)
      ? payload.deletedShortcuts
        .filter(item => item && typeof item.id === 'string')
        .slice(0, 300)
        .map(item => ({
          id: item.id.slice(0, 120),
          url: typeof item.url === 'string' ? item.url.slice(0, 500) : '',
          deletedAt: Number.isFinite(item.deletedAt) ? item.deletedAt : Date.now(),
        }))
      : [],
    settings: {
      iconDensity: ['small', 'medium', 'large'].includes(payload.settings?.iconDensity)
        ? payload.settings.iconDensity
        : 'small',
    },
  };
}
