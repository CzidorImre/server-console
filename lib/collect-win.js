import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const platform = 'win32';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function runCollector(script) {
  return new Promise((resolve) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, script)],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export async function fast() {
  const raw = await runCollector('collect-fast.ps1');
  return {
    mem: null, // os.totalmem/freemem are accurate on Windows
    disks: asArray(raw?.disks),
    procs: asArray(raw?.procs),
    procsCpu: asArray(raw?.procsCpu),
    net: asArray(raw?.net),
    // Windows reports per-second rates directly, so no delta is needed here.
    diskIo: raw?.diskIo || null,
    cpuMhz: raw?.cpuMhz ?? null,
    cpuTemp: raw?.cpuTemp ?? null,
  };
}

export async function slow() {
  const raw = await runCollector('collect-slow.ps1');
  return {
    sys: raw?.sys || null,
    ports: asArray(raw?.ports),
    services: asArray(raw?.services),
    failed: asArray(raw?.failed),
    gpus: asArray(raw?.gpus),
    users: asArray(raw?.users),
    containers: [],
    wsl: asArray(raw?.wsl),
  };
}
