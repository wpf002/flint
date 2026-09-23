#!/bin/zsh
# Raise the GPU wired limit now and on every boot. Needs root:
#   sudo ./apps/studio/install_gpu_limit.sh
set -e
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
DST=/Library/LaunchDaemons/com.flint.gpulimit.plist
install -m 644 -o root -g wheel "${0:A:h}/com.flint.gpulimit.plist" "$DST"
launchctl bootout system "$DST" 2>/dev/null || true
launchctl bootstrap system "$DST"
# bootstrap returns before the job runs; without this the echo reads the old 0.
for i in {1..10}; do [ "$(sysctl -n iogpu.wired_limit_mb)" != 0 ] && break; sleep 0.5; done
echo "iogpu.wired_limit_mb = $(sysctl -n iogpu.wired_limit_mb)"
