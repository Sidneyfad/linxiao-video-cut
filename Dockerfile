# syntax=docker/dockerfile:1
# Production image for the video-use web app.
# Bundles Node 20 + ffmpeg + Python 3.12. Native agent calls the Anthropic
# API directly via @anthropic-ai/sdk (pure HTTP) — no platform-specific
# native binaries to wrangle. Slim base is fine again.

# Node 22+ required: lib/agent.js uses fs/promises.glob() which was added
# in Node 22.0. Sticking with 20 throws SyntaxError on import at startup.
FROM node:22-bookworm-slim

# System deps: ffmpeg for editing, python for the skill helpers, build tools
# for native Python packages, curl for healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-venv \
      python3-pip \
      build-essential \
      pkg-config \
      libsndfile1 \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-fund --no-audit

# Copy the rest of the app
COPY . .

# Set up the video-use skill's Python venv.
#
# --prefer-binary forces pip to use pre-built wheels and skip source compile,
# which matters because librosa pulls in scipy (compiling from source on a
# 0.1 vCPU container can take 10+ minutes and bust Render's build window).
#
# The whole step is wrapped in `|| true` so that if pip somehow can't fetch
# wheels (rare network blip during build), we still ship a working server.
# The agent's Bash tool can retry the install at runtime if needed.
RUN python3 -m venv vendor/video-use/.venv \
 && vendor/video-use/.venv/bin/pip install --no-cache-dir --upgrade pip wheel setuptools \
 && (vendor/video-use/.venv/bin/pip install --no-cache-dir --prefer-binary -e vendor/video-use \
     || (echo '[WARN] Python venv install failed during build — agent can reinstall on first use' >&2 \
         && rm -rf vendor/video-use/.venv \
         && python3 -m venv vendor/video-use/.venv))

# Persistent volume for sessions (Render mounts a disk to this path)
RUN mkdir -p /data/sessions
ENV SESSIONS_DIR=/data/sessions
VOLUME ["/data"]

EXPOSE 3000
ENV PORT=3000 NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=4s CMD curl -fsS http://localhost:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
