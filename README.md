# Server Dashboard

A small, dependency-free dashboard for a single machine. It shows what is running,
how much storage is left, and gives you guarded restart / shutdown controls.

Runs on Node with no `npm install` — standard library only. It detects the OS at
startup and uses the right collectors:

| | Linux | Windows |
|---|---|---|
| CPU | `os.cpus()` deltas + `os.loadavg()` | `os.cpus()` deltas |
| Memory | `/proc/meminfo` (**MemAvailable**, not MemFree) | `os.totalmem` / `os.freemem` |
| Disks | `df -PB1 -T`, pseudo filesystems filtered out | `Win32_LogicalDisk`, fixed drives |
| Network | `/proc/net/dev` | `Get-NetAdapterStatistics` |
| Ports | `ss -lntp` | `Get-NetTCPConnection` |
| Processes | `ps -eo pid,rss,comm` | `Get-Process` |
| Services | `systemctl list-units --state=running` | `Get-Service` |
| Containers | `docker ps` (panel hidden if absent) | — |
| Extra | — | WSL distributions |

The page polls every 2s and pauses while the tab is in the background. Cheap data
refreshes every ~1.5s; the heavier service/port scan is cached for 10s.

## Install on a Linux server

Copy the folder over and run the installer:

```bash
rsync -av --exclude config.json ./ user@server:/tmp/server-dashboard/
ssh user@server 'sudo bash /tmp/server-dashboard/deploy/install.sh'
```

It installs to `/opt/server-dashboard`, registers a systemd unit, starts it, and prints
the URL with the access token. Node must already be present — on Debian/Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

Before trusting the numbers, run the self-test on the server. It reports exactly what
can and cannot be collected and whether the power buttons will work — it never powers
anything down:

```bash
cd /opt/server-dashboard && sudo node selftest.js
```

Service management afterwards:

```bash
systemctl status server-dashboard
journalctl -u server-dashboard -f
```

## Run on Windows

```bat
start.bat
```

The console prints a ready-to-click URL with the token in it. Open it once and the
token is remembered in that browser; there is a "forget token" link in the footer.

## Power controls

Restart and shutdown both pass three gates:

1. A confirmation dialog in the browser.
2. The API refuses the request unless the body carries `confirm: true`.
3. A **30 second grace period** (configurable), during which a red banner with a
   **Cancel it** button is shown.

Every power request is logged with the caller's address.

The action name from a request is only ever used as a key into a fixed table of verbs —
nothing the caller sends reaches a command line.

**Linux** holds the countdown inside the dashboard process and then calls
`systemctl reboot` / `systemctl poweroff` (systemd's own `shutdown` only accepts whole
minutes). This is fail-safe: if the dashboard dies mid-countdown, the machine stays up.
If the final command fails, the error is shown in the Power panel.

**Windows** hands the countdown to `shutdown.exe`, so it survives the dashboard dying;
cancelling calls `shutdown /a`.

### Permissions (Linux)

Rebooting needs privilege. Easiest is the shipped unit, which runs as root — that also
lets `ss` show which process owns each port.

To run unprivileged instead, change `User=` in the unit, then grant just the two verbs:

```
# /etc/sudoers.d/server-dashboard
dashboard ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff
```

and set `"useSudo": true` in `config.json`. `selftest.js` tells you which situation you
are in. Note that an unprivileged `ss` cannot see process names for ports owned by other
users, so that column will read "unknown".

## Configuration — `config.json`

Generated on first run, next to `server.js`. Restart the service after editing.

| Key | Default | Meaning |
|---|---|---|
| `token` | random 48 hex chars | Access token. Delete the line to regenerate. |
| `port` | `8477` | Listening port. |
| `host` | `127.0.0.1` | Bind address. **Loopback only by default.** |
| `powerEnabled` | `true` | Set `false` to serve stats but refuse restart/shutdown entirely. |
| `graceSeconds` | `30` | Cancellable delay before the machine goes down. |
| `useSudo` | `false` | Linux: run the power verbs through `sudo -n`. |

### Reaching it from another machine

Set `"host": "0.0.0.0"` and open the port:

```bash
sudo ufw allow 8477/tcp                     # Linux
```

```powershell
New-NetFirewallRule -DisplayName "Server Dashboard" -Direction Inbound -LocalPort 8477 -Protocol TCP -Action Allow
```

Be deliberate about this. It is plain HTTP with a bearer token, so anyone who can see
the traffic can read the token and then power the machine off. On a trusted LAN that is
usually fine; on the open internet it is not — put it behind a VPN or a TLS-terminating
reverse proxy, and consider `"powerEnabled": false` on anything exposed.

`config.json` holds the token, so it is gitignored and the installer chmods it to 600.

## Layout

```
server.js              HTTP server, auth, routing
selftest.js            what can I see here, and will power work? (safe to run)
lib/metrics.js         platform dispatch, caching, CPU and network rate math
lib/power.js           the only place reboot/shutdown is invoked
lib/collect-linux.js   /proc, df, ss, ps, systemctl, docker  (+ exported parsers)
lib/collect-win.js     wraps the two PowerShell collectors
lib/collect-*.ps1      Windows data collection
public/                the dashboard page
deploy/                systemd unit + install.sh
config.json            generated settings, contains the token
```

The Linux parsers are exported individually from `collect-linux.js` so they can be
tested against captured command output without a Linux box.
