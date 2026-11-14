#!/usr/bin/env bash
# DEV ONLY: install/enable the simulator unit on the test bench. The real box image never runs this.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
install -m 644 /opt/farmpilot-core/deploy/farmpilot-core-sim.service /etc/systemd/system/farmpilot-core-sim.service
systemctl daemon-reload && systemctl enable --now farmpilot-core-sim.service
