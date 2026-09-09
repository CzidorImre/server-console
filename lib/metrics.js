import os from 'node:os';
import { probe as internetProbe } from './internet.js';

const isWindows = process.platform === 'win32';
const collector = isWindows
  ? await import('./collect-win.js')
  : await import('./collect-linux.js');

export const targetPlatform = collector.platform;

const FAST_TTL = 1500;
const SLOW_TTL = 10000;

// One in-flight collection per source, results reused until the TTL expires.
function cached(fn, ttl) {
  let value = null;
  let at = 0;
  let inflight = null;
  return async function get() {
    if (value && Date.now() - at < ttl) return value;
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(fn)
      .then((res) => {
        inflight = null;
        if (res) {
          value = res;
          at = Date.now();
        }
        return value;
      })
      .catch(() => {
        inflight = null;
        return value;
      });
    return inflight;
  };
}

const getFast = cached(collector.fast, FAST_TTL);
const getSlow = cached(collector.slow, SLOW_TTL);

/* ---------------- cpu ---------------- */

function cpuSnapshot() {
  return os.cpus().map((c) => {
    const t = c.times;
    return { total: t.user + t.nice + t.sys + t.idle + t.irq, idle: t.idle };
  });
}

let prevCpu = cpuSnapshot();
let prevCpuAt = Date.now();

function cpuUsage() {
  const now = cpuSnapshot();
  const cores = now.map((c, i) => {
    const p = prevCpu[i];
    if (!p) return 0;
    const dTotal = c.total - p.total;
    const dIdle = c.idle - p.idle;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
  });
  // Only advance the baseline once the window is wide enough to be meaningful.
  if (Date.now() - prevCpuAt > 400) {
    prevCpu = now;
    prevCpuAt = Date.now();
  }
  const avg = cores.length ? cores.reduce((a, b) => a + b, 0) / cores.length : 0;
  return { total: avg, cores, load: isWindows ? null : os.loadavg() };
}

/* ---------------- network ---------------- */

let prevNet = null;

function netRates(adapters) {
  const rx = adapters.reduce((a, n) => a + (n.rx || 0), 0);
  const tx = adapters.reduce((a, n) => a + (n.tx || 0), 0);
  const now = Date.now();
  let rates = { rx: 0, tx: 0 };
  if (prevNet) {
    const dt = (now - prevNet.at) / 1000;
    if (dt > 0.2) {
      rates = {
        rx: Math.max(0, (rx - prevNet.rx) / dt),
        tx: Math.max(0, (tx - prevNet.tx) / dt),
      };
      prevNet = { rx, tx, at: now };
    } else {
      rates = prevNet.rates || rates;
    }
  } else {
    prevNet = { rx, tx, at: now };
  }
  prevNet.rates = rates;
  return { ...rates, totalRx: rx, totalTx: tx };
}

/* ---------------- disk i/o ---------------- */

let prevIo = null;

// Linux exposes cumulative byte counters, Windows exposes per-second rates already.
function diskIoRates(io) {
  if (!io) return { read: 0, write: 0 };
  if (typeof io.readRate === 'number') return { read: io.readRate, write: io.writeRate };

  const now = Date.now();
  let rates = { read: 0, write: 0 };
  if (prevIo) {
    const dt = (now - prevIo.at) / 1000;
    if (dt > 0.2) {
      rates = {
        read: Math.max(0, (io.read - prevIo.read) / dt),
        write: Math.max(0, (io.written - prevIo.written) / dt),
      };
      prevIo = { read: io.read, written: io.written, at: now, rates };
    } else {
      rates = prevIo.rates || rates;
    }
  } else {
    prevIo = { read: io.read, written: io.written, at: now, rates };
  }
  return rates;
}

/* ---------------- internet ---------------- */

let internetCfg = { enabled: true, publicIp: true };

export function configureInternet(cfg) {
  internetCfg = { ...internetCfg, ...cfg };
}

// Probed on a long cycle: it leaves the machine, so it should not run every poll.
const getInternet = cached(
  () => internetProbe(internetCfg.enabled, internetCfg.publicIp),
  60000
);

/* ---------------- addresses ---------------- */

// Virtual switches (WSL, Hyper-V, Docker, VirtualBox) hand out IPv4 addresses that
// look real but are useless for reaching the box, so they sort last.
const VIRTUAL_IFACE = /vethernet|hyper-v|wsl|docker|br-|veth|virbr|virtualbox|vmware|tailscale|zerotier/i;

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ iface: name, address: a.address, virtual: VIRTUAL_IFACE.test(name) });
      }
    }
  }
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

/* ---------------- memory ---------------- */

function memory(fromCollector) {
  if (fromCollector) return fromCollector;
  const total = os.totalmem();
  const free = os.freemem();
  return { total, free, used: total - free, cached: 0, swapTotal: 0, swapUsed: 0 };
}

/* ---------------- public ---------------- */

export async function getMetrics() {
  const [fast, slow, internet] = await Promise.all([getFast(), getSlow(), getInternet()]);

  return {
    time: Date.now(),
    host: {
      name: os.hostname(),
      os: slow?.sys?.caption || `${os.type()} ${os.release()}`,
      version: slow?.sys?.version || os.release(),
      platform: process.platform,
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model?.trim() || 'unknown',
      cpuCount: os.cpus().length,
      uptime: os.uptime(),
      addresses: lanAddresses(),
      node: process.version,
    },
    cpu: { ...cpuUsage(), mhz: fast?.cpuMhz ?? null, temp: fast?.cpuTemp ?? null },
    memory: memory(fast?.mem),
    disks: fast?.disks || [],
    diskIo: diskIoRates(fast?.diskIo),
    processes: fast?.procs || [],
    processesByCpu: fast?.procsCpu || [],
    // Linux ps gives live %CPU; Windows Get-Process gives cumulative CPU seconds.
    processesByCpuUnit: isWindows ? 'seconds' : 'percent',
    services: slow?.services || [],
    failed: slow?.failed || [],
    ports: slow?.ports || [],
    gpus: slow?.gpus || [],
    users: slow?.users || [],
    containers: slow?.containers || [],
    wsl: slow?.wsl || [],
    network: netRates(fast?.net || []),
    internet: internet || { enabled: false, online: null, latency: null, publicIp: null },
    degraded: { fast: !fast, slow: !slow },
  };
}
