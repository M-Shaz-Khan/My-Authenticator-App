@echo off
setlocal
cd /d "%~dp0"

where cargo >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Rust was not found. Install it from https://rustup.rs first.
  pause
  exit /b 1
)

echo Starting Authenticator in debug mode (first run compiles for a while)...
pushd src-tauri
cargo run
popd
pause
