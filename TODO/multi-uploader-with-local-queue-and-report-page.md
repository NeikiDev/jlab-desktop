# Multi-file Uploader with Local Queue and Report Page

**Priority:** Medium
**Category:** Frontend
**Effort:** L

## Goal

Let the user drop or pick many `.jar` files at once. The app keeps a local in-memory queue, scans them one or two at a time (respecting the 15 req/min API limit), and presents a polished report page that aggregates the results across files. Single-file scans keep working as today.

## Tasks

- [ ] Extend the `ScanState` reducer in `src/App.tsx` so the `scanning` variant can hold a queue of files (pending, scanning, done, failed) instead of a single path. Keep the single-file path working.
- [ ] Update `src/lib/components/DropZone.tsx` to accept multi-file drop and multi-select in the file dialog. Filter to the existing supported extensions (`jar`, `zip`, `mcpack`, `mrpack`), reject the rest with a single grouped message.
- [ ] Build a `QueuePanel.tsx` component listing each file with status icon, name, size, severity counts, and an inline progress bar. Per-row actions: cancel (pending), retry (failed), open report (done).
- [ ] Run scans serially with a small concurrency cap (start with 1, configurable up to 2). Pause the queue automatically on a 429 and resume after `retry_after_seconds`.
- [ ] Store all completed `ScanResult`s in memory keyed by a session-local id. Do not persist across launches.
- [ ] Add a `ReportPage.tsx` aggregate view: total files, totals per severity across the batch, list of files sorted by worst severity, click to drill into the per-file `SignatureList`.
- [ ] Wire navigation between queue, individual result, and report. Use a small in-memory router (no library), backed by the state machine.
- [ ] Handle abort: a `cancel_scan(id)` Tauri command that aborts an in-flight `reqwest` request. Add `tokio::sync::CancellationToken` plumbing.
- [ ] Update `RemoteStatus.tsx` to also pause the queue if the API goes offline mid-batch, and resume on the next successful health check.
- [ ] Performance: keep the queue panel virtualized-friendly (no per-row timers, only one shared 1s tick for elapsed, content stays inside the existing scroll container).
- [ ] Update `CLAUDE.md`: document the queue state shape, concurrency rule, and the new commands.
- [ ] Manual test: drop 10 small jars, drop a mix that includes a non-jar, hit the rate limit, kill the network mid-batch, retry a failed file.
