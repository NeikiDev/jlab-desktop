//! Friendly user-visible data and log directory paths, decoupled from the
//! Tauri bundle identifier.
//!
//! Tauri 2 derives `app_data_dir()` / `app_log_dir()` from the bundle
//! `identifier`, which is now `rip.threat.jlab-desktop` for store and
//! macOS Bundle ID compliance. We do not want users to find a folder
//! named `rip.threat.jlab-desktop` in their data dir, so we resolve a
//! friendly folder (`JLab`) ourselves using the same platform conventions
//! and store `history.json` and the log files there.
//!
//! The legacy folder (`JLAB-Desktop`, used by 0.3.x and earlier) is migrated
//! one-shot on startup so existing installs do not appear to lose history.

use std::path::PathBuf;

/// User-visible folder name. Stays stable across identifier changes.
pub const FRIENDLY_FOLDER: &str = "JLab";

/// 0.3.x and earlier wrote here. Migrated on first launch of the new build.
pub const LEGACY_FOLDER: &str = "JLAB-Desktop";

// Only macOS and Linux resolve from `$HOME`. Windows reads `APPDATA` /
// `LOCALAPPDATA` directly, so this helper is unused there and gating it
// keeps clippy `-D warnings` happy on the Windows job.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn data_base() -> Option<PathBuf> {
    Some(home_dir()?.join("Library").join("Application Support"))
}

#[cfg(target_os = "macos")]
fn log_base() -> Option<PathBuf> {
    Some(home_dir()?.join("Library").join("Logs"))
}

#[cfg(target_os = "windows")]
fn data_base() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn log_base() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

#[cfg(target_os = "linux")]
fn data_base() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(xdg));
    }
    Some(home_dir()?.join(".local").join("share"))
}

#[cfg(target_os = "linux")]
fn log_base() -> Option<PathBuf> {
    data_base()
}

/// `<data_base>/JLab` on every platform.
pub fn friendly_data_dir() -> Option<PathBuf> {
    Some(data_base()?.join(FRIENDLY_FOLDER))
}

/// `<data_base>/JLAB-Desktop` on every platform.
pub fn legacy_data_dir() -> Option<PathBuf> {
    Some(data_base()?.join(LEGACY_FOLDER))
}

/// Friendly log dir. macOS: `~/Library/Logs/JLab`. Windows + Linux:
/// `<base>/JLab/logs` to match `tauri-plugin-log`'s historical layout.
pub fn friendly_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(log_base()?.join(FRIENDLY_FOLDER))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(log_base()?.join(FRIENDLY_FOLDER).join("logs"))
    }
}

/// Legacy log dir, mirrored from `friendly_log_dir` shape.
pub fn legacy_log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(log_base()?.join(LEGACY_FOLDER))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(log_base()?.join(LEGACY_FOLDER).join("logs"))
    }
}

/// One-shot migration of `history.json` from the legacy folder. Idempotent:
/// running twice is a no-op. Never overwrites an existing target file. Errors
/// are returned to the caller so it can decide how to surface them; failure
/// is non-fatal at the call site.
pub fn migrate_history_file(
    legacy_dir: &std::path::Path,
    target_dir: &std::path::Path,
) -> std::io::Result<bool> {
    if legacy_dir == target_dir {
        return Ok(false);
    }
    let src = legacy_dir.join("history.json");
    let dst = target_dir.join("history.json");
    if !src.exists() || dst.exists() {
        return Ok(false);
    }
    std::fs::create_dir_all(target_dir)?;
    std::fs::rename(&src, &dst)?;
    Ok(true)
}

/// One-shot migration of `debug*.log` files (active + rotated) from the
/// legacy folder. Idempotent. Per-file: skip if the same name already exists
/// in the target. Other files in the legacy log dir are left alone.
///
/// Match rule: the file name must start with `debug` AND end with `.log`.
/// This rejects unrelated files like `debug-notes.txt` or `debugger.cfg`
/// that happen to share the prefix.
///
/// Returns the number of files moved.
pub fn migrate_log_files(
    legacy_dir: &std::path::Path,
    target_dir: &std::path::Path,
) -> std::io::Result<usize> {
    if legacy_dir == target_dir || !legacy_dir.exists() {
        return Ok(0);
    }
    let entries = std::fs::read_dir(legacy_dir)?;
    let mut moved = 0usize;
    let mut target_ready = false;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with("debug") || !name_str.ends_with(".log") {
            continue;
        }
        let src = entry.path();
        let dst = target_dir.join(&name);
        if dst.exists() {
            continue;
        }
        if !target_ready {
            std::fs::create_dir_all(target_dir)?;
            target_ready = true;
        }
        if std::fs::rename(&src, &dst).is_ok() {
            moved += 1;
        }
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn friendly_dir_uses_jlab_suffix() {
        if let Some(p) = friendly_data_dir() {
            assert_eq!(
                p.file_name().and_then(|n| n.to_str()),
                Some(FRIENDLY_FOLDER),
                "expected trailing JLab in {p:?}"
            );
        }
    }

    #[test]
    fn legacy_and_friendly_share_a_parent() {
        if let (Some(a), Some(b)) = (friendly_data_dir(), legacy_data_dir()) {
            assert_eq!(a.parent(), b.parent());
            assert_ne!(a, b);
        }
    }

    #[test]
    fn migrate_history_moves_when_target_is_empty() {
        let tmp = std::env::temp_dir().join(format!("jlab-paths-test-{}", std::process::id()));
        let legacy = tmp.join("legacy");
        let target = tmp.join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("history.json"), b"{\"version\":1}").unwrap();

        let moved = migrate_history_file(&legacy, &target).unwrap();
        assert!(moved);
        assert!(target.join("history.json").exists());
        assert!(!legacy.join("history.json").exists());

        // Idempotent: second call is a no-op.
        let again = migrate_history_file(&legacy, &target).unwrap();
        assert!(!again);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn migrate_history_does_not_overwrite() {
        let tmp =
            std::env::temp_dir().join(format!("jlab-paths-test-overwrite-{}", std::process::id()));
        let legacy = tmp.join("legacy");
        let target = tmp.join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("history.json"), b"OLD").unwrap();
        fs::write(target.join("history.json"), b"NEW").unwrap();

        let moved = migrate_history_file(&legacy, &target).unwrap();
        assert!(!moved, "must not overwrite an existing target file");
        assert_eq!(fs::read(target.join("history.json")).unwrap(), b"NEW");
        assert_eq!(fs::read(legacy.join("history.json")).unwrap(), b"OLD");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn migrate_logs_moves_debug_files_only() {
        let tmp = std::env::temp_dir().join(format!("jlab-paths-test-logs-{}", std::process::id()));
        let legacy = tmp.join("legacy");
        let target = tmp.join("target");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("debug.log"), b"a").unwrap();
        fs::write(legacy.join("debug_2.log"), b"b").unwrap();
        fs::write(legacy.join("other.log"), b"c").unwrap();
        // Starts with "debug" but is not a log file. Must not be moved.
        fs::write(legacy.join("debug-notes.txt"), b"d").unwrap();
        fs::write(legacy.join("debugger.cfg"), b"e").unwrap();

        let moved = migrate_log_files(&legacy, &target).unwrap();
        assert_eq!(moved, 2);
        assert!(target.join("debug.log").exists());
        assert!(target.join("debug_2.log").exists());
        assert!(!target.join("other.log").exists());
        assert!(legacy.join("other.log").exists());
        assert!(!target.join("debug-notes.txt").exists());
        assert!(legacy.join("debug-notes.txt").exists());
        assert!(!target.join("debugger.cfg").exists());
        assert!(legacy.join("debugger.cfg").exists());

        // Idempotent.
        let again = migrate_log_files(&legacy, &target).unwrap();
        assert_eq!(again, 0);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn migrate_history_no_legacy_is_noop() {
        let tmp =
            std::env::temp_dir().join(format!("jlab-paths-test-fresh-{}", std::process::id()));
        let legacy = tmp.join("legacy-missing");
        let target = tmp.join("target");
        let moved = migrate_history_file(&legacy, &target).unwrap();
        assert!(!moved);
        fs::remove_dir_all(&tmp).ok();
    }
}
