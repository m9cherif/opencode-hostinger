#!/bin/bash
# Deploy the app.js pinned at this commit. Idempotent: restart only on change.
set -u
t=~/domains/opencode1.chrif.net/hbuilds/current/nodejs/app.js
o=/tmp/deploy.out
{
  echo "== $(date -Is) =="
  if curl -sfL "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/73f1af0c915e654531323a64e868ea4eac28d27a/app.js" -o /tmp/app.new; then
    echo "downloaded $(wc -c < /tmp/app.new) bytes"
    if cmp -s /tmp/app.new "$t"; then
      echo "app.js already current"
    else
      cp /tmp/app.new "$t" && echo "app.js installed; restarting" && pkill -f 'lsnode:.*opencode1\.chrif\.net'
    fi
  else
    echo "app.js download failed"
  fi
  echo "== done =="
} > "$o" 2>&1
