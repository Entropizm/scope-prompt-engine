#!/usr/bin/env bash

set -euo pipefail

echo "🚀 Starting Daydream Scope runtime"

DAYDREAM_SCOPE_MODELS_DIR="${DAYDREAM_SCOPE_MODELS_DIR:-/workspace/models}"
mkdir -p "${DAYDREAM_SCOPE_MODELS_DIR}"
echo "📁 Models directory: ${DAYDREAM_SCOPE_MODELS_DIR}"

AUTO_DOWNLOAD_MODELS="${AUTO_DOWNLOAD_MODELS:-1}"
PIPELINE_ENV="${PIPELINE:-longlive}"
MODEL_PIPELINES="${MODEL_PIPELINES:-${PIPELINE_ENV}}"

ensure_models_for_pipeline() {
  local pipeline="$1"
  if [[ -z "${pipeline}" ]]; then
    return
  fi

  pipeline="$(echo "${pipeline}" | tr '[:upper:]' '[:lower:]' | xargs)"
  if [[ "${pipeline}" == "none" ]]; then
    return
  fi

  echo "🔍 Checking models for pipeline: ${pipeline}"
  if CHECK_PIPELINE="${pipeline}" uv run python -c "import os, sys; from lib.models_config import models_are_downloaded; pipeline = os.environ.get('CHECK_PIPELINE'); pipeline = None if pipeline in ('', 'all', None) else pipeline; sys.exit(0 if models_are_downloaded(pipeline) else 1)"; then
    echo "✅ Models already present for ${pipeline}"
  else
    echo "⬇️  Downloading models for ${pipeline}"
    uv run download_models --pipeline "${pipeline}"
  fi
}

if [[ "${AUTO_DOWNLOAD_MODELS}" == "1" ]]; then
  IFS=',' read -ra pipeline_array <<< "${MODEL_PIPELINES}"
  for pipeline in "${pipeline_array[@]}"; do
    ensure_models_for_pipeline "${pipeline}"
  done
else
  echo "⚠️  AUTO_DOWNLOAD_MODELS disabled; ensure weights are already mounted."
fi

HOST_BIND="${HOST:-0.0.0.0}"
PORT_BIND="${PORT:-8000}"

echo "🌐 Launching API on ${HOST_BIND}:${PORT_BIND}"
exec uv run app.py --host "${HOST_BIND}" --port "${PORT_BIND}"
