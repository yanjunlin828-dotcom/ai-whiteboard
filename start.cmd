@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\@excalidraw\excalidraw\package.json" (
  echo Project dependencies are missing. See the usage guide.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo Build is missing. Run npm run build first.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:48765 in your browser.
echo Keep this window open. Press Ctrl+C to stop this server.
node server\main.mjs
if errorlevel 1 pause
