#!/usr/bin/env bash
# Ricompila e pubblica il bundle del runner sul server (install + auto-update).
# Da rilanciare quando cambia il codice del runner o si aggiorna l'SDK Claude.
set -euo pipefail
cd "$(dirname "$0")/.."
DL="${HIVE_DOWNLOAD_ROOT:-/srv/hive/downloads}"
npm run -w @hive/shared build >/dev/null
npm run -w @hive/agent-runtime build >/dev/null
SDKVER=$(node -e "console.log(require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)")
VER="${1:-$(node -e 'console.log(new Date().toISOString().slice(0,16).replace(/[-:T]/g,""))')}"
TMP=$(mktemp -d)
node_modules/.bin/esbuild apps/agent-runtime/dist/run-runner.js \
  --bundle --platform=node --format=esm --target=node22 \
  --external:@anthropic-ai/claude-agent-sdk --outfile="$TMP/runner.mjs" >/dev/null
cat > "$TMP/package.json" <<PKG
{ "name": "hive-runner", "version": "$VER", "private": true, "type": "module",
  "dependencies": { "@anthropic-ai/claude-agent-sdk": "$SDKVER" } }
PKG
echo "$VER" > "$TMP/VERSION"
tar -czf "$DL/hive-runner.tar.gz" -C "$TMP" .
echo "$VER" > "$DL/runner-version"
rm -rf "$TMP"
echo "Runner $VER pubblicato (Claude Code SDK $SDKVER) → $DL"
