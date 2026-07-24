#!/usr/bin/env bash
# Costruisce l'immagine di isolamento per gli agenti sviluppatore di Hive.
# Va rilanciato solo quando cambia il Dockerfile (non a ogni deploy del codice:
# l'app è bind-montata a runtime, non copiata nell'immagine).
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -f deploy/dev-sandbox.Dockerfile -t "${AGENT_DEV_IMAGE:-hive/dev-sandbox:latest}" .
echo "Immagine pronta: ${AGENT_DEV_IMAGE:-hive/dev-sandbox:latest}"
