# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Continuous release workflow. Every push to `main` builds macOS and Windows installers and attaches them to a new GitHub Release.
- Tauri auto-updater. The app checks for updates on startup and via a manual button, downloads the new version, verifies the signature, and replaces the previous install in place.
- `SECURITY.md` with private vulnerability disclosure flow.
- Issue and pull request templates under `.github/`.
- Dependabot config for `npm`, `cargo`, and `github-actions`.
- CI workflow on every pull request: `npm run check`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo check`, `tauri build --debug` smoke job on macOS and Windows, and `gitleaks` scan.

### Changed

- README rewritten with a download section, first-run instructions for macOS Gatekeeper and Windows SmartScreen, and a build-from-source section.
- `CONTRIBUTING.md` documents the branch model (`dev` for work, `main` for releases) and the version bump procedure.
- `.gitignore` now covers signing materials and bundle outputs.

### Security

- Repository audited for secrets in source and history. None found.

## [0.1.1] - 2026-05-02

### Changed

- Bumped `sha2` to `0.11`, `@tauri-apps/plugin-dialog` and `tauri-plugin-dialog` to `2.7.1`, `swatinem/rust-cache` to `2.9.1`, and `tauri-apps/tauri-action` to `0.6.2`. No user-facing changes.
- Release pipeline now extracts the matching section from `CHANGELOG.md` and posts it as the GitHub Release body, instead of just linking to the file.

## [0.1.0] - 2026-05-02

The first public release. Initial macOS (universal) and Windows (MSI) builds.

[Unreleased]: https://github.com/NeikiDev/jlab-desktop/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.1.0
