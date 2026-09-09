'use strict';

const $ = (id) => document.getElementById(id);
const KEY = 'server-dashboard-token';

let token = '';
let pollTimer = null;
let countdownTimer = null;
let pending = null;
let lastOk = 0;

/* ---------------- formatting ---------------- */

function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const dp = n < 10 && i > 0 ? 1 : 0;
  return n.toFixed(dp) + ' ' + units[i];
}

function rate(n) {
  if (!Number.isFinite(n)) return '—';
  return bytes(n) + '/s';
}

function duration(sec) {
  if (!Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function level(pct) {
  return pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
}

function setBar(el, pct) {
  el.style.width = Math.max(0, Math.min(100, pct)) + '%';
  el.className = 'fill ' + level(pct);
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

/* ---------------- rendering ---------------- */

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
  const pct = cpu.total;
  $('cpu-pct').textContent = pct.toFixed(0);
  setBar($('cpu-bar'), pct);

  const host = $('cores');
  if (host.children.length !== cpu.cores.length) {
    host.innerHTML = cpu.cores.map(() => '<div class="core"></div>').join('');
  }
  cpu.cores.forEach((v, i) => {
    const el = host.children[i];
    el.style.setProperty('--h', Math.max(4, v).toFixed(0) + '%');
    el.title = `core ${i}: ${v.toFixed(0)}%`;
  });

  // Load average is Linux-only; clock speed and temperature depend on the hardware
  // exposing them, so each part appears only when there is a real reading.
  const bits = [];
  if (cpu.load) bits.push('load ' + cpu.load.map((n) => n.toFixed(2)).join(' '));
  if (cpu.mhz) bits.push((cpu.mhz / 1000).toFixed(2) + ' GHz');
  if (cpu.temp) bits.push(Math.round(cpu.temp) + '°C');
  const foot = $('cpu-foot');
  foot.hidden = bits.length === 0;
  foot.textContent = bits.join(' · ');
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
    // No live metrics available (no nvidia-smi) — name the adapter and say so.
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

function formatSeconds(s) {
  if (s < 60) return s.toFixed(0) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
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

function renderContainers(list) {
  const card = $('containers-card');
  if (!list.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('containers-count').textContent = `${list.length} running`;
  $('containers').innerHTML = list
    .map(
      (c) => `
        <div class="row">
          <div class="l">
            <span class="pill ${c.up ? 'on' : 'off'}">${c.up ? 'up' : 'down'}</span>
            <span class="name">${esc(c.name)}</span>
          </div>
          <span class="r">${esc(c.image)}</span>
        </div>`
    )
    .join('');
}

function renderDisks(disks, io) {
  $('drives-count').textContent = disks.length ? `${disks.length} mounted` : '';

  // Headline tile follows the system drive: C: on Windows, / on Linux.
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
}

function renderNet(n) {
  $('net-rx').innerHTML = `↓ ${rate(n.rx)}`;
  $('net-foot').textContent = `↑ ${rate(n.tx)} · ${bytes(n.totalRx)} in / ${bytes(n.totalTx)} out since boot`;
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

let allServices = [];

function renderServices(list) {
  allServices = list;
  paintServices();
}

function paintServices() {
  const q = $('svc-filter').value.trim().toLowerCase();
  const shown = q
    ? allServices.filter(
        (s) => s.display.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
      )
    : allServices;

  $('services').innerHTML = shown.length
    ? shown
        .map(
          (s) => `
        <div class="row">
          <div class="l"><span class="name">${esc(s.display || s.name)}</span></div>
          <span class="r">${esc(s.name)}</span>
        </div>`
        )
        .join('')
    : '<p class="empty">No services match.</p>';
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
  $('pending-title').textContent =
    p.action === 'restart' ? 'Restart scheduled' : 'Shutdown scheduled';

  const tick = () => {
    const left = Math.max(0, Math.round((p.deadline - Date.now()) / 1000));
    $('pending-sub').textContent =
      left > 0 ? `in ${left}s — you can still cancel` : 'going down now…';
  };
  tick();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 500);
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
    const res = await api('/api/power', {
      method: 'POST',
      body: JSON.stringify({ action, confirm: confirmFlag }),
    });
    showPending(res.pending);
  } catch (err) {
    if (err.unauthorized) return gate(true);
    alert(`Could not ${action}: ${err.message}`);
  }
}

/* ---------------- polling ---------------- */

async function tick() {
  try {
    const s = await api('/api/stats');
    lastOk = Date.now();
    $('live-dot').className = 'dot';

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

    const errEl = $('power-error');
    errEl.hidden = !s.power.error;
    if (s.power.error) errEl.textContent = s.power.error;

    $('power-sub').textContent = s.power.enabled
      ? `${s.power.graceSeconds}s grace period`
      : 'disabled in config';
    $('restart-btn').disabled = !s.power.enabled;
    $('shutdown-btn').disabled = !s.power.enabled;

    const p = s.power.pending;
    if (JSON.stringify(p) !== JSON.stringify(pending)) showPending(p);

    $('stamp').textContent = 'updated ' + new Date(s.time).toLocaleTimeString();
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
  localStorage.setItem(KEY, t);
  $('gate').hidden = true;
  $('app').hidden = false;
  startPolling();
}

function boot() {
  $('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('gate-input').value.trim();
    if (t) enter(t);
  });

  $('svc-filter').addEventListener('input', paintServices);

  $('forget').addEventListener('click', () => {
    localStorage.removeItem(KEY);
    token = '';
    gate(false);
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

  // A token in the URL wins, then gets stripped so it stays out of history and screenshots.
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    history.replaceState(null, '', location.pathname);
    enter(fromUrl);
    return;
  }
  const saved = localStorage.getItem(KEY);
  if (saved) enter(saved);
  else gate(false);
}

boot();
