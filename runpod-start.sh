#!/usr/bin/env bash
set -e

# Basic config
REPO_URL="https://github.com/Entropizm/scope-prompt-engine.git"
APP_DIR="/workspace/scope-prompt-engine"
BACKEND_PORT=8000
FRONTEND_PORT=5173

# Models directory - use /workspace for persistent storage on RunPod
export DAYDREAM_SCOPE_MODELS_DIR="/workspace/.daydream-scope/models"

# Clear cache option - set CLEAR_CACHE=1 to force re-download
CLEAR_CACHE="${CLEAR_CACHE:-0}"

# Make sure PATH includes uv (if installed to ~/.local/bin)
export PATH="$HOME/.local/bin:$PATH"

echo "[runpod] Updating system packages..."
apt-get update -y
apt-get install -y git ffmpeg build-essential curl

# Install uv if missing
if ! command -v uv >/dev/null 2>&1; then
  echo "[runpod] Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# Install Node via nvm if missing
if ! command -v node >/dev/null 2>&1; then
  echo "[runpod] Installing Node via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # load nvm for this shell
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install --lts
fi

# Ensure working directory
mkdir -p /workspace
cd /workspace

# Clone or update repo
if [ ! -d "$APP_DIR" ]; then
  echo "[runpod] Cloning repo..."
  git clone "$REPO_URL"
else
  echo "[runpod] Repo exists, pulling latest..."
  cd "$APP_DIR"
  git pull
fi

cd "$APP_DIR"

echo "[runpod] Syncing Python deps with uv..."
uv sync --group dev

echo "[runpod] Installing frontend deps..."
cd frontend
npm install
cd ..

# Handle model cache
if [ "$CLEAR_CACHE" = "1" ]; then
  echo "[runpod] CLEAR_CACHE=1 detected, removing existing models..."
  rm -rf "$DAYDREAM_SCOPE_MODELS_DIR"
  mkdir -p "$DAYDREAM_SCOPE_MODELS_DIR"
fi

# Check if models exist before downloading
if [ -f "download_models.py" ]; then
  echo "[runpod] Checking for existing models at: $DAYDREAM_SCOPE_MODELS_DIR"
  
  # Check if models directory has content
  if [ -d "$DAYDREAM_SCOPE_MODELS_DIR" ] && [ "$(ls -A $DAYDREAM_SCOPE_MODELS_DIR)" ]; then
    echo "[runpod] Models directory exists and has content. Checking if complete..."
    
    # Try to verify models are complete using Python
    MODEL_CHECK=$(uv run python -c "
from lib.models_config import models_are_downloaded
import sys
pipeline = '${PIPELINE:-longlive}'
if models_are_downloaded(pipeline):
    print('complete')
else:
    print('incomplete')
" 2>/dev/null || echo "incomplete")
    
    if [ "$MODEL_CHECK" = "complete" ]; then
      echo "[runpod] ✓ Models already downloaded and verified for pipeline: ${PIPELINE:-longlive}"
    else
      echo "[runpod] ⚠ Models incomplete or verification failed. Downloading..."
      uv run python download_models.py --pipeline "${PIPELINE:-longlive}" || echo "[runpod] Model download failed."
    fi
  else
    echo "[runpod] No existing models found. Downloading..."
    mkdir -p "$DAYDREAM_SCOPE_MODELS_DIR"
    uv run python download_models.py --pipeline "${PIPELINE:-longlive}" || echo "[runpod] Model download failed."
  fi
else
  echo "[runpod] download_models.py not found, skipping model download."
fi

# Show disk usage
echo "[runpod] Disk usage for models directory:"
du -sh "$DAYDREAM_SCOPE_MODELS_DIR" 2>/dev/null || echo "No models directory yet"
df -h /workspace | grep -E '(Filesystem|/workspace)' || df -h /workspace

# Start backend
echo "[runpod] Starting backend on 0.0.0.0:${BACKEND_PORT}..."
PIPELINE="${PIPELINE:-longlive}"

uv run daydream-scope \
  --reload \
  --host 0.0.0.0 \
  --port "${BACKEND_PORT}" &
BACKEND_PID=$!

# Start frontend
echo "[runpod] Starting frontend on 0.0.0.0:${FRONTEND_PORT}..."
cd frontend
npm run dev -- --host 0.0.0.0 --port "${FRONTEND_PORT}" &
FRONTEND_PID=$!

# Wait for any process to exit
wait -n "$BACKEND_PID" "$FRONTEND_PID"
