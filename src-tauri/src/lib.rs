mod api;
mod error;
mod history;

use std::time::Duration;

use tauri::Manager;
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};

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
        .manage(api::ScanJobs::default())
        .manage(api::HttpClient(http))
        .setup(|app| {
            // History needs an on-disk home before any scan starts. If the
            // platform-specific app_data_dir is unavailable (very rare), fall
            // back to a temp directory so the rest of the app keeps working.
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("jlab-desktop"));
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                log::warn!(
                    "could not create app data dir {}: {e}",
                    api::redact_path(&data_dir.to_string_lossy())
                );
            } else {
                log::info!(
                    "app data dir: {}",
                    api::redact_path(&data_dir.to_string_lossy())
                );
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
