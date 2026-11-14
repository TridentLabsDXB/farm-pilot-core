#!/usr/bin/env bash
# Idle RAM/CPU of the runtime + history size per 100 sensors. Run as root. Polite: nice/ionice, scratch DB only.
set -euo pipefail
cd "$(dirname "$0")/.."; export PATH="$PWD/node/bin:$PATH"
echo "== load / docker before"; uptime; docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
echo "== runtime (60 s sample)"
PID=$(systemctl show -p MainPID --value farmpilot-core); T1=$(awk '{print $14+$15}' /proc/$PID/stat); sleep 60; T2=$(awk '{print $14+$15}' /proc/$PID/stat)
echo "RSS MB: $(( $(awk '/VmRSS/{print $2}' /proc/$PID/status) / 1024 ))   CPU %: $(awk -v a=$T1 -v b=$T2 -v h=$(getconf CLK_TCK) 'BEGIN{printf "%.2f", (b-a)/h/60*100}')"
systemctl show farmpilot-core -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec
echo "== history size, 100 sensors x 2 readings x 1/min x 1 day (scratch db)"
nice -n 19 ionice -c3 node dist/scripts/seed-bench.js /tmp/core-bench.db 100 1; rm -f /tmp/core-bench.db*
echo "== load / docker after"; uptime; docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
