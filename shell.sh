#!/bin/bash
# Stable entry point: resolve the current commit of branch "opencode" and run
# its cmds.sh from that immutable commit URL (branch URLs are CDN-cached).
sha=$(curl -sfL -H 'User-Agent: bridge' https://api.github.com/repos/m9cherif/opencode-hostinger/commits/opencode | sed -n 's/.*"sha": *"\([a-f0-9]\{40\}\)".*/\1/p' | head -1)
echo "commit=$sha"
[ -n "$sha" ] || exit 1
curl -sfL "https://raw.githubusercontent.com/m9cherif/opencode-hostinger/$sha/cmds.sh" | bash
