# Watched Folders Auto-Scan with Native Alerts

**Priority:** Medium
**Category:** Backend
**Effort:** L

## Goal

Let the user opt in to watching one or more folders (typical case: `.minecraft/mods`). When a new or modified `.jar` (or supported container) appears, the app auto-scans it in the background and fires a native OS notification with the severity summary on completion. Watching is opt-in, off by default, and gated by the 15 req/min API limit.

## Tasks

- [ ] Add the `notify` crate (recursive filesystem watcher) and `tauri-plugin-notification` (cross-platform native alerts: Windows toast + macOS notification center) to `src-tauri/Cargo.toml`. Wire the notification plugin in `src-tauri/src/lib.rs`.
- [ ] Update `src-tauri/capabilities/` and `tauri.conf.json` to grant the notification permission. Keep CSP unchanged (notifications go through the plugin, not `fetch`).
- [ ] Define a `WatcherSettings` shape in Rust + TS: `{ enabled: bool, folders: Vec<WatchedFolder> }` where `WatchedFolder = { path, added_at, last_scanned_at? }`. Persist to `settings.json` in the Tauri app data dir (atomic write, same path strategy as the scan history TODO #5).
- [ ] Add a `watcher` module in `src-tauri/src/`. It owns a single `notify::RecommendedWatcher`, a debounce buffer (500 ms window), and a `tokio::sync::mpsc` channel feeding a background task. The task pulls debounced events, filters to supported extensions (`jar`, `zip`, `mcpack`, `mrpack`), de-duplicates by `(path, mtime, size)`, and enqueues scans.
- [ ] On watch start, take a baseline snapshot of each folder. Only scan files that are **new** or whose `(mtime, size)` changed after watch start. Don't auto-scan the existing pre-snapshot contents unless the user clicks an explicit "Scan all now" action.
- [ ] Reuse the existing `scan_jar` flow (container unwrap, 50 MB guard, `x-jlab-client: desktop`). Funnel auto-scans through a small in-process queue with a token-bucket limiter set to **12 requests / minute** to leave headroom under the 15/min API limit. On a 429, pause the queue for `retry_after_seconds`.
- [ ] Tauri commands: `watcher_get_settings()`, `watcher_set_enabled(bool)`, `watcher_add_folder(path)`, `watcher_remove_folder(path)`, `watcher_pick_folder()` (uses `tauri-plugin-dialog` to open a native folder picker). Register in `src-tauri/src/lib.rs`. Errors as new `AppError` variants (`WatcherIo`, `InvalidWatchPath`).
- [ ] Emit a Tauri event (`watcher://scan-complete`) per finished auto-scan with the file name and severity counts. The frontend subscribes via `listen()` to refresh UI state.
- [ ] Fire a native notification per auto-scan result via `tauri-plugin-notification`. Title: file name. Body: top severity + counts (e.g. "1 critical, 2 high, 3 medium"). Suppress notifications for `info`-only or empty results behind a setting (default: notify on `medium` or higher).
- [ ] Clicking the notification focuses the app window and routes to the corresponding result view. Use the existing window handle from `AppHandle`.
- [ ] Build a `WatcherSettingsPanel.tsx` under `src/lib/components/`. Master toggle (off by default), list of watched folders with remove buttons, "Add folder" button (calls `watcher_pick_folder`), and a "Scan all now" action per folder. Empty state copy when none.
- [ ] Add a small badge / indicator on the idle landing in `App.tsx` when watching is active, with a click target to open the settings panel.
- [ ] OS-aware default suggestion: when the user opens the panel for the first time, offer `~/Library/Application Support/minecraft/mods` (macOS) or `%APPDATA%\.minecraft\mods` (Windows) as a one-click add. Don't auto-add anything.
- [ ] Tear down the watcher cleanly on app exit and on `watcher_set_enabled(false)`. No leaked threads or open handles.
- [ ] If TODO #5 (scan history) is in place by then, route auto-scan results through the same `history_append` so they show up in the history view.
- [ ] Update `CLAUDE.md`: new "Watched folders" section explaining the opt-in default, the 12 req/min auto-scan cap, the baseline-snapshot rule, the settings file location, and the new commands. Note the user can disable notifications per OS as usual.
- [ ] Manual test: drop a fresh jar into a watched folder, confirm a notification appears with correct counts. Modify the jar, confirm a re-scan. Drop 20 jars at once, confirm the queue paces under 12/min and never trips a 429. Toggle off, confirm no further events fire. Restart the app, confirm settings persist and the watcher resumes if it was enabled.
