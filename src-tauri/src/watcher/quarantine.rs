//! Move flagged files out of the user's watched folder into a per-app
//! quarantine folder under the JLab data dir.
//!
//! Unlike the trash path, quarantined files do not show up in the OS
//! recycle bin; they sit at `<data_dir>/quarantine/<timestamp>-<name>.quarantined`.
//! The `.quarantined` suffix prevents Java launchers from picking them up
//! and gives external AV scanners a clear hint that the file is held by us
//! intentionally.
//!
//! Same-volume rename is tried first (atomic, instant); cross-volume falls
//! back to copy + remove so a download folder on a removable disk still
//! works.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;

pub const QUARANTINE_FOLDER: &str = "quarantine";
pub const QUARANTINE_SUFFIX: &str = ".quarantined";

pub fn quarantine_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(QUARANTINE_FOLDER)
}

pub async fn send_to_quarantine(path: &Path, data_dir: &Path) -> Result<PathBuf, AppError> {
    let src = path.to_path_buf();
    let dir = quarantine_dir(data_dir);
    tokio::task::spawn_blocking(move || quarantine_blocking(src, dir))
        .await
        .map_err(|e| AppError::WatcherIo {
            message: format!("task: {e}"),
        })?
}

fn quarantine_blocking(src: PathBuf, dir: PathBuf) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(&dir).map_err(|e| AppError::WatcherIo {
        message: format!("create quarantine dir: {e}"),
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Best-effort: tighten to 0o700 so other local users cannot read
        // quarantined payloads even if the data dir was created looser.
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    let original_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = dir.join(format!("{stamp}-{original_name}{QUARANTINE_SUFFIX}"));

    // Try a same-volume rename first. EXDEV (cross-device) is the most
    // common failure: fall back to copy + remove.
    if std::fs::rename(&src, &target).is_ok() {
        log::info!(
            "quarantined {} -> {}",
            crate::api::redact_path(&src.to_string_lossy()),
            crate::api::redact_path(&target.to_string_lossy())
        );
        return Ok(target);
    }

    std::fs::copy(&src, &target).map_err(|e| AppError::WatcherIo {
        message: format!("copy to quarantine: {e}"),
    })?;
    if let Err(e) = std::fs::remove_file(&src) {
        // We already produced a copy. Roll it back so the user does not end
        // up with the same payload in two places.
        let _ = std::fs::remove_file(&target);
        return Err(AppError::WatcherIo {
            message: format!("remove original after copy: {e}"),
        });
    }
    log::info!(
        "quarantined (cross-volume) {} -> {}",
        crate::api::redact_path(&src.to_string_lossy()),
        crate::api::redact_path(&target.to_string_lossy())
    );
    Ok(target)
}
