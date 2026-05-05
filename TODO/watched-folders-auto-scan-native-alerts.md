# Watched Folders Auto-Scan with Native Alerts

**Priority:** Medium
**Category:** Backend
**Effort:** L

## Goal

Let the user opt in to watching one or more folders (typical case:
`%APPDATA%\.minecraft` or `~/Library/Application Support/minecraft`). When a
new or modified `.jar` (or supported container) appears, the app auto-scans it
in the background through the existing public API and, only if the result has
a high or critical severity, raises a native OS alert with two clear actions
("Kill process" / "Delete file") and a Discord support link. Watching is
opt-in, off by default, runs idle-quiet so it does not look like an
antivirus, and explicitly does not change any file without the user's
consent.

This is **not** an antivirus and must not behave like one:
- No real-time process interception, no driver, no kernel hooks.
- No on-access blocking, no quarantine vault, no auto-delete, no
  auto-kill.
- No heuristic scanning of arbitrary files. Only `.jar` (or supported
  containers we already accept) get uploaded to the JLab API. Everything
  else is ignored.
- The watcher is a plain user-space `notify` filesystem subscriber that
  reuses the existing `scan_jar` HTTP flow. That stays true even as we
  add features.

## Non-goals (write these into the design doc and CLAUDE.md so they don't drift)

- The app never deletes, moves, renames, or modifies a file on its own.
  Every destructive action is initiated by the user from the alert UI
  with a confirmation step.
- The app never kills a process on its own. "Kill process" only fires
  after the user clicks it on a per-alert basis.
- The watcher does not scan files that existed before watching was
  enabled (no full-disk sweep). A "Scan all now" button exists but
  requires an explicit click.
- No telemetry, no background uploads other than the same `scan_jar`
  request the user can already trigger by drag-drop.

## Tasks

### Dependencies and platform plumbing

- [ ] Add the `notify` crate (recursive filesystem watcher with
  debouncing, `notify-debouncer-full` for the debounce layer) and
  `tauri-plugin-notification` (Windows toast + macOS user notification)
  to `src-tauri/Cargo.toml`. Wire the notification plugin in
  `src-tauri/src/lib.rs`.
- [ ] Add `tauri-plugin-dialog` if not already present, for the folder
  picker and the action confirmation dialogs.
- [ ] Update `src-tauri/capabilities/` and `tauri.conf.json` to grant the
  notification + dialog permissions. Keep CSP unchanged (notifications
  and dialogs go through plugins, not `fetch`).

### Anti-AV-trigger guardrails

These are not optional. They are the line between "background helper" and
"thing your AV flags as suspicious".

- [ ] Do **not** read every file the watcher sees. Read only the small
  header bytes needed to confirm the `PK` zip magic for `.jar` /
  container candidates, then pass the path to the existing `scan_jar`
  upload path. No bulk reading of `.exe`, `.dll`, `.bat`, `.ps1`, etc.
- [ ] Filter strictly by extension (`jar`, `zip`, `mcpack`, `mrpack`)
  before opening the file. Skip everything else without reading.
- [ ] Do not enumerate or hash files outside of watched folders. No
  process listing, no `tasklist` / `ps`, no driver / WMI / etcdir
  queries from the watcher path. The only place we touch a process
  table is when the user explicitly clicks "Kill process" on an alert
  (see below).
- [ ] Sign Windows builds (covered in the existing release flow). An
  unsigned binary that watches folders and pops alerts is what AV
  vendors flag, more than the behavior itself.
- [ ] Keep the bundle name, executable name, publisher field, and file
  description honest. Nothing that looks like a security product:
  no "shield", no "guard", no "protect" in the binary metadata. Names
  like `JLab Desktop` / `jlab-desktop.exe` only.
- [ ] Document in `SECURITY.md` exactly what the watcher does and does
  not do. Link this list from the in-app warning modal.

### Resource budget

- [ ] Idle CPU at watch time must be ~0%: `notify` uses OS-level events
  (`ReadDirectoryChangesW` on Windows, `FSEvents` on macOS), no polling
  loop. Verify with Activity Monitor / Task Manager during a 10-minute
  idle test and record numbers in the design notes.
- [ ] Idle memory budget for the watcher subsystem: target < 20 MB on
  top of the existing process. Reuse the global `reqwest::Client`. Do
  not spin up extra runtimes.
- [ ] Single watcher instance per app process. Single background task.
  Single bounded `tokio::sync::mpsc` channel (capacity 256) feeding the
  scan queue. Backpressure logs a warning instead of growing
  unbounded.
- [ ] Pause the watcher's notification side while the OS reports the app
  as not visible only if the user opts into "quiet when minimized".
  Default is to keep notifications on, since the whole point is
  background protection.

### Settings model and persistence

- [ ] Define `WatcherSettings` in Rust + TS:
  ```
  WatcherSettings {
    enabled: bool,                       // master toggle
    warning_acknowledged: bool,          // set after the first-enable modal
    folders: Vec<WatchedFolder>,
    notify_min_severity: Severity,       // default: "high"
    coalesce_window_ms: u64,             // default: 4000 (see "Alert coalescing")
    quiet_when_minimized: bool,          // default: false
  }
  WatchedFolder { path, added_at, last_scanned_at? }
  ```
  Persist atomically to `settings.json` in the Tauri app data dir, same
  path strategy as the existing scan history.
- [ ] Validate watch paths: reject non-existent paths, reject root
  drives (`C:\`, `/`), reject system folders (`C:\Windows`,
  `/System`, `/Library` outside `Application Support`). Surface
  `AppError::InvalidWatchPath` with a clear message.

### Watcher core

- [ ] New `watcher` module in `src-tauri/src/`. It owns the debouncer
  (500 ms window), the supported-extension filter (`jar`, `zip`,
  `mcpack`, `mrpack`), and a de-duplication map keyed by
  `(canonical path, mtime, size)`.
- [ ] Baseline snapshot on watch start: record the existing files so we
  do not scan pre-existing contents. Only files that are **new** or
  whose `(mtime, size)` changed after start get queued.
- [ ] Reuse the existing `scan_jar` pipeline (magic check, 50 MB guard,
  container unwrap, `x-jlab-client: desktop`). Funnel auto-scans
  through a token-bucket limiter set to **12 requests / minute** to
  stay under the 15/min public API cap. On 429, pause for
  `retry_after_seconds`.
- [ ] Emit a Tauri event `watcher://scan-complete` per finished
  auto-scan with `{ filePath, fileName, severityCounts, topSeverity,
  signatureCount, scanResultId }`. Frontend listens via `listen()`.

### Tauri commands

- [ ] `watcher_get_settings()`
- [ ] `watcher_set_enabled(bool)` (triggers the warning modal flow on
  the frontend before it ever calls this with `true`)
- [ ] `watcher_add_folder(path)` / `watcher_remove_folder(path)` /
  `watcher_pick_folder()`
- [ ] `watcher_set_notify_min_severity(severity)`
- [ ] `watcher_scan_all_now(folder_path)` (explicit user action only,
  same rate limit applies)
- [ ] `watcher_acknowledge_warning()` (writes `warning_acknowledged`)
- [ ] Action commands invoked from the alert UI:
  `watcher_delete_file(path)` and `watcher_kill_processes_for_file(path)`.
  Both require the user to confirm in a native dialog (`tauri-plugin-dialog`)
  before the action runs. See "Destructive actions" below.
- Errors as new `AppError` variants: `WatcherIo`, `InvalidWatchPath`,
  `DeleteFailed`, `KillProcessFailed`, `NoOwningProcessFound`.

### Alert coalescing (no notification spam)

- [ ] Maintain a per-window buffer of completed auto-scans. The default
  window is `coalesce_window_ms = 4000`. The first qualifying result
  starts the window; further results within the window are merged.
- [ ] Qualifying = severity at or above `notify_min_severity` (default
  `high`). `info`, `low`, and `medium` results never raise an OS
  notification on their own; they only update the in-app history.
- [ ] At window close, fire **one** native notification:
  - 1 result: title = file name, body = `top severity + counts` (e.g.
    `1 critical, 2 high`).
  - N results: title = `JLab found N risky files`, body = `M critical,
    K high in <folder name>`. Clicking opens the in-app review queue
    listing all N results.
- [ ] If a new qualifying result arrives while the user is already
  looking at the review queue, just update the queue list, do not fire
  another notification.

### In-app review queue

- [ ] Build a `WatcherReviewQueue.tsx` under `src/lib/components/`. List
  of recent auto-scan hits (file name, top severity badge, scanned-at,
  signature count, "Open details" / "Delete file" / "Kill process"
  buttons, "Help on Discord" link). Empty state when nothing is
  pending.
- [ ] Clicking an OS notification focuses the app window and routes to
  this queue. Single-result notifications open the corresponding
  result view directly.
- [ ] Each row exposes a small "Why was this flagged?" expander with the
  matched signatures rendered the same way as the manual scan view.

### Destructive actions (with explicit consent)

These are the only places the app touches the user's system beyond
reading the watched folders. They are user-initiated, never automatic.

- [ ] **Delete file** (`watcher_delete_file(path)`):
  - Confirm via `tauri-plugin-dialog` with a clear message: file name,
    path, top severity, "This cannot be undone."
  - On confirm, move the file to the OS recycle bin / trash if
    available (use the `trash` crate). Fall back to refusing the
    delete if trash is unavailable; do not silently hard-delete.
  - Log the action via the existing logger. Do not auto-add a re-scan
    of the trashed file.
- [ ] **Kill process** (`watcher_kill_processes_for_file(path)`):
  - Use `sysinfo` to enumerate processes whose loaded module list, open
    handles, or executable path contains the target jar path. The
    typical case is a Java process holding the mod jar.
  - Show the user the list of matching processes (PID, name, command
    line). Require a second confirmation before sending a terminate
    signal.
  - Do not raise privileges. If we cannot terminate (permission
    denied), surface `AppError::KillProcessFailed` with a "try
    closing the launcher manually" hint.
  - This code path runs **only** when the user clicks the button.
    Watcher idle path must not import or call into the process table.
- [ ] Both actions emit a `watcher://action-taken` event so the queue
  refreshes.

### UI: settings panel

- [ ] `WatcherSettingsPanel.tsx`:
  - Master toggle (off by default).
  - List of watched folders with remove buttons.
  - "Add folder" (calls `watcher_pick_folder`).
  - "Scan all now" per folder (explicit, throttled).
  - Severity threshold selector (default `high`).
  - "Quiet when minimized" toggle.
  - Inline restatement of the non-goals from the warning modal so the
    user can re-read them at any time.
- [ ] OS-aware first-time suggestion: offer
  `%APPDATA%\.minecraft` (Windows) or
  `~/Library/Application Support/minecraft` (macOS) as a one-click
  add. Never auto-add.
- [ ] Add a small badge on the idle landing when watching is active,
  click target opens the settings panel.

### First-enable warning modal

- [ ] The first time the user flips the master toggle on (and again
  whenever they re-enable after a disable), show a blocking dialog
  before the watcher actually starts. Call
  `watcher_acknowledge_warning()` before calling
  `watcher_set_enabled(true)`.
  Required content:
  - Heading: "Heads up: this is not an antivirus".
  - Plain-language list:
    - The static scanner catches **known** signatures only. New,
      repacked, or heavily obfuscated payloads can slip through. A
      "clean" result is not a guarantee.
    - Auto-scan only sees files added or modified after watching
      starts. Existing files are ignored unless you click "Scan all
      now".
    - Auto-scan is rate-limited to 12 requests / minute. Bursts get
      queued, not dropped.
    - JLab Desktop never deletes or kills anything by itself. You
      decide on each alert.
    - Each detection still needs human judgement: open the result,
      look at the matched signatures, and decide.
  - Two action buttons: "Cancel" (leaves the toggle off) and "Enable
    watching" (writes the ack flag and starts the watcher).
  - Footer link: "Questions or false positive? Join our Discord"
    pointing at the project Discord invite. Route the click through
    the existing `open_url` allowlist; extend the allowlist with the
    Discord invite host (`discord.gg` and/or `discord.com/invite`)
    if not already covered. See `src-tauri/src/api.rs`.

### History integration

- [ ] If TODO #5 (scan history) is in place by then, route auto-scan
  results through the same `history_append` so they show up in the
  history view. Tag entries with `source: "watcher"` so the UI can
  filter.

### Lifecycle and cleanup

- [ ] Tear down the watcher cleanly on app exit and on
  `watcher_set_enabled(false)`. No leaked threads, watcher handles, or
  open files. Verify with handle counts on Windows.
- [ ] On app start, if `enabled = true`, resume watching. Re-take the
  baseline snapshot so files that arrived while the app was closed
  are not retroactively scanned without an explicit "Scan all now".

### Documentation

- [ ] Update `CLAUDE.md`: new "Watched folders" section. Cover the
  opt-in default, the 12 req/min auto-scan cap, the baseline-snapshot
  rule, the settings file location, the new commands, the "not an
  antivirus" non-goals, and that destructive actions are always
  user-initiated.
- [ ] Update `SECURITY.md`: extend the "Hardening already in place"
  section with the watcher's read scope (`PK` magic header only,
  extension filter), no process table access on the idle path, and
  the consent rule for delete/kill.

### Manual test plan

- [ ] Drop a fresh jar into a watched folder; expect a single
  notification with correct counts only if severity ≥ threshold.
- [ ] Drop 20 jars at once; expect coalesced notification ("X risky
  files"), queue paces under 12/min, no 429.
- [ ] Toggle watching off; confirm no further events fire and CPU /
  memory return to baseline.
- [ ] Restart the app with `enabled = true`; confirm settings persist,
  watcher resumes, baseline is re-taken (existing files are not
  re-uploaded).
- [ ] Click "Delete file" on an alert; confirm dialog; verify the file
  ends up in the OS trash and the queue updates.
- [ ] Click "Kill process" with a Java launcher running the flagged
  jar; confirm dialog; verify the process exits and we surface a
  clear error if it does not.
- [ ] Idle for 10 minutes with watching enabled and no file activity;
  CPU should sit at ~0%, memory should not grow.
- [ ] Run the signed Windows build through Defender / SmartScreen and
  a couple of consumer AV products; expect no detections. If any
  trigger, capture the report and adjust naming / scope before ship.
