import { execFile } from 'node:child_process';

const isWindows = process.platform === 'win32';

// Everything here runs commands, so nothing from a request is ever interpolated into
// a shell string: actions are keys into fixed tables, and names must match a strict
// pattern before they are passed as a single argv element.
const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart']);
const CONTAINER_ACTIONS = new Set(['start', 'stop', 'restart']);

const SERVICE_NAME = /^[A-Za-z0-9_.@-]{1,128}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;

let useSudo = false;
export function configure(opts = {}) {
  useSudo = !!opts.useSudo;
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message).trim().slice(0, 500)));
        resolve((stdout || '').trim());
      });
  });
}

function sudoWrap(cmd, args) {
  return useSudo && !isWindows ? { cmd: 'sudo', args: ['-n', cmd, ...args] } : { cmd, args };
}

/* ---------------- services ---------------- */

export async function serviceAction(name, action) {
  if (!SERVICE_ACTIONS.has(action)) throw new Error(`invalid action: ${action}`);
  if (!SERVICE_NAME.test(name)) throw new Error('invalid service name');

  // Refuse to stop ourselves: the request would kill the process answering it.
  if (/server-dashboard/i.test(name) && action !== 'restart') {
    throw new Error('refusing to act on the dashboard\'s own service');
  }

  if (isWindows) {
    const verb = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' }[action];
    return run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${verb} -Name '${name.replace(/'/g, "''")}' -ErrorAction Stop`,
    ]);
  }
  const { cmd, args } = sudoWrap('systemctl', [action, name]);
  return run(cmd, args);
}

/* ---------------- containers ---------------- */

export async function containerAction(name, action) {
  if (!CONTAINER_ACTIONS.has(action)) throw new Error(`invalid action: ${action}`);
  if (!CONTAINER_NAME.test(name)) throw new Error('invalid container name');
  const { cmd, args } = sudoWrap('docker', [action, name]);
  return run(cmd, args);
}

/* ---------------- logs ---------------- */

export async function logs({ source, name, lines = 200 }) {
  const n = Math.max(10, Math.min(1000, Number(lines) || 200));

  if (source === 'container') {
    if (!CONTAINER_NAME.test(name)) throw new Error('invalid container name');
    const { cmd, args } = sudoWrap('docker', ['logs', '--tail', String(n), name]);
    return run(cmd, args, 20000);
  }

  if (source === 'unit') {
    if (!SERVICE_NAME.test(name)) throw new Error('invalid unit name');
    if (isWindows) {
      // Windows has no journal; the closest equivalent is that service's event log rows.
      const safe = name.replace(/'/g, "''");
      return run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-WinEvent -FilterHashtable @{LogName='System'} -MaxEvents 400 -ErrorAction SilentlyContinue |` +
          ` Where-Object { $_.Message -like '*${safe}*' } | Select-Object -First ${n} |` +
          ` ForEach-Object { "{0:yyyy-MM-dd HH:mm:ss}  {1}  {2}" -f $_.TimeCreated, $_.LevelDisplayName, $_.Message }`,
      ], 25000);
    }
    const { cmd, args } = sudoWrap('journalctl', ['-u', name, '-n', String(n), '--no-pager', '--output=short-iso']);
    return run(cmd, args, 20000);
  }

  if (source === 'system') {
    if (isWindows) {
      return run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-WinEvent -FilterHashtable @{LogName='System'} -MaxEvents ${n} -ErrorAction SilentlyContinue |` +
          ` ForEach-Object { "{0:yyyy-MM-dd HH:mm:ss}  {1}  {2}" -f $_.TimeCreated, $_.LevelDisplayName, $_.Message }`,
      ], 25000);
    }
    const { cmd, args } = sudoWrap('journalctl', ['-n', String(n), '--no-pager', '--output=short-iso']);
    return run(cmd, args, 20000);
  }

  throw new Error('source must be unit, container, or system');
}

/* ---------------- compose pull ---------------- */

export async function composePull(name) {
  if (!CONTAINER_NAME.test(name)) throw new Error('invalid container name');
  // Find the compose project + working dir from the container's own labels, so this
  // works without the dashboard knowing where any compose file lives.
  const inspect = await run('docker', [
    'inspect', name,
    '--format', '{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
  ]);
  const [project, dir] = inspect.split('\t').map((s) => s.trim());
  if (!project || !dir) throw new Error(`${name} is not managed by docker compose`);

  const pull = await run('docker', ['compose', '--project-directory', dir, 'pull'], 300000);
  const up = await run('docker', ['compose', '--project-directory', dir, 'up', '-d'], 300000);
  return `${pull}\n${up}`.trim();
}
