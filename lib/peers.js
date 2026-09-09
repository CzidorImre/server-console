// Multi-host view: this instance fetches /api/stats from other dashboards and shows
// them alongside its own. Peers are read-only here — power and management actions
// still have to be performed against the peer's own URL, so one compromised token
// cannot reach across machines.

let peers = [];
const cache = new Map(); // url -> { at, ok, stats, error }
const TTL = 5000;

export function configure(list = []) {
  peers = (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.url === 'string' && /^https?:\/\//i.test(p.url))
    .map((p) => ({ name: p.name || new URL(p.url).host, url: p.url.replace(/\/+$/, ''), token: p.token || '' }));
  return peers;
}

export function list() {
  return peers.map((p) => ({ name: p.name, url: p.url }));
}

async function fetchPeer(peer) {
  const hit = cache.get(peer.url);
  if (hit && Date.now() - hit.at < TTL) return hit;

  let entry;
  try {
    const res = await fetch(`${peer.url}/api/stats`, {
      headers: { 'x-dash-token': peer.token },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'token rejected' : `HTTP ${res.status}`);
    const stats = await res.json();
    entry = { at: Date.now(), ok: true, stats, error: null };
  } catch (err) {
    entry = { at: Date.now(), ok: false, stats: null, error: err.message };
  }
  cache.set(peer.url, entry);
  return entry;
}

// Only the handful of fields the overview strip renders — pulling a peer's full
// payload into ours would multiply the response size for no benefit.
function summarize(name, url, entry) {
  if (!entry.ok) return { name, url, ok: false, error: entry.error };
  const s = entry.stats;
  const root = s.disks?.find((d) => d.id === '/' || /^C:/i.test(d.id)) || s.disks?.[0];
  return {
    name,
    url,
    ok: true,
    host: s.host?.name,
    os: s.host?.os,
    uptime: s.host?.uptime,
    cpu: s.cpu?.total ?? null,
    memPct: s.memory?.total ? (s.memory.used / s.memory.total) * 100 : null,
    diskPct: root && root.size ? ((root.size - root.free) / root.size) * 100 : null,
    diskFree: root?.free ?? null,
    gpu: s.gpus?.[0] ? { util: s.gpus[0].util, temp: s.gpus[0].temp, name: s.gpus[0].name } : null,
    containers: (s.containers || []).length,
    failed: (s.failed || []).length,
    alerts: (s.alerts?.active || []).length,
  };
}

export async function poll() {
  if (!peers.length) return [];
  return Promise.all(peers.map(async (p) => summarize(p.name, p.url, await fetchPeer(p))));
}
