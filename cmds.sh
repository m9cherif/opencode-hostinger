#!/bin/bash
# Start an instrumented OpenCode child on 4322 under strace, leave it up while
# the bash tool is triggered from outside, then dump the tail of the trace.
set -u
d=$HOME/domains/opencode1.chrif.net
o=$d/public_html/p5.txt
mkdir -p /tmp/ocprobe
if [ ! -d /tmp/ocprobe/.git ]; then (cd /tmp/ocprobe && git init -q); fi
w=$(pgrep -f 'lsnode:.*opencode1\.chrif\.net' | head -1)
pw=$(tr '\0' '\n' < "/proc/$w/environ" 2>/dev/null | sed -n 's/^OPENCODE_SERVER_PASSWORD=//p')
{
  echo "== $(date -Is) worker=$w pwlen=${#pw} =="
  if [ -z "$pw" ]; then echo "no password found"; exit 1; fi
  cd /tmp/ocprobe
  HOME=$d OPENCODE_SERVER_PASSWORD=$pw nohup /usr/bin/strace -f -tt -s 300 -e trace=signal,process \
    -o /tmp/oc.strace /home/u170282392/opencode-1.19.3-test/opencode web --hostname 0.0.0.0 --port 4322 \
    > /tmp/oc.out 2>&1 &
  echo $! > /tmp/oc.pid
  echo "started pid=$(cat /tmp/oc.pid)"
  sleep 80
  echo "-- out tail --"
  tail -40 /tmp/oc.out
  echo "-- strace tail --"
  tail -100 /tmp/oc.strace
  pkill -f 'opencode web --hostname 0.0.0.0 --port 4322' 2>/dev/null
  echo "-- done --"
} > "$o" 2>&1
