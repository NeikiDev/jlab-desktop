mod api;
mod error;
mod history;
mod paths;
mod watcher;

#[cfg(target_os = "windows")]
mod windows_aumid;

/// Windows AppUserModelID. Must match `identifier` in `tauri.conf.json` so
/// the toast AUMID set by `tauri-plugin-notification` matches the one we
/// register in HKCU and bind to the process at startup.
#[cfg(target_os = "windows")]
const APP_AUMID: &str = "rip.threat.jlab-desktop";

use std::path::PathBuf;
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};

/// Strip everything outside `[A-Za-z0-9_-]` from a username and lowercase it.
/// We use the result as a path component, so we have to defend against
/// hostile values in `$USER` / `$USERNAME` / `$LOGNAME` (path traversal,
/// embedded slashes, control characters, very long inputs).
fn sanitize_username(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                Some(c.to_ascii_lowercase())
            } else {
                None
            }
        })
        .collect();
    out.truncate(32);
    if out.is_empty() {
        out.push_str("anon");
    }
    out
}

/// Last-resort directory for `history.json` if the platform-specific
/// `app_data_dir()` is unavailable. Scoped per-user so two accounts on the
/// same Linux box never share a `/tmp` history file. The caller still has
/// to chmod the directory to 0o700 on Unix; doing it here would be a
/// silent surprise for tests.
fn fallback_data_dir() -> PathBuf {
    let raw = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    let user = sanitize_username(&raw);
    let mut p = std::env::temp_dir();
    p.push(format!("jlab-desktop-{user}"));
    p
}

/// Effective user id of the current process. POSIX `geteuid` is thread-safe
/// and has no preconditions, so a tiny `extern "C"` declaration is enough
/// to avoid pulling in `libc` as a direct dependency for this single call.
/// `uid_t` is `u32` on Linux, macOS, and FreeBSD, which are the platforms
/// this build targets.
#[cfg(unix)]
fn current_euid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid is async-signal-safe and always succeeds.
    unsafe { geteuid() }
}

/// Verify that the per-user `/tmp` fallback dir is owned by us and locked
/// to mode 0o700. The fallback path lives in a world-writable directory, so
/// without this check a local attacker can pre-create the path under their
/// own ownership; chmod then fails with EPERM (only the owner can chmod) and
/// the app would otherwise keep writing to a directory the attacker controls.
///
/// `symlink_metadata` is used so a pre-placed symlink is rejected as "not a
/// directory" rather than being followed to its target. The reason is
/// returned as `AppError::Io` so existing UI surfaces render it without a
/// new typed variant. (#59)
#[cfg(unix)]
fn verify_fallback_dir_security(path: &std::path::Path) -> Result<(), error::AppError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let display = path.to_string_lossy();
    let unsafe_err = |reason: String| error::AppError::Io {
        message: format!("refusing fallback data dir {display}: {reason}"),
    };
    let meta =
        std::fs::symlink_metadata(path).map_err(|e| unsafe_err(format!("stat failed: {e}")))?;
    if !meta.file_type().is_dir() {
        return Err(unsafe_err(
            "not a directory (symlink or other file type)".into(),
        ));
    }
    let owner = meta.uid();
    let euid = current_euid();
    if owner != euid {
        return Err(unsafe_err(format!(
            "owner uid {owner} does not match effective uid {euid}"
        )));
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(unsafe_err(format!("mode 0o{mode:o} is not 0o700")));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Buffer for warnings that fire before the log plugin is up. Replayed
    // via `log::warn!` inside the `setup` callback. On Windows packaged
    // builds (`windows_subsystem = "windows"`) this is the only way they
    // reach `debug.log`, since stderr is detached.
    let mut deferred_warnings: Vec<String> = Vec::new();

    // Windows: register our AUMID in HKCU and bind it to this process before
    // any UI work. Without this the Action Center silently drops every
    // toast we send (the plugin still returns Ok), so both the watcher's
    // coalesced alert and the "send test notification" button look broken.
    // See `windows_aumid.rs` for the full story.
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = windows_aumid::register_aumid(APP_AUMID, "JLab Desktop", None) {
            deferred_warnings.push(format!("aumid registry write failed: {e}"));
        }
        if let Err(e) = windows_aumid::bind_process_aumid(APP_AUMID) {
            deferred_warnings.push(format!("aumid process bind failed: {e}"));
        }
    }

    // Client default needs headroom for a 50 MB scan upload over a slow link.
    // 200 KB/s (saturated home Wi-Fi, rural DSL) needs ~250s for the body
    // alone, so the old 120s ceiling failed before the upload finished and
    // surfaced a generic network error to the user (#69). 300s keeps slow
    // but steady uploads alive; threat-intel and releases override with
    // their own tighter per-call timeouts.
    let http = reqwest::Client::builder()
        .user_agent(concat!("jlab-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .gzip(true)
        .brotli(true)
        .build()
        .expect("failed to build reqwest client");

    let log_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };

    // Resolve our friendly user-visible folder (`JLab`) ourselves so the
    // bundle identifier and the data folder name stay decoupled. See
    // `paths.rs` for the platform layout. Migration from the legacy
    // `JLAB-Desktop` folder runs before the logger is up, so any failures
    // here are buffered and replayed via `log::warn!` from inside the
    // `setup` callback once the log plugin is initialized. Windows
    // packaged builds detach stdout/stderr (`windows_subsystem = "windows"`
    // in `main.rs`), so a plain `eprintln!` would vanish there; the
    // user only ever sees `debug.log`.
    let friendly_log = paths::friendly_log_dir();
    let friendly_data = paths::friendly_data_dir();

    if let (Some(legacy), Some(target)) = (paths::legacy_log_dir(), friendly_log.as_ref()) {
        if let Err(e) = paths::migrate_log_files(&legacy, target) {
            deferred_warnings.push(format!("log migration skipped: {e}"));
        }
    }
    if let (Some(legacy), Some(target)) = (paths::legacy_data_dir(), friendly_data.as_ref()) {
        if let Err(e) = paths::migrate_history_file(&legacy, target) {
            deferred_warnings.push(format!("history migration skipped: {e}"));
        }
    }

    // Point the log plugin at the friendly folder. If the platform
    // resolver fails (no HOME / USERPROFILE / APPDATA, extremely rare),
    // fall back to Tauri's default `LogDir` so logging still works.
    let log_target = match friendly_log.clone() {
        Some(path) => Target::new(TargetKind::Folder {
            path,
            file_name: Some("debug".into()),
        }),
        None => Target::new(TargetKind::LogDir {
            file_name: Some("debug".into()),
        }),
    };

    let log_plugin = LogBuilder::new()
        .level(log_level)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(2))
        .targets([Target::new(TargetKind::Stderr), log_target])
        .build();

    let mut builder = tauri::Builder::default();

    // Must be the first plugin so a duplicate launch is intercepted before
    // any window or watcher work runs (per the tauri-plugin-single-instance
    // README). The callback runs in the already-live process; we surface the
    // existing main window so a double-click focuses instead of spawning a
    // second JLab. Without this, two processes would both poll
    // `watcher-settings.json` and race each other's atomic writes.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(log_plugin)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(api::ScanJobs::default())
        .manage(api::HttpClient(http))
        .setup(move |app| {
            // Replay any pre-logger warnings (migration, Windows AUMID
            // setup) now that the log plugin is up. On Windows packaged
            // builds this is the only path that reaches the user, since
            // `windows_subsystem = "windows"` detaches stderr.
            for warning in &deferred_warnings {
                log::warn!("{warning}");
            }

            // History needs an on-disk home before any scan starts. Prefer
            // the friendly resolver (`<base>/JLab`) so the user-visible
            // folder is decoupled from the bundle identifier. Fall back to
            // Tauri's `app_data_dir()` if the platform resolver fails, and
            // to a per-user temp dir if even that is unavailable. The
            // fallback path is scoped by `$USER` and locked to 0o700 on
            // Unix so a shared `/tmp` does not leak history file names and
            // SHA-256s to other local users (see issue #19).
            let (data_dir, used_fallback) = match friendly_data.clone() {
                Some(dir) => (dir, false),
                None => match app.path().app_data_dir() {
                    Ok(dir) => (dir, false),
                    Err(_) => (fallback_data_dir(), true),
                },
            };
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                log::warn!(
                    "could not create app data dir {}: {e}",
                    api::redact_path(&data_dir.to_string_lossy())
                );
            } else {
                if used_fallback {
                    log::warn!(
                        "platform data dir unavailable; using fallback {}",
                        api::redact_path(&data_dir.to_string_lossy())
                    );
                } else {
                    log::info!(
                        "app data dir: {}",
                        api::redact_path(&data_dir.to_string_lossy())
                    );
                }
                // Lock the data dir to 0o700 on Unix on every path. The
                // platform data dir (e.g. `~/.local/share/JLab`) inherits
                // the home-directory mode, which on Fedora and openSUSE
                // defaults to 0o755, so without this the scan history
                // (file names + SHA-256s) would be readable by other local
                // users. macOS uses 0o700 on the home dir and Windows uses
                // per-user ACLs, so this is defense in depth there. (#19, #39, #46)
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Err(e) =
                        std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700))
                    {
                        log::warn!(
                            "could not chmod 0700 data dir {}: {e}",
                            api::redact_path(&data_dir.to_string_lossy())
                        );
                    }
                }
            }
            // The `/tmp` fallback lives in a world-writable directory, so an
            // attacker can pre-create the per-user path before launch. chmod
            // then silently fails (only the owner can chmod) and we would
            // otherwise keep writing to a directory the attacker controls.
            // Refuse the fallback unless we own it and it is locked to 0o700.
            // (#59)
            #[cfg(unix)]
            if used_fallback {
                if let Err(e) = verify_fallback_dir_security(&data_dir) {
                    log::error!(
                        "{}: refusing to use fallback data dir {}",
                        e,
                        api::redact_path(&data_dir.to_string_lossy())
                    );
                    return Err(Box::new(e));
                }
            }
            app.manage(history::HistoryStore::new(data_dir.clone()));
            // Watcher state. Always managed so the frontend can query
            // settings before the user enables anything. The watcher itself
            // only spins up if `enabled` is persisted as true.
            let settings_store = watcher::settings::SettingsStore::new(data_dir.clone());
            let watcher_store = watcher::WatcherStore::new(settings_store);
            app.manage(watcher_store.clone());

            // Resume the watcher and reconcile autolaunch on startup.
            let initial = watcher_store.snapshot_settings();
            if initial.minimize_to_tray {
                if let Err(e) = watcher::tray::ensure_tray(app.handle()) {
                    log::warn!("tray init skipped: {e}");
                }
            }
            if initial.enabled {
                if let Err(e) = watcher_store.start(app.handle()) {
                    log::warn!("watcher start on boot failed: {e}");
                }
            }
            // Best-effort autolaunch reconcile. We do not surface failures
            // to the user; an old launch agent that no longer matches just
            // gets re-applied next time the toggle is touched.
            use tauri_plugin_autostart::ManagerExt;
            let autolaunch = app.autolaunch();
            let is_enabled = autolaunch.is_enabled().unwrap_or(false);
            if initial.launch_at_login != is_enabled {
                let res = if initial.launch_at_login {
                    autolaunch.enable()
                } else {
                    autolaunch.disable()
                };
                if let Err(e) = res {
                    log::warn!("autolaunch reconcile failed: {e}");
                }
            }
            // Apply start-minimized if it lines up with minimize-to-tray.
            if initial.start_minimized && initial.minimize_to_tray {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }

            let log_dir = friendly_log
                .clone()
                .or_else(|| app.path().app_log_dir().ok());
            if let Some(log_dir) = log_dir {
                log::info!(
                    "app log dir: {}",
                    api::redact_path(&log_dir.to_string_lossy())
                );
                api::prune_old_logs(&log_dir);
            }
            log::info!("jlab-desktop {} started", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if let Some(store) = app.try_state::<watcher::WatcherStore>() {
                    if store.snapshot_settings().minimize_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            api::scan_jar,
            api::cancel_scan,
            api::check_status,
            api::check_for_update,
            api::app_version,
            api::open_url,
            api::open_log_dir,
            api::clear_logs,
            api::log_dir_size,
            api::history_list,
            api::history_clear,
            api::history_delete,
            api::history_cap,
            watcher::commands::watcher_get_settings,
            watcher::commands::watcher_get_runtime_state,
            watcher::commands::watcher_set_enabled,
            watcher::commands::watcher_acknowledge_warning,
            watcher::commands::watcher_add_folder,
            watcher::commands::watcher_remove_folder,
            watcher::commands::watcher_set_notifications,
            watcher::commands::watcher_set_alert_threshold,
            watcher::commands::watcher_set_multiple_criticals_threshold,
            watcher::commands::watcher_set_auto_action,
            watcher::commands::watcher_set_auto_action_mode,
            watcher::commands::watcher_set_hold,
            watcher::commands::watcher_set_rescan,
            watcher::commands::watcher_set_tray,
            watcher::commands::watcher_set_start_minimized,
            watcher::commands::watcher_set_launch_at_login,
            watcher::commands::watcher_scan_all_now,
            watcher::commands::watcher_show_in_folder,
            watcher::commands::watcher_open_quarantine_dir,
            watcher::commands::watcher_pick_folder,
            watcher::commands::watcher_reset_to_defaults,
            watcher::commands::watcher_send_test_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_username_drops_traversal_and_separators() {
        assert_eq!(sanitize_username("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_username("alice/../bob"), "alicebob");
        assert_eq!(sanitize_username("a\\b/c"), "abc");
    }

    #[test]
    fn sanitize_username_keeps_safe_chars() {
        assert_eq!(sanitize_username("alice"), "alice");
        assert_eq!(sanitize_username("Alice_42"), "alice_42");
        assert_eq!(sanitize_username("user-name"), "user-name");
    }

    #[test]
    fn sanitize_username_handles_empty_and_unicode() {
        assert_eq!(sanitize_username(""), "anon");
        assert_eq!(sanitize_username(" "), "anon");
        assert_eq!(sanitize_username("ülrich"), "lrich");
        // After stripping non-ASCII, only "" -> "anon".
        assert_eq!(sanitize_username("日本語"), "anon");
    }

    #[test]
    fn sanitize_username_truncates_long_input() {
        let long = "a".repeat(200);
        let s = sanitize_username(&long);
        assert_eq!(s.len(), 32);
        assert!(s.chars().all(|c| c == 'a'));
    }

    #[cfg(unix)]
    fn unique_tempdir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let mut p = std::env::temp_dir();
        p.push(format!("jlab-verify-{tag}-{pid}-{n}"));
        p
    }

    #[cfg(unix)]
    #[test]
    fn verify_fallback_dir_accepts_self_owned_0o700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_tempdir("ok");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = verify_fallback_dir_security(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(result.is_ok(), "expected ok, got {result:?}");
    }

    #[cfg(unix)]
    #[test]
    fn verify_fallback_dir_rejects_loose_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_tempdir("loose");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = verify_fallback_dir_security(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        let err = result.expect_err("expected mode rejection");
        let msg = err.to_string();
        assert!(msg.contains("mode"), "unexpected error: {msg}");
    }

    #[cfg(unix)]
    #[test]
    fn verify_fallback_dir_rejects_missing_path() {
        let dir = unique_tempdir("missing");
        let result = verify_fallback_dir_security(&dir);
        let err = result.expect_err("expected stat rejection");
        let msg = err.to_string();
        assert!(msg.contains("stat failed"), "unexpected error: {msg}");
    }

    #[cfg(unix)]
    #[test]
    fn verify_fallback_dir_rejects_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let target = unique_tempdir("symtarget");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = unique_tempdir("symlink");
        symlink(&target, &link).unwrap();
        let result = verify_fallback_dir_security(&link);
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&target);
        let err = result.expect_err("expected symlink rejection");
        let msg = err.to_string();
        assert!(msg.contains("not a directory"), "unexpected error: {msg}");
    }

    #[test]
    fn fallback_data_dir_is_scoped_per_user() {
        // We can't safely mutate process env in a parallel test runner, so
        // just verify the path is shaped correctly under whatever the current
        // user is, and that two calls return the same dir (per-user, not
        // per-call random).
        let a = fallback_data_dir();
        let b = fallback_data_dir();
        assert_eq!(a, b, "fallback dir must be stable across calls");
        let name = a
            .file_name()
            .and_then(|n| n.to_str())
            .expect("dir has a name");
        assert!(
            name.starts_with("jlab-desktop-"),
            "expected jlab-desktop-<user>, got {name:?}"
        );
        assert!(
            a.starts_with(std::env::temp_dir()),
            "expected fallback under temp_dir, got {}",
            a.display()
        );
    }
}
