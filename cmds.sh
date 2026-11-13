#!/bin/bash
# Prepare the project repo on the server: SSH deploy key, ssh command for git,
# origin remote, initial commit on "main". The public key is written to the
# docroot so it can be registered on GitHub; the next run deletes that file.
set -u
d=~/domains/opencode1.chrif.net
p=$d/project
key=$HOME/.ssh/opencode_projects
out=$d/public_html/repo.txt
{
  echo "== $(date -Is) =="
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  if [ ! -f "$key" ]; then
    ssh-keygen -t ed25519 -N '' -C 'opencode1 project deploy key' -f "$key" >/dev/null 2>&1 && echo "ssh key: generated"
  else
    echo "ssh key: already present"
  fi
  chmod 600 "$key"
  chmod 644 "$key.pub"
  echo "===PUBKEY==="
  cat "$key.pub"
  echo "===END==="

  if ! grep -q '^github.com ' "$HOME/.ssh/known_hosts" 2>/dev/null; then
    mkdir -p "$HOME/.ssh"
    ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null && echo "known_hosts: added github.com"
  fi

  cd "$p" || exit 1
  git config user.name "OpenCode"
  git config user.email "opencode@opencode1.chrif.net"
  git config core.sshCommand "ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts"
  git remote remove origin 2>/dev/null || true
  git remote add origin git@github.com:m9cherif/opencode-projects.git
  echo "remote: $(git remote get-url origin)"
  git add -A
  git commit -q -m "Initial commit" 2>/dev/null && echo "commit: created" || echo "commit: nothing to commit"
  git branch -M main
  echo "branch: $(git branch --show-current)"
  echo "tracked: $(git ls-files | tr '\n' ' ')"
  echo "== done =="
} > "$out" 2>&1
