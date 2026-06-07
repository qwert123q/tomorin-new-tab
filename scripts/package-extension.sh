#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(cd "$ROOT_DIR" && python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path("extension/manifest.json").read_text())["version"])
PY
)"
OUT_DIR="$ROOT_DIR/dist"
PACKAGE="$OUT_DIR/tomorin-new-tab-$VERSION.zip"

mkdir -p "$OUT_DIR"
rm -f "$PACKAGE"

(
  cd "$ROOT_DIR/extension"
  zip -r "$PACKAGE" . -x "*.DS_Store"
)

echo "$PACKAGE"
