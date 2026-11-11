# Authenticator for Windows

A simple, fast TOTP (time-based one-time password) authenticator — "Google
Authenticator, but for Windows". Built with Tauri 2 (Rust + WebView2), so the
release binary is small and starts instantly.

## Features

- 30-second time-based codes (RFC 6238), SHA-1 / SHA-256 / SHA-512, 6 or 8
  digits, configurable period — everything Google Authenticator and most
  other apps (Aegis, Authy, Microsoft Authenticator, 1Password, ...) export
  via the standard `otpauth://totp/...` QR format.
- **Three ways to scan a QR code:**
  1. **Upload image** — pick a PNG/JPG/WebP/BMP/GIF file containing the QR.
  2. **Screenshot screen** — captures every connected monitor and finds any
     authenticator QR code automatically.
  3. **Live on-screen finder** — opens a translucent always-on-top frame you
     drag (and resize from its corner) over the QR shown in another app or
     browser window; it scans continuously and grabs the code the moment it
     recognizes one.
- **Manual entry** — paste a Base32 secret (or type it from the "can't scan?"
  screen of any app).
- **Edit / reorder / delete** accounts (hover an account row for the controls).
- **Click a code to copy** it to the clipboard.
- **Pinned mini window** — a small always-on-top window showing just your
  codes; toggle "always on top" off with its pin button.
- **Export / Import** JSON backup files to move accounts between PCs.
- 30 s countdown ring per account; codes turn red in the final 5 seconds.

## Build it (one click)

Requirements, one-time:

1. **Rust** — install from <https://rustup.rs>.
2. **Visual Studio Build Tools** with the *"Desktop development with C++"*
   workload — <https://visualstudio.microsoft.com/visual-cpp-build-tools/>.
3. WebView2 Runtime — already included in Windows 10/11 by default.

Then double-click **`build.bat`**. The first build downloads all Rust crates
and takes roughly 5-15 minutes; after that it is fast. When it finishes you
get:

```
Authenticator.exe        <- portable, no install needed
```

To run in development mode instead, use **`dev.bat`**.

To additionally produce a proper NSIS installer, run inside `src-tauri`:

```
cargo install tauri-cli --locked
cargo tauri build
```

The installer appears in `src-tauri/target/release/bundle/nsis/`.

## Project layout

```
windows-authenticator/
├── build.bat / dev.bat        one-click build / run scripts
├── ui/                        frontend (plain HTML/CSS/JS, no bundler)
│   ├── index.html
│   ├── app.js                 TOTP engine, UI logic, overlay + pin windows
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/                 app icons (generated)
    └── src/main.rs            storage, otpauth parsing, QR decoding, screen capture
```

## Where are my accounts stored?

In plain JSON (as configured), next to nothing else is written:

```
%APPDATA%\com.authenticator.app\accounts.json
```

Warning: this file contains the Base32 secrets **unencrypted**, exactly like
you asked. Anyone with access to your Windows user account (or a backup of
your profile) can read them. If you ever want them protected, the easiest
upgrade is Windows DPAPI encryption of that file in `src/main.rs`.

## Backup files

`Export` writes a JSON file like:

```json
{
  "app": "windows-authenticator",
  "version": 1,
  "exportedAt": 1731400000,
  "accounts": [ { "id": "...", "issuer": "Google", "label": "you@gmail.com",
                  "secret": "JBSWY3DPEHPK3PXP", "algorithm": "SHA1",
                  "digits": 6, "period": 30, "color": "#4f8cff" } ]
}
```

`Import` merges it, skipping duplicates.

## Notes & limitations

- Import QR codes from other apps (Google Authenticator export, Aegis,
  Authy...) work because they use the same `otpauth://totp` scheme.
- **Steam Guard** (`otpauth://steam/`) uses a proprietary alphabet and is not
  supported.
- The live overlay scans the monitor the frame is currently on; place the
  frame over the QR shown anywhere on that monitor.
- The overlay frame itself is excluded from what matters: it only draws a
  thin border around the code, the interior stays transparent.
- Codes are computed locally on your PC. Nothing ever leaves the machine.
