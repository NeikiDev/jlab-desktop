# Integrity check on build (SHA-256 vs. GitHub release)

**Priority:** High
**Category:** Other
**Effort:** M

## Goal

Detect tampered or repackaged builds. CI publishes a SHA-256 for every
release artifact (`.dmg`, `.app`, `.msi`, `.exe`) on the GitHub release
page. At runtime the app hashes its own binary, fetches the expected
hash from the matching GitHub release, and shows an alert if the hash
does not match or cannot be found. Goal is to make it obvious to a user
when they are running a build that did not come from `NeikiDev/jlab-desktop`.

## Tasks

- [ ] Update `.github/workflows/release.yml` to compute SHA-256 for every bundled artifact and upload `<artifact>.sha256` files to the GitHub release
- [ ] Add a `checksums.txt` (one line per artifact) to the release for easy fetching
- [ ] Use the existing `sha2` crate (already in `src-tauri/Cargo.toml`) and `std::env::current_exe` for the self-binary path lookup
- [ ] Add `verify_integrity` Tauri command that hashes the running binary in `tokio::task::spawn_blocking` (chunked read, no full-file load)
- [ ] Add GitHub release lookup: fetch `https://api.github.com/repos/NeikiDev/jlab-desktop/releases/tags/v<APP_VERSION>` (reuse the shared `reqwest::Client`, send `x-jlab-client: desktop`, tight timeout)
- [ ] Parse the matching `<artifact>.sha256` asset for the current platform/arch and compare
- [ ] Extend `AppError` with `IntegrityMismatch { expected, actual }` and `IntegrityUnknown { reason }` variants (tagged, snake_case); mirror in `src/lib/types.ts`
- [ ] Run the check once on app startup, surface result through a new state slice; do not block the idle UI
- [ ] Add a prominent frontend alert (red banner above the drop zone, or a modal) for `IntegrityMismatch`; softer warning for `IntegrityUnknown` (offline, dev build, no matching release)
- [ ] Skip the check in `tauri dev` builds (debug assertions on) so local development is not noisy
- [ ] Document the verification flow in README so users can manually re-check with `shasum -a 256` / `Get-FileHash`
