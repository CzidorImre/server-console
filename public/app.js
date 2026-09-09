'use strict';

const $ = (id) => document.getElementById(id);
const KEY = 'server-dashboard-token';
const TAB_KEY = 'server-dashboard-tab';

let token = '';
let role = 'admin';
let pollTimer = null;
let countdownTimer = null;
let logTimer = null;
let pending = null;
let lastOk = 0;
let currentTab = 'overview';
let mountPaths = [];

/* ---------------- formatting ---------------- */

function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + units[i];
}

const rate = (n) => (Number.isFinite(n) ? bytes(n) + '/s' : '—');

function duration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const level = (pct) => (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '');

function setBar(el, pct) {
  el.style.width = Math.max(0, Math.min(100, pct)) + '%';
  el.className = 'fill ' + level(pct);
}

function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

/* ---------------- sparklines ---------------- */

// Drawn as a tiny inline SVG path rather than a chart library: one polyline per tile,
// scaled to its own range so a flat-but-nonzero series still reads as flat.
function sparkline(el, values, opts = {}) {
  const pts = (values || []).filter((v) => typeof v === 'number');
  if (pts.length < 2) {
    el.innerHTML = '';
    return;
  }
  const W = 100;
  const H = 24;
  const max = opts.max ?? Math.max(...pts, opts.floor ?? 0);
  const min = opts.min ?? Math.min(...pts, 0);
  const span = max - min || 1;
  const step = W / (pts.length - 1);

  const coords = pts.map((v, i) => [i * step, H - ((v - min) / span) * H]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;

  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="spark-area" d="${area}"/>` +
    `<path class="spark-line" d="${line}"/>` +
    `</svg>`;
}

/* ---------------- api ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'x-dash-token': token, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.unauthorized = true;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

/* ---------------- overview rendering ---------------- */

function renderHost(h) {
  $('hostname').textContent = h.name;
  $('osline').textContent = `${h.os} · ${h.arch} · Node ${h.node}`;
  $('uptime').textContent = duration(h.uptime);
  const addr = h.addresses[0];
  $('address').textContent = addr ? addr.address : 'local only';
  $('address').title = addr ? addr.iface : 'no external IPv4 address';
  $('cpu-model').textContent = `${h.cpuCount} threads`;
  $('cpu-model').title = h.cpuModel;
  $('power-host').textContent = h.name;
}

function renderCpu(cpu) {
  $('cpu-pct').textContent = cpu.total.toFixed(0);
  setBar($('cpu-bar'), cpu.total);

  const host = $('cores');
  if (host.children.length !== cpu.cores.length) {
    host.innerHTML = cpu.cores.map(() => '<div class="core"></div>').join('');
  }
  cpu.cores.forEach((v, i) => {
    const el = host.children[i];
    el.style.setProperty('--h', Math.max(4, v).toFixed(0) + '%');
    el.title = `core ${i}: ${v.toFixed(0)}%`;
  });

  const bits = [];
  if (cpu.load) bits.push('load ' + cpu.load.map((n) => n.toFixed(2)).join(' '));
  if (cpu.mhz) bits.push((cpu.mhz / 1000).toFixed(2) + ' GHz');
  if (cpu.temp) bits.push(Math.round(cpu.temp) + '°C');
  $('cpu-foot').hidden = bits.length === 0;
  $('cpu-foot').textContent = bits.join(' · ');
}

function renderMemory(m) {
  const pct = m.total ? (m.used / m.total) * 100 : 0;
  $('mem-pct').textContent = pct.toFixed(0);
  setBar($('mem-bar'), pct);
  $('mem-sub').textContent = bytes(m.total) + ' total';
  let foot = `${bytes(m.used)} used · ${bytes(m.free)} available`;
  if (m.cached) foot += ` · ${bytes(m.cached)} cached`;
  if (m.swapTotal) foot += ` · swap ${bytes(m.swapUsed)}/${bytes(m.swapTotal)}`;
  $('mem-foot').textContent = foot;
}

function renderDisks(disks, io) {
  $('drives-count').textContent = disks.length ? `${disks.length} mounted` : '';

  const primary =
    disks.find((d) => /^C:/i.test(d.id)) || disks.find((d) => d.id === '/') || disks[0];
  if (primary) {
    const usedPct = primary.size ? ((primary.size - primary.free) / primary.size) * 100 : 0;
    $('disk-free').textContent = bytes(primary.free);
    setBar($('disk-bar'), usedPct);
    $('disk-sub').textContent = primary.id === '/' ? 'root filesystem' : `${primary.id} system drive`;
    let foot = `${usedPct.toFixed(0)}% used of ${bytes(primary.size)}`;
    if (io && (io.read || io.write)) foot += ` · r ${rate(io.read)} · w ${rate(io.write)}`;
    $('disk-foot').textContent = foot;
  }

  $('drives').innerHTML = disks.length
    ? disks
        .map((d) => {
          const used = d.size - d.free;
          const pct = d.size ? (used / d.size) * 100 : 0;
          return `
            <div class="drive">
              <div class="dhead">
                <span class="dname">${esc(d.id)}</span>
                <span class="dlabel">${esc(d.label || d.fs || '')}</span>
              </div>
              <div class="bar"><div class="fill ${level(pct)}" style="width:${pct.toFixed(1)}%"></div></div>
              <div class="dnums">
                <span><b>${bytes(d.free)}</b> free</span>
                <span>${bytes(used)} / ${bytes(d.size)}</span>
              </div>
            </div>`;
        })
        .join('')
    : '<p class="empty">No fixed drives reported.</p>';

  // Keep the storage-scan picker in sync with what is actually mounted.
  const ids = disks.map((d) => d.id);
  if (ids.join('|') !== mountPaths.join('|')) {
    mountPaths = ids;
    $('scan-path').innerHTML = ids.map((id) => `<option>${esc(id)}</option>`).join('');
  }
}

function renderGpu(gpus) {
  const tile = $('gpu-tile');
  if (!gpus.length) {
    tile.hidden = true;
    return;
  }
  tile.hidden = false;
  const g = gpus[0];
  $('gpu-name').textContent = gpus.length > 1 ? `${g.name} +${gpus.length - 1}` : g.name;
  $('gpu-name').title = gpus.map((x) => x.name).join('\n');

  if (typeof g.util === 'number') {
    $('gpu-pct').textContent = g.util.toFixed(0);
    $('gpu-unit').hidden = false;
    setBar($('gpu-bar'), g.util);
    $('gpu-bar').parentElement.hidden = false;
  } else {
    $('gpu-pct').textContent = 'present';
    $('gpu-unit').hidden = true;
    $('gpu-bar').parentElement.hidden = true;
  }

  const bits = [];
  if (g.memTotal) bits.push(`${bytes(g.memUsed)} / ${bytes(g.memTotal)}`);
  if (g.temp) bits.push(Math.round(g.temp) + '°C');
  if (g.power) bits.push(g.power.toFixed(0) + ' W');
  if (!bits.length) bits.push('no live metrics — install nvidia-smi for load');
  $('gpu-foot').textContent = bits.join(' · ');
}

function renderNet(n) {
  $('net-rx').innerHTML = `↓ ${rate(n.rx)}`;
  $('net-foot').textContent =
    `↑ ${rate(n.tx)} · ${bytes(n.totalRx)} in / ${bytes(n.totalTx)} out since boot`;
}

function renderInternet(n) {
  if (!n || n.enabled === false) {
    $('inet-latency').textContent = 'off';
    $('inet-target').textContent = 'checks disabled';
    $('inet-foot').textContent = 'set internetCheck: true in config.json';
    return;
  }
  if (n.online) {
    $('inet-latency').innerHTML = `${Math.round(n.latency)}<i> ms</i>`;
    $('inet-target').textContent = 'reachable';
    $('inet-foot').textContent = n.publicIp ? `public IP ${n.publicIp} · via ${n.target}` : `via ${n.target}`;
  } else {
    $('inet-latency').textContent = 'offline';
    $('inet-target').textContent = 'unreachable';
    $('inet-foot').textContent = 'no outbound connection';
  }
}

function renderAttention(failed) {
  const card = $('attention-card');
  if (!failed.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('attention-count').textContent = `${failed.length} not running`;
  $('attention').innerHTML = failed
    .map(
      (f) => `
        <div class="row">
          <div class="l"><span class="name">${esc(f.display || f.name)}</span></div>
          <span class="r">${esc(f.detail || f.name)}</span>
        </div>`
    )
    .join('');
}

function renderPorts(ports) {
  $('ports-count').textContent = ports.length ? `${ports.length} TCP ports` : '';
  $('ports').innerHTML = ports.length
    ? ports
        .map(
          (p) => `
        <div class="row">
          <div class="l">
            <span class="pill">${esc(p.port)}</span>
            <span class="name">${esc(p.proc || 'unknown')}</span>
          </div>
          <span class="r">${esc(p.addr)}</span>
        </div>`
        )
        .join('')
    : '<p class="empty">Nothing listening.</p>';
}

function renderProcs(procs) {
  $('procs').innerHTML = procs.length
    ? procs
        .map(
          (p) => `
        <div class="row">
          <div class="l">
            <span class="pill plain">${esc(p.pid)}</span>
            <span class="name">${esc(p.name)}</span>
          </div>
          <span class="r">${bytes(p.mem)}</span>
        </div>`
        )
        .join('')
    : '<p class="empty">No process data.</p>';
}

function formatSeconds(s) {
  if (s < 60) return s.toFixed(0) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
}

function renderCpuProcs(list, unit) {
  const seconds = unit === 'seconds';
  $('cpuprocs-sub').textContent = seconds ? 'total CPU time used' : 'live % of one core';
  const fmt = (v) => (seconds ? formatSeconds(v) : v.toFixed(1) + '%');

  $('cpuprocs').innerHTML = list.length
    ? list
        .map(
          (p) => `
        <div class="row">
          <div class="l">
            <span class="pill plain">${esc(p.pid)}</span>
            <span class="name">${esc(p.name)}</span>
          </div>
          <span class="r">${fmt(p.cpu)}</span>
        </div>`
        )
        .join('')
    : '<p class="empty">No CPU activity to report.</p>';
}

function renderUsers(list) {
  $('users-count').textContent = list.length ? `${list.length} session(s)` : '';
  $('users').innerHTML = list.length
    ? list
        .map(
          (u) => `
        <div class="row">
          <div class="l">
            <span class="pill plain">${esc(u.tty || '—')}</span>
            <span class="name">${esc(u.user)}</span>
          </div>
          <span class="r">${esc(u.from || '')} ${esc(u.since || '')}</span>
        </div>`
        )
        .join('')
    : '<p class="empty">Nobody logged in interactively.</p>';
}

function renderWsl(list) {
  const card = $('wsl-card');
  if (!list.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('wsl').innerHTML = list
    .map((w) => {
      const on = /running/i.test(w.state);
      return `
        <div class="row">
          <div class="l"><span class="name">${esc(w.name)}</span></div>
          <span class="pill ${on ? 'on' : 'off'}">${esc(w.state)}</span>
        </div>`;
    })
    .join('');
}

/* ---------------- services and containers ---------------- */

let allServices = [];

function renderServices(list) {
  allServices = list;
  paintServices();
}

function paintServices() {
  const q = $('svc-filter').value.trim().toLowerCase();
  const shown = q
    ? allServices.filter((s) => s.display.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    : allServices;

  const admin = role === 'admin';
  $('services').innerHTML = shown.length
    ? shown
        .map(
          (s) => `
        <div class="row">
          <div class="l"><span class="name">${esc(s.display || s.name)}</span></div>
          <div class="ractions">
            <span class="r">${esc(s.name)}</span>
            ${admin ? `
              <button class="mini" data-svc="${esc(s.name)}" data-act="restart" title="Restart">↻</button>
              <button class="mini" data-svc="${esc(s.name)}" data-act="stop" title="Stop">■</button>
              <button class="mini" data-log-unit="${esc(s.name)}" title="Logs">≡</button>` : ''}
          </div>
        </div>`
        )
        .join('')
    : '<p class="empty">No services match.</p>';
}

function renderContainers(list) {
  $('containers-count').textContent = list.length ? `${list.length} running` : 'none';
  const admin = role === 'admin';
  $('containers').innerHTML = list.length
    ? list
        .map(
          (c) => `
        <div class="row">
          <div class="l">
            <span class="pill ${c.up ? 'on' : 'off'}">${c.up ? 'up' : 'down'}</span>
            <span class="name">${esc(c.name)}</span>
          </div>
          <div class="ractions">
            <span class="r">${esc(c.image)}</span>
            ${admin ? `
              <button class="mini" data-ctr="${esc(c.name)}" data-act="restart" title="Restart">↻</button>
              <button class="mini" data-ctr="${esc(c.name)}" data-act="stop" title="Stop">■</button>
              <button class="mini" data-ctr="${esc(c.name)}" data-act="pull" title="Pull newer image and recreate">⇩</button>
              <button class="mini" data-log-ctr="${esc(c.name)}" title="Logs">≡</button>` : ''}
          </div>
        </div>`
        )
        .join('')
    : '<p class="empty">No containers. Docker may not be installed.</p>';
}

/* ---------------- peers ---------------- */

function renderPeers(list) {
  const host = $('peers');
  if (!list.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = list
    .map((p) => {
      if (!p.ok) {
        return `<a class="peer bad" href="${esc(p.url)}" target="_blank" rel="noreferrer">
          <strong>${esc(p.name)}</strong><span>unreachable — ${esc(p.error)}</span></a>`;
      }
      const flags = [];
      if (p.alerts) flags.push(`${p.alerts} alert(s)`);
      if (p.failed) flags.push(`${p.failed} failed`);
      return `<a class="peer" href="${esc(p.url)}" target="_blank" rel="noreferrer">
        <strong>${esc(p.host || p.name)}</strong>
        <span>cpu ${p.cpu != null ? p.cpu.toFixed(0) + '%' : '—'} · mem ${p.memPct != null ? p.memPct.toFixed(0) + '%' : '—'} · ${bytes(p.diskFree)} free</span>
        <span class="peer-flags">${flags.length ? esc(flags.join(' · ')) : 'healthy'}</span>
      </a>`;
    })
    .join('');
}

/* ---------------- security ---------------- */

function renderSecurity(s) {
  if (s.updates.supported === false) {
    $('upd-count').textContent = '?';
    $('upd-foot').textContent = 'update check unavailable on this machine';
  } else {
    $('upd-count').textContent = s.updates.total;
    $('upd-foot').textContent = s.updates.security
      ? `${s.updates.security} security update(s)`
      : s.updates.total
        ? 'none flagged as security'
        : 'up to date';
  }
  $('upd-sub').textContent = s.platform === 'linux' ? 'apt' : 'Windows Update';

  if (s.logins.supported) {
    $('login-count').textContent = s.logins.total;
    $('login-foot').textContent = s.logins.topIps.length
      ? `${s.logins.topIps.length} distinct source(s)`
      : 'no failed attempts';
  } else {
    $('login-count').textContent = 'n/a';
    $('login-foot').textContent = 'no SSH log available on this platform';
  }

  const fw = s.firewall;
  $('fw-state').textContent = fw ? (fw.active ? 'on' : 'off') : '—';
  $('fw-sub').textContent = s.platform === 'linux' ? 'ufw' : 'Windows Firewall';
  $('fw-foot').textContent = fw && fw.active
    ? fw.allowed.length ? `${fw.allowed.length} port rule(s)` : 'active'
    : 'no firewall detected — every listening port is reachable';

  const f2b = s.fail2ban;
  $('f2b-tile').hidden = !f2b;
  if (f2b) {
    const banned = f2b.jails.reduce((a, j) => a + j.currentlyBanned, 0);
    $('f2b-banned').textContent = banned;
    $('f2b-sub').textContent = `${f2b.jails.length} jail(s)`;
    $('f2b-foot').textContent = f2b.jails.map((j) => `${j.jail}: ${j.totalBanned} total`).join(' · ');
  }

  $('exposure').innerHTML = s.exposure.length
    ? s.exposure
        .map((p) => {
          const cls = p.exposed ? 'bad' : p.reach === 'local' ? 'off' : 'on';
          const label = p.exposed ? 'reachable' : p.reach === 'local' ? 'localhost' : 'blocked';
          return `
            <div class="row">
              <div class="l">
                <span class="pill">${esc(p.port)}</span>
                <span class="name">${esc(p.proc || 'unknown')}</span>
              </div>
              <div class="ractions">
                <span class="r">${esc(p.addr)}</span>
                <span class="pill ${cls}">${label}</span>
              </div>
            </div>`;
        })
        .join('')
    : '<p class="empty">No listening ports.</p>';

  $('top-ips').innerHTML = s.logins.topIps.length
    ? s.logins.topIps
        .map(
          (i) => `
        <div class="row">
          <div class="l"><span class="name mono">${esc(i.ip)}</span></div>
          <span class="r">${i.count} attempts</span>
        </div>`
        )
        .join('')
    : '<p class="empty">Nothing to show.</p>';

  $('recent-logins').innerHTML = s.logins.recent.length
    ? s.logins.recent
        .map(
          (l) => `
        <div class="row">
          <div class="l"><span class="name">${esc(l.user)}</span></div>
          <span class="r mono">${esc(l.ip)}</span>
        </div>`
        )
        .join('')
    : '<p class="empty">No failed logins recorded.</p>';

  $('pkg-sub').textContent = s.updates.packages.length ? `showing ${s.updates.packages.length}` : '';
  $('packages').innerHTML = s.updates.packages.length
    ? s.updates.packages
        .map(
          (p) => `
        <div class="row">
          <div class="l"><span class="name">${esc(p.name)}</span></div>
          ${p.security ? '<span class="pill bad">security</span>' : '<span class="r"></span>'}
        </div>`
        )
        .join('')
    : '<p class="empty">Nothing to upgrade.</p>';
}

/* ---------------- storage ---------------- */

function renderSmart(disks) {
  $('smart-sub').textContent = disks.length ? `${disks.length} device(s)` : 'not available';
  $('smart').innerHTML = disks.length
    ? disks
        .map((d) => {
          const bits = [];
          if (d.capacity) bits.push(bytes(d.capacity));
          if (d.temp) bits.push(`${d.temp}°C`);
          if (d.hours) bits.push(`${Math.round(d.hours / 24)}d powered on`);
          if (d.percentUsed != null) bits.push(`${d.percentUsed}% wear`);
          if (d.reallocated) bits.push(`${d.reallocated} reallocated`);
          if (d.mediaErrors) bits.push(`${d.mediaErrors} media errors`);
          const ok = d.passed !== false;
          return `
            <div class="row">
              <div class="l">
                <span class="pill ${ok ? 'on' : 'bad'}">${ok ? 'ok' : 'FAIL'}</span>
                <span class="name">${esc(d.model)} <span class="dim">${esc(d.device)}</span></span>
              </div>
              <span class="r">${esc(bits.join(' · '))}</span>
            </div>`;
        })
        .join('')
    : '<p class="empty">SMART data unavailable. On Linux install <code>smartmontools</code>.</p>';
}

function renderScan(path, entries) {
  $('scan-result').innerHTML = entries.length
    ? entries
        .map((e) => {
          const max = entries[0].size || 1;
          const pct = (e.size / max) * 100;
          return `
            <div class="scanrow">
              <div class="scanbar" style="width:${pct.toFixed(1)}%"></div>
              <span class="name">${esc(e.path)}</span>
              <span class="r">${bytes(e.size)}</span>
            </div>`;
        })
        .join('')
    : `<p class="empty">Nothing measurable under ${esc(path)}.</p>`;
}

/* ---------------- alerts ---------------- */

function renderAlerts(a) {
  $('alert-state').textContent = !a.enabled
    ? 'disabled'
    : a.configured
      ? 'enabled'
      : 'enabled, but no webhook configured';

  $('alert-rules').innerHTML = Object.entries(a.rules || {})
    .map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, ' $1').toLowerCase();
      const val = typeof v === 'boolean' ? (v ? 'on' : 'off') : k.includes('Temp') ? `${v}°C` : `${v}%`;
      return `
        <div class="row">
          <div class="l"><span class="name">${esc(label)}</span></div>
          <span class="r">${esc(val)}</span>
        </div>`;
    })
    .join('');

  $('alert-log').innerHTML = a.recent.length
    ? a.recent
        .map(
          (l) => `
        <div class="row">
          <div class="l">
            <span class="pill ${l.level === 'critical' ? 'bad' : l.level === 'info' ? 'off' : 'warn'}">${esc(l.level)}</span>
            <span class="name">${esc(l.title)}</span>
          </div>
          <span class="r">${ago(l.time)}${l.error ? ' · ' + esc(l.error) : l.delivered ? ' · sent' : ''}</span>
        </div>`
        )
        .join('')
    : '<p class="empty">Nothing has fired yet.</p>';

  const strip = $('alert-strip');
  if (a.active.length) {
    strip.hidden = false;
    strip.innerHTML = a.active
      .map((x) => `<span class="chip ${x.level === 'critical' ? 'bad' : ''}">${esc(x.message || x.key)}</span>`)
      .join('');
  } else {
    strip.hidden = true;
  }
}

/* ---------------- actions ---------------- */

async function serviceAction(name, action) {
  try {
    await api('/api/service', { method: 'POST', body: JSON.stringify({ name, action }) });
    toast(`${action} ${name}: done`);
    tick();
  } catch (err) {
    if (err.unauthorized) return gate(true);
    toast(`${action} ${name} failed: ${err.message}`, true);
  }
}

async function containerAction(name, action) {
  toast(action === 'pull' ? `Pulling ${name}… this can take a while` : `${action} ${name}…`);
  try {
    await api('/api/container', { method: 'POST', body: JSON.stringify({ name, action }) });
    toast(`${action} ${name}: done`);
    tick();
  } catch (err) {
    if (err.unauthorized) return gate(true);
    toast(`${action} ${name} failed: ${err.message}`, true);
  }
}

async function fetchLogs() {
  const source = $('log-source').value;
  const name = $('log-name').value.trim();
  const lines = $('log-lines').value;
  if (source !== 'system' && !name) {
    $('log-output').textContent = 'Enter a name first.';
    return;
  }
  try {
    const q = new URLSearchParams({ source, name, lines });
    const res = await api('/api/logs?' + q.toString());
    $('log-output').textContent = res.text || '(no output)';
    $('log-output').scrollTop = $('log-output').scrollHeight;
  } catch (err) {
    if (err.unauthorized) return gate(true);
    $('log-output').textContent = `Could not read logs: ${err.message}`;
  }
}

function openLogs(source, name) {
  showTab('logs');
  $('log-source').value = source;
  $('log-name').hidden = false;
  $('log-name').value = name;
  fetchLogs();
}

async function runScan() {
  const path = $('scan-path').value;
  if (!path) return;
  $('scan-result').innerHTML = '<p class="empty">Scanning… this can take a minute on a large disk.</p>';
  try {
    const res = await api('/api/storage/scan', { method: 'POST', body: JSON.stringify({ path }) });
    renderScan(res.path, res.entries);
  } catch (err) {
    if (err.unauthorized) return gate(true);
    $('scan-result').innerHTML = `<p class="empty">Scan failed: ${esc(err.message)}</p>`;
  }
}

/* ---------------- power ---------------- */

function showPending(p) {
  pending = p;
  const banner = $('pending-banner');
  if (!p) {
    banner.hidden = true;
    clearInterval(countdownTimer);
    countdownTimer = null;
    return;
  }
  banner.hidden = false;
  $('pending-title').textContent = p.action === 'restart' ? 'Restart scheduled' : 'Shutdown scheduled';

  const tickDown = () => {
    const left = Math.max(0, Math.round((p.deadline - Date.now()) / 1000));
    $('pending-sub').textContent = left > 0 ? `in ${left}s — you can still cancel` : 'going down now…';
  };
  tickDown();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tickDown, 500);
}

function confirmThen(title, body, onYes) {
  $('modal-title').textContent = title;
  $('modal-body').textContent = body;
  $('modal').hidden = false;
  const close = () => {
    $('modal').hidden = true;
    $('modal-ok').onclick = null;
    $('modal-cancel').onclick = null;
  };
  $('modal-cancel').onclick = close;
  $('modal-ok').onclick = () => {
    close();
    onYes();
  };
}

async function power(action, confirmFlag) {
  try {
    const res = await api('/api/power', { method: 'POST', body: JSON.stringify({ action, confirm: confirmFlag }) });
    showPending(res.pending);
  } catch (err) {
    if (err.unauthorized) return gate(true);
    toast(`Could not ${action}: ${err.message}`, true);
  }
}

/* ---------------- tabs ---------------- */

function showTab(name) {
  currentTab = name;
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {}
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => {
    p.hidden = p.dataset.pane !== name;
  });
  if (name === 'security') loadSecurity();
  if (name === 'storage') loadSmart();
}

let securityLoaded = 0;
async function loadSecurity(force) {
  if (role !== 'admin') return;
  if (!force && Date.now() - securityLoaded < 60_000) return;
  securityLoaded = Date.now();
  try {
    renderSecurity(await api('/api/security'));
  } catch (err) {
    if (err.unauthorized) gate(true);
  }
}

let smartLoaded = 0;
async function loadSmart(force) {
  if (!force && Date.now() - smartLoaded < 5 * 60_000) return;
  smartLoaded = Date.now();
  try {
    renderSmart((await api('/api/smart')).disks);
  } catch (err) {
    if (err.unauthorized) gate(true);
  }
}

let peersLoaded = 0;
async function loadPeers() {
  if (Date.now() - peersLoaded < 10_000) return;
  peersLoaded = Date.now();
  try {
    renderPeers((await api('/api/peers')).peers);
  } catch {
    /* peers are optional */
  }
}

/* ---------------- polling ---------------- */

async function tick() {
  try {
    const s = await api('/api/stats');
    lastOk = Date.now();
    $('live-dot').className = 'dot';

    if (s.role !== role) {
      role = s.role;
      applyRole();
    }

    renderHost(s.host);
    renderCpu(s.cpu);
    renderMemory(s.memory);
    renderDisks(s.disks, s.diskIo);
    renderNet(s.network);
    renderGpu(s.gpus || []);
    renderInternet(s.internet);
    renderAttention(s.failed || []);
    renderPorts(s.ports);
    renderProcs(s.processes);
    renderCpuProcs(s.processesByCpu || [], s.processesByCpuUnit);
    renderUsers(s.users || []);
    renderContainers(s.containers || []);
    renderWsl(s.wsl);
    renderServices(s.services);
    renderAlerts(s.alerts);

    const sp = s.history?.sparklines;
    if (sp) {
      sparkline($('spark-cpu'), sp.cpu, { min: 0, max: 100 });
      sparkline($('spark-mem'), sp.mem, { min: 0, max: 100 });
      sparkline($('spark-diskPct'), sp.diskPct, { min: 0, max: 100 });
      sparkline($('spark-netRx'), sp.netRx, { min: 0 });
      sparkline($('spark-gpu'), sp.gpu, { min: 0, max: 100 });
    }
    $('hist-note').textContent = s.history?.samples
      ? `${s.history.samples} samples over ${duration(s.history.span / 1000)}`
      : 'building history…';

    const errEl = $('power-error');
    errEl.hidden = !s.power.error;
    if (s.power.error) errEl.textContent = s.power.error;

    $('power-sub').textContent = s.power.enabled ? `${s.power.graceSeconds}s grace period` : 'disabled in config';
    $('restart-btn').disabled = !s.power.enabled;
    $('shutdown-btn').disabled = !s.power.enabled;

    const p = s.power.pending;
    if (JSON.stringify(p) !== JSON.stringify(pending)) showPending(p);

    $('stamp').textContent = 'updated ' + new Date(s.time).toLocaleTimeString();
    loadPeers();
  } catch (err) {
    if (err.unauthorized) return gate(true);
    const age = Date.now() - lastOk;
    $('live-dot').className = age > 15000 ? 'dot dead' : 'dot stale';
    $('stamp').textContent = 'connection lost — retrying';
  }
}

function startPolling() {
  clearInterval(pollTimer);
  tick();
  pollTimer = setInterval(() => {
    if (!document.hidden) tick();
  }, 2000);
}

/* ---------------- role ---------------- */

function applyRole() {
  const admin = role === 'admin';
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.hidden = !admin;
  });
  $('role-meta').hidden = admin;
  $('role').textContent = admin ? 'full' : 'read-only';
  // A read-only session must not be left sitting on a tab it can no longer load.
  if (!admin && ['logs', 'security', 'alerts'].includes(currentTab)) showTab('overview');
}

/* ---------------- token gate ---------------- */

function gate(showError) {
  clearInterval(pollTimer);
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate-err').hidden = !showError;
  $('gate-input').value = '';
  $('gate-input').focus();
}

function enter(t) {
  token = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {}
  $('gate').hidden = true;
  $('app').hidden = false;
  startPolling();
}

/* ---------------- boot ---------------- */

function boot() {
  $('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('gate-input').value.trim();
    if (t) enter(t);
  });

  $('svc-filter').addEventListener('input', paintServices);

  $('forget').addEventListener('click', () => {
    try {
      localStorage.removeItem(KEY);
    } catch {}
    token = '';
    gate(false);
  });

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => showTab(t.dataset.tab));
  });

  // Row buttons are created on every repaint, so the handler lives on the container.
  document.addEventListener('click', (e) => {
    const svc = e.target.closest('[data-svc]');
    if (svc) {
      const { svc: name, act } = svc.dataset;
      return confirmThen(`${act} ${name}?`, 'This acts on the service immediately.', () =>
        serviceAction(name, act)
      );
    }
    const ctr = e.target.closest('[data-ctr]');
    if (ctr) {
      const { ctr: name, act } = ctr.dataset;
      const what = act === 'pull' ? 'Pull a newer image and recreate' : act;
      return confirmThen(`${what} ${name}?`, 'This acts on the container immediately.', () =>
        containerAction(name, act)
      );
    }
    const lu = e.target.closest('[data-log-unit]');
    if (lu) return openLogs('unit', lu.dataset.logUnit);
    const lc = e.target.closest('[data-log-ctr]');
    if (lc) return openLogs('container', lc.dataset.logCtr);
  });

  $('log-source').addEventListener('change', () => {
    $('log-name').hidden = $('log-source').value === 'system';
  });
  $('log-fetch').addEventListener('click', fetchLogs);
  $('log-follow').addEventListener('change', () => {
    clearInterval(logTimer);
    logTimer = null;
    if ($('log-follow').checked) logTimer = setInterval(fetchLogs, 5000);
  });

  $('scan-btn').addEventListener('click', runScan);

  $('alert-test').addEventListener('click', async () => {
    try {
      const res = await api('/api/alerts/test', { method: 'POST' });
      const err = res.result?.error;
      $('alert-error').hidden = !err;
      if (err) $('alert-error').textContent = err;
      toast(err ? 'Test failed — see the panel' : 'Test notification sent', !!err);
      tick();
    } catch (e) {
      toast(`Test failed: ${e.message}`, true);
    }
  });

  $('restart-btn').addEventListener('click', () =>
    confirmThen(
      'Restart this machine?',
      'Everything running on it stops. You will get a countdown with a cancel button first.',
      () => power('restart', true)
    )
  );
  $('shutdown-btn').addEventListener('click', () =>
    confirmThen(
      'Shut this machine down?',
      'It will power off and you will need physical or wake-on-LAN access to bring it back. A countdown with a cancel button comes first.',
      () => power('shutdown', true)
    )
  );
  $('abort-btn').addEventListener('click', () => power('cancel', false));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token) tick();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  let savedTab = 'overview';
  try {
    savedTab = localStorage.getItem(TAB_KEY) || 'overview';
  } catch {}
  showTab(savedTab);

  // A token in the URL wins, then gets stripped so it stays out of history and screenshots.
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    history.replaceState(null, '', location.pathname);
    enter(fromUrl);
    return;
  }
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {}
  if (saved) enter(saved);
  else gate(false);
}

boot();
