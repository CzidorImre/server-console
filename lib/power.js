import { execFile } from 'node:child_process';

const isWindows = process.platform === 'win32';

// The action name from a request is only ever a key into this table. Nothing the
// caller sends is ever interpolated into a command line.
const WINDOWS_FLAG = { restart: '/r', shutdown: '/s', cancel: '/a' };
const LINUX_VERB = { restart: 'reboot', shutdown: 'poweroff' };

let pending = null; // { action, at, deadline, by }
let timer = null; // linux only: the in-process grace timer
let lastError = null; // surfaced to the UI when a countdown ends in a failure

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || '').trim();
        return reject(new Error(msg || `${cmd} failed`));
      }
      resolve((stdout || '').trim());
    });
  });
}

export function getPending() {
  if (pending && !timer && Date.now() > pending.deadline + 120000) pending = null;
  return pending;
}

export function getLastError() {
  return lastError;
}

/* ---------------- windows ---------------- */
// shutdown.exe owns the countdown, so it survives this process dying. Cancelling
// means asking it to abort.

async function windowsAction(action, delay) {
  if (action === 'cancel') {
    try {
      await run('shutdown', [WINDOWS_FLAG.cancel]);
    } catch (err) {
      // 1116 = "no shutdown was in progress" — already cancelled, not a failure.
      if (!/1116/.test(err.message)) throw err;
    }
    pending = null;
    return;
  }
  const label = action === 'restart' ? 'Restart' : 'Shutdown';
  await run('shutdown', [
    WINDOWS_FLAG[action],
    '/t',
    String(delay),
    '/c',
    `${label} requested from the server dashboard.`,
  ]);
}

/* ---------------- linux ---------------- */
// systemd's shutdown only takes whole minutes, so the grace period is held here
// instead. That also makes it fail safe: if the dashboard dies mid-countdown,
// the machine stays up.

function linuxCommand(action, useSudo) {
  const verb = LINUX_VERB[action];
  return useSudo
    ? { cmd: 'sudo', args: ['-n', 'systemctl', verb] }
    : { cmd: 'systemctl', args: [verb] };
}

async function linuxAction(action, delay, useSudo) {
  if (action === 'cancel') {
    clearTimeout(timer);
    timer = null;
    pending = null;
    return;
  }

  const { cmd, args } = linuxCommand(action, useSudo);

  // Check permission with a command that cannot power anything down. Never probe by
  // running the reboot command itself.
  if (useSudo) {
    try {
      await run('sudo', ['-n', 'true'], 8000);
    } catch (err) {
      throw new Error(
        `Passwordless sudo is not available to this user, so it cannot ${action} the machine ` +
          `(${err.message}). See "Permissions" in the README.`
      );
    }
  }

  lastError = null;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    run(cmd, args).catch((err) => {
      lastError = `${action} failed: ${err.message}`;
      console.error(`[power] ${lastError}`);
      pending = null;
    });
  }, delay * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

/* ---------------- public ---------------- */

export async function powerAction(action, { delaySec = 30, by = 'dashboard', useSudo = false } = {}) {
  if (!['restart', 'shutdown', 'cancel'].includes(action)) {
    throw new Error(`unknown action: ${action}`);
  }

  const delay = Math.max(0, Math.min(600, Math.floor(delaySec)));

  if (isWindows) await windowsAction(action, delay);
  else await linuxAction(action, delay, useSudo);

  if (action === 'cancel') {
    lastError = null;
    return { ok: true, action, pending: null };
  }

  pending = { action, at: Date.now(), deadline: Date.now() + delay * 1000, by };
  return { ok: true, action, pending };
}
