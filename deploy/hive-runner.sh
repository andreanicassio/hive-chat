#!/usr/bin/env bash
# Avvia Hive come RUNNER LOCALE. Gli agenti "local" di cui sei proprietario
# girano su questa macchina. Ctrl-C per fermarlo (torneranno offline).
set -euo pipefail
cd "$(dirname "$0")/.."
ENVFILE="${1:-deploy/runner.env}"
if [ ! -f "$ENVFILE" ]; then
  echo "Config non trovata: $ENVFILE"
  echo "Copia deploy/runner.env.example in $ENVFILE e compilalo."
  exit 1
fi
if [ ! -f apps/agent-runtime/dist/index.js ]; then
  echo "Manca la build. Esegui: npm install && npm run build"
  exit 1
fi
set -a; . "$ENVFILE"; set +a
if [ -z "${HIVE_RUNNER_USER_ID:-}" ]; then
  echo "HIVE_RUNNER_USER_ID non impostato in $ENVFILE"; exit 1
fi
echo "Avvio del runner per l'utente $HIVE_RUNNER_USER_ID …"
exec node apps/agent-runtime/dist/index.js
