import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

export const platform = 'linux';

function sh(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout) => {
      // A missing or failing tool degrades that one panel rather than the whole page.
      if (err && !stdout) return resolve(null);
      resolve(stdout);
    });
  });
}

async function readFile(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/* ---------------- memory ---------------- */

// os.freemem() on Linux reports MemFree, which ignores reclaimable page cache and makes
// a healthy server look nearly out of memory. MemAvailable is the number that matters.
export function parseMeminfo(txt) {
  if (!txt) return null;
  const m = {};
  for (const line of txt.split('\n')) {
    const hit = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (hit) m[hit[1]] = Number(hit[2]) * 1024;
  }
  if (!m.MemTotal) return null;
  const available = m.MemAvailable ?? m.MemFree ?? 0;
  return {
    total: m.MemTotal,
    free: available,
    used: m.MemTotal - available,
    cached: (m.Cached ?? 0) + (m.Buffers ?? 0),
    swapTotal: m.SwapTotal ?? 0,
    swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
  };
}

/* ---------------- disks ---------------- */

const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'overlayfs', 'aufs', 'ramfs', 'efivarfs',
  'autofs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'mqueue', 'hugetlbfs',
  'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl',
  'binfmt_misc', 'nsfs', 'rpc_pipefs', 'iso9660', 'none', 'udev',
  '9p', 'drvfs', 'v9fs', 'virtiofs_pseudo',
]);

const SKIP_MOUNT = /^\/(snap|init|proc|sys|dev|run)(\/|$)|^\/var\/lib\/docker\/|^\/usr\/lib\/wsl(\/|$)|^\/mnt\/wsl(\/|$)/;

export function parseDf(txt) {
  if (!txt) return [];
  const out = [];
  for (const line of txt.trim().split('\n').slice(1)) {
    // df -PB1 -T: source, type, 1B-blocks, used, available, capacity%, mount (mount may contain spaces)
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const [source, type, size, used, avail] = parts;
    const mount = parts.slice(6).join(' ');
    if (PSEUDO_FS.has(type) || type.startsWith('fuse.')) continue;
    if (SKIP_MOUNT.test(mount)) continue;
    const total = Number(size);
    if (!Number.isFinite(total) || total <= 0) continue;
    out.push({
      id: mount,
      label: source,
      fs: type,
      size: total,
      free: Number(avail),
      used: Number(used),
    });
  }
  // Largest first, but keep / at the head since it is the one people mean by "the disk".
  return out.sort((a, b) => (a.id === '/' ? -1 : b.id === '/' ? 1 : b.size - a.size));
}

/* ---------------- processes ---------------- */

export function parsePs(txt) {
  if (!txt) return [];
  return txt
    .trim()
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return { pid: Number(m[1]), mem: Number(m[2]) * 1024, name: m[3].trim(), cpu: 0 };
    })
    .filter(Boolean)
    .slice(0, 14);
}

export function parsePsCpu(txt) {
  if (!txt) return [];
  return txt
    .trim()
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
      if (!m) return null;
      return { pid: Number(m[1]), cpu: Number(m[2]), name: m[3].trim(), mem: 0 };
    })
    .filter((p) => p && p.cpu > 0)
    .slice(0, 10);
}

/* ---------------- listening ports ---------------- */

export function parseSs(txt) {
  if (!txt) return [];
  const seen = new Set();
  const out = [];
  for (const line of txt.trim().split('\n')) {
    if (/^State\b/.test(line) || !line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[3];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const port = Number(local.slice(idx + 1));
    if (!Number.isFinite(port)) continue;
    // Strip the %iface suffix ss appends to link-local addresses.
    const addr = local.slice(0, idx).replace(/%.*$/, '') || '*';
    // users:(("nginx",pid=1234,fd=6),...) — only present when we can see the owner.
    const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const proc = owner ? owner[1] : '';
    // Collapse the IPv4/IPv6 pair a single daemon usually reports, but keep genuinely
    // separate listeners on the same port. Unowned rows key on address instead, since
    // without a process name they are otherwise indistinguishable.
    const key = `${port}|${proc || addr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, addr, proc, pid: owner ? Number(owner[2]) : 0 });
  }
  return out.sort((a, b) => a.port - b.port);
}

/* ---------------- services ---------------- */

export function parseSystemctl(txt) {
  if (!txt) return [];
  const out = [];
  for (const line of txt.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().replace(/^\W+\s*/, '').split(/\s+/);
    if (parts.length < 4) continue;
    const unit = parts[0];
    if (!unit.endsWith('.service')) continue;
    out.push({
      name: unit.replace(/\.service$/, ''),
      display: parts.slice(4).join(' ') || unit,
      start: parts[3] || '',
    });
  }
  return out.sort((a, b) => a.display.localeCompare(b.display));
}

/* ---------------- containers ---------------- */

export function parseDocker(txt) {
  if (!txt) return [];
  return txt
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, image, status] = line.split('\t');
      return { name, image, status, up: /^Up\b/.test(status || '') };
    });
}

/* ---------------- network ---------------- */

export function parseNetDev(txt) {
  if (!txt) return [];
  const out = [];
  for (const line of txt.split('\n').slice(2)) {
    const m = line.trim().match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const iface = m[1].trim();
    if (iface === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    out.push({ name: iface, rx: f[0] || 0, tx: f[8] || 0 });
  }
  return out;
}

/* ---------------- gpu ---------------- */

// nvidia-smi is the only broadly reliable source of live GPU load. Without it we still
// report the adapter name from lspci so the panel is not simply empty.
export function parseNvidiaSmi(txt) {
  if (!txt) return [];
  return txt
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(',').map((s) => s.trim());
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        name: f[0] || 'GPU',
        util: num(f[1]),
        memUsed: num(f[2]) !== null ? num(f[2]) * 1024 * 1024 : null,
        memTotal: num(f[3]) !== null ? num(f[3]) * 1024 * 1024 : null,
        temp: num(f[4]),
        power: num(f[5]),
        source: 'nvidia-smi',
      };
    });
}

export function parseLspciVga(txt) {
  if (!txt) return [];
  return txt
    .trim()
    .split('\n')
    .filter((l) => /VGA compatible controller|3D controller|Display controller/i.test(l))
    .map((l) => ({
      name: l.replace(/^\S+\s+(VGA compatible controller|3D controller|Display controller):\s*/i, '').trim(),
      util: null,
      memUsed: null,
      memTotal: null,
      temp: null,
      power: null,
      source: 'lspci',
    }));
}

/* ---------------- cpu frequency and temperature ---------------- */

export function parseCpuMhz(txt) {
  if (!txt) return null;
  const vals = [...txt.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) => Number(m[1]));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// /sys/class/thermal exposes millidegrees. Package/core sensors are the meaningful
// ones; acpitz on many boards reads a chassis probe that is not the CPU.
export function pickTemp(zones) {
  const usable = zones.filter((z) => Number.isFinite(z.temp) && z.temp > 0 && z.temp < 150);
  if (!usable.length) return null;
  const preferred = usable.find((z) => /x86_pkg_temp|coretemp|k10temp|cpu/i.test(z.type));
  return preferred || usable.reduce((a, b) => (b.temp > a.temp ? b : a));
}

async function thermal() {
  const zones = [];
  for (let i = 0; i < 16; i++) {
    const raw = await readFile(`/sys/class/thermal/thermal_zone${i}/temp`);
    if (raw === null) break;
    const type = (await readFile(`/sys/class/thermal/thermal_zone${i}/type`)) || '';
    zones.push({ type: type.trim(), temp: Number(raw.trim()) / 1000 });
  }
  return pickTemp(zones);
}

/* ---------------- disk i/o ---------------- */

// /proc/diskstats counts in 512-byte sectors. Partitions and virtual devices are
// skipped so a read is not counted twice against its parent disk.
const VIRTUAL_BLOCK = /^(loop|ram|zram|dm-|sr|fd)\d*/;

export function parseDiskstats(txt) {
  if (!txt) return { read: 0, written: 0 };
  let read = 0;
  let written = 0;
  for (const line of txt.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    if (VIRTUAL_BLOCK.test(name)) continue;
    // Skip partitions (sda1) when their whole disk (sda) is also present.
    if (/^(sd[a-z]|hd[a-z]|vd[a-z])\d+$/.test(name)) continue;
    if (/^nvme\d+n\d+p\d+$/.test(name)) continue;
    read += Number(f[5]) * 512;
    written += Number(f[9]) * 512;
  }
  return { read, written };
}

/* ---------------- health extras ---------------- */

export function parseFailedUnits(txt) {
  if (!txt) return [];
  return txt
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().replace(/^\W+\s*/, '').split(/\s+/);
      return { name: parts[0], display: parts.slice(4).join(' ') || parts[0] };
    })
    .filter((u) => u.name && u.name.includes('.'));
}

export function parseWho(txt) {
  if (!txt) return [];
  const out = [];
  const seen = new Set();
  for (const line of txt.trim().split('\n').filter(Boolean)) {
    const f = line.trim().split(/\s+/);
    if (!f[0]) continue;
    const from = (line.match(/\(([^)]+)\)\s*$/) || [])[1] || 'local';
    // A user can hold several concurrent sessions from the same host, so the tty is
    // what makes a session distinct — keying on user+origin alone hides them.
    const key = `${f[0]}|${f[1] || ''}|${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ user: f[0], tty: f[1] || '', since: `${f[2] || ''} ${f[3] || ''}`.trim(), from });
  }
  return out;
}

/* ---------------- os identity ---------------- */

export function parseOsRelease(txt) {
  if (!txt) return null;
  const m = txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return m ? m[1] : null;
}

/* ---------------- collectors ---------------- */

const NVIDIA_QUERY =
  'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw';

export async function fast() {
  const [meminfo, dfOut, psOut, psCpuOut, netDev, diskstats, cpuinfo, temp] = await Promise.all([
    readFile('/proc/meminfo'),
    sh('df', ['-PB1', '-T']),
    sh('ps', ['-eo', 'pid=,rss=,comm=', '--sort=-rss']),
    sh('ps', ['-eo', 'pid=,pcpu=,comm=', '--sort=-pcpu']),
    readFile('/proc/net/dev'),
    readFile('/proc/diskstats'),
    readFile('/proc/cpuinfo'),
    thermal(),
  ]);

  return {
    mem: parseMeminfo(meminfo),
    disks: parseDf(dfOut),
    procs: parsePs(psOut),
    procsCpu: parsePsCpu(psCpuOut),
    net: parseNetDev(netDev),
    diskIo: parseDiskstats(diskstats),
    cpuMhz: parseCpuMhz(cpuinfo),
    cpuTemp: temp,
  };
}

export async function slow() {
  const [osRelease, ssOut, sysctlOut, dockerOut, nvidia, lspci, failed, who] = await Promise.all([
    readFile('/etc/os-release'),
    sh('ss', ['-lntp']),
    sh('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--no-pager', '--plain']),
    sh('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], 5000),
    sh('nvidia-smi', [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'], 5000),
    sh('lspci', [], 5000),
    sh('systemctl', ['list-units', '--state=failed', '--no-legend', '--no-pager', '--plain']),
    sh('who', []),
  ]);

  const gpus = parseNvidiaSmi(nvidia);

  return {
    sys: { caption: parseOsRelease(osRelease) || 'Linux', version: '' },
    ports: parseSs(ssOut),
    services: parseSystemctl(sysctlOut),
    containers: parseDocker(dockerOut),
    gpus: gpus.length ? gpus : parseLspciVga(lspci),
    failed: parseFailedUnits(failed),
    users: parseWho(who),
    wsl: [],
  };
}
