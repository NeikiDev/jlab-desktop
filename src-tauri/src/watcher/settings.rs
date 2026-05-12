//! Persistent settings for the folder watcher.
//!
//! Stored as `settings.json` alongside `history.json` in the friendly app
//! data dir. Atomic writes via temp + rename, same pattern as `history.rs`.
//! Schema is versioned; a future-version file is moved aside instead of
//! being trampled by an older build.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const SETTINGS_FILE: &str = "watcher-settings.json";
const TMP_FILE: &str = "watcher-settings.json.tmp";
pub const SCHEMA_VERSION: u32 = 1;

/// Default coalesce window for native notifications, in milliseconds. Hits
/// arriving inside the window after the first one are folded into a single
/// "N risky files" notification instead of spamming the OS.
pub const DEFAULT_COALESCE_WINDOW_MS: u64 = 4000;

/// Hard cap on the auto-scan submission rate. The public API caps inbound
/// at 15 / minute / IP; we leave headroom for the user's manual drag-drop
/// scans by capping the watcher at 12 / minute.
pub const WATCHER_REQUESTS_PER_MINUTE: u32 = 12;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertThreshold {
    /// Fire on any 1 `critical` signature.
    CriticalSingle,
    /// Fire when at least `multiple_criticals_threshold` (2-4) criticals
    /// match in one scan. The count is configured separately so the alert
    /// and auto-delete rules can share a single user-tunable knob.
    #[default]
    MultipleCriticals,
    /// Fire only when at least one entry is present in `confirmedFamilies`.
    ConfirmedFamiliesOnly,
}

/// Threshold for the auto-action (`auto_action_mode` controls *what* the
/// action is: trash or quarantine). When `Off`, no auto-action ever fires.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionThreshold {
    Off,
    /// Fire when at least `multiple_criticals_threshold` criticals match.
    #[default]
    MultipleCriticals,
    ConfirmedFamiliesOnly,
}

/// What the watcher does to a flagged file once the action threshold is
/// met. Quarantine is the default: the file is moved to
/// `<data_dir>/quarantine/<timestamp>-<name>.quarantined` where it cannot
/// be loaded but stays recoverable. Trash moves the file to the operating
/// system recycle bin instead.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionMode {
    #[default]
    Quarantine,
    Trash,
}

/// Default number of critical signatures required by the
/// `MultipleCriticals` threshold. Range is [2, 4] per the settings UI.
pub const DEFAULT_MULTIPLE_CRITICALS_THRESHOLD: u32 = 2;

fn default_multiple_criticals_threshold() -> u32 {
    DEFAULT_MULTIPLE_CRITICALS_THRESHOLD
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RescanInterval {
    #[default]
    #[serde(rename = "off")]
    Off,
    // serde's `rename_all = "snake_case"` does not split `Days7` into
    // `days_7` (there is no letter boundary before the digit), so the
    // TypeScript discriminator `days_7 | days_14 | days_30` only round-trips
    // if we name each variant explicitly. Same goes for any other enum that
    // mixes a word and a number.
    #[serde(rename = "days_7")]
    Days7,
    #[serde(rename = "days_14")]
    Days14,
    #[serde(rename = "days_30")]
    Days30,
}

impl RescanInterval {
    pub fn as_seconds(self) -> Option<u64> {
        match self {
            RescanInterval::Off => None,
            RescanInterval::Days7 => Some(7 * 24 * 60 * 60),
            RescanInterval::Days14 => Some(14 * 24 * 60 * 60),
            RescanInterval::Days30 => Some(30 * 24 * 60 * 60),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolder {
    pub path: PathBuf,
    pub added_at: String,
    #[serde(default)]
    pub last_full_scan_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherSettings {
    pub version: u32,
    pub enabled: bool,
    pub warning_acknowledged: bool,
    pub folders: Vec<WatchedFolder>,
    pub notifications_enabled: bool,
    pub alert_threshold: AlertThreshold,
    pub coalesce_window_ms: u64,
    /// Number of `critical` signatures required by the `MultipleCriticals`
    /// alert / auto-action rule. Clamped to [2, 4] on every set.
    #[serde(default = "default_multiple_criticals_threshold")]
    pub multiple_criticals_threshold: u32,
    /// When the watcher should take an automatic action on a flagged file.
    /// Reads from the legacy `autoDelete` field too so settings written by
    /// older builds migrate without losing the choice.
    #[serde(alias = "autoDelete", default)]
    pub auto_action: ActionThreshold,
    /// What the auto-action does (quarantine to the app data dir, or send
    /// to the OS trash). Defaults to quarantine.
    #[serde(default)]
    pub auto_action_mode: ActionMode,
    pub hold_until_scanned: bool,
    pub rescan_interval: RescanInterval,
    pub minimize_to_tray: bool,
    pub start_minimized: bool,
    pub launch_at_login: bool,
}

impl Default for WatcherSettings {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            enabled: false,
            warning_acknowledged: false,
            folders: Vec::new(),
            notifications_enabled: true,
            alert_threshold: AlertThreshold::default(),
            coalesce_window_ms: DEFAULT_COALESCE_WINDOW_MS,
            multiple_criticals_threshold: DEFAULT_MULTIPLE_CRITICALS_THRESHOLD,
            auto_action: ActionThreshold::default(),
            auto_action_mode: ActionMode::default(),
            hold_until_scanned: false,
            rescan_interval: RescanInterval::default(),
            minimize_to_tray: false,
            start_minimized: false,
            launch_at_login: false,
        }
    }
}

/// Cheaply-cloneable handle to the on-disk settings file. Operations
/// serialize through a process-local mutex so concurrent commands cannot
/// race on the rename step.
#[derive(Clone)]
pub struct SettingsStore {
    inner: Arc<Inner>,
}

struct Inner {
    data_dir: PathBuf,
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                data_dir,
                lock: Mutex::new(()),
            }),
        }
    }

    fn file_path(&self) -> PathBuf {
        self.inner.data_dir.join(SETTINGS_FILE)
    }

    fn tmp_path(&self) -> PathBuf {
        self.inner.data_dir.join(TMP_FILE)
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    pub fn load(&self) -> WatcherSettings {
        let _g = self.inner.lock.lock();
        let path = self.file_path();
        if !path.exists() {
            return WatcherSettings::default();
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return WatcherSettings::default(),
        };
        match serde_json::from_slice::<WatcherSettings>(&bytes) {
            Ok(s) if s.version <= SCHEMA_VERSION => s,
            Ok(s) => {
                let bak = path.with_extension("json.future");
                let _ = std::fs::rename(&path, &bak);
                log::warn!(
                    "watcher-settings.json schema v{} is newer than v{SCHEMA_VERSION}; starting empty",
                    s.version
                );
                WatcherSettings::default()
            }
            Err(e) => {
                let bak = path.with_extension("json.corrupt");
                let _ = std::fs::rename(&path, &bak);
                log::warn!("watcher-settings.json failed to parse ({e}); starting empty");
                WatcherSettings::default()
            }
        }
    }

    pub fn save(&self, settings: &WatcherSettings) -> Result<(), AppError> {
        let _g = self.inner.lock.lock();
        std::fs::create_dir_all(&self.inner.data_dir).map_err(|e| AppError::WatcherIo {
            message: format!("mkdir: {e}"),
        })?;
        let tmp = self.tmp_path();
        let final_path = self.file_path();
        let json = serde_json::to_vec_pretty(settings).map_err(|e| AppError::WatcherIo {
            message: format!("encode: {e}"),
        })?;
        std::fs::write(&tmp, &json).map_err(|e| AppError::WatcherIo {
            message: format!("write tmp: {e}"),
        })?;
        std::fs::rename(&tmp, &final_path).map_err(|e| AppError::WatcherIo {
            message: format!("rename: {e}"),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) =
                std::fs::set_permissions(&final_path, std::fs::Permissions::from_mode(0o600))
            {
                log::warn!("could not chmod 0600 watcher-settings.json: {e}");
            }
        }
        Ok(())
    }
}

// `std::fs::canonicalize` on Windows returns the Win32 device-namespace
// form (`\\?\C:\Windows`, or `\\?\UNC\server\share`). Strip that prefix
// before comparing against the banned-prefix list so the check works
// against the path the user actually picked. No-op on other platforms.
#[cfg(windows)]
fn strip_verbatim_prefix(s: &str) -> &str {
    s.strip_prefix(r"\\?\UNC\")
        .or_else(|| s.strip_prefix(r"\\?\"))
        .unwrap_or(s)
}
#[cfg(not(windows))]
fn strip_verbatim_prefix(s: &str) -> &str {
    s
}

/// Reject obviously dangerous watch paths (root drives, system folders, the
/// app's own data dir). Surface a friendly message to the user via
/// `AppError::InvalidWatchPath`.
pub fn validate_watch_path(path: &Path, data_dir: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Err(AppError::InvalidWatchPath {
            message: "this folder does not exist".into(),
        });
    }
    if !path.is_dir() {
        return Err(AppError::InvalidWatchPath {
            message: "this path is not a folder".into(),
        });
    }
    let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let canon_str = canon.to_string_lossy();
    let normalized = strip_verbatim_prefix(&canon_str);
    let normalized_lower = normalized.to_ascii_lowercase();

    // Refuse the app's own data dir so we never recurse into our own history.
    if let Ok(data_canon) = data_dir.canonicalize() {
        if canon.starts_with(&data_canon) {
            return Err(AppError::InvalidWatchPath {
                message: "you can not watch the JLab data folder".into(),
            });
        }
    }

    // Refuse root drives / system folders. These would either pull in
    // gigabytes of unrelated files or fail on permission.
    let banned_prefixes: &[&str] = &[
        // macOS canonical forms (`/etc` -> `/private/etc`, `/var` -> `/private/var`).
        "/system",
        "/usr",
        "/bin",
        "/sbin",
        "/private/var",
        "/private/etc",
        // Linux canonical forms.
        "/etc",
        "/root",
        "/proc",
        "/sys",
        "/dev",
        "/boot",
        "/run",
        // macOS Library.
        "/library",
        // Windows.
        "c:\\windows",
        "c:/windows",
        "c:\\program files",
        "c:/program files",
        "c:\\program files (x86)",
        "c:/program files (x86)",
    ];
    for prefix in banned_prefixes {
        if normalized_lower.starts_with(prefix) {
            return Err(AppError::InvalidWatchPath {
                message: format!("system folders are not allowed ({prefix})"),
            });
        }
    }

    // Refuse the literal root.
    if canon == Path::new("/") {
        return Err(AppError::InvalidWatchPath {
            message: "the root directory is not allowed".into(),
        });
    }
    // A Windows drive like `C:\` has length 3 and ends with a path
    // separator. Match against the verbatim-stripped form so paths like
    // `\\?\C:\` (the canonical form of `C:\` on Windows) are caught too.
    if normalized.len() <= 3 && normalized.ends_with([':', '\\', '/']) {
        return Err(AppError::InvalidWatchPath {
            message: "the root of a drive is not allowed".into(),
        });
    }
    Ok(())
}

/// Return an ISO 8601 UTC timestamp for "now", at second precision. Avoids
/// a `chrono` dependency by reusing the same approach as `history.rs`.
pub fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe + doe / 36_524 - doe / 1460 - doe / 146_096) / 365;
    let mut y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_safe() {
        let s = WatcherSettings::default();
        assert!(!s.enabled);
        assert!(!s.warning_acknowledged);
        // Auto-action defaults to "multiple criticals + quarantine": when
        // the user turns the master switch on, flagged files are moved to
        // the in-app quarantine folder (recoverable), never hard-deleted.
        assert!(matches!(s.auto_action, ActionThreshold::MultipleCriticals));
        assert!(matches!(s.auto_action_mode, ActionMode::Quarantine));
        assert!(matches!(s.rescan_interval, RescanInterval::Off));
        assert!(!s.hold_until_scanned);
        assert!(!s.minimize_to_tray);
        assert!(!s.launch_at_login);
    }

    #[test]
    fn legacy_auto_delete_field_round_trips() {
        // An older build wrote `autoDelete: "confirmed_families_only"`.
        // The new build reads it via `#[serde(alias = "autoDelete")]` and
        // exposes it as `auto_action` to the frontend.
        let raw = serde_json::json!({
            "version": 1,
            "enabled": false,
            "warningAcknowledged": false,
            "folders": [],
            "notificationsEnabled": true,
            "alertThreshold": "multiple_criticals",
            "coalesceWindowMs": 4000,
            "multipleCriticalsThreshold": 2,
            "autoDelete": "confirmed_families_only",
            "autoActionMode": "trash",
            "holdUntilScanned": false,
            "rescanInterval": "off",
            "minimizeToTray": false,
            "startMinimized": false,
            "launchAtLogin": false,
        });
        let parsed: WatcherSettings = serde_json::from_value(raw).unwrap();
        assert!(matches!(
            parsed.auto_action,
            ActionThreshold::ConfirmedFamiliesOnly
        ));
        assert!(matches!(parsed.auto_action_mode, ActionMode::Trash));
    }

    #[test]
    fn round_trip_json() {
        let s = WatcherSettings::default();
        let bytes = serde_json::to_vec(&s).unwrap();
        let s2: WatcherSettings = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(s2.version, s.version);
        assert_eq!(s2.enabled, s.enabled);
    }

    #[test]
    fn rescan_interval_to_seconds() {
        assert_eq!(RescanInterval::Off.as_seconds(), None);
        assert_eq!(RescanInterval::Days7.as_seconds(), Some(7 * 86400));
        assert_eq!(RescanInterval::Days14.as_seconds(), Some(14 * 86400));
        assert_eq!(RescanInterval::Days30.as_seconds(), Some(30 * 86400));
    }

    #[cfg(windows)]
    #[test]
    fn windows_system_folders_are_rejected_even_through_canonicalize() {
        let data_dir = std::env::temp_dir().join("jlab-validate-windows");
        std::fs::create_dir_all(&data_dir).unwrap();
        let r = validate_watch_path(std::path::Path::new(r"C:\Windows"), &data_dir);
        assert!(matches!(r, Err(AppError::InvalidWatchPath { .. })));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_system_folders_are_rejected() {
        let data_dir = std::env::temp_dir().join("jlab-validate-linux");
        std::fs::create_dir_all(&data_dir).unwrap();
        for p in ["/etc", "/proc", "/sys", "/dev", "/boot"] {
            if !std::path::Path::new(p).exists() {
                continue;
            }
            let r = validate_watch_path(std::path::Path::new(p), &data_dir);
            assert!(
                matches!(r, Err(AppError::InvalidWatchPath { .. })),
                "expected reject for {p}, got {r:?}"
            );
        }
    }
}
