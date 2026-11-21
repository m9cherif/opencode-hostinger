#!/bin/bash
# Collect crash evidence for the bash-tool SIGABRT.
set -u
d=$HOME/domains/opencode1.chrif.net
o=$d/public_html/p4.txt
{
  echo "== $(date -Is) =="
  echo "-- tools --"
  command -v gdb; command -v strace; command -v ltrace
  echo "-- limits --"
  ulimit -c
  grep -E 'Max processes|Max open files|Max address' /proc/self/limits 2>/dev/null
  echo "-- core_pattern --"
  cat /proc/sys/kernel/core_pattern 2>&1
  echo "-- dmesg --"
  dmesg 2>&1 | tail -25
  echo "-- tmp bun/crash --"
  ls -la /tmp 2>/dev/null | grep -iE 'bun|crash|core' | head -20
  echo "-- state files --"
  find "$d/.local" -maxdepth 6 -type f 2>/dev/null | head -40
  echo "-- newest logs --"
  for f in $(find "$d/.local" -type f -name '*.log' 2>/dev/null | head -6); do
    echo "### $f"
    tail -60 "$f"
  done
  echo "-- done --"
} > "$o" 2>&1
