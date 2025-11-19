# RunPod Deployment Guide (MVP)

This document summarizes the minimum changes and configuration needed to run
`daydream-scope` (Scope mainline) on RunPod pods.

## Hardware Requirements

- **GPU**: ≥ 40 GB VRAM (H100 80 GB, RTX 6000 Ada, or similar). The LongLive and
  Krea pipelines require large KV caches and multiple large checkpoints.
- **Disk**: ≥ 200 GB NVMe volume mounted at `/workspace/models` to persist
  downloaded weights between restarts.
- **Host RAM**: 64 GB+ recommended.

## Environment Variables / Secrets

Configure these in the RunPod dashboard before boot:

| Variable | Required | Description |
| --- | --- | --- |
| `PIPELINE` | optional | Default pipeline ID (`longlive`, `krea-realtime-video`, etc.). Defaults to `longlive`. |
| `MODEL_PIPELINES` | optional | Comma-separated list of pipelines to pre-download (e.g. `longlive,krea-realtime-video`). |
| `AUTO_DOWNLOAD_MODELS` | optional | Set to `0` to skip automatic downloads (expects weights to be present already). |
| `DAYDREAM_SCOPE_MODELS_DIR` | optional | Defaults to `/workspace/models`. Adjust if you mount a different path. |
| `HF_TOKEN` | recommended | Enables Cloudflare FASTRTC TURN credentials for WebRTC clients behind NAT. |
| `ANTHROPIC_API_KEY` | optional | Powers the story-engine endpoint (falls back to mock responses when absent). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | optional | Alternate TURN provider if you prefer Twilio over HF/Cloudflare. |

> Tip: use RunPod "Secrets" so tokens never enter the Git history.

## Building the Image

1. Push the updated repository (with `start.sh`, `.dockerignore`, and the new
   readiness endpoint) to GitHub.
2. In RunPod, create a new Pod (Pro or On-Demand) using that repo's Dockerfile.
3. Attach a persistent volume at `/workspace/models`.

The Docker build now:

- Installs runtime-only Python deps via `uv sync --frozen --no-dev`.
- Builds the Vite frontend via `npm ci && npm run build`.
- Copies `start.sh` as the container entrypoint.

## Runtime Flow

`start.sh` performs the following at boot:

1. Creates `/workspace/models`.
2. Optionally downloads model weights for every entry in `MODEL_PIPELINES`
   (falls back to the `PIPELINE` env value).
3. Launches the FastAPI app via `uv run app.py --host 0.0.0.0 --port 8000`.

## Health / Readiness Probes

- `GET /health` – basic heartbeat (always returns 200 if the process is alive).
- `GET /readyz` – returns 200 only when a pipeline has finished loading. Configure
  RunPod's readiness probe to hit this endpoint.

Example pod settings:

- **Port**: 8000
- **Command**: `["/bin/bash", "/app/start.sh"]` (already the image default)
- **Readiness**: HTTP `GET /readyz` with initial delay ≥ 30 s and timeout ≥ 5 m
  (model downloads can take several minutes on first boot).
- **Liveness**: HTTP `GET /health`.

## Post-Deployment Checklist

1. Watch the pod logs until you see `🌐 Launching API...` followed by
   `INFO - Pipeline <name> loaded successfully`.
2. Verify `GET /readyz` returns `{ "status": "ready", "pipeline_loaded": true }`.
3. Call `/api/v1/models/status?pipeline_id=<pipeline>` to confirm weights exist.
4. Load the pipeline via `/api/v1/pipeline/load` (if not auto-loaded) and then
   initiate a WebRTC offer from the frontend UI to validate TURN + GPU flow.

You're now ready to expose the RunPod public endpoint or front it with your own
proxy/CDN for production traffic.
