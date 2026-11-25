#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/start-portable.js" ]; then
  START="$SCRIPT_DIR/scripts/launchers/start-macos.command"
elif [ -f "$SCRIPT_DIR/../start-portable.js" ]; then
  START="$SCRIPT_DIR/start-macos.command"
else
  echo "错误：找不到 AI 妙听项目。请将停止文件放回项目目录。" >&2
  exit 1
fi

exec /bin/bash "$START" --stop
