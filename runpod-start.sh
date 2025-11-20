#!/usr/bin/env bash
set -e

# Basic config
REPO_URL="https://github.com/Entropizm/scope-prompt-engine.git"
APP_DIR="/workspace/scope-prompt-engine"
BACKEND_PORT=8000
FRONTEND_PORT=5173

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

# Optional: pre-download models
if [ -f "download_models.py" ]; then
  echo "[runpod] Downloading models..."
  uv run python download_models.py || echo "[runpod] Model download failed or skipped."
fi

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
