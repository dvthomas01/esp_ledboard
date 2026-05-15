#!/usr/bin/env bash
# Serial monitor at 115200 baud (matches firmware Serial.begin).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec pio device monitor -b 115200 "$@"
