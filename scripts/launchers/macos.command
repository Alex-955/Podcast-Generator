#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/scripts/start-portable.js" ]; then
  PROJECT_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../start-portable.js" ]; then
  PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  echo "错误：找不到拾声集项目。请将启动文件放回项目目录。" >&2
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

run_portable() {
  "$NODE_BIN" "$PROJECT_DIR/scripts/start-portable.js" "$@"
}

ensure_dependencies() {
  if [ -f "$PROJECT_DIR/node_modules/express/package.json" ]; then
    return
  fi
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  if ! command -v npm >/dev/null 2>&1; then
    echo "错误：找不到 npm。请安装含 npm 的 Node.js 22 或更新版本（https://nodejs.org/）。" >&2
    return 1
  fi
  echo "正在安装拾声集运行依赖…"
  npm install --omit=dev
}

if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    case "$arg" in
      --status|--stop) exec "$NODE_BIN" "$PROJECT_DIR/scripts/start-portable.js" "$@" ;;
    esac
  done
  ensure_dependencies
  exec "$NODE_BIN" "$PROJECT_DIR/scripts/start-portable.js" "$@"
fi

can_show_dialog() {
  [ -z "${CI:-}${SSH_CONNECTION:-}${SSH_TTY:-}" ] &&
    [ "$(uname -s)" = Darwin ] && [ -O /dev/console ] && command -v osascript >/dev/null 2>&1
}

dialog_choice() {
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  try
    activate
    if item 1 of argv is "2" then
      return button returned of (display dialog "拾声集服务异常，请选择操作。" buttons {"退出", "停止服务", "重启服务"} default button "重启服务" cancel button "退出" with title "拾声集")
    end if
    return button returned of (display dialog "拾声集正在运行，请选择操作。" buttons {"停止服务", "重启服务", "打开网页"} default button "打开网页" with title "拾声集")
  on error messageText number errorNumber
    if errorNumber is -128 then return "退出"
    error messageText number errorNumber
  end try
end run
APPLESCRIPT
}

status=0
run_portable --status || status=$?
case "$status" in
  0|2) ;;
  1) ensure_dependencies; run_portable --open; exit ;;
  *) exit "$status" ;;
esac

if can_show_dialog && choice="$(dialog_choice "$status" 2>/dev/null)"; then
  case "$choice" in
    '打开网页') choice=1 ;;
    '停止服务') choice=2 ;;
    '重启服务') choice=3 ;;
    '退出') exit 0 ;;
  esac
else
  if [ "$status" -eq 0 ]; then
    printf '%s\n' '[1] 打开网页（默认回车）' '[2] 停止服务' '[3] 重启服务'
  else
    printf '%s\n' '[2] 停止服务' '[3] 重启服务'
  fi
  IFS= read -r -p '请选择操作：' choice || exit 0
  if [ -z "$choice" ] && [ "$status" -eq 0 ]; then
    choice=1
  fi
fi

case "$choice" in
  1)
    if [ "$status" -ne 0 ]; then
      echo '请选择 2 或 3。'
      exit 0
    fi
    ;;
  2) run_portable --stop; exit ;;
  3) run_portable --stop ;;
  *) echo '未选择有效操作，已退出。'; exit 0 ;;
esac
ensure_dependencies
run_portable --open
