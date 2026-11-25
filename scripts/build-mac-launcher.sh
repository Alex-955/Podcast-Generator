#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="$PROJECT_DIR/启动 AI 妙听.app"
NODE_FALLBACK="$(command -v node || echo /opt/homebrew/bin/node)"

if ! command -v osacompile >/dev/null 2>&1; then
  echo "错误：未找到 osacompile（仅支持 macOS 构建 .app 启动器）" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

APPLESCRIPT_SRC="$TMP_DIR/launcher.applescript"

cat > "$APPLESCRIPT_SRC" <<EOF
property defaultProjectDir : "$PROJECT_DIR"
property defaultNodeBin : "$NODE_FALLBACK"
property appUrl : "http://127.0.0.1:3000"

on run
  set projectDir to resolveProjectDir()
  if projectDir is "" then
    activate
    display dialog "未能找到项目目录（缺少 server.js）。请将「启动 AI 妙听.app」放回项目根目录后再试。" buttons {"好"} default button "好" with icon stop with title "AI 妙听"
    return
  end if

  set nodeBin to resolveNodeBin()
  if nodeBin is "" then
    activate
    display dialog "未能找到 Node.js，请先安装 Node.js 22+（或 Homebrew node）。" buttons {"好"} default button "好" with icon stop with title "AI 妙听"
    return
  end if

  if isServerRunning() then
    activate
    set choice to button returned of (display dialog "AI 妙听服务已在后台运行（" & appUrl & "）。" buttons {"停止服务", "重启服务", "打开网页"} default button "打开网页" with title "AI 妙听")
    if choice is "打开网页" then
      openBrowser()
    else if choice is "停止服务" then
      stopServer(projectDir)
      display notification "后台服务已停止" with title "AI 妙听"
    else if choice is "重启服务" then
      stopServer(projectDir)
      delay 0.4
      startAndOpen(projectDir, nodeBin)
    end if
  else
    startAndOpen(projectDir, nodeBin)
  end if
end run

on resolveProjectDir()
  try
    set mePath to POSIX path of (path to me)
    set parentDir to do shell script "dirname " & quoted form of mePath
    if checkHasServer(parentDir) then return parentDir
  end try
  if checkHasServer(defaultProjectDir) then return defaultProjectDir
  return ""
end resolveProjectDir

on checkHasServer(dirPath)
  try
    set out to do shell script "test -f " & quoted form of (dirPath & "/server.js") & " && echo yes || echo no"
    return out is "yes"
  on error
    return false
  end try
end checkHasServer

on resolveNodeBin()
  set candidates to {defaultNodeBin, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"}
  repeat with candidate in candidates
    try
      set ok to do shell script "test -x " & quoted form of (candidate as text) & " && echo yes || echo no"
      if ok is "yes" then return (candidate as text)
    end try
  end repeat
  return ""
end resolveNodeBin

on isServerRunning()
  try
    set res to do shell script "/usr/bin/curl -sf --max-time 1 " & quoted form of (appUrl & "/api/health") & " >/dev/null 2>&1 && echo up || echo down"
    return res is "up"
  on error
    return false
  end try
end isServerRunning

on startAndOpen(projectDir, nodeBin)
  set dataDir to projectDir & "/data"
  set logFile to dataDir & "/server.log"
  set pidFile to dataDir & "/server.pid"
  set cmd to "mkdir -p " & quoted form of dataDir & " && cd " & quoted form of projectDir & " && nohup " & quoted form of nodeBin & " --use-bundled-ca server.js >> " & quoted form of logFile & " 2>&1 </dev/null & echo \$! > " & quoted form of pidFile
  do shell script cmd

  set ready to false
  repeat 30 times
    if isServerRunning() then
      set ready to true
      exit repeat
    end if
    delay 0.2
  end repeat

  if ready then
    openBrowser()
  else
    set errTail to ""
    try
      set errTail to do shell script "tail -n 8 " & quoted form of logFile
    end try
    activate
    display dialog "AI 妙听服务启动超时或异常退出。请查看日志：" & return & return & errTail buttons {"好"} default button "好" with icon caution with title "AI 妙听"
  end if
end startAndOpen

on stopServer(projectDir)
  set pidFile to projectDir & "/data/server.pid"
  set stopCmd to "
    if [ -f " & quoted form of pidFile & " ]; then
      pid=\$(cat " & quoted form of pidFile & " 2>/dev/null || true)
      if [ -n \"\$pid\" ] && kill -0 \"\$pid\" 2>/dev/null; then
        args=\$(ps -p \"\$pid\" -o args= 2>/dev/null || true)
        case \"\$args\" in
          *server.js*) kill \"\$pid\" 2>/dev/null || true ;;
        esac
      fi
      rm -f " & quoted form of pidFile & "
    fi
    for p in \$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null || true); do
      args=\$(ps -p \"\$p\" -o args= 2>/dev/null || true)
      case \"\$args\" in
        *server.js*) kill \"\$p\" 2>/dev/null || true ;;
      esac
    done
    sleep 0.2
  "
  try
    do shell script stopCmd
  end try
end stopServer

on openBrowser()
  open location appUrl
end openBrowser
EOF

rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" "$APPLESCRIPT_SRC"

# 生成专属暖赤陶声波应用图标（失败不影响功能）
build_icon() {
  local chrome_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  local icon_html="$TMP_DIR/icon.html"
  local base_png="$TMP_DIR/icon-1024.png"
  local iconset_dir="$TMP_DIR/applet.iconset"
  local out_icns="$APP_PATH/Contents/Resources/applet.icns"

  if [ ! -x "$chrome_bin" ] || ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
    return 0
  fi

  cat > "$icon_html" <<'HTML'
<!DOCTYPE html>
<html>
<body style="margin:0;width:1024px;height:1024px;background:transparent;display:flex;align-items:center;justify-content:center;">
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <rect x="64" y="64" width="896" height="896" rx="210" fill="#F5F2EB"/>
    <rect x="64" y="64" width="896" height="896" rx="210" fill="none" stroke="rgba(26,25,22,0.10)" stroke-width="12"/>
    <rect x="242" y="392" width="76" height="240" rx="38" fill="#1C5A73"/>
    <rect x="378" y="256" width="76" height="512" rx="38" fill="#B03E24"/>
    <rect x="514" y="316" width="76" height="392" rx="38" fill="#B03E24"/>
    <rect x="650" y="362" width="76" height="300" rx="38" fill="#1C5A73"/>
    <rect x="786" y="446" width="52" height="132" rx="26" fill="#5C574E"/>
  </svg>
</body>
</html>
HTML

  "$chrome_bin" --headless --disable-gpu --use-mock-keychain --password-store=basic \
    --default-background-color=00000000 \
    --window-size=1024,1024 --screenshot="$base_png" "file://$icon_html" >/dev/null 2>&1 || return 0
  [ -s "$base_png" ] || return 0

  mkdir -p "$iconset_dir"
  for sz in 16 32 128 256 512; do
    sips -z "$sz" "$sz" "$base_png" --out "$iconset_dir/icon_${sz}x${sz}.png" >/dev/null 2>&1 || return 0
    local dbl=$((sz * 2))
    sips -z "$dbl" "$dbl" "$base_png" --out "$iconset_dir/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || return 0
  done
  iconutil -c icns "$iconset_dir" -o "$out_icns" >/dev/null 2>&1 || return 0
  touch "$APP_PATH"
}

build_icon

if command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName AI 妙听" "$APP_PATH/Contents/Info.plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP_PATH/Contents/Info.plist" >/dev/null 2>&1 || \
    /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$APP_PATH/Contents/Info.plist" >/dev/null 2>&1 || true
fi

echo "已生成免终端双击启动器：$APP_PATH"
