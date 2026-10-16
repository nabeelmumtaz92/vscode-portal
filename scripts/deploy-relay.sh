#!/bin/zsh
# Deploy the VSCode Portal relay (plus the phone web app it serves) to Railway.
# First time: run from a linked folder (railway init / railway link). Usage: scripts/deploy-relay.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.relay-deploy"
rm -rf "$OUT" && mkdir -p "$OUT/web"
cp "$ROOT/relay/server.js" "$ROOT/relay/package.json" "$OUT/"
[ -f "$ROOT/relay/package-lock.json" ] && cp "$ROOT/relay/package-lock.json" "$OUT/"
cp -R "$ROOT/extension/web/." "$OUT/web/"
cd "$OUT"
railway up --ci --service vscode-portal-relay
