#!/bin/bash
# One-shot instrumented reproduction, fully server-side, under ~60s.
set -u
d=$HOME/domains/opencode1.chrif.net
o=$d/public_html/p6.txt
pw=$(tr '\0' '\n' < "/proc/$(pgrep -f 'lsnode:.*opencode1\.chrif\.net' | head -1)/environ" 2>/dev/null | sed -n 's/^OPENCODE_SERVER_PASSWORD=//p')
base=http://217.65.157.33:4322
{
  echo "== $(date -Is) pwlen=${#pw} =="
  pkill -f 'opencode web --hostname 0.0.0.0 --port 4322' 2>/dev/null
  sleep 1
  mkdir -p /tmp/ocprobe
  [ -d /tmp/ocprobe/.git ] || (cd /tmp/ocprobe && git init -q)
  cd /tmp/ocprobe
  : > /tmp/oc.strace
  HOME=$d OPENCODE_SERVER_PASSWORD=$pw nohup /usr/bin/strace -f -tt -s 300 -e trace=signal,process \
    -o /tmp/oc.strace /home/u170282392/opencode-1.19.3-test/opencode web --hostname 0.0.0.0 --port 4322 \
    > /tmp/oc.out 2>&1 &
  echo "child pid=$!"
  for i in $(seq 1 12); do
    code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -u "opencode:$pw" $base/global/health)
    echo "health[$i]=$code"
    [ "$code" = "200" ] && break
    sleep 1
  done
  sid=$(curl -s -m 8 -u "opencode:$pw" -H 'Content-Type: application/json' \
    -d '{"title":"strace bash"}' "$base/session?directory=/tmp/ocprobe" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
  echo "sid=$sid"
  if [ -n "$sid" ]; then
    curl -s -m 15 -u "opencode:$pw" -H 'Content-Type: application/json' \
      -d '{"model":{"providerID":"opencode","modelID":"deepseek-v4.1-flash-free"},"tools":{"bash":true},"parts":[{"type":"text","text":"Use the bash tool to run exactly: echo hello"}]}' \
      "$base/session/$sid/message?directory=/tmp/ocprobe" > /tmp/oc.post 2>&1
    echo "post rc=$? bytes=$(wc -c < /tmp/oc.post)"
  fi
  sleep 3
  echo "-- out --"
  tail -50 /tmp/oc.out
  echo "-- strace size --"
  ls -la /tmp/oc.strace
  echo "-- strace tail --"
  tail -120 /tmp/oc.strace
  pkill -f 'opencode web --hostname 0.0.0.0 --port 4322' 2>/dev/null
  echo "-- done --"
} > "$o" 2>&1
