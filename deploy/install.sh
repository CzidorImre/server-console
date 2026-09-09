#!/usr/bin/env bash
# Installs the dashboard on this machine as a systemd service.
#   sudo bash deploy/install.sh
set -euo pipefail

DEST=/opt/server-dashboard
UNIT=/etc/systemd/system/server-dashboard.service
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. On Debian/Ubuntu:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  exit 1
fi

echo "Installing from $SRC to $DEST"
mkdir -p "$DEST"
# Keep any existing config.json (it holds the access token).
for item in server.js selftest.js package.json README.md lib public; do
  [ -e "$SRC/$item" ] && cp -r "$SRC/$item" "$DEST/"
done
# The Windows collectors are dead weight here but harmless; drop them for tidiness.
rm -f "$DEST/lib/collect-fast.ps1" "$DEST/lib/collect-slow.ps1" "$DEST/lib/collect-win.js"

chmod 700 "$DEST"
[ -f "$DEST/config.json" ] && chmod 600 "$DEST/config.json"

install -m 644 "$SRC/deploy/server-dashboard.service" "$UNIT"
systemctl daemon-reload
systemctl enable --now server-dashboard

sleep 1
systemctl --no-pager --lines=0 status server-dashboard || true

echo
echo "Installed. The access token is in $DEST/config.json:"
if [ -f "$DEST/config.json" ]; then
  TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DEST/config.json")
  PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$DEST/config.json")
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo
  echo "  http://${IP:-localhost}:${PORT:-8477}/?token=${TOKEN}"
  echo
  echo "By default it listens on 127.0.0.1 only. To reach it from another machine, set"
  echo "  \"host\": \"0.0.0.0\"  in $DEST/config.json, then: systemctl restart server-dashboard"
fi
