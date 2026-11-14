#!/usr/bin/env bash
# Farm-Pilot CORE deploy helper (test bench). Run as root on the bench VPS.
#   ./deploy.sh            git pull --ff-only, install, build, restart, health check
#   ./deploy.sh --no-pull  build and restart whatever is in /opt/farmpilot-core now
# Never touches /var/lib/farmpilot-core (the database) or /etc/farmpilot-core.env. Never installs the simulator unit.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PWD/node/bin:$PATH"
[ -x node/bin/node ] || { echo "Node runtime missing at $PWD/node (see README, 'Node on the bench')." >&2; exit 1; }

if [ "${1:-}" != "--no-pull" ]; then echo "==> git pull --ff-only"; git pull --ff-only; fi
echo "==> npm ci"; npm ci --no-audit --no-fund; npm --prefix web ci --no-audit --no-fund
echo "==> build"; npm run build
chown -R root:root src dist web/dist deploy 2>/dev/null || true; chmod -R a+rX . 
if ! cmp -s deploy/farmpilot-core.service /etc/systemd/system/farmpilot-core.service; then
  echo "==> updating systemd unit"; install -m 644 deploy/farmpilot-core.service /etc/systemd/system/farmpilot-core.service; systemctl daemon-reload
fi
systemctl enable farmpilot-core.service >/dev/null
echo "==> restart"; systemctl restart farmpilot-core.service
. /etc/farmpilot-core.env 2>/dev/null || true
for i in $(seq 1 15); do
  if curl -fsS "http://${HOST_BIND_IP:-127.0.0.1}:${PORT:-4100}/api/health" >/dev/null 2>&1; then echo "==> healthy: $(curl -fsS "http://${HOST_BIND_IP:-127.0.0.1}:${PORT:-4100}/api/health")"; exit 0; fi
  sleep 1
done
echo "!! health check failed; journalctl -u farmpilot-core -n 50" >&2; exit 1
