#!/bin/bash
# Executed on the Hostinger server through the cron bridge.
out=~/domains/opencode1.chrif.net/public_html/cmds.out
exec > "$out" 2>&1
echo "== $(date -Is) =="
t=~/domains/opencode1.chrif.net/hbuilds/current/nodejs/app.js

echo "== stop site workers + old children"
pkill -f 'lsnode:.*opencode1\.chrif\.net'
pkill -f '/opencode-1.19.3-test/opencode web'
sleep 25

echo "== download app.js (after workers stopped, so no rewrite races)"
sha=$(curl -sfL -H 'User-Agent: bridge' https://api.github.com/repos/m9cherif/opencode-hostinger/commits/opencode | sed -n 's/.*"sha": *"\([a-f0-9]\{40\}\)".*/\1/p' | head -1)
curl -sfLo "$t" "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/$sha/app.js"
echo "rc=$?"
ls -l "$t"
grep -c "public4" "$t"

echo "== workers now"
ps -eo pid,etime,args | grep -F 'opencode1.chrif.net/hbuilds' | grep -v grep

echo "== opencode children now"
ps -eo pid,etime,args | grep -F 'opencode web --hostname' | grep -v grep

echo "== live /__diag"
curl -s -m 12 https://opencode1.chrif.net/__diag | head -12

echo "== done"
