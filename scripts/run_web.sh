#!/usr/bin/env bash
# Local production-style launch. For frontend development see README_WEB.md.
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  echo "Create the web environment first: python3.11 -m venv .venv && .venv/bin/pip install -r requirements-web.lock" >&2
  exit 1
fi
if [[ ! -f web/dist/index.html || "${BUILD:-0}" == "1" ]]; then
  (cd web && npm ci --no-audit --no-fund && npm run build)
fi
if [[ ! -f .web-data/models/kong-piano/model.onnx ]]; then
  "$PYTHON" scripts/setup_web_models.py
fi
"$PYTHON" scripts/create_demo.py
exec "$PYTHON" -m uvicorn webapp.main:app --host 0.0.0.0 --port "${PORT:-3000}" --workers 1
