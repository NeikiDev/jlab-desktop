# JLab Desktop

[![License: MIT or Apache-2.0](https://img.shields.io/badge/license-MIT%20or%20Apache--2.0-blue.svg)](#license)
[![Latest release](https://img.shields.io/github/v/release/NeikiDev/jlab-desktop?display_name=tag&sort=semver)](https://github.com/NeikiDev/jlab-desktop/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/NeikiDev/jlab-desktop/ci.yml?branch=main&label=ci)](https://github.com/NeikiDev/jlab-desktop/actions/workflows/ci.yml)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#download)

Native desktop client for the public [JLab static JAR scanner](https://jlab.threat.rip). Drop a `.jar` (or a `.zip`, `.mcpack`, or `.mrpack` that contains one), the app uploads the file to the JLab API and shows the matched signatures grouped by severity. The HTTP upload runs in Rust, so no file bytes leak through the JavaScript layer.

<img width="2584" height="1786" alt="image" src="https://github.com/user-attachments/assets/ef43889f-4608-4eda-a850-8fc6abc9d291" />

## Features

- Drag and drop a `.jar`, `.zip`, `.mcpack`, or `.mrpack`. For container archives, the largest inner `.jar` is extracted and scanned.
- Native multipart upload from Rust (`reqwest` + `rustls`). No browser fetch on the hot path.
- Strict CSP. The webview can only talk to the Rust side. No outbound network from JavaScript.
- Severity-grouped signature view (`critical`, `high`, `medium`, `low`, `info`) with file metadata, family tags, and a copy-friendly card layout.
- Inline error banner with a live `Retry-After` countdown for rate limits (HTTP 429).
- Local size validation (50 MB) and zip-magic check before any network call.
- Cancellable scans, phase-aware progress UI with a live event log.
- Local scan history (last 100 scans, summary only). Stored on your device, never uploaded. File bytes and signature payloads are not persisted.
- Small (well under 10 MB), starts fast, no analytics, no auth. The header status indicator pings `jlab.threat.rip/api/stats` once on launch and then once a minute while the window is visible. Each scan also fetches `jlab.threat.rip/api/public/threat-intel/<sha256>` to enrich the report. See [SECURITY.md](SECURITY.md#network-surface) for the full list of outbound endpoints.

## Download

Pre-built installers are published on the GitHub Releases page on every push to `main`.

- macOS (universal, Apple Silicon and Intel): `JLab.Desktop_x.y.z_universal.dmg`
- Windows (MSI): `JLab.Desktop_x.y.z_x64_en-US.msi`
- Linux (Debian / Ubuntu): `JLab.Desktop_x.y.z_amd64.deb`
- Linux (Fedora / RHEL / openSUSE): `JLab.Desktop-x.y.z-1.x86_64.rpm`
- Linux (universal): `JLab.Desktop_x.y.z_amd64.AppImage`

[Download the latest release](https://github.com/NeikiDev/jlab-desktop/releases/latest).

### First run on macOS

The current builds are not yet signed with an Apple Developer ID. macOS Gatekeeper will warn that the app is from an unidentified developer or that the app is "damaged". This is expected for an unsigned binary downloaded from the internet.

Use one of these to allow the app:

1. Right-click the app in `Applications`, choose `Open`, then confirm the dialog. macOS remembers the choice.
2. Or remove the quarantine attribute from a terminal:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/JLab Desktop.app"
   ```

Signed builds will land in a later release.

### First run on Windows

The current builds are not signed with a code-signing certificate. Windows SmartScreen will show "Windows protected your PC". Click `More info`, then `Run anyway`. Windows remembers the choice for that file.

Signed builds will land in a later release.

### First run on Linux

The Linux bundles are built on Ubuntu 24.04 against `webkit2gtk-4.1` and target `x86_64`. Pick the format that matches your distro:

- Debian / Ubuntu (and derivatives like Mint, Pop!\_OS):

  ```bash
  sudo apt install ./JLab.Desktop_x.y.z_amd64.deb
  ```

- Fedora / RHEL / openSUSE:

  ```bash
  sudo dnf install ./JLab.Desktop-x.y.z-1.x86_64.rpm
  # or, on openSUSE:
  sudo zypper install ./JLab.Desktop-x.y.z-1.x86_64.rpm
  ```

- Anything else (Arch, NixOS, immutable distros, etc.) via AppImage:

  ```bash
  chmod +x JLab.Desktop_x.y.z_amd64.AppImage
  ./JLab.Desktop_x.y.z_amd64.AppImage
  ```

  AppImage needs FUSE on the host. On Ubuntu 24.04 install `libfuse2t64`; on older distros install `libfuse2`. On systems without FUSE you can extract and run instead:

  ```bash
  ./JLab.Desktop_x.y.z_amd64.AppImage --appimage-extract-and-run
  ```

The Linux builds are not signed. There is no Linux-equivalent of Gatekeeper or SmartScreen, so installs proceed normally, but verify the SHA-256 against the GitHub Release page if you want a signature-style check.

## Updates

Updates are manual. The app checks the GitHub releases API once on startup and, if a newer version is available, shows a small "Update to vX" button in the header that opens the release page in your browser. Nothing is downloaded or installed automatically. To update, grab the new installer from the [Releases page](https://github.com/NeikiDev/jlab-desktop/releases/latest) and run it. You can dismiss the update notice; it stays hidden until the next release.

## How it works

1. You pick a file (or drop one on the window).
2. The Rust side validates the extension and reads the first bytes to confirm the file is really a zip archive.
3. For container archives (`.zip`, `.mcpack`, `.mrpack`), the largest inner `.jar` by uncompressed size is extracted in memory. Inner jars over 50 MB are rejected up front, which guards against zip bombs.
4. Rust uploads the jar to `https://jlab.threat.rip/api/public/static-scan` via `multipart/form-data`. No file bytes cross the IPC boundary into the webview.
5. The frontend renders the response, grouped by severity.

The desktop client keeps the JavaScript side from making network calls. The Content Security Policy is restricted to `connect-src ipc:`, so any future `fetch()` would fail at runtime.

## Build from source

You need:

- [Node.js](https://nodejs.org/) 20 or newer
- [Rust](https://rustup.rs/) 1.85 or newer (the project pins `rust-version = "1.85"`)
- The Tauri 2 platform prerequisites for your OS: <https://tauri.app/start/prerequisites/>

Install and run:

```bash
npm install
npm run tauri dev
```

Useful commands:

```bash
npm run check                                                # TypeScript type-check
cargo check    --manifest-path src-tauri/Cargo.toml          # Rust type-check
cargo fmt      --manifest-path src-tauri/Cargo.toml          # format Rust
cargo clippy   --manifest-path src-tauri/Cargo.toml -- -D warnings
npm run tauri build                                          # release bundle
```

The release bundle lands in `src-tauri/target/release/bundle/`.

### Icons

The repo ships with the icons referenced in `src-tauri/tauri.conf.json`. To regenerate them from a 1024 x 1024 PNG:

```bash
npm run tauri icon path/to/source.png
```

This populates `src-tauri/icons/` with all required sizes and formats (`.png`, `.icns`, `.ico`).

## API

The app talks to a single endpoint:

```
POST https://jlab.threat.rip/api/public/static-scan
Content-Type: multipart/form-data
Field:        file (max 50 MB, .jar archive)
Rate limit:   15 requests / minute / IP
```

For `.zip`, `.mcpack`, and `.mrpack` drops, the desktop client opens the archive locally, picks the largest inner `.jar`, and uploads only that file. The endpoint itself only accepts `.jar`.

No authentication is required. See <https://jlab.threat.rip/api-docs.html> for the full schema.

## Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model, commit style, and how releases are cut. The short version: feature work lands on `dev`, releases ship from `main`.

## Security

If you find a security issue, please report it privately. See [SECURITY.md](SECURITY.md) for the disclosure process. Do not file public issues for vulnerabilities.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this work, as defined in the Apache-2.0 license, shall be dual-licensed as above, without any additional terms or conditions.
