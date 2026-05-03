# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-05-03

### Added

- Local scan history. Past scans are summarized in `history.json` inside the Tauri app data dir, capped at 100 entries. Each entry stores the file name, size, SHA-256, severity counts, top severity, signature count, and an ISO 8601 timestamp. No file bytes, no signature payloads, no API response bodies are persisted. Writes are atomic (write to `.tmp`, then rename) and run on a blocking task pool. New `history_list`, `history_clear`, and `history_delete` Tauri commands back a redesigned idle dashboard and a dedicated history view with per-entry delete and bulk clear.
- SHA-256 click-to-copy chip in scan history rows and the recent-scans module. Falls back to `document.execCommand("copy")` on older WebViews.
- Idle landing reworked into a two-column dashboard: drop zone on top, a recent-scans module that previews the three latest scans, and a folder-watcher placeholder for the upcoming auto-scan feature.
- Continuous release workflow. Every push to `main` builds macOS and Windows installers and attaches them to a new GitHub Release.
- Tauri auto-updater. The app checks for updates on startup and via a manual button, downloads the new version, verifies the signature, and replaces the previous install in place.
- `SECURITY.md` with private vulnerability disclosure flow.
- Issue and pull request templates under `.github/`.
- Dependabot config for `npm`, `cargo`, and `github-actions`.
- CI workflow on every pull request: `npm run check`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo check`, `tauri build --debug` smoke job on macOS and Windows, and `gitleaks` scan.

### Changed

- Outbound API requests now identify with `x-jlab-client: desktop` instead of `web`, so the JLab server can tell desktop traffic from the public web client.
- RatterScanner threat-intel card rebuilt around the new server response shape (`safe`, `malicious`, `automatedSafe`, `hash`, optional `githubInfo`). Verified projects link straight to the upstream GitHub repo.
- Threat-intel parse path rewritten for diagnostics: full `std::error::Error` source chain, status code, content-type, content-encoding, body length, and a 256-byte snippet are logged on parse failure. The shared `reqwest` client now negotiates `gzip` and `brotli`; the threat-intel call asks for `identity` to sidestep transient decompression issues for that small body. The threat-intel timeout was raised from 15s to 60s to absorb upstream cold-start lookups (RatterScanner / VirusTotal).
- "Clear logs" now also truncates the active `debug.log` in addition to removing rotated files. Previously the active file was left untouched, so users could not actually free its bytes from the UI.
- API rate-limit references updated from 5 to 15 requests per minute per IP, matching the current public quota.
- README rewritten with a download section, first-run instructions for macOS Gatekeeper and Windows SmartScreen, and a build-from-source section.
- `CONTRIBUTING.md` documents the branch model (`dev` for work, `main` for releases) and the version bump procedure.
- `.gitignore` now covers signing materials and bundle outputs.

### Security

- Local history stores only summary metadata. File bytes, signature match values, and raw API bodies never touch disk.
- History writes are atomic and serialized through a process-local mutex, so a crash mid-write cannot leave a half-written file.
- Repository audited for secrets in source and history. None found.

## [0.1.1] - 2026-05-02

### Changed

- Bumped `sha2` to `0.11`, `@tauri-apps/plugin-dialog` and `tauri-plugin-dialog` to `2.7.1`, `swatinem/rust-cache` to `2.9.1`, and `tauri-apps/tauri-action` to `0.6.2`. No user-facing changes.
- Release pipeline now extracts the matching section from `CHANGELOG.md` and posts it as the GitHub Release body, instead of just linking to the file.

## [0.1.0] - 2026-05-02

The first public release. Initial macOS (universal) and Windows (MSI) builds.

[Unreleased]: https://github.com/NeikiDev/jlab-desktop/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.2.0
[0.1.1]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.1.0
