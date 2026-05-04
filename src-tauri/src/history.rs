use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const HISTORY_FILE: &str = "history.json";
const TMP_FILE: &str = "history.json.tmp";
const SCHEMA_VERSION: u32 = 1;

/// Cap entries persisted on disk. On overflow the oldest entries are dropped
/// in `append`. Documented in CLAUDE.md ("Local history" section).
pub const HISTORY_CAP: usize = 100;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeverityCounts {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub info: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub scanned_at: String,
    pub file_name: String,
    pub file_size_bytes: u64,
    pub sha256: String,
    pub severity_counts: SeverityCounts,
    pub top_severity: String,
    pub signature_count: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    entries: Vec<HistoryEntry>,
}

impl Default for HistoryFile {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

/// Tauri-managed handle to the on-disk history. Cheaply cloneable; the actual
/// state lives behind an `Arc`. Operations serialize through a process-local
/// mutex so concurrent commands don't race on the rename step.
#[derive(Clone)]
pub struct HistoryStore {
    inner: Arc<Inner>,
}

struct Inner {
    data_dir: PathBuf,
    lock: Mutex<()>,
}

impl HistoryStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                data_dir,
                lock: Mutex::new(()),
            }),
        }
    }

    fn file_path(&self) -> PathBuf {
        self.inner.data_dir.join(HISTORY_FILE)
    }

    fn tmp_path(&self) -> PathBuf {
        self.inner.data_dir.join(TMP_FILE)
    }
}

pub async fn list(store: HistoryStore) -> Result<Vec<HistoryEntry>, AppError> {
    spawn_blocking_history(move || load_blocking(&store)).await
}

pub async fn append(store: HistoryStore, entry: HistoryEntry) -> Result<(), AppError> {
    spawn_blocking_history(move || append_blocking(&store, entry)).await
}

pub async fn clear(store: HistoryStore) -> Result<(), AppError> {
    spawn_blocking_history(move || {
        let _g = store.inner.lock.lock();
        ensure_dir(&store)?;
        write_atomic(&store, &HistoryFile::default())
    })
    .await
}

pub async fn delete(store: HistoryStore, id: String) -> Result<(), AppError> {
    spawn_blocking_history(move || {
        let _g = store.inner.lock.lock();
        let mut file = read_or_default(&store.file_path());
        file.entries.retain(|e| e.id != id);
        file.version = SCHEMA_VERSION;
        ensure_dir(&store)?;
        write_atomic(&store, &file)
    })
    .await
}

async fn spawn_blocking_history<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::HistoryIo {
            message: format!("task: {e}"),
        })?
}

fn load_blocking(store: &HistoryStore) -> Result<Vec<HistoryEntry>, AppError> {
    let _g = store.inner.lock.lock();
    let path = store.file_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = read_or_default(&path);
    Ok(file.entries)
}

fn append_blocking(store: &HistoryStore, entry: HistoryEntry) -> Result<(), AppError> {
    let _g = store.inner.lock.lock();
    ensure_dir(store)?;
    let mut file = read_or_default(&store.file_path());
    file.version = SCHEMA_VERSION;
    file.entries.push(entry);
    if file.entries.len() > HISTORY_CAP {
        let drop_count = file.entries.len() - HISTORY_CAP;
        file.entries.drain(0..drop_count);
    }
    write_atomic(store, &file)
}

fn ensure_dir(store: &HistoryStore) -> Result<(), AppError> {
    std::fs::create_dir_all(&store.inner.data_dir).map_err(|e| AppError::HistoryIo {
        message: format!("mkdir: {e}"),
    })
}

/// Load the history file from disk, or fall back to an empty default.
///
/// On parse failure the bad file is renamed to `history.json.corrupt`
/// before we return the default. Without that step the next `append` would
/// silently overwrite the unreadable file with an empty one and the user
/// would lose every prior entry with no warning. Renaming preserves the
/// data for inspection and leaves a log line the user can find through the
/// existing log control.
fn read_or_default(path: &Path) -> HistoryFile {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return HistoryFile::default(),
    };
    match serde_json::from_slice(&bytes) {
        Ok(file) => file,
        Err(e) => {
            let bak = path.with_extension("json.corrupt");
            if let Err(rename_err) = std::fs::rename(path, &bak) {
                log::warn!(
                    "history.json failed to parse ({e}); could not move aside ({rename_err}), starting empty"
                );
            } else {
                log::warn!(
                    "history.json failed to parse ({e}); moved to {} and starting empty",
                    bak.display()
                );
            }
            HistoryFile::default()
        }
    }
}

fn write_atomic(store: &HistoryStore, contents: &HistoryFile) -> Result<(), AppError> {
    let tmp = store.tmp_path();
    let final_path = store.file_path();
    let json = serde_json::to_vec_pretty(contents).map_err(|e| AppError::HistoryIo {
        message: format!("encode: {e}"),
    })?;
    std::fs::write(&tmp, &json).map_err(|e| AppError::HistoryIo {
        message: format!("write tmp: {e}"),
    })?;
    std::fs::rename(&tmp, &final_path).map_err(|e| AppError::HistoryIo {
        message: format!("rename: {e}"),
    })?;
    Ok(())
}

/// Build a `HistoryEntry` from the parsed scan response. Walks the
/// `signatures` array once to compute per-severity counts and the highest
/// severity present. Any unknown severity rolls up under `info`, matching
/// the frontend's normalization.
pub fn build_entry(
    scan: &serde_json::Value,
    file_name: &str,
    file_size_bytes: u64,
    sha256: &str,
) -> HistoryEntry {
    let mut counts = SeverityCounts::default();
    let mut signature_count: u32 = 0;
    if let Some(sigs) = scan.get("signatures").and_then(|v| v.as_array()) {
        signature_count = sigs.len() as u32;
        for sig in sigs {
            let sev = sig
                .get("severity")
                .and_then(|s| s.as_str())
                .unwrap_or("info");
            match sev {
                "critical" => counts.critical += 1,
                "high" => counts.high += 1,
                "medium" => counts.medium += 1,
                "low" => counts.low += 1,
                _ => counts.info += 1,
            }
        }
    }

    let top_severity = if counts.critical > 0 {
        "critical"
    } else if counts.high > 0 {
        "high"
    } else if counts.medium > 0 {
        "medium"
    } else if counts.low > 0 {
        "low"
    } else {
        "info"
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let scanned_at_ms = now.as_millis() as u64;
    let scanned_at = iso8601_utc(now.as_secs() as i64, now.subsec_millis());
    let id = format!("{scanned_at_ms}-{}", sha256.get(..8).unwrap_or(sha256));

    HistoryEntry {
        id,
        scanned_at,
        file_name: file_name.to_string(),
        file_size_bytes,
        sha256: sha256.to_string(),
        severity_counts: counts,
        top_severity: top_severity.to_string(),
        signature_count,
    }
}

fn iso8601_utc(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let h = secs_of_day / 3600;
    let m = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

// Howard Hinnant's "civil_from_days" — converts days since the Unix epoch
// (1970-01-01) into a proleptic Gregorian date. Public-domain algorithm
// from <https://howardhinnant.github.io/date_algorithms.html>. The shifted
// epoch (March 1, year 0) lets us handle leap years without per-month
// branches; we shift back at the end.
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
    fn iso_format_basic() {
        // 2024-01-02T03:04:05.006Z (=> 1704164645 seconds since epoch)
        let s = iso8601_utc(1_704_164_645, 6);
        assert_eq!(s, "2024-01-02T03:04:05.006Z");
    }

    #[test]
    fn iso_format_epoch() {
        assert_eq!(iso8601_utc(0, 0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn iso_format_leap_year() {
        // 2024-02-29T00:00:00Z => 1709164800
        assert_eq!(iso8601_utc(1_709_164_800, 0), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn build_entry_counts_severities() {
        let scan = serde_json::json!({
            "signatures": [
                { "severity": "critical" },
                { "severity": "critical" },
                { "severity": "high" },
                { "severity": "low" },
                { "severity": "weird" },
            ]
        });
        let e = build_entry(&scan, "x.jar", 1234, "abcdef0123456789");
        assert_eq!(e.signature_count, 5);
        assert_eq!(e.severity_counts.critical, 2);
        assert_eq!(e.severity_counts.high, 1);
        assert_eq!(e.severity_counts.medium, 0);
        assert_eq!(e.severity_counts.low, 1);
        assert_eq!(e.severity_counts.info, 1);
        assert_eq!(e.top_severity, "critical");
        assert_eq!(e.sha256, "abcdef0123456789");
        assert!(e.id.ends_with("-abcdef01"));
    }

    #[test]
    fn build_entry_no_signatures() {
        let scan = serde_json::json!({ "signatures": [] });
        let e = build_entry(&scan, "x.jar", 0, "00");
        assert_eq!(e.signature_count, 0);
        assert_eq!(e.top_severity, "info");
    }

    #[test]
    fn corrupt_history_is_moved_aside() {
        let dir = std::env::temp_dir().join(format!(
            "jlab-history-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.json");
        let bak = dir.join("history.json.corrupt");

        std::fs::write(&path, b"{not json").unwrap();

        let file = read_or_default(&path);
        assert!(
            file.entries.is_empty(),
            "expected empty default on parse failure"
        );
        assert!(!path.exists(), "expected the bad file to be moved aside");
        assert!(bak.exists(), "expected history.json.corrupt to exist");
        assert_eq!(std::fs::read(&bak).unwrap(), b"{not json");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
