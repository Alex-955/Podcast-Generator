#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/start-portable.js" ]; then
  PROJECT_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../start-portable.js" ]; then
  PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  echo "错误：找不到 AI 妙听项目。请将启动文件放回项目目录。" >&2
  exit 1
fi

NODE_BIN=""
for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" "$HOME/.fnm/current/bin/node"; do
  if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)' 2>/dev/null; then
    NODE_BIN="$candidate"
    break
  fi
done
if [ -z "$NODE_BIN" ]; then
  echo "错误：请先安装 Node.js 22 或更新版本（https://nodejs.org/），然后重新打开启动器。" >&2
  exit 1
fi

cd "$PROJECT_DIR"
case "${1:---open}" in
  --status|--stop) ;;
  *)
    if [ ! -f "$PROJECT_DIR/node_modules/express/package.json" ]; then
      export PATH="$(dirname "$NODE_BIN"):$PATH"
      if ! command -v npm >/dev/null 2>&1; then
        echo "错误：找不到 npm。请安装含 npm 的 Node.js 22 或更新版本（https://nodejs.org/）。" >&2
        exit 1
      fi
      echo "正在安装 AI 妙听运行依赖…"
      npm install --omit=dev
    fi
    ;;
esac
if [ "$#" -eq 0 ]; then
  set -- --open
fi
exec "$NODE_BIN" "$PROJECT_DIR/scripts/start-portable.js" "$@"
