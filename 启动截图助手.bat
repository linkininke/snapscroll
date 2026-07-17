@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "E:\截图文件" mkdir "E:\截图文件"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [截图助手] 正在安装依赖...
  call npm install
)

if not exist "out\main\index.js" (
  echo [截图助手] 正在编译...
  call npm run build
)

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo [截图助手] 未找到 Electron，启动失败
  pause
  exit /b 1
)

start "" "%ELECTRON_EXE%" "%~dp0" --silent
exit /b 0
