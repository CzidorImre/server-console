// Run this on the target machine before trusting the dashboard:
//   node selftest.js
// It prints exactly what the dashboard can and cannot see, and reports whether the
// power controls will work — without ever powering anything down.

import os from 'node:os';
import { execFile } from 'node:child_process';
import { getMetrics, targetPlatform } from './lib/metrics.js';
import * as storage from './lib/storage.js';

const GB = (n) => (n / 1e9).toFixed(1) + ' GB';
const B = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
};
const pad = (s, n) => String(s).padEnd(n);

function ok(label, detail) {
  console.log(`  \x1b[32m✓\x1b[0m ${pad(label, 22)} ${detail}`);
}
function dim(label, detail) {
  console.log(`  \x1b[90m·\x1b[0m ${pad(label, 22)} ${detail}`);
}
function warn(label, detail) {
  console.log(`  \x1b[33m!\x1b[0m ${pad(label, 22)} ${detail}`);
}

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err) => resolve(!err));
  });
}

const s = await getMetrics();

console.log(`\n  ${s.host.name} — ${s.host.os}`);
console.log(`  collector: ${targetPlatform} · node ${process.version}\n`);

console.log('COLLECTION');
ok('cpu', `${s.cpu.total.toFixed(0)}% across ${s.host.cpuCount} cores` +
  (s.cpu.load ? ` · load ${s.cpu.load.map((n) => n.toFixed(2)).join(' ')}` : ''));
ok('memory', `${GB(s.memory.used)} used of ${GB(s.memory.total)} · ${GB(s.memory.free)} available`);

if (s.disks.length) {
  ok('disks', `${s.disks.length} filesystem(s)`);
  for (const d of s.disks) {
    console.log(`      ${pad(d.id, 24)} ${pad(d.fs, 8)} ${pad(GB(d.free) + ' free', 14)} of ${GB(d.size)}`);
  }
} else {
  warn('disks', 'nothing detected — check that df works and is not all pseudo filesystems');
}

if (s.ports.length) {
  const named = s.ports.filter((p) => p.proc).length;
  ok('listening ports', `${s.ports.length} found, ${named} with a process name`);
  if (!named && process.getuid && process.getuid() !== 0) {
    warn('', 'run as root to see which process owns each port');
  }
  for (const p of s.ports.slice(0, 10)) {
    console.log(`      ${pad(p.port, 8)} ${pad(p.proc || '(unknown)', 20)} ${p.addr}`);
  }
  if (s.ports.length > 10) console.log(`      … and ${s.ports.length - 10} more`);
} else {
  warn('listening ports', 'none found — is `ss` installed?');
}

if (s.services.length) ok('services', `${s.services.length} running`);
else warn('services', 'none found — is this a systemd machine?');

if (s.containers.length) ok('containers', `${s.containers.length} running`);
else console.log(`  \x1b[90m·\x1b[0m ${pad('containers', 22)} docker not present or no containers`);

if (s.gpus.length) {
  const g = s.gpus[0];
  if (typeof g.util === 'number') {
    ok('gpu', `${g.name} — ${g.util}%, ${GB(g.memUsed)} of ${GB(g.memTotal)}, ${g.temp}°C`);
  } else {
    warn('gpu', `${g.name} detected, but no live metrics (install nvidia-smi for load)`);
  }
} else {
  console.log(`  \x1b[90m·\x1b[0m ${pad('gpu', 22)} none detected`);
}

if (s.cpu.temp) ok('cpu temperature', `${Math.round(s.cpu.temp)}°C`);
else console.log(`  \x1b[90m·\x1b[0m ${pad('cpu temperature', 22)} no sensor exposed`);

ok('network', `${GB(s.network.totalRx)} in / ${GB(s.network.totalTx)} out since boot`);
ok('disk i/o', `read ${B(s.diskIo.read)}/s · write ${B(s.diskIo.write)}/s right now`);

if (s.internet.enabled === false) {
  console.log(`  \x1b[90m·\x1b[0m ${pad('internet', 22)} checks disabled in config`);
} else if (s.internet.online) {
  ok('internet', `${Math.round(s.internet.latency)} ms via ${s.internet.target}` +
    (s.internet.publicIp ? ` · public IP ${s.internet.publicIp}` : ''));
} else {
  warn('internet', 'no outbound connection');
}

if (s.failed.length) warn('failed units', `${s.failed.length} — see the dashboard`);
else ok('failed units', 'none');

if (s.users.length) ok('sessions', s.users.map((u) => `${u.user}@${u.tty}`).join(', '));

const addr = s.host.addresses[0];
if (addr) ok('address', `${addr.address} (${addr.iface})`);
else warn('address', 'no external IPv4 — reachable on localhost only');

console.log('\nPOWER CONTROLS');
if (process.platform === 'win32') {
  ok('method', 'shutdown.exe — works for any interactive user');
} else {
  const uid = process.getuid ? process.getuid() : -1;
  if (uid === 0) {
    ok('privileges', 'running as root — systemctl reboot/poweroff will work');
  } else if (await sh('sudo', ['-n', 'true'])) {
    ok('privileges', `uid ${uid} has passwordless sudo — set "useSudo": true in config.json`);
  } else {
    warn('privileges', `uid ${uid} is not root and has no passwordless sudo`);
    console.log('      Power buttons will fail. Either run the service as root, or add:');
    console.log(`      ${os.userInfo().username} ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff`);
    console.log('      to /etc/sudoers.d/server-dashboard and set "useSudo": true');
  }
}

/* ---------------- capabilities ---------------- */

console.log('\nMANAGEMENT AND EXTRAS');

const have = (cmd, args = ['--version']) => sh(cmd, args);

if (process.platform === 'win32') {
  ok('service control', 'PowerShell Start/Stop/Restart-Service (dashboard must be elevated)');
  ok('logs', 'Windows event log via Get-WinEvent');
} else {
  const root = process.getuid && process.getuid() === 0;
  if (root) ok('service control', 'systemctl as root');
  else if (await sh('sudo', ['-n', 'true'])) ok('service control', 'via passwordless sudo - set "useSudo": true');
  else warn('service control', 'not root and no passwordless sudo - start/stop will fail');

  if (await have('journalctl')) ok('logs', 'journalctl');
  else warn('logs', 'journalctl not found');

  if (await have('fail2ban-client')) ok('fail2ban', 'installed');
  else dim('fail2ban', 'not installed');

  if (await have('ufw')) ok('firewall', 'ufw present - port exposure can be judged');
  else warn('firewall', 'no ufw - every LAN-reachable port is treated as exposed');

  if (await have('smartctl')) ok('smartctl', 'installed');
  else warn('smartctl', 'not installed - no disk health. apt install smartmontools');

  if (await have('du')) ok('storage scan', 'du available');
  else warn('storage scan', 'du not found');
}

if (await have('docker')) ok('docker', `${s.containers.length} container(s) visible`);
else dim('docker', 'not installed');

const smartDisks = await storage.smart();
if (smartDisks.length) {
  ok('disk health', `${smartDisks.length} device(s)`);
  for (const d of smartDisks) {
    const bits = [d.model];
    if (d.temp) bits.push(`${d.temp}C`);
    if (d.percentUsed != null) bits.push(`${d.percentUsed}% wear`);
    console.log(`      ${d.passed === false ? 'FAILING' : 'ok     '} ${bits.join(' - ')}`);
  }
} else {
  dim('disk health', 'unavailable');
}

console.log('\nHISTORY AND ALERTS');
dim('history', 'kept in data/history.json, 24h at 30s resolution');
dim('alerts', 'configure under "alerts" in config.json, then test from the Alerts tab');

if (s.degraded.fast || s.degraded.slow) {
  console.log(`\n  \x1b[33mSome collectors returned nothing:\x1b[0m ${JSON.stringify(s.degraded)}`);
}
console.log('');
