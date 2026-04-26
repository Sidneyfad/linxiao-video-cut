# syntax=docker/dockerfile:1
# Production image for the video-use web app.
# Bundles Node 20 + ffmpeg + Python 3.12 + the video-use skill venv.
# Render / Railway / Fly will all pick this up automatically.

FROM node:20-bookworm-slim

# System deps: ffmpeg for the editor, python for the skill helpers, build tools
# for native Python packages, git for any optional clones the agent might do,
# and curl for healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-venv \
      python3-pip \
      build-essential \
      pkg-config \
      libsndfile1 \
      git \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-fund --no-audit

# Copy the rest of the app
COPY . .

# Set up the video-use skill's Python venv
RUN python3 -m venv vendor/video-use/.venv \
 && vendor/video-use/.venv/bin/pip install --no-cache-dir --upgrade pip \
 && vendor/video-use/.venv/bin/pip install --no-cache-dir -e vendor/video-use

# Persistent volume for sessions (Render mounts a disk to this path)
RUN mkdir -p /data/sessions
ENV SESSIONS_DIR=/data/sessions
VOLUME ["/data"]

EXPOSE 3000
ENV PORT=3000 NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=4s CMD curl -fsS http://localhost:${PORT}/healthz || exit 1

CMD ["node", "server.js"]
