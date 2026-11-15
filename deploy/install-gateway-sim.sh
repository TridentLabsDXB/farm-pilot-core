#!/usr/bin/env bash
# DEV ONLY: install/enable the Milestone 2 gateway simulator unit on the test bench (separate from install-sim.sh, which installs the MQTT simulator).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
install -m 644 /opt/farmpilot-core/deploy/farmpilot-gateway-sim.service /etc/systemd/system/farmpilot-gateway-sim.service
systemctl daemon-reload && systemctl enable --now farmpilot-gateway-sim.service
