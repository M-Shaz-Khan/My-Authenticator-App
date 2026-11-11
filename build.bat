@echo off
setlocal
cd /d "%~dp0"
title Authenticator build

rem ---------------------------------------------------------------
rem  One-click build: produces a portable Authenticator.exe
rem  Requirements (checked below):
rem    1. Rust            https://rustup.rs
rem    2. VS Build Tools  "Desktop development with C++" workload
rem       https://visualstudio.microsoft.com/visual-cpp-build-tools/
rem ---------------------------------------------------------------

where cargo >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Rust was not found on this PC.
  echo         1. Install Rust from https://rustup.rs
  echo         2. Install "Desktop development with C++" from
  echo            https://visualstudio.microsoft.com/visual-cpp-build-tools/
  echo         Then open a NEW terminal and run this script again.
  pause
  exit /b 1
)

echo [1/2] Building release binary...
echo       First build downloads all crates and can take 5-15 minutes.
echo.
pushd src-tauri
cargo build --release
if errorlevel 1 (
  popd
  echo.
  echo [ERROR] Build failed. See messages above.
  pause
  exit /b 1
)
popd

copy /Y "src-tauri\target\release\authenticator.exe" "Authenticator.exe" >nul
if errorlevel 1 (
  echo [ERROR] Could not copy the built exe.
  pause
  exit /b 1
)

echo.
echo [2/2] Done.
echo       Portable app : %~dp0Authenticator.exe
echo       Optional: to also build an NSIS installer, run
echo         cargo install tauri-cli --locked
echo         cargo tauri build
echo       inside the src-tauri folder.
pause
