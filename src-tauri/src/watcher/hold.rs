//! Hold-until-scanned: rename a newly arrived `.jar` (or supported
//! container) to add a `.jlab-pending` suffix so Java launchers cannot
//! load it while we upload it to the scanner. Renamed back when the scan
//! clears, sent to trash when auto-delete fires.
//!
//! Atomic on the same volume (POSIX `rename`, Win32 `MoveFileEx`). Failures
//! are surfaced as `AppError::RenameFailed`; the caller decides how to
//! recover.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::watcher::core::{enqueue_sync, HOLD_SUFFIX};
use crate::watcher::settings::WatchedFolder;

/// Append `HOLD_SUFFIX` to the file name. Returns the new path. If the
/// destination already exists, fail rather than overwriting.
pub fn rename_to_pending(path: &Path) -> Result<PathBuf, AppError> {
    let target = pending_path_for(path);
    if target.exists() {
        return Err(AppError::RenameFailed {
            message: format!("destination already exists: {}", target.display()),
        });
    }
    std::fs::rename(path, &target).map_err(|e| AppError::RenameFailed {
        message: e.to_string(),
    })?;
    Ok(target)
}

/// Strip the `HOLD_SUFFIX` from the file name. Returns the restored path.
/// Fails if the destination already exists.
pub fn rename_from_pending(path: &Path) -> Result<PathBuf, AppError> {
    let target = restored_path_for(path).ok_or_else(|| AppError::RenameFailed {
        message: "not a hold-pending path".into(),
    })?;
    if target.exists() {
        return Err(AppError::RenameFailed {
            message: format!("destination already exists: {}", target.display()),
        });
    }
    std::fs::rename(path, &target).map_err(|e| AppError::RenameFailed {
        message: e.to_string(),
    })?;
    Ok(target)
}

fn pending_path_for(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(HOLD_SUFFIX);
    PathBuf::from(s)
}

fn restored_path_for(path: &Path) -> Option<PathBuf> {
    let s = path.to_string_lossy();
    let stripped = s.strip_suffix(HOLD_SUFFIX)?;
    Some(PathBuf::from(stripped))
}

/// Walk every watched folder once at startup looking for files that still
/// carry `HOLD_SUFFIX`. These are stragglers from a previous run that
/// crashed or was killed mid-scan. Re-enqueue them so the consumer
/// resolves them (rename back if clean, trash if dirty).
pub fn recover_stragglers(
    app: &AppHandle,
    folders: &[WatchedFolder],
    tx: &mpsc::Sender<PathBuf>,
) -> Result<(), AppError> {
    let mut found: usize = 0;
    for folder in folders {
        for entry in walkdir::WalkDir::new(&folder.path)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let name = match path.to_str() {
                Some(s) => s,
                None => continue,
            };
            if name.ends_with(HOLD_SUFFIX) {
                enqueue_sync(app, tx, path.to_path_buf());
                found += 1;
            }
        }
    }
    if found > 0 {
        log::info!("watcher recovered {found} hold-pending file(s) from previous run");
    }
    Ok(())
}
