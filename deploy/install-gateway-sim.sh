#!/usr/bin/env bash
# DEV ONLY: install/enable the bench Modbus simulators on the test bench: the XZ-DS-MUS2 gateway simulator (Port 1) and the WN90LP weather simulator (Port 2).
# Separate from install-sim.sh, which installs the MQTT simulator.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
for u in farmpilot-gateway-sim farmpilot-wn90lp-sim; do install -m 644 /opt/farmpilot-core/deploy/$u.service /etc/systemd/system/$u.service; done
systemctl daemon-reload && systemctl enable --now farmpilot-gateway-sim.service farmpilot-wn90lp-sim.service
