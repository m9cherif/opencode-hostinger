#!/bin/bash
# Move the project workspace inside the site's home so the web UI's
# "Open a project" browser lists it, and point OpenCode at the new path.
set -u
d=~/domains/opencode1.chrif.net
p=$d/project
old=/home/u170282392/projects/opencode1
o=/tmp/ws-move.out
{
  echo "== $(date -Is) =="
  mkdir -p "$p" && echo "folder: $p"
  if [ -d "$old" ]; then
    cp -a "$old/." "$p"/ && echo "copied from $old"
    rm -rf "$old" ~/projects && echo "removed old folder"
  else
    echo "old folder absent (nothing to move)"
  fi
  if [ -d "$p/.git" ]; then
    echo "git: repository present"
  elif command -v git >/dev/null 2>&1; then
    ( cd "$p" && git init -q ) && echo "git: initialized"
  else
    echo "git: unavailable"
  fi
  [ -f "$p/README.md" ] || printf '# project\n\nOpenCode project workspace for https://opencode1.chrif.net\n' > "$p/README.md"
  printf '%s\n' "$p" > ~/.opencode-workspace
  echo "pointer: $(cat ~/.opencode-workspace)"
  ls -la "$p"
  echo "== done =="
} > "$o" 2>&1
