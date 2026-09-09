// Threshold alerting. Rules are evaluated against each history sample; a rule that
// enters a bad state fires once, then stays quiet until it recovers (or the cooldown
// expires), so a full disk does not produce a message every 30 seconds.

const DEFAULT_RULES = {
  diskPercent: 90,
  memPercent: 92,
  cpuPercent: 95, // sustained, see SUSTAIN_SAMPLES
  cpuTemp: 85,
  gpuTemp: 85,
  failedUnits: true,
  containersExited: true,
  offline: true,
};

const COOLDOWN_MS = 30 * 60_000;
const SUSTAIN_SAMPLES = 4; // ~2 minutes at the 30s sample rate

let cfg = { enabled: false, webhook: '', rules: { ...DEFAULT_RULES } };
let state = new Map(); // key -> { firing, since, lastSent }
let log = []; // recent alert activity, surfaced in the UI
let cpuStreak = 0;

export function configure(next = {}) {
  cfg = {
    enabled: !!next.enabled,
    webhook: next.webhook || '',
    rules: { ...DEFAULT_RULES, ...(next.rules || {}) },
  };
  return cfg;
}

export function getConfig() {
  return cfg;
}

export function recent(limit = 20) {
  return log.slice(-limit).reverse();
}

export function active() {
  return [...state.entries()]
    .filter(([, v]) => v.firing)
    .map(([key, v]) => ({ key, since: v.since, message: v.message, level: v.level }));
}

/* ---------------- delivery ---------------- */

// Shape the payload for whichever service the webhook URL points at.
export function buildPayload(url, alert, host) {
  const title = `${alert.level === 'critical' ? '🔴' : '⚠️'} ${host}: ${alert.title}`;
  const body = alert.message;

  if (/discord\.com\/api\/webhooks/i.test(url)) {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}` }) };
  }
  if (/hooks\.slack\.com/i.test(url)) {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `*${title}*\n${body}` }) };
  }
  if (/ntfy\./i.test(url) || /\/ntfy\//i.test(url)) {
    return {
      headers: {
        'content-type': 'text/plain',
        title,
        priority: alert.level === 'critical' ? 'high' : 'default',
      },
      body,
    };
  }
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, level: alert.level, title: alert.title, message: body, time: Date.now() }),
  };
}

async function send(alert, host) {
  log.push({ ...alert, host, time: Date.now(), delivered: false });
  if (log.length > 100) log = log.slice(-100);
  const entry = log[log.length - 1];

  if (!cfg.enabled || !cfg.webhook) return;
  try {
    const { headers, body } = buildPayload(cfg.webhook, alert, host);
    const res = await fetch(cfg.webhook, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(8000),
    });
    entry.delivered = res.ok;
    if (!res.ok) entry.error = `webhook returned ${res.status}`;
  } catch (err) {
    entry.error = err.message;
  }
}

export async function test(host) {
  const alert = {
    key: 'test',
    level: 'info',
    title: 'Test notification',
    message: 'If you can read this, alerting is wired up correctly.',
  };
  await send(alert, host);
  return log[log.length - 1];
}

/* ---------------- evaluation ---------------- */

async function evaluate(key, firing, alert, host) {
  const prev = state.get(key) || { firing: false, since: 0, lastSent: 0 };

  if (firing) {
    const isNew = !prev.firing;
    const stale = Date.now() - prev.lastSent > COOLDOWN_MS;
    state.set(key, {
      firing: true,
      since: prev.firing ? prev.since : Date.now(),
      lastSent: isNew || stale ? Date.now() : prev.lastSent,
      message: alert.message,
      level: alert.level,
      title: prev.firing ? prev.title : alert.title,
    });
    if (isNew || stale) await send({ ...alert, key }, host);
  } else if (prev.firing) {
    state.set(key, { firing: false, since: 0, lastSent: prev.lastSent });
    // Name the alert that was firing, not the healthy value that ended it:
    // "Resolved: Disk / at 20%" reads like a fresh problem.
    await send(
      {
        key: `${key}:resolved`,
        level: 'info',
        title: `Resolved: ${prev.title || alert.title}`,
        message: `${alert.message} (was firing for ${humanSince(prev.since)})`,
      },
      host
    );
  }
}

export async function check(stats) {
  if (!cfg.enabled) return;
  const host = stats.host.name;
  const r = cfg.rules;

  for (const d of stats.disks) {
    if (!d.size) continue;
    const pct = ((d.size - d.free) / d.size) * 100;
    await evaluate(
      `disk:${d.id}`,
      r.diskPercent > 0 && pct >= r.diskPercent,
      {
        level: pct >= 97 ? 'critical' : 'warning',
        title: `Disk ${d.id} at ${pct.toFixed(0)}%`,
        message: `${d.id} has ${fmtBytes(d.free)} free of ${fmtBytes(d.size)}.`,
      },
      host
    );
  }

  const memPct = stats.memory.total ? (stats.memory.used / stats.memory.total) * 100 : 0;
  await evaluate(
    'memory',
    r.memPercent > 0 && memPct >= r.memPercent,
    {
      level: 'warning',
      title: `Memory at ${memPct.toFixed(0)}%`,
      message: `${fmtBytes(stats.memory.free)} still available.`,
    },
    host
  );

  // CPU has to stay pinned for a few samples: a single spike is not an incident.
  cpuStreak = stats.cpu.total >= r.cpuPercent ? cpuStreak + 1 : 0;
  await evaluate(
    'cpu',
    r.cpuPercent > 0 && cpuStreak >= SUSTAIN_SAMPLES,
    {
      level: 'warning',
      title: `CPU pinned at ${stats.cpu.total.toFixed(0)}%`,
      message: `Sustained for over ${(SUSTAIN_SAMPLES * 30) / 60} minutes.`,
    },
    host
  );

  if (typeof stats.cpu.temp === 'number') {
    await evaluate(
      'cputemp',
      r.cpuTemp > 0 && stats.cpu.temp >= r.cpuTemp,
      {
        level: 'critical',
        title: `CPU at ${Math.round(stats.cpu.temp)}°C`,
        message: `Threshold is ${r.cpuTemp}°C.`,
      },
      host
    );
  }

  const gpu = stats.gpus?.[0];
  if (gpu && typeof gpu.temp === 'number') {
    await evaluate(
      'gputemp',
      r.gpuTemp > 0 && gpu.temp >= r.gpuTemp,
      { level: 'critical', title: `GPU at ${Math.round(gpu.temp)}°C`, message: `${gpu.name}.` },
      host
    );
  }

  await evaluate(
    'failed',
    !!r.failedUnits && stats.failed.length > 0,
    {
      level: 'warning',
      title: `${stats.failed.length} failed unit(s)`,
      message: stats.failed.map((f) => f.name).join(', '),
    },
    host
  );

  const dead = (stats.containers || []).filter((c) => !c.up);
  await evaluate(
    'containers',
    !!r.containersExited && dead.length > 0,
    {
      level: 'warning',
      title: `${dead.length} container(s) not running`,
      message: dead.map((c) => c.name).join(', '),
    },
    host
  );

  if (stats.internet?.enabled) {
    await evaluate(
      'offline',
      !!r.offline && stats.internet.online === false,
      { level: 'warning', title: 'No internet connectivity', message: 'Outbound TCP checks are failing.' },
      host
    );
  }
}

function humanSince(since) {
  if (!since) return 'a moment';
  const m = Math.round((Date.now() - since) / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} minute(s)`;
  return `${Math.round(m / 60)} hour(s)`;
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}
