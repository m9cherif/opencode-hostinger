#!/bin/bash
# One-shot installer for the v16 app.js. Idempotent: it only restarts the site
# when the installed file actually differs, so a repeated cron run is harmless.
d=~/domains/opencode1.chrif.net
t=$d/hbuilds/current/nodejs/app.js
o=/tmp/install.txt
{
  echo "== $(date -Is) =="
  if curl -sfL "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/a0a1006b58f16d16792afd307c16bd30232cde24/app.js" -o /tmp/app.new; then
    echo "downloaded $(wc -c < /tmp/app.new) bytes"
    if cmp -s /tmp/app.new "$t"; then
      echo "installed file already current; nothing to do"
    else
      cp /tmp/app.new "$t" && echo "installed; restarting workers"
      rm -f "$d/public_html/diag.txt" "$d/public_html/childlog.txt" "$d/public_html/c.txt" "$d/public_html/cmds.out" "$d/public_html/install.txt"
      pkill -f 'lsnode:.*opencode1\.chrif\.net'
    fi
  else
    echo "download failed"
  fi
  echo "== done =="
} > "$o" 2>&1
