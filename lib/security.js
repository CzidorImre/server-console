import { execFile } from 'node:child_process';

const isWindows = process.platform === 'win32';

// PowerShell writes in the console codepage unless told otherwise.
const PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';

function sh(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout },
      (err, stdout) => resolve(err && !stdout ? null : stdout));
  });
}

/* ---------------- failed logins ---------------- */

// journalctl is preferred over /var/log/auth.log: it works on systems where rsyslog
// is not installed, which is now the Debian/Ubuntu default.
export function parseSshFailures(txt) {
  if (!txt) return { total: 0, recent: [], topIps: [] };
  const entries = [];
  const ipCount = new Map();

  for (const line of txt.split('\n')) {
    const m = line.match(/Failed (?:password|publickey) for (?:invalid user )?(\S+) from (\S+)/);
    if (!m) continue;
    const [, user, ip] = m;
    const when = (line.match(/^(\S+)/) || [])[1] || '';
    entries.push({ user, ip, when });
    ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  }

  const topIps = [...ipCount.entries()]
    .map(([ip, count]) => ({ ip, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return { total: entries.length, recent: entries.slice(-12).reverse(), topIps };
}

/* ---------------- fail2ban ---------------- */

export function parseFail2banJails(txt) {
  if (!txt) return [];
  const m = txt.match(/Jail list:\s*(.*)/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseFail2banStatus(txt, jail) {
  if (!txt) return null;
  const num = (re) => {
    const hit = txt.match(re);
    return hit ? Number(hit[1]) : 0;
  };
  const banned = (txt.match(/Banned IP list:\s*(.*)/) || [])[1] || '';
  return {
    jail,
    currentlyFailed: num(/Currently failed:\s*(\d+)/),
    totalFailed: num(/Total failed:\s*(\d+)/),
    currentlyBanned: num(/Currently banned:\s*(\d+)/),
    totalBanned: num(/Total banned:\s*(\d+)/),
    bannedIps: banned.split(/\s+/).filter(Boolean).slice(0, 20),
  };
}

/* ---------------- pending updates ---------------- */

export function parseAptUpgradable(txt) {
  if (txt === null || txt === undefined) return { total: 0, security: 0, packages: [], supported: false };
  const packages = [];
  let security = 0;
  for (const line of txt.split('\n')) {
    if (!line.includes('/') || line.startsWith('Listing')) continue;
    const name = line.split('/')[0].trim();
    if (!name) continue;
    const isSecurity = /-security/i.test(line);
    if (isSecurity) security++;
    packages.push({ name, security: isSecurity });
  }
  return { total: packages.length, security, packages: packages.slice(0, 50), supported: true };
}

// Windows Update via the COM API; returns a count only.
export function parseWindowsUpdates(txt) {
  // A failed COM query and a genuinely up-to-date machine both come back empty, and
  // reporting "0 updates" for a failed check is a lie. null means "could not tell".
  if (txt === null || txt === undefined) return { total: 0, security: 0, packages: [], supported: false };
  if (!txt.trim()) return { total: 0, security: 0, packages: [], supported: true };
  const lines = txt.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    total: lines.length,
    security: lines.filter((l) => /security|critical/i.test(l)).length,
    packages: lines.slice(0, 50).map((name) => ({ name, security: /security|critical/i.test(name) })),
    supported: true,
  };
}

/* ---------------- firewall exposure ---------------- */

export function parseUfw(txt) {
  if (!txt) return null;
  if (!/Status:\s*active/i.test(txt)) return { active: false, allowed: [] };
  const allowed = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^(\d+)(?:\/(tcp|udp))?\s+ALLOW/i);
    if (m) allowed.push({ port: Number(m[1]), proto: m[2] || 'any' });
  }
  return { active: true, allowed };
}

// A port is "exposed" when it listens on all interfaces AND the firewall lets it
// through (or there is no firewall at all). Loopback-only ports are never exposed.
export function classifyExposure(ports, firewall) {
  const wildcard = (a) => a === '0.0.0.0' || a === '::' || a === '*' || a === '';
  const loopback = (a) => /^127\./.test(a) || a === '::1';

  return ports.map((p) => {
    let reach = 'local';
    if (loopback(p.addr)) reach = 'local';
    else if (wildcard(p.addr) || p.addr) reach = 'lan';

    let exposed = false;
    if (reach === 'lan') {
      if (!firewall || !firewall.active) exposed = true;
      else exposed = firewall.allowed.some((a) => a.port === p.port);
    }
    return { ...p, reach, exposed };
  });
}

/* ---------------- collection ---------------- */

export async function collect(ports) {
  if (isWindows) {
    const [updates, fw] = await Promise.all([
      sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        PREFIX + "try { (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search('IsInstalled=0').Updates | ForEach-Object { $_.Title } } catch { '' }"], 30000),
      sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-NetFirewallProfile | Where-Object { $_.Enabled } | Select-Object -First 1 -ExpandProperty Name"]),
    ]);
    const firewall = fw && fw.trim() ? { active: true, allowed: [] } : { active: false, allowed: [] };
    return {
      platform: 'win32',
      logins: { total: 0, recent: [], topIps: [], supported: false },
      fail2ban: null,
      updates: parseWindowsUpdates(updates),
      firewall,
      // With no per-rule detail from the Windows firewall, exposure is not asserted.
      exposure: classifyExposure(ports, null).map((p) => ({ ...p, exposed: false })),
    };
  }

  const [auth, jailsRaw, aptRaw, ufwRaw] = await Promise.all([
    sh('journalctl', ['-u', 'ssh', '-u', 'sshd', '--since', '-7d', '--no-pager', '--output=short-iso'], 15000),
    sh('fail2ban-client', ['status'], 8000),
    sh('apt', ['list', '--upgradable'], 20000),
    sh('ufw', ['status'], 8000),
  ]);

  const jails = parseFail2banJails(jailsRaw);
  const jailStatuses = [];
  for (const j of jails.slice(0, 6)) {
    const raw = await sh('fail2ban-client', ['status', j], 8000);
    const parsed = parseFail2banStatus(raw, j);
    if (parsed) jailStatuses.push(parsed);
  }

  const firewall = parseUfw(ufwRaw);

  return {
    platform: 'linux',
    logins: { ...parseSshFailures(auth), supported: auth !== null },
    fail2ban: jails.length ? { jails: jailStatuses } : null,
    updates: parseAptUpgradable(aptRaw),
    firewall,
    exposure: classifyExposure(ports, firewall),
  };
}
