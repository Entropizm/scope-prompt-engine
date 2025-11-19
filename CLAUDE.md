# CLAUDE.md

## Project Overview

Daydream Scope is a real-time streaming application that combines FastAPI backend with FastRTC for WebRTC streaming and a React TypeScript frontend. The project is designed for streaming machine learning models for real-time video generation.

## Architecture

### Backend (`app.py`)
- **Framework**: FastAPI with WebRTC integration using aiortc
- **Main Components**:
  - WebRTC manager with session handling for video streaming
  - WebRTC offer/answer endpoint (`/api/v1/webrtc/offer`)
  - Health check endpoint (`/health`)
  - Root API endpoint (`/`)
  - Lifespan management for proper resource cleanup
  - Selective logging configuration (app logs at INFO, libraries at WARNING)
  - Cloudflare TURN server support for restrictive network environments

### Frontend (React TypeScript)
- **Framework**: React 19 with TypeScript, Vite build system
- **UI Library**: Tailwind CSS with custom components using Radix UI
- **Architecture**: Component-based with hooks for state management
- **Development Setup**: Vite proxy configuration for API calls to backend
- **Production Ready**: Uses relative URLs for API calls (no hardcoded backend URLs)

## Project Structure

```
scope/
├── app.py                 # FastAPI backend with WebRTC integration
├── pyproject.toml         # Python dependencies
├── lib/                   # Backend library modules
│   ├── webrtc.py          # WebRTC manager and session handling
│   ├── schema.py          # Pydantic schemas
│   ├── credentials.py     # TURN server credential management
│   └── tracks.py          # Video track processing (echo functionality)
└── frontend/              # React TypeScript frontend
    ├── src/
    │   ├── components/    # UI components
    │   ├── hooks/         # Custom React hooks
    │   ├── pages/         # Page components
    │   ├── types/         # TypeScript type definitions
    │   └── lib/           # Utility functions (API client)
    ├── package.json       # Node.js dependencies
    └── vite.config.ts     # Vite configuration with proxy setup
```

## Key Components

### Backend Components

#### WebRTC Integration (`lib/webrtc.py`)
- Uses `aiortc` library for WebRTC streaming
- Session-based management with automatic cleanup
- Video echo functionality via `EchoTrack` (receives and returns same frames)
- ICE server configuration with TURN/STUN support
- Configurable with Cloudflare or Twilio TURN servers

#### API Endpoints
- `POST /api/v1/webrtc/offer`: WebRTC offer/answer exchange
- `GET /health`: Health check with timestamp
- `GET /`: Root endpoint returning API info

#### Resource Management
- FastAPI lifespan handler for proper WebRTC manager initialization/cleanup
- Automatic session cleanup on connection failures
- Parallel session closing for efficient shutdown

### Frontend Components

#### Core Pages
- **StreamPage**: Main layout with 3-panel design (controls, video, settings)

#### UI Components
- **Header**: Application header
- **VideoOutput**: Video display with recording controls
- **InputAndControlsPanel**: Left panel for input controls
- **SettingsPanel**: Right panel for model settings
- **PromptInput**: Text input for AI prompts
- **StatusBar**: Bottom status information

#### State Management
- **useStreamState**: Custom hook managing:
  - System metrics (CPU, GPU, RAM, VRAM, FPS, latency)
  - Stream status and recording state
  - Settings (denoising steps, noise scale)
  - Prompt processing state

#### TypeScript Types
- **SystemMetrics**: Performance monitoring interface
- **StreamStatus**: Stream state and recording status
- **SettingsState**: ML model parameter configuration
- **PromptData**: Text prompt and processing state

## Dependencies

### Backend
- `fastapi>=0.116.1`: Web framework
- `aiortc>=1.13.0`: WebRTC streaming
- `uvicorn>=0.35.0`: ASGI server
- `httpx>=0.28.1`: HTTP client for TURN credentials
- `twilio>=9.8.0`: Twilio integration for TURN servers

### Frontend
- React 19 with TypeScript
- Tailwind CSS for styling
- Radix UI components (@radix-ui/react-slider, @radix-ui/react-slot)
- Vite for build tooling
- ESLint for code quality

## Development Setup

### Backend
```bash
# Set HuggingFace token for TURN server support (optional)
export HF_TOKEN=your_token_here

# Install dependencies (includes dev dependencies like ruff and pre-commit)
uv sync --group dev

# Run the application
uv run app.py
```

### Frontend
```bash
cd frontend

# Install dependencies (includes ESLint and Prettier)
npm install

# Development server (with proxy to backend on localhost:8000)
npm run dev

# Build for production
npm run build

# Lint and format code
npm run lint          # Check for linting errors
npm run lint:fix      # Fix linting errors automatically
npm run format        # Format code with Prettier
npm run format:check  # Check if code is formatted correctly
```

### Code Quality Setup

This project includes comprehensive linting and formatting setup:

#### Python (Ruff)
- **Linting**: Configured with pycodestyle, pyflakes, isort, flake8-bugbear, and more
- **Formatting**: Black-compatible formatting with 88 character line length
- **Exclusions**: Vendor directories (`*/vendor/*`) are excluded from linting and formatting
- **Ignored Rules**: B008 (FastAPI dependency injection pattern) and E501 (line length, handled by formatter)
- **Commands**:
  ```bash
  # Check and fix Python code
  uv run ruff check .          # Lint check
  uv run ruff check . --fix    # Lint and auto-fix
  uv run ruff format .         # Format code
  ```

#### Frontend (ESLint + Prettier)
- **ESLint**: TypeScript, React hooks, and React refresh rules
- **Prettier**: Consistent code formatting
- **Commands**: See frontend section above

#### Pre-commit Hooks
```bash
# Install pre-commit hooks (run once after cloning)
uv run pre-commit install

# Run hooks manually on all files
uv run pre-commit run --all-files
```

The pre-commit hooks will automatically:
- Format Python code with ruff
- Lint Python code and fix issues
- Format frontend code with Prettier
- Lint frontend code with ESLint
- Check for trailing whitespace, large files, and merge conflicts

#### Editor Integration
- **VSCode/Cursor**: Configured via `.vscode/settings.json` for auto-formatting on save
- **Any Editor**: Uses `.editorconfig` for consistent indentation and line endings
- **Recommended Extensions**: See `.vscode/extensions.json`

#### Continuous Integration
- **GitHub Actions**: Automated linting runs on all pull requests via `.github/workflows/lint.yml`
- **PR Checks**: Both Python (ruff) and frontend (ESLint + Prettier) linting must pass
- **Branch Protection**: Can be configured to require passing linting checks before merge

### Production Deployment
```bash
# Build the frontend
cd frontend
npm run build
cd ..

# Run the production server (serves both API and frontend)
uv run app.py
```

The FastAPI server will automatically detect the built frontend and serve it on the same port. Access the application at `http://localhost:8000`.

### Environment Variables
```bash
# Optional: Enable verbose logging for libraries
export VERBOSE_LOGGING=1

# Optional: HuggingFace token for Cloudflare TURN servers
export HF_TOKEN=your_token_here

# Optional: Twilio credentials for TURN servers
export TWILIO_ACCOUNT_SID=your_sid
export TWILIO_AUTH_TOKEN=your_token
```

## Features

### Current Implementation
- Real-time video streaming using WebRTC with aiortc
- Session-based WebRTC connection management
- Video echo functionality (receives video, returns same frame)
- React-based UI with modern component architecture
- **Production ready**: Single-port deployment with FastAPI serving built frontend
- **Development friendly**: Vite proxy for seamless backend integration
- Static file serving with SPA fallback routing
- Relative API URLs (no hardcoded backend URLs)
- Selective logging (app INFO, libraries WARNING)
- Proper resource cleanup with FastAPI lifespan management
- System metrics monitoring interface
- Settings panel for ML model parameters
- Prompt input system for AI models

### Planned Features (Based on Code Structure)
- Advanced ML model parameter tuning
- Recording and playback functionality
- Performance monitoring and optimization

## Configuration

### Network Configuration
- Supports Cloudflare TURN servers for restricted networks
- Requires HF_TOKEN environment variable for TURN server access
- Default server runs on 0.0.0.0:8000

### UI Configuration
- Responsive 12-column grid layout
- Customizable denoising steps (4 configurable parameters)
- Adjustable noise scale settings
- Real-time metrics display

## Technical Notes

### WebRTC Integration
- Uses aiortc for WebRTC streaming with FastAPI
- Session-based connection management with automatic cleanup
- Video processing handled through custom tracks
- ICE server configuration with TURN/STUN fallback
- Proper resource management with lifespan handlers

### Frontend Architecture
- Component-based architecture with clear separation of concerns
- Custom hooks for state management
- TypeScript for type safety
- Modern React patterns (hooks, functional components)
- Vite proxy configuration for development API calls
- Relative URLs for production deployment compatibility
- No hardcoded backend URLs in frontend code

### Logging Configuration
- Selective logging levels: app modules at INFO, libraries at WARNING
- Optional verbose mode with `VERBOSE_LOGGING` environment variable
- Structured logging format with timestamps and module names
- Prevents noisy library logs while maintaining app visibility

## Security Considerations
- TURN server integration for firewall traversal
- Token-based authentication for external services
- WebRTC secure communication protocols

## Potential Extensions
- Additional ML model pipelines
- Advanced video processing filters
- User authentication and session management
- Cloud deployment configurations
- Performance analytics and logging

---

This project serves as a foundation for real-time streaming applications with machine learning integration, providing both the infrastructure for WebRTC communication and a modern web interface for user interaction.
