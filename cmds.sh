#!/bin/bash
# Push the project repo to GitHub, then remove the temporary public-key file.
set -u
d=~/domains/opencode1.chrif.net
p=$d/project
out=$d/public_html/push.txt
{
  echo "== $(date -Is) =="
  rm -f "$d/public_html/repo.txt"
  cd "$p" || exit 1
  echo "remote: $(git remote get-url origin)"
  echo "branch: $(git branch --show-current)"
  echo "commits: $(git rev-list --count HEAD 2>/dev/null || echo 0)"
  git push -u origin main 2>&1
  echo "push_rc=$?"
  git status -sb
  echo "== done =="
} > "$out" 2>&1
( sleep 90; rm -f "$out" ) &
