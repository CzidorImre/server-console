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

/* ---------------- os identity ---------------- */

export function parseOsRelease(txt) {
  if (!txt) return null;
  const m = txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return m ? m[1] : null;
}

/* ---------------- collectors ---------------- */

export async function fast() {
  const [meminfo, dfOut, psOut, netDev] = await Promise.all([
    readFile('/proc/meminfo'),
    sh('df', ['-PB1', '-T']),
    sh('ps', ['-eo', 'pid=,rss=,comm=', '--sort=-rss']),
    readFile('/proc/net/dev'),
  ]);

  return {
    mem: parseMeminfo(meminfo),
    disks: parseDf(dfOut),
    procs: parsePs(psOut),
    net: parseNetDev(netDev),
  };
}

export async function slow() {
  const [osRelease, ssOut, sysctlOut, dockerOut] = await Promise.all([
    readFile('/etc/os-release'),
    sh('ss', ['-lntp']),
    sh('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--no-pager', '--plain']),
    sh('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], 5000),
  ]);

  return {
    sys: { caption: parseOsRelease(osRelease) || 'Linux', version: '' },
    ports: parseSs(ssOut),
    services: parseSystemctl(sysctlOut),
    containers: parseDocker(dockerOut),
    wsl: [],
  };
}
