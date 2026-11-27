#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FINAL_APP_PATH="$PROJECT_DIR/拾声集.app"
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
APP_PATH="$TMP_DIR/拾声集.app"
APPLESCRIPT_SRC="$TMP_DIR/launcher.applescript"

# Finder uses the same portable launcher and Node/CA detection as the .command file.
escaped_dir="$(printf '%s' "$FALLBACK_PROJECT_DIR" | sed 's/[\\"]/\\&/g')"
printf 'property defaultProjectDir : "%s"\n' "$escaped_dir" > "$APPLESCRIPT_SRC"
cat >> "$APPLESCRIPT_SRC" <<'APPLESCRIPT'
on run
  set launcherPath to resolveLauncher()
  if launcherPath is "" then
    activate
    display dialog "未能找到便携启动脚本。请将「拾声集.app」放回项目根目录后再试。" buttons {"好"} default button "好" with icon stop with title "拾声集"
    return
  end if

  try
    set {statusCode, detail} to getServerStatus(launcherPath)
    activate
    if statusCode is 0 then
      set actionChoice to button returned of (display dialog (detail & return & return & "请选择操作：") buttons {"停止服务", "重启服务", "打开网页"} default button "打开网页" with title "拾声集")
    else if statusCode is 2 then
      set actionChoice to button returned of (display dialog (detail & return & return & "服务异常或未就绪，可直接停止或重启：") buttons {"退出", "停止服务", "重启服务"} default button "停止服务" with title "拾声集")
    else
      set actionChoice to button returned of (display dialog "拾声集服务当前未启动。" buttons {"退出", "启动服务"} default button "启动服务" with title "拾声集")
    end if
    if actionChoice is "退出" then return

    if actionChoice is "停止服务" or actionChoice is "重启服务" then
      set stopOutput to runLauncher(launcherPath, "--stop")
      if stopOutput does not contain "拾声集已停止" then
        activate
        display dialog stopOutput buttons {"好"} default button "好" with title "拾声集"
        return
      end if
      if actionChoice is "停止服务" then
        activate
        display dialog "拾声集后台服务已停止。" buttons {"好"} default button "好" with title "拾声集"
        return
      end if
    end if
    runLauncher(launcherPath, "--open")
  on error errorMessage number errorNumber
    if errorNumber is not -128 then
      activate
      display dialog ("拾声集操作失败。" & return & errorMessage) buttons {"好"} default button "好" with icon caution with title "拾声集"
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
  set launcherPath to dirPath & "/scripts/launchers/macos.command"
  try
    do shell script "test -f " & quoted form of launcherPath
    return launcherPath
  on error
    return ""
  end try
end findLauncher

on getServerStatus(launcherPath)
  try
    return {0, runLauncher(launcherPath, "--status")}
  on error errorMessage number errorNumber
    if errorNumber is 2 then return {2, errorMessage}
    if errorNumber is 1 and errorMessage contains "拾声集未在运行" then return {1, ""}
    error errorMessage number errorNumber
  end try
end getServerStatus

on runLauncher(launcherPath, actionFlag)
  return do shell script "/bin/bash " & quoted form of launcherPath & " " & quoted form of actionFlag
end runLauncher
APPLESCRIPT

osacompile -o "$APP_PATH" "$APPLESCRIPT_SRC"

# Use the desktop icon in the repository, or the shipped PNG in a portable archive.
build_icon() {
  local iconset_dir="$TMP_DIR/applet.iconset"
  local out_icns="$APP_PATH/Contents/Resources/applet.icns"
  local base_png="$PROJECT_DIR/public/icon.png"

  if [ -f "$PROJECT_DIR/build/icon.icns" ]; then
    cp "$PROJECT_DIR/build/icon.icns" "$out_icns"
    return
  fi

  mkdir -p "$iconset_dir"
  for sz in 16 32 128 256 512; do
    sips -z "$sz" "$sz" "$base_png" --out "$iconset_dir/icon_${sz}x${sz}.png" >/dev/null
    local dbl=$((sz * 2))
    sips -z "$dbl" "$dbl" "$base_png" --out "$iconset_dir/icon_${sz}x${sz}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset_dir" -o "$out_icns" >/dev/null
  touch "$APP_PATH"
}

build_icon
touch "$APP_PATH/Contents/Resources/inkcast-launcher"

if command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName 拾声集" "$APP_PATH/Contents/Info.plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP_PATH/Contents/Info.plist" >/dev/null 2>&1 || \
    /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$APP_PATH/Contents/Info.plist" >/dev/null 2>&1 || true
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_PATH"
  codesign --verify --deep --strict "$APP_PATH"
fi

if [ -e "$FINAL_APP_PATH" ] || [ -L "$FINAL_APP_PATH" ]; then
  if [ -L "$FINAL_APP_PATH" ] || [ ! -f "$FINAL_APP_PATH/Contents/Resources/inkcast-launcher" ]; then
    echo "同名应用已存在，请先将其移出项目目录。" >&2
    exit 1
  fi
  mv "$FINAL_APP_PATH" "$TMP_DIR/previous.app"
fi
if ! mv "$APP_PATH" "$FINAL_APP_PATH"; then
  if [ -d "$TMP_DIR/previous.app" ]; then mv "$TMP_DIR/previous.app" "$FINAL_APP_PATH"; fi
  exit 1
fi
echo "已生成拾声集服务控制应用：$FINAL_APP_PATH"
