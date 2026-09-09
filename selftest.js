// Run this on the target machine before trusting the dashboard:
//   node selftest.js
// It prints exactly what the dashboard can and cannot see, and reports whether the
// power controls will work — without ever powering anything down.

import os from 'node:os';
import { execFile } from 'node:child_process';
import { getMetrics, targetPlatform } from './lib/metrics.js';

const GB = (n) => (n / 1e9).toFixed(1) + ' GB';
const pad = (s, n) => String(s).padEnd(n);

function ok(label, detail) {
  console.log(`  \x1b[32m✓\x1b[0m ${pad(label, 22)} ${detail}`);
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

ok('network', `${GB(s.network.totalRx)} in / ${GB(s.network.totalTx)} out since boot`);

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

if (s.degraded.fast || s.degraded.slow) {
  console.log(`\n  \x1b[33mSome collectors returned nothing:\x1b[0m ${JSON.stringify(s.degraded)}`);
}
console.log('');
