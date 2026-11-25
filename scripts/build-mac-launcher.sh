#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FINAL_APP_PATH="$PROJECT_DIR/启动 AI 妙听.app"
FALLBACK_PROJECT_DIR="$PROJECT_DIR"

if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 1 ] || [ "$1" != "--portable" ]; then
    echo "用法：bash scripts/build-mac-launcher.sh [--portable]" >&2
    exit 1
  fi
  FALLBACK_PROJECT_DIR=""
fi

if ! command -v osacompile >/dev/null 2>&1; then
  echo "错误：未找到 osacompile（仅支持 macOS 构建 .app 启动器）" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
APP_PATH="$TMP_DIR/启动 AI 妙听.app"
APPLESCRIPT_SRC="$TMP_DIR/launcher.applescript"

# Finder uses the same portable launcher and Node/CA detection as the .command file.
escaped_dir="$(printf '%s' "$FALLBACK_PROJECT_DIR" | sed 's/[\\"]/\\&/g')"
printf 'property defaultProjectDir : "%s"\n' "$escaped_dir" > "$APPLESCRIPT_SRC"
cat >> "$APPLESCRIPT_SRC" <<'APPLESCRIPT'
on run
  set launcherPath to resolveLauncher()
  if launcherPath is "" then
    activate
    display dialog "未能找到便携启动脚本。请将「启动 AI 妙听.app」放回项目根目录后再试。" buttons {"好"} default button "好" with icon stop with title "AI 妙听"
    return
  end if

  try
    set actionChoice to "打开网页"
    if isServerRunning(launcherPath) then
      activate
      set actionChoice to button returned of (display dialog "AI 妙听服务已在后台运行。" buttons {"停止服务", "重启服务", "打开网页"} default button "打开网页" with title "AI 妙听")
    end if
    if actionChoice is "停止服务" or actionChoice is "重启服务" then
      set stopOutput to runLauncher(launcherPath, "--stop")
      if stopOutput contains "AI 妙听已停止" then
        if actionChoice is "停止服务" then
          display notification "后台服务已停止" with title "AI 妙听"
          return
        end if
      else
        activate
        display dialog stopOutput buttons {"好"} default button "好" with title "AI 妙听"
        return
      end if
    end if
    runLauncher(launcherPath, "--open")
  on error errorMessage number errorNumber
    if errorNumber is not -128 then
      activate
      display dialog ("AI 妙听操作失败。" & return & errorMessage) buttons {"好"} default button "好" with icon caution with title "AI 妙听"
    end if
  end try
end run

on resolveLauncher()
  set parentDir to do shell script "/usr/bin/dirname " & quoted form of (POSIX path of (path to me))
  set launcherPath to findLauncher(parentDir)
  if launcherPath is "" and defaultProjectDir is not "" then set launcherPath to findLauncher(defaultProjectDir)
  return launcherPath
end resolveLauncher

on findLauncher(dirPath)
  set launcherPath to dirPath & "/scripts/launchers/start-macos.command"
  try
    do shell script "test -f " & quoted form of launcherPath
    return launcherPath
  on error
    return ""
  end try
end findLauncher

on isServerRunning(launcherPath)
  try
    runLauncher(launcherPath, "--status")
    return true
  on error
    return false
  end try
end isServerRunning

on runLauncher(launcherPath, actionFlag)
  return do shell script "/bin/bash " & quoted form of launcherPath & " " & quoted form of actionFlag
end runLauncher
APPLESCRIPT

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

rm -rf "$FINAL_APP_PATH"
mv "$APP_PATH" "$FINAL_APP_PATH"
echo "已生成免终端双击启动器：$FINAL_APP_PATH"
