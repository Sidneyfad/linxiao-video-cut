#!/usr/bin/env bash
# Cross-platform-ish setup for the video-use skill's Python deps.
# Mac / Linux. Windows users: see scripts/setup.ps1.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found. Install it first:"
  echo "  Mac:   brew install python"
  echo "  Linux: apt install python3 python3-venv  (or your distro equiv)"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARN: ffmpeg not found. Install it before using video editing:"
  echo "  Mac:   brew install ffmpeg"
  echo "  Linux: apt install ffmpeg"
fi

VENV="vendor/video-use/.venv"
if [ ! -d "$VENV" ]; then
  echo "[setup] creating Python venv at $VENV"
  python3 -m venv "$VENV"
fi

echo "[setup] installing video-use Python deps"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -e vendor/video-use

echo "[setup] done. Run: npm start"
