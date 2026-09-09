import fs from 'node:fs';
import path from 'node:path';

// A fixed-size ring buffer persisted as one compact JSON file. Deliberately not a
// database: the server runs on Node 22 where node:sqlite is still flag-gated, and a
// day of samples is a few hundred KB.
const SAMPLE_MS = 30_000;
const MAX_SAMPLES = 2880; // 24h at 30s
const FLUSH_MS = 60_000;

const FIELDS = ['cpu', 'mem', 'diskPct', 'netRx', 'netTx', 'gpu', 'cpuTemp', 'gpuTemp', 'ioRead', 'ioWrite'];

let samples = [];
let file = null;
let dirty = false;
let timers = [];

function round(n, dp = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function load(dataDir) {
  file = path.join(dataDir, 'history.json');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw?.samples)) {
      samples = raw.samples.slice(-MAX_SAMPLES);
    }
  } catch {
    samples = [];
  }
  return samples.length;
}

export function flush() {
  if (!file || !dirty) return;
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, samples }));
    fs.renameSync(tmp, file); // atomic: a crash mid-write cannot truncate the history
    dirty = false;
  } catch (err) {
    console.error(`[history] could not persist: ${err.message}`);
  }
}

// Reduce a full stats object to the handful of numbers worth keeping over time.
export function record(stats) {
  const root =
    stats.disks.find((d) => d.id === '/' || /^C:/i.test(d.id)) || stats.disks[0];
  const gpu = stats.gpus?.[0];

  samples.push({
    t: Date.now(),
    cpu: round(stats.cpu.total),
    mem: round(stats.memory.total ? (stats.memory.used / stats.memory.total) * 100 : null),
    diskPct: root && root.size ? round(((root.size - root.free) / root.size) * 100) : null,
    netRx: round(stats.network.rx, 0),
    netTx: round(stats.network.tx, 0),
    gpu: round(gpu?.util ?? null),
    cpuTemp: round(stats.cpu.temp ?? null),
    gpuTemp: round(gpu?.temp ?? null),
    ioRead: round(stats.diskIo?.read ?? null, 0),
    ioWrite: round(stats.diskIo?.write ?? null, 0),
  });

  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
  dirty = true;
  return samples[samples.length - 1];
}

export function series(sinceMs) {
  const cutoff = Date.now() - sinceMs;
  return samples.filter((s) => s.t >= cutoff);
}

// Downsampled arrays for the tile sparklines: cheap to compute, cheap to send.
export function sparklines(sinceMs = 3 * 3600_000, points = 60) {
  const rows = series(sinceMs);
  const out = { points: 0, span: sinceMs };
  for (const f of FIELDS) out[f] = [];
  if (!rows.length) return out;

  const bucket = Math.max(1, Math.ceil(rows.length / points));
  for (let i = 0; i < rows.length; i += bucket) {
    const chunk = rows.slice(i, i + bucket);
    for (const f of FIELDS) {
      const vals = chunk.map((r) => r[f]).filter((v) => typeof v === 'number');
      out[f].push(vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : null);
    }
    out.points++;
  }
  return out;
}

export function stats() {
  if (!samples.length) return { samples: 0, oldest: null, span: 0 };
  return {
    samples: samples.length,
    oldest: samples[0].t,
    span: Date.now() - samples[0].t,
  };
}

export function start(getStats, onSample) {
  const tick = async () => {
    try {
      const s = await getStats();
      const sample = record(s);
      if (onSample) await onSample(s, sample);
    } catch (err) {
      console.error(`[history] sample failed: ${err.message}`);
    }
  };
  tick();
  timers.push(setInterval(tick, SAMPLE_MS));
  timers.push(setInterval(flush, FLUSH_MS));
  for (const t of timers) if (t.unref) t.unref();
}

export function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  flush();
}
