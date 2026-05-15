#!/usr/bin/env bash
# Build and upload firmware to the ESP32 (PlatformIO).
# Run from anywhere: ./scripts/upload.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec pio run -t upload "$@"
