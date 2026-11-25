@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion

if exist "%~dp0scripts\start-portable.js" (
    set "PROJECT_DIR=%~dp0"
) else if exist "%~dp0..\start-portable.js" (
    set "PROJECT_DIR=%~dp0..\.."
) else (
    echo 错误：找不到 AI 妙听项目。请将停止文件放回项目目录。
    goto :failure
)

where node >nul 2>&1
if errorlevel 1 goto :missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto :missing_node

node "%PROJECT_DIR%\scripts\start-portable.js" --stop
if errorlevel 1 goto :failure
exit /b 0

:missing_node
echo 错误：请先安装 Node.js 22 或更新版本，下载地址 https://nodejs.org/

:failure
pause
exit /b 1
