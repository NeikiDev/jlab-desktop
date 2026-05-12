//! Filesystem watcher core: subscribe to OS events, debounce, dedupe,
//! filter, and feed a rate-limited consumer that drives `scan_jar`.
//!
//! Design notes:
//!
//! - One `notify-debouncer-full` per process. Adding / removing watched
//!   folders mutates the existing debouncer's watch set, never replaces it.
//! - For each newly added folder we snapshot every file's
//!   `(canonical path, mtime, size)` once. Files already present at watch
//!   start are NOT auto-scanned. Only files that appear later, or whose
//!   `(mtime, size)` no longer matches the baseline entry, qualify.
//! - The qualifying path goes through a bounded `tokio::sync::mpsc` channel
//!   (capacity 256). On overflow a `warn!` is logged and the path is
//!   dropped: backpressure is finite by design.
//! - A single consumer drains the channel through a token-bucket rate
//!   limiter that allows 12 scans per 60s (the public API's cap is 15/min).
//!   On HTTP 429 the consumer sleeps `retry_after_seconds` and retries the
//!   item once before dropping it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use notify::{EventKind, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Notify};

use crate::api::{run_scan, HttpClient, ScanOutcome, ScanSource};
use crate::error::AppError;
use crate::watcher::hold;
use crate::watcher::notify as wnotify;
use crate::watcher::quarantine;
use crate::watcher::rescan;
use crate::watcher::settings::{
    ActionMode, ActionThreshold, SettingsStore, WatchedFolder, WatcherSettings,
    WATCHER_REQUESTS_PER_MINUTE,
};
use crate::watcher::trash as wtrash;

const SUPPORTED_EXTS: &[&str] = &["jar", "zip", "mcpack", "mrpack"];
pub const HOLD_SUFFIX: &str = ".jlab-pending";

const WATCHER_EVENT: &str = "watcher://event";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatcherRunState {
    Off,
    Idle,
    Scanning,
    #[allow(dead_code)]
    Paused,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherRuntimeState {
    pub run_state: WatcherRunState,
    pub queue_depth: usize,
    pub current_file: Option<String>,
    pub current_started_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug)]
struct BaselineEntry {
    mtime: SystemTime,
    size: u64,
}

/// Tauri-managed handle. Cheaply cloneable. The actual state lives behind
/// an `Arc<Mutex<RuntimeState>>`; the debouncer is parked inside the mutex
/// too so add / remove folder calls can mutate it.
#[derive(Clone)]
pub struct WatcherStore {
    inner: Arc<Inner>,
}

struct Inner {
    settings: SettingsStore,
    state: Mutex<RuntimeState>,
}

type DebouncerKind = Debouncer<notify::RecommendedWatcher, notify_debouncer_full::RecommendedCache>;

struct RuntimeState {
    settings: WatcherSettings,
    debouncer: Option<DebouncerKind>,
    queue_tx: Option<mpsc::Sender<PathBuf>>,
    baseline: HashMap<PathBuf, BaselineEntry>,
    consumer_kill: Option<Arc<Notify>>,
    rescan_kill: Option<Arc<Notify>>,
    run_state: WatcherRunState,
    queue_depth: usize,
    current_file: Option<String>,
    current_started_ms: Option<u64>,
}

impl WatcherStore {
    pub fn new(settings: SettingsStore) -> Self {
        let initial = settings.load();
        Self {
            inner: Arc::new(Inner {
                settings,
                state: Mutex::new(RuntimeState {
                    settings: initial,
                    debouncer: None,
                    queue_tx: None,
                    baseline: HashMap::new(),
                    consumer_kill: None,
                    rescan_kill: None,
                    run_state: WatcherRunState::Off,
                    queue_depth: 0,
                    current_file: None,
                    current_started_ms: None,
                }),
            }),
        }
    }

    pub fn data_dir(&self) -> PathBuf {
        self.inner.settings.data_dir().to_path_buf()
    }

    pub fn snapshot_settings(&self) -> WatcherSettings {
        self.inner.state.lock().unwrap().settings.clone()
    }

    pub fn snapshot_runtime(&self) -> WatcherRuntimeState {
        let s = self.inner.state.lock().unwrap();
        WatcherRuntimeState {
            run_state: s.run_state,
            queue_depth: s.queue_depth,
            current_file: s.current_file.clone(),
            current_started_ms: s.current_started_ms,
        }
    }

    /// Apply an arbitrary mutation to the settings and persist to disk.
    ///
    /// Does NOT emit a `state-changed` event: that event is reserved for
    /// actual run-state transitions (start/stop/scan-begin/scan-end), and
    /// emitting it on every settings tweak made the status card flicker to
    /// "watcher is off" whenever a toggle was flipped. The frontend gets
    /// the updated settings from the return value of the command.
    pub fn mutate_settings<F>(&self, _app: &AppHandle, f: F) -> Result<WatcherSettings, AppError>
    where
        F: FnOnce(&mut WatcherSettings),
    {
        let updated = {
            let mut s = self.inner.state.lock().unwrap();
            f(&mut s.settings);
            s.settings.clone()
        };
        self.inner.settings.save(&updated)?;
        Ok(updated)
    }

    /// Start the OS watcher with the currently configured folders. Idempotent
    /// once running. Returns `Ok` even if no folders are configured: the
    /// debouncer is created so subsequent `add_folder` calls light up.
    pub fn start(&self, app: &AppHandle) -> Result<(), AppError> {
        let (tx, rx) = mpsc::channel::<PathBuf>(256);
        let consumer_kill = Arc::new(Notify::new());
        let rescan_kill = Arc::new(Notify::new());

        let folders: Vec<WatchedFolder> = {
            let s = self.inner.state.lock().unwrap();
            s.settings.folders.clone()
        };

        // Raw-event channel: debouncer thread → async qualifier task. The
        // debouncer callback runs on a `notify-rs`-owned thread, and the
        // previous code did `std::fs::metadata` + `Path::canonicalize`
        // straight inside that callback. On slow disks, NFS, or
        // FUSE-mounted volumes those calls can hang for seconds and
        // wedge the debouncer thread, dropping later events. Forward the
        // raw paths here and qualify them on the blocking pool.
        let (raw_tx, mut raw_rx) = mpsc::channel::<PathBuf>(256);
        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            None,
            move |res: DebounceEventResult| match res {
                Ok(events) => {
                    for ev in events {
                        if !matches!(
                            ev.event.kind,
                            EventKind::Create(_) | EventKind::Modify(_) | EventKind::Other
                        ) {
                            continue;
                        }
                        for path in &ev.event.paths {
                            let _ = raw_tx.try_send(path.clone());
                        }
                    }
                }
                Err(errors) => {
                    for e in errors {
                        log::warn!("watcher debouncer error: {e}");
                    }
                }
            },
        )
        .map_err(|e| AppError::WatcherIo {
            message: format!("create debouncer: {e}"),
        })?;

        // Qualifier task. Reads raw paths, runs the sync `metadata` +
        // `canonicalize` on the blocking pool, forwards qualified paths
        // to the consumer queue. Ends naturally when the debouncer is
        // dropped in `stop()` and `raw_tx` is gone.
        let store_for_qual = self.clone();
        let app_for_qual = app.clone();
        let tx_for_qual = tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(raw_path) = raw_rx.recv().await {
                let store = store_for_qual.clone();
                let qualified =
                    tokio::task::spawn_blocking(move || store.qualify_event_path(raw_path))
                        .await
                        .ok()
                        .flatten();
                if let Some(p) = qualified {
                    enqueue_sync(&app_for_qual, &tx_for_qual, p);
                }
            }
        });

        for f in &folders {
            if let Err(e) = debouncer.watch(&f.path, RecursiveMode::Recursive) {
                log::warn!("could not watch {}: {e}", f.path.display());
            }
        }

        // Recover stragglers from a previous run that crashed mid-rename.
        if let Err(e) = hold::recover_stragglers(app, &folders, &tx) {
            log::warn!("hold recovery failed: {e}");
        }

        {
            let mut s = self.inner.state.lock().unwrap();
            s.debouncer = Some(debouncer);
            s.queue_tx = Some(tx);
            s.baseline = HashMap::new();
            s.consumer_kill = Some(consumer_kill.clone());
            s.rescan_kill = Some(rescan_kill.clone());
            s.run_state = WatcherRunState::Idle;
            s.queue_depth = 0;
            s.current_file = None;
            s.current_started_ms = None;
        }

        // Baseline walk in the background: large watch folders can take
        // seconds to scan, and `start` is called from the synchronous
        // setup callback. Doing the walk inline blocks first paint.
        // Defer it to a blocking pool task and merge the result with
        // `entry().or_insert(..)` so any qualifier-task inserts from
        // events that arrived during the walk win over stale entries.
        let store_for_baseline = self.clone();
        let folders_for_walk = folders.clone();
        tauri::async_runtime::spawn(async move {
            let walked = tokio::task::spawn_blocking(move || -> HashMap<PathBuf, BaselineEntry> {
                let mut map: HashMap<PathBuf, BaselineEntry> = HashMap::new();
                for f in &folders_for_walk {
                    collect_baseline(&f.path, &mut map);
                }
                map
            })
            .await
            .unwrap_or_default();
            let mut s = store_for_baseline.inner.state.lock().unwrap();
            for (k, v) in walked {
                s.baseline.entry(k).or_insert(v);
            }
        });

        // Start the consumer task and the rescan scheduler. We use
        // `tauri::async_runtime::spawn` because `WatcherStore::start` is
        // called from the synchronous `setup` callback, which is not inside
        // a tokio runtime context, so a bare `tokio::spawn` would panic
        // with "there is no reactor running". The tauri helper runs the
        // future on the global tokio runtime that the app already owns.
        let store_for_consumer = self.clone();
        let app_for_consumer = app.clone();
        tauri::async_runtime::spawn(async move {
            consumer_loop(store_for_consumer, app_for_consumer, rx, consumer_kill).await;
        });

        let store_for_rescan = self.clone();
        let app_for_rescan = app.clone();
        tauri::async_runtime::spawn(async move {
            rescan::scheduler_loop(store_for_rescan, app_for_rescan, rescan_kill).await;
        });

        emit_event(
            app,
            &WatcherEvent::StateChanged {
                run_state: WatcherRunState::Idle,
            },
        );
        Ok(())
    }

    /// Stop the OS watcher and the consumer. Drains in-flight events.
    pub fn stop(&self, app: &AppHandle) {
        let (kill_consumer, kill_rescan) = {
            let mut s = self.inner.state.lock().unwrap();
            s.debouncer = None;
            s.queue_tx = None;
            s.baseline.clear();
            let kc = s.consumer_kill.take();
            let kr = s.rescan_kill.take();
            s.run_state = WatcherRunState::Off;
            s.queue_depth = 0;
            s.current_file = None;
            s.current_started_ms = None;
            (kc, kr)
        };
        if let Some(k) = kill_consumer {
            k.notify_waiters();
        }
        if let Some(k) = kill_rescan {
            k.notify_waiters();
        }
        emit_event(
            app,
            &WatcherEvent::StateChanged {
                run_state: WatcherRunState::Off,
            },
        );
    }

    /// Add a folder to the watch set without restarting. Snapshots baseline
    /// for the new folder so its existing contents are not re-uploaded.
    pub fn watch_folder(&self, path: &Path) -> Result<(), AppError> {
        let mut s = self.inner.state.lock().unwrap();
        if let Some(debouncer) = s.debouncer.as_mut() {
            debouncer
                .watch(path, RecursiveMode::Recursive)
                .map_err(|e| AppError::WatcherIo {
                    message: format!("watch: {e}"),
                })?;
        }
        collect_baseline(path, &mut s.baseline);
        Ok(())
    }

    pub fn unwatch_folder(&self, path: &Path) {
        let mut s = self.inner.state.lock().unwrap();
        if let Some(debouncer) = s.debouncer.as_mut() {
            let _ = debouncer.unwatch(path);
        }
        s.baseline.retain(|p, _| !p.starts_with(path));
    }

    /// Returns the qualifying canonical path if this event should be
    /// queued for a scan. Filters by extension and the baseline.
    fn qualify_event_path(&self, raw_path: PathBuf) -> Option<PathBuf> {
        let ext = raw_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())?;
        // Skip our own hold-suffix files; the hold path re-enqueues them.
        let lower = raw_path.to_string_lossy().to_ascii_lowercase();
        if lower.ends_with(HOLD_SUFFIX) {
            return None;
        }
        if !SUPPORTED_EXTS.contains(&ext.as_str()) {
            return None;
        }
        let meta = std::fs::metadata(&raw_path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let mtime = meta.modified().ok()?;
        let size = meta.len();
        let canon = raw_path.canonicalize().unwrap_or_else(|_| raw_path.clone());

        let mut s = self.inner.state.lock().unwrap();
        let is_new_or_changed = match s.baseline.get(&canon) {
            None => true,
            Some(base) => base.mtime != mtime || base.size != size,
        };
        if !is_new_or_changed {
            return None;
        }
        s.baseline
            .insert(canon.clone(), BaselineEntry { mtime, size });
        Some(canon)
    }

    /// Enqueue a path for the consumer to scan, bypassing the baseline
    /// check. Used by "Scan all now" and the rescan scheduler.
    pub fn force_enqueue(&self, app: &AppHandle, path: PathBuf) {
        let tx = {
            let s = self.inner.state.lock().unwrap();
            s.queue_tx.clone()
        };
        if let Some(tx) = tx {
            enqueue_sync(app, &tx, path);
        }
    }

    fn bump_queue(&self, delta: i64) {
        let mut s = self.inner.state.lock().unwrap();
        let next = (s.queue_depth as i64 + delta).max(0) as usize;
        s.queue_depth = next;
    }

    fn set_scanning(&self, file: Option<String>) {
        let mut s = self.inner.state.lock().unwrap();
        if let Some(name) = &file {
            s.run_state = WatcherRunState::Scanning;
            s.current_file = Some(name.clone());
            s.current_started_ms = Some(
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            );
        } else {
            s.run_state = if s.queue_depth > 0 {
                WatcherRunState::Scanning
            } else {
                WatcherRunState::Idle
            };
            s.current_file = None;
            s.current_started_ms = None;
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatcherEvent {
    #[serde(rename = "state-changed")]
    StateChanged { run_state: WatcherRunState },
    #[serde(rename = "queue-updated")]
    QueueUpdated { depth: usize },
    #[serde(rename = "scan-started")]
    ScanStarted { file_name: String, path: String },
    #[serde(rename = "scan-completed")]
    ScanCompleted {
        file_name: String,
        path: String,
        top_severity: String,
        signature_count: u32,
        critical_count: u32,
        high_count: u32,
        confirmed_families: u32,
        sha256: String,
        flagged: bool,
        /// `"quarantined"`, `"trashed"`, or `None` when no auto-action ran.
        action: Option<String>,
    },
    #[serde(rename = "error")]
    Error {
        path: String,
        code: String,
        message: String,
    },
    #[serde(rename = "focus-review")]
    #[allow(dead_code)]
    FocusReview,
}

pub fn emit_event(app: &AppHandle, event: &WatcherEvent) {
    if let Err(e) = app.emit(WATCHER_EVENT, event) {
        log::warn!("emit watcher event failed: {e}");
    }
}

pub(crate) fn enqueue_sync(app: &AppHandle, tx: &mpsc::Sender<PathBuf>, path: PathBuf) {
    let store = match app.try_state::<WatcherStore>() {
        Some(s) => s,
        None => return,
    };
    match tx.try_send(path) {
        Ok(_) => {
            store.bump_queue(1);
            let depth = store.snapshot_runtime().queue_depth;
            emit_event(app, &WatcherEvent::QueueUpdated { depth });
        }
        Err(mpsc::error::TrySendError::Full(p)) => {
            log::warn!(
                "watcher queue full, dropping {}",
                crate::api::redact_path(&p.to_string_lossy())
            );
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            log::warn!("watcher queue closed; consumer is gone");
        }
    }
}

async fn consumer_loop(
    store: WatcherStore,
    app: AppHandle,
    mut rx: mpsc::Receiver<PathBuf>,
    kill: Arc<Notify>,
) {
    let mut last_minute: Vec<Instant> = Vec::with_capacity(16);
    let cap = WATCHER_REQUESTS_PER_MINUTE as usize;

    loop {
        tokio::select! {
            biased;
            _ = kill.notified() => {
                log::info!("watcher consumer shutting down");
                return;
            }
            maybe_path = rx.recv() => {
                let Some(path) = maybe_path else { return };

                // Token bucket. Drop expired entries, then if we are at the
                // cap wait until the oldest falls off. The file stays
                // counted in the visible queue depth during this wait so
                // the UI keeps showing "queued" instead of going idle.
                let now = Instant::now();
                last_minute.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
                if last_minute.len() >= cap {
                    let wait = Duration::from_secs(60) - now.duration_since(last_minute[0]);
                    tokio::select! {
                        biased;
                        _ = kill.notified() => return,
                        _ = tokio::time::sleep(wait) => {},
                    }
                    let now2 = Instant::now();
                    last_minute.retain(|t| now2.duration_since(*t) < Duration::from_secs(60));
                }
                last_minute.push(Instant::now());

                // Only decrement once we are about to start the scan so
                // the queue counter and run state stay accurate during
                // rate-limit waits.
                store.bump_queue(-1);
                let depth = store.snapshot_runtime().queue_depth;
                emit_event(&app, &WatcherEvent::QueueUpdated { depth });

                process_one(&store, &app, path).await;
            }
        }
    }
}

async fn process_one(store: &WatcherStore, app: &AppHandle, original_path: PathBuf) {
    let settings = store.snapshot_settings();
    let display_name = original_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    let hold_active =
        settings.hold_until_scanned && !original_path.to_string_lossy().ends_with(HOLD_SUFFIX);

    let scan_path = if hold_active {
        match hold::rename_to_pending(&original_path) {
            Ok(p) => p,
            Err(e) => {
                emit_event(
                    app,
                    &WatcherEvent::Error {
                        path: original_path.to_string_lossy().into_owned(),
                        code: "rename_failed".into(),
                        message: e.to_string(),
                    },
                );
                return;
            }
        }
    } else {
        original_path.clone()
    };

    store.set_scanning(Some(display_name.clone()));
    emit_event(
        app,
        &WatcherEvent::ScanStarted {
            file_name: display_name.clone(),
            path: scan_path.to_string_lossy().into_owned(),
        },
    );

    let outcome = run_internal_scan(app, &scan_path).await;
    let mut action_taken: Option<String> = None;
    let mut final_path = scan_path.clone();

    match outcome {
        Ok(o) => {
            let (critical, high, _med, _low, _info) = severity_counts_from(&o.scan);
            let families = confirmed_families_count(&o.scan);
            let top = top_severity(critical, high, &o.scan);
            let signatures = signature_count(&o.scan);

            let multi_count = settings.multiple_criticals_threshold;
            let above_alert =
                matches_alert(&settings.alert_threshold, critical, families, multi_count);
            let above_action =
                matches_action(&settings.auto_action, critical, families, multi_count);
            let action_enabled =
                above_action && !matches!(settings.auto_action, ActionThreshold::Off);

            if action_enabled {
                let data_dir = store.data_dir();
                let (result, label) = match settings.auto_action_mode {
                    ActionMode::Quarantine => (
                        quarantine::send_to_quarantine(&final_path, &data_dir)
                            .await
                            .map(Some),
                        "quarantined",
                    ),
                    ActionMode::Trash => (
                        wtrash::send_to_trash(&final_path).await.map(|_| None),
                        "trashed",
                    ),
                };
                match result {
                    Ok(new_path) => {
                        action_taken = Some(label.to_string());
                        if let Some(p) = new_path {
                            final_path = p;
                        }
                    }
                    Err(e) => {
                        emit_event(
                            app,
                            &WatcherEvent::Error {
                                path: final_path.to_string_lossy().into_owned(),
                                code: format!("{label}_failed"),
                                message: e.to_string(),
                            },
                        );
                        // The action failed. If we were holding the file
                        // with .jlab-pending, restore the original name so
                        // the user does not end up with a stranded suffix.
                        if hold_active {
                            if let Err(re) = hold::rename_from_pending(&final_path) {
                                log::warn!("restore from hold failed: {re}");
                            } else {
                                final_path = original_path.clone();
                            }
                        }
                    }
                }
            } else if hold_active {
                // No action: restore the original name from the hold suffix.
                match hold::rename_from_pending(&final_path) {
                    Ok(restored) => final_path = restored,
                    Err(e) => {
                        emit_event(
                            app,
                            &WatcherEvent::Error {
                                path: final_path.to_string_lossy().into_owned(),
                                code: "rename_failed".into(),
                                message: e.to_string(),
                            },
                        );
                    }
                }
            }

            emit_event(
                app,
                &WatcherEvent::ScanCompleted {
                    file_name: display_name.clone(),
                    path: final_path.to_string_lossy().into_owned(),
                    top_severity: top.clone(),
                    signature_count: signatures,
                    critical_count: critical,
                    high_count: high,
                    confirmed_families: families,
                    sha256: o.sha256.clone(),
                    flagged: above_alert,
                    action: action_taken.clone(),
                },
            );

            if settings.notifications_enabled && (above_alert || action_taken.is_some()) {
                wnotify::record_hit(
                    app,
                    &settings,
                    wnotify::Hit {
                        file_name: display_name.clone(),
                        path: final_path.to_string_lossy().into_owned(),
                        top_severity: top.clone(),
                        signature_count: signatures,
                        critical_count: critical,
                        family_names: confirmed_family_names(&o.scan),
                        action: action_taken.clone(),
                    },
                );
            }
        }
        Err(e) => {
            log::warn!(
                "watcher scan failed for {}: {e}",
                crate::api::redact_path(&scan_path.to_string_lossy())
            );
            if hold_active {
                if let Err(re) = hold::rename_from_pending(&scan_path) {
                    log::warn!("restore from hold after failure failed: {re}");
                }
            }
            emit_event(
                app,
                &WatcherEvent::Error {
                    path: original_path.to_string_lossy().into_owned(),
                    code: format!("{:?}", std::mem::discriminant(&e)),
                    message: e.to_string(),
                },
            );
        }
    }

    store.set_scanning(None);
    emit_event(
        app,
        &WatcherEvent::StateChanged {
            run_state: store.snapshot_runtime().run_state,
        },
    );
}

async fn run_internal_scan(app: &AppHandle, path: &Path) -> Result<ScanOutcome, AppError> {
    let client: Client = {
        let http = app.state::<HttpClient>();
        http.0.clone()
    };
    let cancel = Arc::new(Notify::new());
    let started = Instant::now();
    run_scan(
        app,
        &client,
        &cancel,
        started,
        path.to_string_lossy().into_owned(),
        ScanSource::Watcher,
    )
    .await
}

fn collect_baseline(root: &Path, baseline: &mut HashMap<PathBuf, BaselineEntry>) {
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        let canon = entry
            .path()
            .canonicalize()
            .unwrap_or_else(|_| entry.path().to_path_buf());
        baseline.insert(
            canon,
            BaselineEntry {
                mtime,
                size: meta.len(),
            },
        );
    }
}

fn severity_counts_from(scan: &JsonValue) -> (u32, u32, u32, u32, u32) {
    let mut c = (0u32, 0u32, 0u32, 0u32, 0u32);
    if let Some(arr) = scan.get("signatures").and_then(|v| v.as_array()) {
        for s in arr {
            let sev = s.get("severity").and_then(|v| v.as_str()).unwrap_or("info");
            match sev {
                "critical" => c.0 += 1,
                "high" => c.1 += 1,
                "medium" => c.2 += 1,
                "low" => c.3 += 1,
                _ => c.4 += 1,
            }
        }
    }
    c
}

fn top_severity(critical: u32, high: u32, scan: &JsonValue) -> String {
    if critical > 0 {
        return "critical".into();
    }
    if high > 0 {
        return "high".into();
    }
    let (_, _, m, l, i) = severity_counts_from(scan);
    if m > 0 {
        return "medium".into();
    }
    if l > 0 {
        return "low".into();
    }
    if i > 0 {
        return "info".into();
    }
    "info".into()
}

fn signature_count(scan: &JsonValue) -> u32 {
    scan.get("signatures")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u32)
        .unwrap_or(0)
}

pub fn confirmed_families_count(scan: &JsonValue) -> u32 {
    scan.get("confirmedFamilies")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u32)
        .unwrap_or(0)
}

/// Names of confirmed malware families in the scan. Each entry is
/// `confirmedFamilies[i].name` as returned by the server. Order preserved.
pub fn confirmed_family_names(scan: &JsonValue) -> Vec<String> {
    scan.get("confirmedFamilies")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|f| f.get("name").and_then(|n| n.as_str()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn matches_alert(
    t: &crate::watcher::settings::AlertThreshold,
    critical: u32,
    families: u32,
    multi_count: u32,
) -> bool {
    use crate::watcher::settings::AlertThreshold::*;
    match t {
        CriticalSingle => critical >= 1,
        MultipleCriticals => critical >= multi_count.max(2),
        ConfirmedFamiliesOnly => families >= 1,
    }
}

pub fn matches_action(t: &ActionThreshold, critical: u32, families: u32, multi_count: u32) -> bool {
    match t {
        ActionThreshold::Off => false,
        ActionThreshold::MultipleCriticals => critical >= multi_count.max(2),
        ActionThreshold::ConfirmedFamiliesOnly => families >= 1,
    }
}
