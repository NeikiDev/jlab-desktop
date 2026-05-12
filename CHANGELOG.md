# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Bumped `tokio` from 1.52.1 to 1.52.3 (patch). No code changes required. `cargo check` and `cargo clippy -D warnings` stay green. (#71)

### Security

- Bumped `tauri` to 2.11.1 (and `tauri-build` to 2.6.1) to pick up the upstream fix for CVE-2026-42184. No code changes required. (#80)

## [0.4.0] - 2026-05-08

### Added

- Scan response now surfaces deobfuscation match fields (`encoding`, `original`, `decoded`) on signatures of `kind: "deobfuscation"`. `SignatureCard` filters matches with no content and renders each non-empty field row by row. The frontend also honors the new top-level `note` field (preserved on `ScanResult` for future use) and treats a per-signature `redacted: true` flag from the server as authoritative. CLAUDE.md's API contract section was refreshed to match the live shape: severity scale, current `kind` values, full `confirmedFamilies` redaction behavior, and the new match fields.

### Changed

- Tauri bundle identifier flipped from `JLAB-Desktop` to the reverse-DNS `rip.threat.jlab-desktop`, matching the API host (`jlab.threat.rip`) and Tauri's recommended layout for macOS `CFBundleIdentifier`, Windows MSI scope, and Linux `.desktop` integration. The user-visible product name (`JLab Desktop`) and window title are unchanged. (#46, #55)
- User-visible data and log folders are now `JLab`, decoupled from the bundle identifier. Without this, the identifier flip above would have created a `rip.threat.jlab-desktop/` folder under `Application Support`, `AppData`, or `.local/share`. New paths: `~/Library/Application Support/JLab/` (macOS), `%APPDATA%\JLab\` (Windows), `$XDG_DATA_HOME/JLab/` or `~/.local/share/JLab/` (Linux). Logs follow the same shape (`~/Library/Logs/JLab/` on macOS, `%LOCALAPPDATA%\JLab\logs\` on Windows, `<data>/JLab/logs/` on Linux). All resolution lives in the new `paths` module so future identifier changes never touch user folders again. (#46, #57)
- `SignatureDisclaimer` is now hidden when one or more malware families are confirmed. The `FamilyAlert` already says "this is malware", so the soft "matches alone are not a verdict" caveat would only confuse the result. The component was simplified at the same time (no more `hasConfirmedFamily` branch).
- Severity histogram and threat-score bars animate via `transform: scaleX` instead of `transition-[width]`, so they no longer trigger Recalculate Style + Layout for the full duration window. CLAUDE.md already required transform-only animations; this brings the two outliers into line. (#41, #50)
- Capability set drops `dialog:default` and keeps only `dialog:allow-open`. The frontend never imports `ask`, `confirm`, `message`, or `save` from the dialog plugin, so the bundled defaults were dead capability surface. (#40, #49)
- CLAUDE.md, SECURITY.md, and README.md now describe the webview CSP as `connect-src ipc: http://ipc.localhost`, matching the actual policy in `tauri.conf.json`. Both sources are Tauri 2's IPC handler; dropping the second one breaks `invoke()`. CLAUDE.md also surfaces `script-src 'self'` and `img-src ... http://asset.localhost` so the full picture is documented in one place. Docs only, no runtime change. (#47, #56)
- `open_log_dir` now goes through `tauri-plugin-opener` (`OpenerExt::open_path`) instead of the per-OS `Command::new` branch (`open` / `explorer` / `xdg-open`). Same shape as the existing `open_url` path, so the two "open something on disk or on the web" commands now share one platform call. Adds `opener:allow-open-path` to the capability set. No shell quoting in the path anymore. (#63, #73)
- `SECURITY.md` "Hardening already in place" now lists every permission from `src-tauri/capabilities/default.json` (core defaults, window, event, internal devtools toggle, `dialog:allow-open`, `log:default`, `opener:allow-open-url`, `opener:allow-open-path`) and points at the JSON file as the source of truth. The earlier prose only named "dialog, log, window, internal devtools toggle", which under-described the actual scope. (#64, #72)

### Fixed

- `history.json` and `debug*.log` files are migrated one-shot from the legacy `JLAB-Desktop` folder on first launch of the new build, so existing 0.3.x users do not appear to lose history when the identifier flips. Migration is idempotent, never overwrites an existing target file, and never blocks startup if it fails. The legacy folder is left in place for one release as a rollback hatch. Five new unit tests cover the migration helpers (idempotent, no-overwrite, fresh install, debug-only filter). (#46, #57)
- `HistoryEntry.id` no longer collides when the same file is scanned twice in the same millisecond. The id now appends a process-local `AtomicU64` sequence, so `history_delete` can no longer remove two rows on a single click. `delete` also warns when more than one row matches an id, so a future regression is visible in the log. (#44, #53)
- A `history.json` written by a future build (schema version greater than the current `SCHEMA_VERSION`) is now moved aside to `history.json.future` and the older build starts with an empty file, instead of silently deserializing the future file and writing it back as v1 with new fields stripped. Adds a regression test that writes a v999 file and asserts the move-aside path. (#45, #54)
- "Clear logs" no longer leaves the active `debug.log` NUL-padded on disk on Unix. The active log is renamed to `debug-cleared-<unix-secs>.log` and unlinked; `tauri-plugin-log` keeps writing into the orphaned inode (which goes away when the process exits) and the next log line lands in a freshly-created `debug.log`. Windows keeps the in-place truncate as a fallback because the OS rejects rename-while-open; the upstream fix there waits on a `rotate_now()` API in `tauri-plugin-log`. (#43, #52)
- "Clear logs" no longer over-reports `bytes_freed` on Unix when the rotated log cannot be unlinked. The discarded `let _ = remove_file(...)` is now a `match` that only adds to the running total on a successful unlink and emits a `warn!` with the redacted path and OS error on failure. The truncate fallback gained the redacted path on its warning for the same diagnostic shape. `truncated += 1` still runs on rotation success. (#62, #75)
- Pre-logger migration failures on Windows packaged builds are now visible. They were buffered into a `Vec<String>` and replayed via `log::warn!` from inside the `setup` callback, after the log plugin is initialized. Earlier the path went through `eprintln!`, which has no console on `windows_subsystem = "windows"`, so a failed legacy folder migration produced no signal at all. The user now sees a line in `debug.log`. (#60, #76)

### Security

- The data dir is now locked to `0o700` on Unix on every code path (the platform `app_data_dir` in addition to the `/tmp` fallback that already had it), and `history.json` itself is chmodded to `0o600` after every atomic write. Previously the platform path inherited the home-directory mode, which on Fedora and openSUSE defaults to `0o755`, leaving scan filenames and SHA-256s readable to other local users. Defense in depth on macOS (home is 0o700) and Windows (per-user ACLs). SECURITY.md "Hardening already in place" updated to match. (#39, #51)
- CI now gates merges on `npm audit --audit-level=high --omit=dev` alongside the existing `cargo audit` step. Closes the asymmetry where Dependabot proposed npm upgrade PRs but no merge gate existed on the JS tree. The two `cargo audit --ignore` entries (`RUSTSEC-2024-0429`, `RUSTSEC-2026-0097`) gained inline rationale so they are re-evaluated on every Tauri minor bump. (#42, #48)
- Startup now refuses the `/tmp` fallback data dir if a hostile pre-existing entry was placed at the path. After `create_dir_all` and `chmod`, a new `verify_fallback_dir_security` helper uses `symlink_metadata` (rejects symlinks), then asserts `euid == st_uid` and `mode & 0o777 == 0o700`. The chmod warning alone was not enough because `chmod` silently fails on attacker-owned dirs (only the owner can change the mode, so a 0o755 dir owned by another user stays 0o755). Aborts startup on failure with `AppError::Io { message }` so the existing UI error path renders the failure. Four tests cover accept (self-owned 0o700), reject loose mode, reject missing path, reject symlink. (#59, #77)
- `is_github_repo_url` now rejects owner / repo segments with a leading `.`, trailing `.`, or consecutive `..`, matching GitHub's own naming rules. No live exploit (those URLs already 404 on GitHub today), purely a hardening alignment so the allowlist cannot be tightened later by GitHub without breaking us. Four new reject tests cover `.evil/.repo`, `evil./repo.`, `foo..bar/baz`, and `owner/foo..`. (#61, #74)

### Migration (Windows)

- The Wix `upgradeCode` is now pinned (`2E5324F3-603E-4837-9E6D-724525410B27`) so future MSI bumps upgrade the existing install in place. The first MSI built from this release will not match the auto-generated `upgradeCode` from `0.3.0`, so users upgrading from `0.3.0` may see the new build install side-by-side with the old one in `Apps & features`. The legacy entry can be uninstalled safely; `history.json` and `debug*.log` files are migrated automatically.

## [0.3.0] - 2026-05-05

### Added

- Linux desktop bundles. Releases now publish `.deb` (Debian / Ubuntu), `.rpm` (Fedora / RHEL / openSUSE), and `.AppImage` (universal) artifacts alongside the existing macOS DMG and Windows MSI. CI builds on `ubuntu-24.04` against `webkit2gtk-4.1`. README install section gained a "First run on Linux" block. Track the upstream advisories listed in `TODO/linux-builds-deb-rpm-appimage.md` (`glib` 0.18.5 and `rand` 0.7.3) on every Tauri minor bump.
- "Matches are not a verdict" disclaimer on the scan result view. The new `SignatureDisclaimer` component sits above the signature list and explains that signature hits indicate similarity to known patterns, not proof of malicious intent. Wording tuned to keep false positives in context without burying the result. (#5)
- New `history_cap` Tauri command. The frontend now reads `HISTORY_CAP` from Rust on mount instead of duplicating the constant. `IdleDashboard` keeps `100` only as a placeholder while the IPC roundtrip is in flight. A tripwire test in `history.rs` reminds future maintainers to bump the docs if they change the cap. (#23, #34)

### Changed

- `RemoteStatus` pauses the 60-second `/api/stats` poll while the window is hidden and reruns the check on `visibilitychange`. Idle, hidden windows no longer heartbeat. README now names the recurring stats poll and the per-scan threat-intel fetch, and links to a new "Network surface" section in `SECURITY.md` that lists every outbound endpoint. (#17, #25)
- `SECURITY.md` now spells out the full `open_url` allowlist (threat.rip family, `www.virustotal.com`, and any `github.com/<owner>/<repo>`) and points at `src-tauri/src/api.rs` as the source of truth. The GitHub clause was widened from a single hard-coded repo to any repo, matching the runtime behavior. (#20, #27, #33)
- `CLAUDE.md` Tauri-commands section refreshed. The list now reflects all twelve registered commands (scan, status, updater, opener, log management, local history) and points at `api.rs` and `lib.rs` instead of trying to track command names inline. (#21, #26)
- `Cargo.toml` and `package.json` now carry `repository`, `homepage`, and `readme` / `bugs` fields pointing at `github.com/NeikiDev/jlab-desktop`. `cargo metadata` and npm tooling no longer report empty repository strings. (#29, #32)

### Fixed

- `open_url` now accepts any `https://github.com/<owner>/<repo>` URL with optional sub-path, query, or fragment. The old hard-coded prefix only allowed `NeikiDev/jlab-desktop`, so the RatterScanner threat-intel card's "Visit" button on verified third-party projects was rejected with `AppError::Network` and silently swallowed by the frontend. The new check uses an `is_github_repo_url` helper that constrains owner / repo segments to `[A-Za-z0-9_.-]` and rejects empty / `..` / host-smuggling shapes. Two unit tests cover accepted and rejected URL shapes. (#28, #33)
- Updater no longer hides a stable release from users running a prerelease that shares the same numeric core. `0.2.1-rc1` is now correctly told that `0.2.1` is available. The new `parse_version` returns `((major, minor, patch), Option<prerelease>)`, and `is_newer` ranks any release without a prerelease tag above any release with one on the same numeric core; newer cores always win regardless of prerelease state. Build metadata (`+...`) is still ignored, matching semver. Update notifications still only ever offer stable releases (`releases/latest` excludes prereleases by default). Seven new unit tests, including the explicit regression. (#18, #37)
- Container archives (`.zip` / `.mcpack` / `.mrpack`) are now streamed straight into `zip::ZipArchive` from a `std::fs::File` inside `spawn_blocking`. `run_scan` previously called `tokio::fs::read` on the outer archive and handed the resulting `Vec<u8>` to `extract_largest_jar` via `Cursor`, which meant up to 50 MB of allocation per scan, with both the original and the moved copy alive during the IPC handoff. Plain `.jar` keeps the buffered path because those bytes are needed in memory anyway for SHA-256 and the multipart upload. New regression test opens a real on-disk zip via the streaming entry point. (#22, #35)
- Scan-result header no longer renders `"undefined"` or `"null B"` when the API omits envelope fields. Every scan field now goes through the same `asStr` / `asNum` / `asBool` helpers already used for threat intel, with safe fallbacks (file name falls back to `"(unknown file)"`, counts to the local signature count, sizes to `0`). (#30, #31)

### Security

- Local scan history is no longer world-readable on Linux when the platform `app_data_dir` is unavailable. The fallback path used `/tmp/jlab-desktop`, which on a shared Linux box left history files at the process umask (often 644) so any local user could read scan file names, SHA-256s, and severity counts. The fallback now resolves to `<tempdir>/jlab-desktop-<sanitized-USER>` (sanitizer strips anything outside `[A-Za-z0-9_-]`, lowercases, caps at 32 chars, collapses empty input to `anon`), and on Unix `chmod 0o700` is applied to the directory after creation. Per-user (not per-PID) so degraded mode keeps history across launches. The platform `app_data_dir` is untouched because it already has the right ACL. New unit tests cover sanitizer edge cases (path traversal, separators, unicode, length cap, empty input). (#19, #36)
- `open_url` now goes through `tauri-plugin-opener` instead of a per-OS `Command::new` branch (`open` / `cmd /C start` / `xdg-open`). `cmd.exe` applies its own metacharacter parsing on top of the CRT, so a URL with embedded quotes plus `&` could in theory chain commands. The current allowlist makes that unreachable today, but the platform call no longer depends on shell quoting at all. (#16, #24)

## [0.2.1] - 2026-05-04

### Changed

- `SECURITY.md` "Signing keys" section rewritten to match reality: there is no in-app auto-updater today and no Tauri updater signing keypair in use. Updates remain manual via the GitHub Release page. The unused `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars were dropped from both build jobs in `release.yml` to shrink the secret footprint in CI runners. (#8, #13)
- Bumped `tauri-plugin-dialog` from 2.7.0 to 2.7.1 (transitively `tauri-plugin-fs` 2.5.0 → 2.5.1). (#14)

### Fixed

- Scan-progress tip now reads "Up to 50 MB per file. 15 scans per minute." instead of the incorrect "Five scans per minute". The new wording matches the documented JLab API rate limit. (#9, #11)
- A corrupt `history.json` is no longer silently overwritten with an empty file on the next scan. The unparseable file is renamed to `history.json.corrupt` for inspection and a warning is written to the existing log control before the empty default is returned. Adds a regression test. (#10, #12)

### Security

- Inner-jar zip-bomb hardening (GHSA-9m5v-g42x-xq8f, CWE-409). `extract_largest_jar` previously trusted the central-directory `uncompressed_size` of the inner `.jar`, so a hostile `.zip` / `.mcpack` / `.mrpack` could declare a small size, pass the 50 MB pre-check, and then deflate gigabytes into a `Vec<u8>` before any HTTP call. The read is now capped with `Read::take(MAX_BYTES + 1)` and rejected when the cap is hit. Adds a regression test that builds an in-memory archive whose central directory lies about the inner jar's size.

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
- RatterScanner threat-intel card rebuilt around the new server response shape (`safe`, `malicious`, `automated_safe`, `hash`, optional `githubInfo`). Verified projects link straight to the upstream GitHub repo.
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

[Unreleased]: https://github.com/NeikiDev/jlab-desktop/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.4.0
[0.3.0]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.3.0
[0.2.1]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.2.1
[0.2.0]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.2.0
[0.1.1]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/NeikiDev/jlab-desktop/releases/tag/v0.1.0
