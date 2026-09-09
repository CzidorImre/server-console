import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getMetrics } from './lib/metrics.js';
import { powerAction, getPending, getLastError } from './lib/power.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      console.warn('config.json is unreadable; regenerating.');
    }
  }
  let changed = false;
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  if (!cfg.port) {
    cfg.port = 8477;
    changed = true;
  }
  // Loopback by default: power controls should not be reachable from the LAN
  // until you deliberately change this to 0.0.0.0.
  if (!cfg.host) {
    cfg.host = '127.0.0.1';
    changed = true;
  }
  if (typeof cfg.powerEnabled !== 'boolean') {
    cfg.powerEnabled = true;
    changed = true;
  }
  if (typeof cfg.graceSeconds !== 'number') {
    cfg.graceSeconds = 30;
    changed = true;
  }
  // Linux only: run reboot/poweroff through `sudo -n`. Leave false when the service
  // already runs as root, or when a polkit rule grants the right directly.
  if (typeof cfg.useSudo !== 'boolean') {
    cfg.useSudo = false;
    changed = true;
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  // Env overrides win over the file, for running a second instance or a quick test.
  if (process.env.DASH_PORT) cfg.port = Number(process.env.DASH_PORT);
  if (process.env.DASH_HOST) cfg.host = process.env.DASH_HOST;
  return cfg;
}

const cfg = loadConfig();

function tokenOk(req, url) {
  const given = req.headers['x-dash-token'] || url.searchParams.get('token') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(cfg.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, 'public', rel);
  // Refuse anything that escapes public/.
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  try {
    if (!route.startsWith('/api/')) {
      if (req.method !== 'GET') return res.writeHead(405).end();
      return serveStatic(res, route);
    }

    if (!tokenOk(req, url)) {
      return sendJson(res, 401, { error: 'unauthorized', hint: 'Missing or wrong access token.' });
    }

    if (route === '/api/stats' && req.method === 'GET') {
      const stats = await getMetrics();
      return sendJson(res, 200, {
        ...stats,
        power: {
          enabled: cfg.powerEnabled,
          graceSeconds: cfg.graceSeconds,
          pending: getPending(),
          error: getLastError(),
        },
      });
    }

    if (route === '/api/power' && req.method === 'POST') {
      if (!cfg.powerEnabled) {
        return sendJson(res, 403, { error: 'Power controls are disabled in config.json.' });
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      const { action, confirm } = body;
      if (!['restart', 'shutdown', 'cancel'].includes(action)) {
        return sendJson(res, 400, { error: 'action must be restart, shutdown, or cancel' });
      }
      if (action !== 'cancel' && confirm !== true) {
        return sendJson(res, 400, { error: 'confirm:true is required for this action' });
      }
      const who = req.socket.remoteAddress || 'unknown';
      console.log(`[power] ${action} requested by ${who} at ${new Date().toISOString()}`);
      try {
        const result = await powerAction(action, {
          delaySec: cfg.graceSeconds,
          by: who,
          useSudo: cfg.useSudo,
        });
        return sendJson(res, 200, result);
      } catch (err) {
        console.error(`[power] ${action} failed: ${err.message}`);
        return sendJson(res, 500, { error: err.message });
      }
    }

    return sendJson(res, 404, { error: 'no such endpoint' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(cfg.port, cfg.host, () => {
  const shown = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log('');
  console.log('  Server dashboard is up.');
  console.log(`  →  http://${shown}:${cfg.port}/?token=${cfg.token}`);
  console.log('');
  console.log(`  bound to      ${cfg.host}:${cfg.port}`);
  console.log(`  power buttons ${cfg.powerEnabled ? `enabled (${cfg.graceSeconds}s cancellable grace period)` : 'disabled'}`);
  console.log(`  settings      ${CONFIG_PATH}`);
  console.log('');
});
