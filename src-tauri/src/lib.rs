mod api;
mod error;
mod history;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("jlab-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .gzip(true)
        .brotli(true)
        .build()
        .expect("failed to build reqwest client");

    let log_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };

    let log_plugin = LogBuilder::new()
        .level(log_level)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(2))
        .targets([
            Target::new(TargetKind::Stderr),
            Target::new(TargetKind::LogDir {
                file_name: Some("debug".into()),
            }),
        ])
        .build();

    tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(api::ScanJobs::default())
        .manage(api::HttpClient(http))
        .setup(|app| {
            // History needs an on-disk home before any scan starts. If the
            // platform-specific app_data_dir is unavailable (very rare), fall
            // back to a per-user temp directory so the rest of the app keeps
            // working. The fallback path is scoped by `$USER` and locked to
            // 0o700 on Unix so a shared `/tmp` does not leak the scan history
            // (file names + sha256s) to other local users (see issue #19).
            let (data_dir, used_fallback) = match app.path().app_data_dir() {
                Ok(dir) => (dir, false),
                Err(_) => (fallback_data_dir(), true),
            };
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                log::warn!(
                    "could not create app data dir {}: {e}",
                    api::redact_path(&data_dir.to_string_lossy())
                );
            } else {
                if used_fallback {
                    log::warn!(
                        "app_data_dir unavailable; using fallback {}",
                        api::redact_path(&data_dir.to_string_lossy())
                    );
                } else {
                    log::info!(
                        "app data dir: {}",
                        api::redact_path(&data_dir.to_string_lossy())
                    );
                }
                // Lock the data dir to 0o700 on Unix on every path. The
                // platform `app_data_dir` (e.g. `~/.local/share/JLAB-Desktop`)
                // inherits the home-directory mode, which on Fedora and
                // openSUSE defaults to 0o755, so without this the scan
                // history (file names + SHA-256s) would be readable by
                // other local users. macOS uses 0o700 on the home dir and
                // Windows uses per-user ACLs, so this is a no-op there but
                // never hurts. (#19, #39)
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
            app.manage(history::HistoryStore::new(data_dir));
            if let Ok(log_dir) = app.path().app_log_dir() {
                log::info!(
                    "app log dir: {}",
                    api::redact_path(&log_dir.to_string_lossy())
                );
                api::prune_old_logs(&log_dir);
            }
            log::info!("jlab-desktop {} started", env!("CARGO_PKG_VERSION"));
            Ok(())
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
