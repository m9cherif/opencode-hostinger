#!/bin/bash
# One-shot setup: create the OpenCode project folder, make it a git repo,
# register it in ~/.opencode-workspace, then install the current app.js.
# Idempotent: the site is only restarted when app.js actually changes.
set -u
d=~/domains/opencode1.chrif.net
t=$d/hbuilds/current/nodejs/app.js
w=~/projects/opencode1
o=/tmp/setup.out
{
  echo "== $(date -Is) =="
  mkdir -p "$w" && echo "workspace: $w"
  if [ -d "$w/.git" ]; then
    echo "git: already a repository"
  elif command -v git >/dev/null 2>&1; then
    ( cd "$w" && git init -q ) && echo "git: initialized"
  else
    echo "git: not available, skipping init"
  fi
  if [ ! -f "$w/README.md" ]; then
    printf '# opencode1\n\nProject workspace for https://opencode1.chrif.net\n' > "$w/README.md"
    echo "README: created"
  fi
  printf '%s\n' "$w" > ~/.opencode-workspace
  echo "pointer: $(cat ~/.opencode-workspace)"
  ls -la "$w"

  if curl -sfL "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/62a1d790281c98d50515855106519b7646db0d9a/app.js" -o /tmp/app.new; then
    echo "downloaded $(wc -c < /tmp/app.new) bytes"
    if cmp -s /tmp/app.new "$t"; then
      echo "app.js already current"
    else
      cp /tmp/app.new "$t" && echo "app.js installed; restarting workers"
      pkill -f 'lsnode:.*opencode1\.chrif\.net'
    fi
  else
    echo "app.js download failed"
  fi
  echo "== done =="
} > "$o" 2>&1
