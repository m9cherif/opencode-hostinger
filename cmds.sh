#!/bin/bash
# Executed on the Hostinger server through the cron bridge.
out=~/domains/opencode1.chrif.net/public_html/cmds.out
exec > "$out" 2>&1
echo "== $(date -Is) =="
t=~/domains/opencode1.chrif.net/hbuilds/current/nodejs/app.js

echo "== download app.js"
curl -sfLo "$t" "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/cd99b3f4/app.js"
echo "dl rc=$?"
ls -l "$t"
echo "public4=$(grep -c public4 "$t")"

echo "== restart site workers"
pkill -f 'lsnode:.*opencode1\.chrif\.net'
pkill -f '/opencode-1.19.3-test/opencode web'
sleep 30

echo "== workers"
ps -eo pid,etime,args | grep -F 'opencode1.chrif.net/hbuilds/current' | grep -v grep

echo "== children"
ps -eo pid,etime,args | grep -F 'opencode web --hostname' | grep -v grep

echo "== diag"
curl -s -m 12 https://opencode1.chrif.net/__diag | head -12

echo "== root"
curl -s -m 20 -o /dev/null -w "root=%{http_code} ct=%{content_type}\n" https://opencode1.chrif.net/

echo "== done"
