//! Periodic rescan scheduler. Wakes every 6 hours, and if the user has
//! configured a rescan interval (7 / 14 / 30 days), walks each watched
//! folder for `.jar` files whose latest history scan is older than the
//! interval. Capped per wake-up so the first run after install does not
//! wedge the rate limiter for a full minute.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::history::{self, HistoryStore};
use crate::watcher::core::WatcherStore;
use crate::watcher::settings::RescanInterval;

const SCHEDULER_TICK: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_BATCH: usize = 50;

pub async fn scheduler_loop(store: WatcherStore, app: AppHandle, kill: Arc<Notify>) {
    loop {
        tokio::select! {
            biased;
            _ = kill.notified() => return,
            _ = tokio::time::sleep(SCHEDULER_TICK) => {},
        }
        tick_once(&store, &app).await;
    }
}

pub async fn tick_once(store: &WatcherStore, app: &AppHandle) {
    let settings = store.snapshot_settings();
    let Some(interval_secs) = settings.rescan_interval.as_seconds() else {
        return;
    };
    let cutoff = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs().saturating_sub(interval_secs),
        Err(_) => return,
    };

    let history_store = match app.try_state::<HistoryStore>() {
        Some(s) => s.clone(),
        None => return,
    };
    let entries = match history::list((*history_store).clone()).await {
        Ok(e) => e,
        Err(err) => {
            log::warn!("rescan: history list failed: {err}");
            return;
        }
    };

    let folders = settings.folders.clone();
    // `walkdir` is synchronous; running it directly in this `async fn`
    // would burn a tokio worker for the duration of the walk (and the
    // walk can take seconds on a large baseline). Collect the batch on
    // the blocking pool, then enqueue back on the async side.
    let batch = tokio::task::spawn_blocking(move || -> Vec<PathBuf> {
        let mut batch: Vec<PathBuf> = Vec::new();
        'outer: for folder in &folders {
            for entry in walkdir::WalkDir::new(&folder.path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path();
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_ascii_lowercase());
                if ext.as_deref() != Some("jar") {
                    continue;
                }
                // Find newest history entry for this file by name.
                // (We do not compute sha256 on the rescan path: we are
                // just pacing the queue, not gating correctness. The
                // actual scan does the sha256 inside `run_scan`.)
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default();
                let last = entries
                    .iter()
                    .filter(|e| e.file_name == file_name && e.source == "watcher")
                    .map(|e| iso_to_unix(&e.scanned_at))
                    .max()
                    .unwrap_or(0);
                if last == 0 || last < cutoff as i64 {
                    batch.push(PathBuf::from(path));
                    if batch.len() >= MAX_BATCH {
                        break 'outer;
                    }
                }
            }
        }
        batch
    })
    .await
    .unwrap_or_default();

    let queued = batch.len();
    for path in batch {
        store.force_enqueue(app, path);
    }
    if queued > 0 {
        log::info!("rescan: queued {queued} file(s) for re-upload");
    }
}

fn iso_to_unix(iso: &str) -> i64 {
    // Best-effort parser: handles `YYYY-MM-DDTHH:MM:SSZ` and the variant
    // with `.fff`. Avoids pulling chrono just for this comparison. Returns
    // 0 on parse failure, which makes the rescan path treat the file as
    // stale.
    let s = iso.trim_end_matches('Z');
    let (date, time) = match s.split_once('T') {
        Some(p) => p,
        None => return 0,
    };
    let mut dparts = date.split('-');
    let y: i32 = dparts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let mo: u32 = dparts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let d: u32 = dparts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let time_main = time.split('.').next().unwrap_or("");
    let mut tparts = time_main.split(':');
    let h: i64 = tparts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let mi: i64 = tparts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let se: i64 = tparts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let days = civil_to_days(y, mo, d);
    days * 86_400 + h * 3600 + mi * 60 + se
}

fn civil_to_days(y: i32, m: u32, d: u32) -> i64 {
    if y == 0 || m == 0 || d == 0 {
        return 0;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y / 400 } else { (y - 399) / 400 } as i64;
    let yoe = y as i64 - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// Suppress dead-code warning for `RescanInterval` re-export only used
// inline; this is a no-op import that documents the public type.
#[allow(dead_code)]
const _USE_INTERVAL: Option<RescanInterval> = None;
