//! Move-to-trash for the auto-delete option. Uses the `trash` crate so the
//! file lands in the OS recycle bin / freedesktop trash and can be
//! restored by the user. We never hard-delete.

use std::path::{Path, PathBuf};

use crate::error::AppError;

pub async fn send_to_trash(path: &Path) -> Result<(), AppError> {
    let path: PathBuf = path.to_path_buf();
    tokio::task::spawn_blocking(move || trash::delete(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| AppError::TrashFailed {
            message: format!("task: {e}"),
        })?
        .map_err(|e| AppError::TrashFailed { message: e })
}
