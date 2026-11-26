@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

set "INTERACTIVE="
if [%1]==[] set "INTERACTIVE=1"

if exist "%~dp0scripts\start-portable.js" (
    set "PROJECT_DIR=%~dp0"
) else if exist "%~dp0..\start-portable.js" (
    set "PROJECT_DIR=%~dp0..\.."
) else (
    echo 错误：找不到 AI 妙听项目。请将启动文件放回项目目录。
    goto :failure
)

where node >nul 2>&1
if errorlevel 1 goto :missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto :missing_node

pushd "%PROJECT_DIR%"
if errorlevel 1 goto :failure
if defined INTERACTIVE goto :status

:scan_args
if [%1]==[] goto :cli_with_deps
if "%~1"=="--status" goto :run_cli
if "%~1"=="--stop" goto :run_cli
shift /1
goto :scan_args

:cli_with_deps
call :ensure_dependencies
if errorlevel 1 goto :finish

:run_cli
rem SHIFT leaves the original argument list in %%*.
node "scripts\start-portable.js" %*
goto :finish

:status
node "scripts\start-portable.js" --status
if errorlevel 3 goto :finish
if errorlevel 2 goto :unhealthy
if errorlevel 1 goto :open

echo [1] 打开网页（直接回车默认）
echo [2] 停止服务
echo [3] 重启服务
set "DEFAULT_CHOICE=1"
goto :menu

:unhealthy
echo [2] 停止服务
echo [3] 重启服务
set "DEFAULT_CHOICE="

:menu
call :read_choice
if errorlevel 3 goto :restart
if errorlevel 2 goto :stop
if errorlevel 1 goto :open
goto :finish

:restart
node "scripts\start-portable.js" --stop
if errorlevel 1 goto :finish

:open
call :ensure_dependencies
if errorlevel 1 goto :finish
node "scripts\start-portable.js" --open
goto :finish

:stop
node "scripts\start-portable.js" --stop

:finish
set "RESULT=%errorlevel%"
popd
if defined INTERACTIVE if not "%RESULT%"=="0" pause
exit /b %RESULT%

:missing_node
echo 错误：请先安装 Node.js 22 或更新版本，下载地址 https://nodejs.org/

:failure
if defined INTERACTIVE pause
exit /b 1

:ensure_dependencies
if exist "node_modules\express\package.json" exit /b 0
where npm >nul 2>&1
if errorlevel 1 (
    echo 错误：找不到 npm。请安装含 npm 的 Node.js 22 或更新版本。
    exit /b 1
)
echo 正在安装 AI 妙听运行依赖…
call npm install --omit=dev
exit /b %errorlevel%

:read_choice
rem Delayed expansion keeps console input out of cmd's metacharacter parsing.
setlocal EnableDelayedExpansion
set "CHOICE=%DEFAULT_CHOICE%"
set /p "CHOICE=请选择操作："
if "!CHOICE!"=="1" if defined DEFAULT_CHOICE exit /b 1
if "!CHOICE!"=="2" exit /b 2
if "!CHOICE!"=="3" exit /b 3
echo 未选择有效操作，已退出。
exit /b 0
