@echo off
chcp 65001 >nul
if "%~1"=="" (
  echo 用法: 把文件拖到这个 .bat 上，或运行 watch.mjs 常驻监听
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 18+ 并添加到 PATH
  pause
  exit /b 1
)
node "%~dp0watch.mjs" --once "%~1"
if errorlevel 1 pause
