import { execFile } from 'node:child_process';

const isWindows = process.platform === 'win32';

// PowerShell writes in the console codepage unless told otherwise; without this,
// non-ASCII device and path names come back as mojibake.
const PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';

function sh(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout },
      (err, stdout) => resolve(err && !stdout ? null : stdout));
  });
}

/* ---------------- SMART health ---------------- */

export function parseSmartctlScan(txt) {
  if (!txt) return [];
  return txt
    .split('\n')
    .map((l) => (l.match(/^(\S+)/) || [])[1])
    .filter((d) => d && d.startsWith('/dev/'));
}

export function parseSmartctl(json, device) {
  if (!json) return null;
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  const temp = d.temperature?.current ?? null;
  const hours = d.power_on_time?.hours ?? null;

  // NVMe and ATA report wear differently; surface whichever exists.
  const nvme = d.nvme_smart_health_information_log;
  const attrs = d.ata_smart_attributes?.table || [];
  const attr = (id) => attrs.find((a) => a.id === id)?.raw?.value ?? null;

  return {
    device,
    model: d.model_name || d.model_family || 'unknown',
    serial: d.serial_number ? `…${String(d.serial_number).slice(-4)}` : null,
    passed: d.smart_status?.passed ?? null,
    temp,
    hours,
    percentUsed: nvme?.percentage_used ?? null,
    reallocated: attr(5),
    pending: attr(197),
    mediaErrors: nvme?.media_errors ?? null,
    capacity: d.user_capacity?.bytes ?? null,
  };
}

export async function smart() {
  if (isWindows) {
    // No smartctl by default; Get-PhysicalDisk gives a coarse health verdict.
    const raw = await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      PREFIX + "Get-PhysicalDisk | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.FriendlyName, $_.HealthStatus, $_.Size, $_.MediaType }"]);
    if (!raw) return [];
    return raw.trim().split('\n').filter(Boolean).map((line) => {
      const [model, health, size, media] = line.trim().split('|');
      return {
        device: media || 'disk',
        model,
        passed: /healthy/i.test(health),
        temp: null, hours: null, percentUsed: null,
        reallocated: null, pending: null, mediaErrors: null,
        capacity: Number(size) || null,
        serial: null,
      };
    });
  }

  const scan = await sh('smartctl', ['--scan'], 10000);
  const devices = parseSmartctlScan(scan);
  const out = [];
  for (const dev of devices.slice(0, 8)) {
    const json = await sh('smartctl', ['-a', '-j', dev], 15000);
    const parsed = parseSmartctl(json, dev);
    if (parsed) out.push(parsed);
  }
  return out;
}

/* ---------------- per-device I/O ---------------- */

const VIRTUAL_BLOCK = /^(loop|ram|zram|dm-|sr|fd)\d*/;

export function parseDiskstatsPerDevice(txt) {
  if (!txt) return [];
  const out = [];
  for (const line of txt.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    if (VIRTUAL_BLOCK.test(name)) continue;
    if (/^(sd[a-z]|hd[a-z]|vd[a-z])\d+$/.test(name)) continue;
    if (/^nvme\d+n\d+p\d+$/.test(name)) continue;
    out.push({ name, read: Number(f[5]) * 512, written: Number(f[9]) * 512 });
  }
  return out;
}

/* ---------------- directory usage ---------------- */

export function parseDu(txt, root) {
  if (!txt) return [];
  return txt
    .trim()
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) return null;
      return { size: Number(m[1]), path: m[2].trim() };
    })
    .filter((e) => e && e.path !== root)
    .sort((a, b) => b.size - a.size)
    .slice(0, 25);
}

// Deliberately on-demand only: walking a filesystem is far too expensive to poll.
// The path is validated by the caller and passed as a single argv element.
export async function usage(root) {
  const TIMEOUT = 150000;
  let raw;

  if (isWindows) {
    // No Windows equivalent of `du` exists, so each top-level directory has to be
    // summed by walking it. That is slow on a large system drive; the caller is
    // warned, and a timeout is reported rather than being shown as "empty".
    const safe = root.replace(/'/g, "''");
    raw = await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      PREFIX + `Get-ChildItem -LiteralPath '${safe}' -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {` +
      ` $s = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |` +
      ` Measure-Object -Property Length -Sum).Sum; '{0} {1}' -f [int64]$s, $_.FullName }`], TIMEOUT);
  } else {
    // -x stays on one filesystem so a scan of / does not wander into every mount.
    raw = await sh('du', ['-xbd', '1', root], TIMEOUT);
  }

  if (raw === null) {
    throw new Error(
      `Scanning ${root} timed out after ${TIMEOUT / 1000}s or was not permitted.` +
        (isWindows ? ' Windows has no fast du equivalent, so large drives may not finish.' : '')
    );
  }
  return parseDu(raw, root);
}
