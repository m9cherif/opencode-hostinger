#!/bin/bash
# Executed on the Hostinger server through the cron bridge.
out=~/domains/opencode1.chrif.net/public_html/cmds.out
exec > "$out" 2>&1
echo "== $(date -Is) =="
echo "user=$(id -un) uid=$(id -u) pwd=$(pwd) HOME=$HOME"
for t in curl wget python3 node bash base64 ss netstat lsof; do printf '%s=' "$t"; command -v "$t" || echo missing; done

echo "== local tcp self-test 127.0.0.1:4399"
node -e 'require("http").createServer((q,s)=>s.end("HELLO")).listen(4399,"127.0.0.1")' &
sp=$!
sleep 1
curl -s -m 3 -o /dev/null -w "via127=%{http_code}\n" http://127.0.0.1:4399/ ; echo "rc=$?"
curl -s -m 3 -o /dev/null -w "vialocalhost=%{http_code}\n" http://localhost:4399/ ; echo "rc=$?"
kill $sp 2>/dev/null

echo "== child on 4179"
curl -s -m 5 -o /dev/null -w "child4179=%{http_code}\n" http://127.0.0.1:4179/ ; echo "rc=$?"

echo "== live app.js"
ls -l ~/domains/opencode1.chrif.net/hbuilds/current/nodejs/app.js
grep -c "v13" ~/domains/opencode1.chrif.net/hbuilds/current/nodejs/app.js

echo "== console.log tail"
tail -30 ~/domains/opencode1.chrif.net/hbuilds/current/nodejs/console.log
