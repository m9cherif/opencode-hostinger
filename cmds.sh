#!/bin/bash
# One-shot installer for the v15 app.js. Idempotent: it only restarts the site
# when the installed file actually differs, so a repeated cron run is harmless.
d=~/domains/opencode1.chrif.net
t=$d/hbuilds/current/nodejs/app.js
o=$d/public_html/install.txt
{
  echo "== $(date -Is) =="
  if curl -sfL "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/c97cd4cdc7f005c6e8eb897bed309602b72f9f7f/app.js" -o /tmp/app.new; then
    echo "downloaded $(wc -c < /tmp/app.new) bytes"
    if cmp -s /tmp/app.new "$t"; then
      echo "installed file already current; nothing to do"
    else
      cp /tmp/app.new "$t" && echo "installed; restarting workers"
      pkill -f 'lsnode:.*opencode1\.chrif\.net'
    fi
  else
    echo "download failed"
  fi
  echo "== done =="
} > "$o" 2>&1
