import net from 'node:net';

// Reachability is measured with a plain TCP connect rather than ICMP: no ping binary,
// no raw-socket privileges, and it works the same on both platforms.
const TARGETS = [
  { host: '1.1.1.1', port: 443, label: 'Cloudflare' },
  { host: '8.8.8.8', port: 443, label: 'Google' },
];

const PUBLIC_IP_URL = 'https://api.ipify.org';

function tcpPing(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const sock = new net.Socket();
    let settled = false;
    const finish = (ms) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ms);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(Number(process.hrtime.bigint() - started) / 1e6));
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
    sock.connect(port, host);
  });
}

async function publicIp() {
  try {
    const res = await fetch(PUBLIC_IP_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^[0-9a-f.:]+$/i.test(text) ? text : null;
  } catch {
    return null;
  }
}

// `enabled` is driven by config.json. When it is false nothing leaves the machine.
export async function probe(enabled, wantPublicIp) {
  if (!enabled) return { enabled: false, online: null, latency: null, target: null, publicIp: null };

  for (const t of TARGETS) {
    const ms = await tcpPing(t.host, t.port);
    if (ms !== null) {
      return {
        enabled: true,
        online: true,
        latency: ms,
        target: `${t.label} (${t.host})`,
        publicIp: wantPublicIp ? await publicIp() : null,
      };
    }
  }
  return { enabled: true, online: false, latency: null, target: null, publicIp: null };
}
