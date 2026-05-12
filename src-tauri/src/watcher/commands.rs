//! Tauri commands for the folder watcher. Settings and folder mutations
//! are synchronous (small JSON file); destructive and start/stop calls
//! return after their async work resolves.

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::error::AppError;
use crate::watcher::core::{WatcherRuntimeState, WatcherStore};
use crate::watcher::settings::{
    validate_watch_path, ActionMode, ActionThreshold, AlertThreshold, RescanInterval,
    WatchedFolder, WatcherSettings,
};
use crate::watcher::tray;

#[tauri::command]
pub fn watcher_get_settings(store: State<'_, WatcherStore>) -> WatcherSettings {
    store.snapshot_settings()
}

#[tauri::command]
pub fn watcher_get_runtime_state(store: State<'_, WatcherStore>) -> WatcherRuntimeState {
    store.snapshot_runtime()
}

#[tauri::command]
pub async fn watcher_set_enabled(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    enabled: bool,
) -> Result<WatcherSettings, AppError> {
    let current = store.snapshot_settings();
    if enabled && !current.warning_acknowledged {
        return Err(AppError::WatcherDisabled);
    }
    let updated = store.mutate_settings(&app, |s| {
        s.enabled = enabled;
    })?;
    if enabled {
        store.start(&app)?;
    } else {
        store.stop(&app);
    }
    Ok(updated)
}

#[tauri::command]
pub fn watcher_acknowledge_warning(
    app: AppHandle,
    store: State<'_, WatcherStore>,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.warning_acknowledged = true;
    })
}

#[tauri::command]
pub fn watcher_add_folder(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    path: String,
) -> Result<WatcherSettings, AppError> {
    let p = PathBuf::from(&path);
    validate_watch_path(&p, &store.data_dir())?;
    let canon = p.canonicalize().unwrap_or(p.clone());
    let updated = store.mutate_settings(&app, |s| {
        if !s.folders.iter().any(|f| f.path == canon) {
            s.folders.push(WatchedFolder {
                path: canon.clone(),
                added_at: crate::watcher::settings::now_iso8601(),
                last_full_scan_at: None,
            });
        }
    })?;
    if updated.enabled {
        store.watch_folder(&canon)?;
    }
    Ok(updated)
}

#[tauri::command]
pub fn watcher_remove_folder(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    path: String,
) -> Result<WatcherSettings, AppError> {
    let target = PathBuf::from(&path);
    let updated = store.mutate_settings(&app, |s| {
        s.folders.retain(|f| f.path != target);
    })?;
    store.unwatch_folder(&target);
    Ok(updated)
}

#[tauri::command]
pub fn watcher_set_notifications(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    enabled: bool,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.notifications_enabled = enabled;
    })
}

#[tauri::command]
pub fn watcher_set_alert_threshold(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    threshold: AlertThreshold,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.alert_threshold = threshold;
    })
}

#[tauri::command]
pub fn watcher_set_multiple_criticals_threshold(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    count: u32,
) -> Result<WatcherSettings, AppError> {
    let clamped = count.clamp(2, 4);
    store.mutate_settings(&app, |s| {
        s.multiple_criticals_threshold = clamped;
    })
}

#[tauri::command]
pub fn watcher_set_auto_action(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    threshold: ActionThreshold,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.auto_action = threshold;
    })
}

#[tauri::command]
pub fn watcher_set_auto_action_mode(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    mode: ActionMode,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.auto_action_mode = mode;
    })
}

#[tauri::command]
pub fn watcher_set_hold(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    hold: bool,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.hold_until_scanned = hold;
    })
}

#[tauri::command]
pub fn watcher_set_rescan(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    interval: RescanInterval,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.rescan_interval = interval;
    })
}

#[tauri::command]
pub fn watcher_set_tray(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    enabled: bool,
) -> Result<WatcherSettings, AppError> {
    let updated = store.mutate_settings(&app, |s| {
        s.minimize_to_tray = enabled;
    })?;
    if enabled {
        tray::ensure_tray(&app)?;
    }
    Ok(updated)
}

#[tauri::command]
pub fn watcher_set_start_minimized(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    enabled: bool,
) -> Result<WatcherSettings, AppError> {
    store.mutate_settings(&app, |s| {
        s.start_minimized = enabled;
    })
}

#[tauri::command]
pub fn watcher_set_launch_at_login(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    enabled: bool,
) -> Result<WatcherSettings, AppError> {
    let updated = store.mutate_settings(&app, |s| {
        s.launch_at_login = enabled;
    })?;
    let autolaunch = app.autolaunch();
    let res = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    if let Err(e) = res {
        log::warn!("autolaunch toggle failed: {e}");
    }
    Ok(updated)
}

/// Soft per-call cap. The watcher's outbound queue is bounded at 12 scans
/// per minute, so a `Scan all` on a 50k-file folder would otherwise hold
/// the rate limiter for hours. The user can re-click to continue.
const SCAN_ALL_BATCH_CAP: usize = 500;

#[tauri::command]
pub async fn watcher_scan_all_now(
    app: AppHandle,
    store: State<'_, WatcherStore>,
    path: String,
) -> Result<(), AppError> {
    let raw = PathBuf::from(&path);
    if !raw.exists() {
        return Err(AppError::InvalidWatchPath {
            message: "this folder does not exist".into(),
        });
    }
    // Match against the configured watch list using the canonical form,
    // because `watcher_add_folder` stores folders canonicalized. This
    // keeps the command from doubling as an arbitrary-walk API if a
    // future caller passes a path the user never picked.
    let canon = raw.canonicalize().map_err(|e| AppError::InvalidWatchPath {
        message: format!("canonicalize: {e}"),
    })?;
    let settings = store.snapshot_settings();
    if !settings.folders.iter().any(|f| f.path == canon) {
        return Err(AppError::InvalidWatchPath {
            message: "this folder is not one of your watched folders".into(),
        });
    }

    let store_clone: WatcherStore = (*store).clone();
    let app_clone = app.clone();
    let folder_for_walk = canon.clone();

    // `walkdir` is synchronous; running it directly in this `async fn`
    // would burn a tokio worker for the full walk. Move it to the
    // blocking pool so IPC stays responsive.
    let queued = tokio::task::spawn_blocking(move || -> usize {
        let mut queued = 0usize;
        for entry in walkdir::WalkDir::new(&folder_for_walk)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase());
            if !matches!(ext.as_deref(), Some("jar" | "zip" | "mcpack" | "mrpack")) {
                continue;
            }
            store_clone.force_enqueue(&app_clone, p.to_path_buf());
            queued += 1;
            if queued >= SCAN_ALL_BATCH_CAP {
                log::warn!(
                    "scan_all_now: capping batch at {SCAN_ALL_BATCH_CAP}, remaining files skipped"
                );
                break;
            }
        }
        queued
    })
    .await
    .map_err(|e| AppError::WatcherIo {
        message: format!("walk task: {e}"),
    })?;

    log::info!("scan_all_now queued {queued} file(s) from {}", path);
    Ok(())
}

#[tauri::command]
pub async fn watcher_open_quarantine_dir(
    app: AppHandle,
    store: State<'_, WatcherStore>,
) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let dir = crate::watcher::quarantine::quarantine_dir(&store.data_dir());
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| AppError::WatcherIo {
            message: format!("create quarantine dir: {e}"),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Match the lazy-create permissions used when the watcher
            // actually quarantines a file (see watcher/quarantine.rs).
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Io {
            message: e.to_string(),
        })?;
    log::info!(
        "opened quarantine dir {}",
        crate::api::redact_path(&dir.to_string_lossy())
    );
    Ok(())
}

#[tauri::command]
pub async fn watcher_show_in_folder(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::Path::new(&path);
    let parent = if p.is_dir() {
        p
    } else {
        p.parent().unwrap_or(p)
    };
    app.opener()
        .open_path(parent.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Io {
            message: e.to_string(),
        })?;
    Ok(())
}

#[tauri::command]
pub async fn watcher_reset_to_defaults(
    app: AppHandle,
    store: State<'_, WatcherStore>,
) -> Result<WatcherSettings, AppError> {
    // Stop the watcher first if it is running. Any in-flight scans or
    // hold-pending recoveries unwind cleanly before we wipe settings.
    store.stop(&app);

    let defaults = WatcherSettings::default();
    let updated = store.mutate_settings(&app, |s| {
        *s = defaults.clone();
    })?;

    // Reset autolaunch state to match the new (off) setting. Best effort:
    // if the OS rejects the disable call we just log and continue.
    use tauri_plugin_autostart::ManagerExt;
    if let Err(e) = app.autolaunch().disable() {
        log::warn!("autolaunch disable on reset failed: {e}");
    }

    log::info!("watcher: reset to defaults");
    Ok(updated)
}

/// Fire a single notification immediately. Bypasses the alert threshold,
/// the coalescing window, and the watcher's enabled state so the user can
/// confirm the OS is willing to draw a toast for this app.
#[tauri::command]
pub fn watcher_send_test_notification(app: AppHandle) -> Result<(), AppError> {
    crate::watcher::notify::send_test_notification(&app)
}

#[tauri::command]
pub async fn watcher_pick_folder(app: AppHandle) -> Result<Option<String>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    let result = rx.await.map_err(|e| AppError::WatcherIo {
        message: format!("dialog: {e}"),
    })?;
    Ok(result)
}
