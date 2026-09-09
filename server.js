import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { getMetrics, configureInternet } from './lib/metrics.js';
import { powerAction, getPending, getLastError } from './lib/power.js';
import * as history from './lib/history.js';
import * as alerts from './lib/alerts.js';
import * as manage from './lib/manage.js';
import * as security from './lib/security.js';
import * as storage from './lib/storage.js';
import * as peers from './lib/peers.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');

/* ---------------- config ---------------- */

const DEFAULTS = {
  port: 8477,
  // Loopback by default: power and management controls should not be reachable from
  // the LAN until this is deliberately changed to 0.0.0.0.
  host: '127.0.0.1',
  powerEnabled: true,
  graceSeconds: 30,
  useSudo: false,
  internetCheck: true,
  publicIp: true,
  manageEnabled: true,
  alerts: { enabled: false, webhook: '', rules: {} },
  peers: [],
  tls: { cert: '', key: '' },
};

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
  // Second, read-only credential: sees the dashboard but cannot restart, shut down,
  // control services, or read logs.
  if (!cfg.viewerToken) {
    cfg.viewerToken = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (cfg[k] === undefined) {
      cfg[k] = v;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));

  if (process.env.DASH_PORT) cfg.port = Number(process.env.DASH_PORT);
  if (process.env.DASH_HOST) cfg.host = process.env.DASH_HOST;
  return cfg;
}

const cfg = loadConfig();

configureInternet({ enabled: cfg.internetCheck, publicIp: cfg.publicIp });
alerts.configure(cfg.alerts);
manage.configure({ useSudo: cfg.useSudo });
peers.configure(cfg.peers);

/* ---------------- auth ---------------- */

function constantEquals(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Returns 'admin', 'viewer', or null. Both tokens are always compared so that a
// wrong token takes the same time regardless of which one it nearly matched.
function roleOf(req, url) {
  const given = req.headers['x-dash-token'] || url.searchParams.get('token') || '';
  const isAdmin = constantEquals(given, cfg.token);
  const isViewer = cfg.viewerToken ? constantEquals(given, cfg.viewerToken) : false;
  if (isAdmin) return 'admin';
  if (isViewer) return 'viewer';
  return null;
}

/* ---------------- http helpers ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, 'public', rel);
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
      // The service worker must never be served stale or it pins an old app version.
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

function readBody(req, limit = 16384) {
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

async function jsonBody(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch {
    return null;
  }
}

function audit(action, detail, req) {
  const who = req.socket.remoteAddress || 'unknown';
  console.log(`[audit] ${action} ${detail} from ${who} at ${new Date().toISOString()}`);
}

/* ---------------- cached expensive collectors ---------------- */

function cached(fn, ttl) {
  let value = null;
  let at = 0;
  let inflight = null;
  return async (force = false) => {
    if (!force && value && Date.now() - at < ttl) return value;
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(fn)
      .then((res) => {
        inflight = null;
        value = res;
        at = Date.now();
        return value;
      })
      .catch((err) => {
        inflight = null;
        if (value) return value;
        throw err;
      });
    return inflight;
  };
}

const getSecurity = cached(async () => {
  const stats = await getMetrics();
  return security.collect(stats.ports);
}, 5 * 60_000);

const getSmart = cached(() => storage.smart(), 10 * 60_000);

/* ---------------- routes ---------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  try {
    if (!route.startsWith('/api/')) {
      if (req.method !== 'GET') return res.writeHead(405).end();
      return serveStatic(res, route);
    }

    const role = roleOf(req, url);
    if (!role) return sendJson(res, 401, { error: 'unauthorized', hint: 'Missing or wrong access token.' });

    const requireAdmin = () => {
      if (role === 'admin') return true;
      sendJson(res, 403, { error: 'This token is read-only.' });
      return false;
    };

    /* ----- read-only endpoints ----- */

    if (route === '/api/stats' && req.method === 'GET') {
      const stats = await getMetrics();
      return sendJson(res, 200, {
        ...stats,
        role,
        power: {
          enabled: cfg.powerEnabled,
          graceSeconds: cfg.graceSeconds,
          pending: getPending(),
          error: getLastError(),
        },
        manage: { enabled: cfg.manageEnabled },
        alerts: {
          enabled: alerts.getConfig().enabled,
          configured: !!alerts.getConfig().webhook,
          active: alerts.active(),
          recent: alerts.recent(8),
          rules: alerts.getConfig().rules,
        },
        history: { ...history.stats(), sparklines: history.sparklines() },
      });
    }

    if (route === '/api/history' && req.method === 'GET') {
      const hours = Math.max(0.5, Math.min(24, Number(url.searchParams.get('hours')) || 3));
      return sendJson(res, 200, {
        span: hours * 3600_000,
        samples: history.series(hours * 3600_000),
      });
    }

    if (route === '/api/peers' && req.method === 'GET') {
      return sendJson(res, 200, { peers: await peers.poll() });
    }

    if (route === '/api/smart' && req.method === 'GET') {
      return sendJson(res, 200, { disks: await getSmart() });
    }

    /* ----- admin endpoints ----- */

    if (route === '/api/security' && req.method === 'GET') {
      if (!requireAdmin()) return;
      return sendJson(res, 200, await getSecurity());
    }

    if (route === '/api/logs' && req.method === 'GET') {
      if (!requireAdmin()) return;
      const source = url.searchParams.get('source') || 'system';
      const name = url.searchParams.get('name') || '';
      const lines = url.searchParams.get('lines') || 200;
      try {
        const text = await manage.logs({ source, name, lines });
        return sendJson(res, 200, { source, name, text });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (route === '/api/service' && req.method === 'POST') {
      if (!requireAdmin()) return;
      if (!cfg.manageEnabled) return sendJson(res, 403, { error: 'Management is disabled in config.json.' });
      const body = await jsonBody(req);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      audit('service', `${body.action} ${body.name}`, req);
      try {
        const out = await manage.serviceAction(body.name, body.action);
        return sendJson(res, 200, { ok: true, output: out });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (route === '/api/container' && req.method === 'POST') {
      if (!requireAdmin()) return;
      if (!cfg.manageEnabled) return sendJson(res, 403, { error: 'Management is disabled in config.json.' });
      const body = await jsonBody(req);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      audit('container', `${body.action} ${body.name}`, req);
      try {
        const out =
          body.action === 'pull'
            ? await manage.composePull(body.name)
            : await manage.containerAction(body.name, body.action);
        return sendJson(res, 200, { ok: true, output: out });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (route === '/api/storage/scan' && req.method === 'POST') {
      if (!requireAdmin()) return;
      const body = await jsonBody(req);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      // Only a path the collector already reported as a real mount may be scanned,
      // which keeps arbitrary filesystem walks out of reach.
      const stats = await getMetrics();
      const known = stats.disks.map((d) => d.id);
      if (!known.includes(body.path)) {
        return sendJson(res, 400, { error: 'path must be one of the mounted filesystems', known });
      }
      audit('storage-scan', body.path, req);
      try {
        return sendJson(res, 200, { path: body.path, entries: await storage.usage(body.path) });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (route === '/api/alerts/test' && req.method === 'POST') {
      if (!requireAdmin()) return;
      audit('alert-test', '', req);
      const result = await alerts.test((await getMetrics()).host.name);
      return sendJson(res, 200, { ok: !result.error, result });
    }

    if (route === '/api/power' && req.method === 'POST') {
      if (!requireAdmin()) return;
      if (!cfg.powerEnabled) return sendJson(res, 403, { error: 'Power controls are disabled in config.json.' });
      const body = await jsonBody(req);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      const { action, confirm } = body;
      if (!['restart', 'shutdown', 'cancel'].includes(action)) {
        return sendJson(res, 400, { error: 'action must be restart, shutdown, or cancel' });
      }
      if (action !== 'cancel' && confirm !== true) {
        return sendJson(res, 400, { error: 'confirm:true is required for this action' });
      }
      audit('power', action, req);
      try {
        const result = await powerAction(action, {
          delaySec: cfg.graceSeconds,
          by: req.socket.remoteAddress || 'unknown',
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

function createServer(handler) {
  if (cfg.tls?.cert && cfg.tls?.key) {
    try {
      return https.createServer(
        { cert: fs.readFileSync(cfg.tls.cert), key: fs.readFileSync(cfg.tls.key) },
        handler
      );
    } catch (err) {
      console.error(`TLS is configured but the files could not be read: ${err.message}`);
      console.error('Falling back to plain HTTP.');
    }
  }
  return http.createServer(handler);
}

/* ---------------- startup ---------------- */

const loaded = history.load(DATA_DIR);
history.start(getMetrics, async (stats) => {
  await alerts.check(stats);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    history.stop();
    process.exit(0);
  });
}

const scheme = cfg.tls?.cert && cfg.tls?.key ? 'https' : 'http';

server.listen(cfg.port, cfg.host, () => {
  const shown = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log('');
  console.log('  Server dashboard is up.');
  console.log(`  →  ${scheme}://${shown}:${cfg.port}/?token=${cfg.token}`);
  console.log('');
  console.log(`  bound to      ${cfg.host}:${cfg.port} over ${scheme.toUpperCase()}`);
  console.log(`  power         ${cfg.powerEnabled ? `enabled (${cfg.graceSeconds}s cancellable)` : 'disabled'}`);
  console.log(`  management    ${cfg.manageEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  alerts        ${cfg.alerts?.enabled ? (cfg.alerts.webhook ? 'enabled' : 'enabled but no webhook set') : 'disabled'}`);
  console.log(`  peers         ${cfg.peers?.length || 0}`);
  console.log(`  history       ${loaded} samples restored`);
  console.log(`  read-only URL ${scheme}://${shown}:${cfg.port}/?token=${cfg.viewerToken}`);
  console.log(`  settings      ${CONFIG_PATH}`);
  console.log('');
});
