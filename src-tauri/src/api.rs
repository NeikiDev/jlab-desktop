use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::multipart::{Form, Part};
use reqwest::{Client, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use crate::error::AppError;
use crate::history::{self, HistoryStore};

/// Replace the user's home directory prefix with `~` so log lines don't leak
/// the system username. Operates on display strings only.
pub fn redact_path(p: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    if let Some(home) = home {
        if !home.is_empty() && p.starts_with(&home) {
            return format!("~{}", &p[home.len()..]);
        }
    }
    p.to_string()
}

/// Short fingerprint for log triage: first/last 4 bytes hex + total size.
/// Cheap to compute, enough to tell two upload attempts apart in support
/// requests, and never exposes file contents.
fn fingerprint(bytes: &[u8]) -> String {
    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    let n = bytes.len();
    if n == 0 {
        return "empty".into();
    }
    let head = &bytes[..n.min(4)];
    let tail = &bytes[n.saturating_sub(4)..];
    format!("{}..{}", hex(head), hex(tail))
}

/// Lowercase SHA-256 hex of `bytes`. Used to look up third-party threat intel
/// against the public threat-rip endpoint.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Walk the `std::error::Error::source()` chain into a single string. reqwest
/// wraps hyper, which wraps an IO error or timeout, so the top-level Display
/// often hides the real cause ("error decoding response body" can mean a
/// timeout, a chunked-trailer failure, a decompression error, or a TLS
/// close issue, depending on the inner source).
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cur: Option<&(dyn std::error::Error + 'static)> = e.source();
    let mut depth = 0;
    while let Some(src) = cur {
        if depth >= 5 {
            out.push_str(" -> ...");
            break;
        }
        out.push_str(" -> ");
        out.push_str(&src.to_string());
        cur = src.source();
        depth += 1;
    }
    out
}

/// Read a threat-intel response body into a JSON value. Failures are logged
/// with enough detail (status, headers, body length, leading snippet, error
/// source chain) to diagnose the next regression instead of throwing the
/// body away. Always falls back to `null` so a flaky intel call never breaks
/// the scan.
async fn fetch_threat_intel_body(resp: reqwest::Result<reqwest::Response>) -> serde_json::Value {
    let r = match resp {
        Ok(r) => r,
        Err(e) => {
            log::warn!(
                "threat-intel request failed: {} timeout={} connect={}",
                error_chain(&e),
                e.is_timeout(),
                e.is_connect(),
            );
            return serde_json::Value::Null;
        }
    };

    let status = r.status();
    let header_str = |name: reqwest::header::HeaderName| {
        r.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let content_type = header_str(reqwest::header::CONTENT_TYPE);
    let content_encoding = header_str(reqwest::header::CONTENT_ENCODING);

    if !status.is_success() {
        log::warn!(
            "threat-intel non-OK status: {} content-type={:?}",
            status.as_u16(),
            content_type,
        );
        return serde_json::Value::Null;
    }

    let bytes = match r.bytes().await {
        Ok(b) => b,
        Err(e) => {
            log::warn!(
                "threat-intel body read failed: {} timeout={} body={} content-type={:?} content-encoding={:?}",
                error_chain(&e),
                e.is_timeout(),
                e.is_body(),
                content_type,
                content_encoding,
            );
            return serde_json::Value::Null;
        }
    };

    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let snippet = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]);
            log::warn!(
                "threat-intel parse failed: {e} bytes={} content-type={:?} content-encoding={:?} snippet={:?}",
                bytes.len(),
                content_type,
                content_encoding,
                snippet,
            );
            serde_json::Value::Null
        }
    }
}

const ENDPOINT: &str = "https://jlab.threat.rip/api/public/static-scan";
const STATUS_ENDPOINT: &str = "https://jlab.threat.rip/api/stats";
const THREAT_INTEL_ENDPOINT: &str = "https://jlab.threat.rip/api/public/threat-intel";
const CLIENT_HEADER: &str = "x-jlab-client";
const CLIENT_VALUE: &str = "desktop";
const MAX_BYTES: u64 = 50 * 1024 * 1024;
const PHASE_EVENT: &str = "scan://phase";

const SUPPORTED_EXTS: &[&str] = &["jar", "zip", "mcpack", "mrpack"];
const CONTAINER_EXTS: &[&str] = &["zip", "mcpack", "mrpack"];

fn allowed_exts() -> Vec<String> {
    SUPPORTED_EXTS.iter().map(|s| s.to_string()).collect()
}

fn extension_lower(p: &Path) -> Option<String> {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
}

// All zip-format archives (jar / zip / mcpack / mrpack) start with one of
// these "PK" local-file-header magic sequences. We accept any of them so an
// empty or spanned zip is not misclassified.
fn has_zip_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes[0] == b'P'
        && bytes[1] == b'K'
        && ((bytes[2] == 0x03 && bytes[3] == 0x04)
            || (bytes[2] == 0x05 && bytes[3] == 0x06)
            || (bytes[2] == 0x07 && bytes[3] == 0x08))
}

// Containers can hold many JARs (modpacks usually do). Rather than asking
// the user or making N round trips against a 15/min rate-limited API, we
// pick the largest inner .jar by uncompressed size and scan that one. The
// largest is almost always the actual mod / payload, while the rest are
// libraries already covered by their own signatures.
fn extract_largest_jar(container_bytes: Vec<u8>) -> Result<(Vec<u8>, String, usize), AppError> {
    extract_largest_jar_capped(container_bytes, MAX_BYTES)
}

fn extract_largest_jar_capped(
    container_bytes: Vec<u8>,
    max_bytes: u64,
) -> Result<(Vec<u8>, String, usize), AppError> {
    let cursor = std::io::Cursor::new(container_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| AppError::InvalidArchive {
        message: format!("could not open archive: {e}"),
    })?;

    let mut largest: Option<(usize, u64)> = None;
    let mut jar_count: usize = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| AppError::InvalidArchive {
            message: format!("entry {i}: {e}"),
        })?;
        if !entry.is_file() {
            continue;
        }
        if !entry.name().to_ascii_lowercase().ends_with(".jar") {
            continue;
        }
        jar_count += 1;
        let size = entry.size();
        if largest.map(|(_, s)| size > s).unwrap_or(true) {
            largest = Some((i, size));
        }
    }

    let (idx, size) = largest.ok_or(AppError::NoJarInArchive)?;
    if size > max_bytes {
        return Err(AppError::TooLarge {
            max_mb: max_bytes / (1024 * 1024),
        });
    }

    let mut entry = archive
        .by_index(idx)
        .map_err(|e| AppError::InvalidArchive {
            message: format!("entry {idx}: {e}"),
        })?;

    let inner_name = std::path::Path::new(entry.name())
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("inner.jar")
        .to_string();

    // The `size` we just bounded came from the zip central directory, which
    // a hostile container can lie about. Cap the actual read at
    // `max_bytes + 1` and reject if we hit the cap, so a deflate bomb cannot
    // expand into multi-GB and OOM the host (CWE-409).
    use std::io::Read;
    let mut buf = Vec::with_capacity(size.min(max_bytes) as usize);
    let mut limited = (&mut entry).take(max_bytes + 1);
    limited
        .read_to_end(&mut buf)
        .map_err(|e| AppError::InvalidArchive {
            message: format!("extract: {e}"),
        })?;
    if buf.len() as u64 > max_bytes {
        return Err(AppError::TooLarge {
            max_mb: max_bytes / (1024 * 1024),
        });
    }

    Ok((buf, inner_name, jar_count))
}

#[derive(Default)]
pub struct ScanJobs {
    cancel: Mutex<Option<Arc<Notify>>>,
}

impl ScanJobs {
    fn install(&self, token: &Arc<Notify>) {
        if let Ok(mut g) = self.cancel.lock() {
            *g = Some(token.clone());
        }
    }

    fn clear_if_current(&self, token: &Arc<Notify>) {
        if let Ok(mut g) = self.cancel.lock() {
            if g.as_ref().map(|c| Arc::ptr_eq(c, token)).unwrap_or(false) {
                *g = None;
            }
        }
    }

    fn signal(&self) {
        if let Ok(g) = self.cancel.lock() {
            if let Some(c) = g.as_ref() {
                c.notify_waiters();
            }
        }
    }
}

pub struct HttpClient(pub Client);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseEvent {
    phase: &'static str,
    status: &'static str,
    elapsed_ms: u64,
    detail: Option<String>,
}

fn emit_phase(
    app: &AppHandle,
    started: Instant,
    phase: &'static str,
    status: &'static str,
    detail: Option<String>,
) {
    let payload = PhaseEvent {
        phase,
        status,
        elapsed_ms: started.elapsed().as_millis() as u64,
        detail,
    };
    if let Err(e) = app.emit(PHASE_EVENT, payload) {
        log::warn!("failed to emit phase event: {e}");
    }
}

#[tauri::command]
pub async fn scan_jar(
    app: AppHandle,
    jobs: State<'_, ScanJobs>,
    http: State<'_, HttpClient>,
    path: String,
) -> Result<String, AppError> {
    let started = Instant::now();
    let cancel = Arc::new(Notify::new());
    jobs.install(&cancel);

    let result = run_scan(&app, &http.0, &cancel, started, path).await;

    jobs.clear_if_current(&cancel);

    match &result {
        Ok(_) => emit_phase(&app, started, "done", "ok", None),
        Err(AppError::Cancelled) => emit_phase(&app, started, "cancelled", "done", None),
        Err(e) => emit_phase(&app, started, "failed", "error", Some(e.to_string())),
    }

    result
}

async fn run_scan(
    app: &AppHandle,
    client: &Client,
    cancel: &Arc<Notify>,
    started: Instant,
    path: String,
) -> Result<String, AppError> {
    emit_phase(app, started, "validate", "running", None);
    let p = Path::new(&path);
    let metadata = tokio::fs::metadata(p).await?;
    if metadata.len() > MAX_BYTES {
        return Err(AppError::TooLarge {
            max_mb: MAX_BYTES / (1024 * 1024),
        });
    }
    let size = metadata.len();
    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.jar")
        .to_string();

    let ext = extension_lower(p);
    let ext_str = ext.as_deref().unwrap_or("");
    if !SUPPORTED_EXTS.contains(&ext_str) {
        return Err(AppError::UnsupportedFile {
            extension: ext.clone(),
            allowed: allowed_exts(),
        });
    }
    let is_container = CONTAINER_EXTS.contains(&ext_str);

    log::info!(
        "scan start file={file_name:?} size={size} ext={ext_str} path={}",
        redact_path(&path)
    );
    emit_phase(
        app,
        started,
        "validate",
        "done",
        Some(format!("{size} bytes, .{ext_str}")),
    );

    emit_phase(app, started, "read", "running", None);
    let read_started = Instant::now();
    let raw_bytes = tokio::select! {
        biased;
        _ = cancel.notified() => return Err(AppError::Cancelled),
        res = tokio::fs::read(p) => res?,
    };
    log::debug!(
        "read {} bytes from disk in {}ms fingerprint={}",
        raw_bytes.len(),
        read_started.elapsed().as_millis(),
        fingerprint(&raw_bytes)
    );

    if !has_zip_magic(&raw_bytes) {
        return Err(AppError::UnsupportedFile {
            extension: ext.clone(),
            allowed: allowed_exts(),
        });
    }

    let (bytes, upload_name) = if is_container {
        let (extracted, inner_name, jar_count) = tokio::select! {
            biased;
            _ = cancel.notified() => return Err(AppError::Cancelled),
            res = tokio::task::spawn_blocking(move || extract_largest_jar(raw_bytes)) => {
                res.map_err(|e| AppError::Io { message: format!("extract task: {e}") })??
            },
        };
        log::info!(
            "extracted inner jar {inner_name:?} ({} bytes) from {jar_count} candidates fingerprint={}",
            extracted.len(),
            fingerprint(&extracted)
        );
        emit_phase(
            app,
            started,
            "read",
            "done",
            Some(format!(
                "extracted {inner_name} ({} bytes) from {jar_count} jar{} in archive",
                extracted.len(),
                if jar_count == 1 { "" } else { "s" },
            )),
        );
        (extracted, inner_name)
    } else {
        emit_phase(
            app,
            started,
            "read",
            "done",
            Some(format!(
                "{} bytes in {}ms",
                raw_bytes.len(),
                read_started.elapsed().as_millis()
            )),
        );
        (raw_bytes, file_name.clone())
    };

    let upload_size = bytes.len();
    let sha256 = sha256_hex(&bytes);
    log::info!("inner jar sha256={sha256}");

    let part = Part::bytes(bytes)
        .file_name(upload_name.clone())
        .mime_str("application/java-archive")
        .map_err(|e| AppError::Network {
            message: e.to_string(),
        })?;
    let form = Form::new().part("file", part);

    log::info!("POST {ENDPOINT} ({upload_size} bytes)");
    emit_phase(
        app,
        started,
        "upload",
        "running",
        Some(format!("{upload_size} bytes")),
    );
    let send_started = Instant::now();

    let send_fut = client
        .post(ENDPOINT)
        .header(CLIENT_HEADER, CLIENT_VALUE)
        .multipart(form)
        .send();

    let intel_url = format!("{THREAT_INTEL_ENDPOINT}/{sha256}");
    // Threat-intel runs in parallel with a multi-MB upload that can take
    // 30-60s on slow links, and it shares the client's connection pool. The
    // 60s budget keeps it responsive on small jars while surviving the case
    // where the server is slow because its upstream (RatterScanner /
    // VirusTotal) is doing a cold lookup. Identity encoding sidesteps the
    // chance of a malformed gzip / chunked trailer for this small body.
    let intel_fut = client
        .get(&intel_url)
        .header(CLIENT_HEADER, CLIENT_VALUE)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .timeout(Duration::from_secs(60))
        .send();

    let (response, intel_resp) = tokio::select! {
        biased;
        _ = cancel.notified() => return Err(AppError::Cancelled),
        joined = async { tokio::join!(send_fut, intel_fut) } => joined,
    };

    let response = match response {
        Ok(r) => r,
        Err(e) => {
            log::error!(
                "send failed after {}ms: {e}",
                send_started.elapsed().as_millis()
            );
            return Err(e.into());
        }
    };

    let threat_intel = fetch_threat_intel_body(intel_resp).await;

    let status = response.status();
    log::info!(
        "response status={} after {}ms content-type={:?} content-length={:?}",
        status,
        send_started.elapsed().as_millis(),
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()),
    );
    emit_phase(
        app,
        started,
        "upload",
        "done",
        Some(format!(
            "HTTP {} in {}ms",
            status.as_u16(),
            send_started.elapsed().as_millis()
        )),
    );

    match status {
        StatusCode::OK => {
            emit_phase(
                app,
                started,
                "server",
                "done",
                Some(format!("HTTP {}", status.as_u16())),
            );
            emit_phase(app, started, "parse", "running", None);
            let body_fut = response.bytes();
            let body = tokio::select! {
                biased;
                _ = cancel.notified() => return Err(AppError::Cancelled),
                res = body_fut => res.map_err(|e| {
                    log::error!("reading body failed: {e}");
                    AppError::InvalidResponse { message: format!("read body: {e}") }
                })?,
            };
            log::info!(
                "scan ok body={} bytes elapsed={}ms",
                body.len(),
                started.elapsed().as_millis()
            );

            let text = String::from_utf8(body.to_vec()).map_err(|e| {
                log::error!("body is not valid UTF-8: {e}");
                AppError::InvalidResponse {
                    message: format!("non-utf8 body: {e}"),
                }
            })?;
            emit_phase(
                app,
                started,
                "parse",
                "done",
                Some(format!("{} bytes", text.len())),
            );

            let scan_value: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| AppError::InvalidResponse {
                    message: format!("scan json: {e}"),
                })?;

            // Persist a small history entry on the side. We never fail the
            // scan if disk IO is misbehaving: log and move on so the user
            // still sees their result.
            let store: HistoryStore = (*app.state::<HistoryStore>()).clone();
            let entry =
                history::build_entry(&scan_value, &upload_name, upload_size as u64, &sha256);
            if let Err(e) = history::append(store, entry).await {
                log::warn!("history append failed: {e}");
            }

            let envelope = serde_json::json!({
                "scan": scan_value,
                "threatIntel": threat_intel,
                "sha256": sha256,
            });
            serde_json::to_string(&envelope).map_err(|e| AppError::InvalidResponse {
                message: format!("envelope: {e}"),
            })
        }
        StatusCode::PAYLOAD_TOO_LARGE => {
            log::warn!("scan rejected by server: 413 too large");
            emit_phase(app, started, "server", "error", Some("HTTP 413".into()));
            Err(AppError::TooLarge {
                max_mb: MAX_BYTES / (1024 * 1024),
            })
        }
        StatusCode::TOO_MANY_REQUESTS => {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(60);
            log::warn!("rate limited, retry-after={retry_after}s");
            emit_phase(
                app,
                started,
                "server",
                "error",
                Some(format!("HTTP 429, retry {retry_after}s")),
            );
            Err(AppError::RateLimited {
                retry_after_seconds: retry_after,
            })
        }
        s => {
            let message = response
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| s.canonical_reason().unwrap_or("unknown error").to_string());
            log::error!("non-OK status {} message={message}", s.as_u16());
            emit_phase(
                app,
                started,
                "server",
                "error",
                Some(format!("HTTP {} {message}", s.as_u16())),
            );
            Err(AppError::Server {
                status: s.as_u16(),
                message,
            })
        }
    }
}

#[tauri::command]
pub fn cancel_scan(jobs: State<'_, ScanJobs>) -> Result<(), AppError> {
    jobs.signal();
    Ok(())
}

/// Active log file written by `tauri-plugin-log` (the `file_name: "debug"`
/// from `lib.rs` becomes `debug.log` on disk). Rotated files share the
/// `debug` prefix and the `.log` suffix but carry a timestamp in between.
const ACTIVE_LOG_NAME: &str = "debug.log";
const LOG_FILE_PREFIX: &str = "debug";
const LOG_FILE_SUFFIX: &str = ".log";
const LOG_PRUNE_MAX_AGE_DAYS: u64 = 14;

fn is_rotated_log(name: &str) -> bool {
    name != ACTIVE_LOG_NAME && name.starts_with(LOG_FILE_PREFIX) && name.ends_with(LOG_FILE_SUFFIX)
}

/// Walk the app log dir and remove any rotated debug log file whose
/// modification time is older than `LOG_PRUNE_MAX_AGE_DAYS`. The active log
/// file is never touched. Errors are swallowed: this is a best-effort
/// housekeeping pass that runs at startup.
pub fn prune_old_logs(log_dir: &Path) {
    let entries = match std::fs::read_dir(log_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(LOG_PRUNE_MAX_AGE_DAYS * 24 * 60 * 60))
        .unwrap_or(std::time::UNIX_EPOCH);
    let mut removed: usize = 0;
    let mut bytes: u64 = 0;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_rotated_log(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = path.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        if mtime < cutoff && std::fs::remove_file(&path).is_ok() {
            removed += 1;
            bytes += meta.len();
        }
    }
    if removed > 0 {
        log::info!(
            "pruned {removed} log file(s) older than {LOG_PRUNE_MAX_AGE_DAYS}d, freed {bytes} bytes"
        );
    }
}

fn read_log_dir_total(dir: &Path) -> std::io::Result<u64> {
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() {
            total += meta.len();
        }
    }
    Ok(total)
}

#[tauri::command]
pub fn log_dir_size(app: AppHandle) -> Result<u64, AppError> {
    let dir = app.path().app_log_dir().map_err(|e| AppError::Io {
        message: format!("resolve log dir: {e}"),
    })?;
    if !dir.exists() {
        return Ok(0);
    }
    read_log_dir_total(&dir).map_err(|e| AppError::Io {
        message: format!("read log dir: {e}"),
    })
}

/// Delete rotated log files and truncate the active `debug.log` to zero.
/// The active log can't be deleted because `tauri-plugin-log` holds it open,
/// so we open it with `truncate(true)` to reset its size. The plugin keeps
/// writing from its current offset, which leaves a zero-padded gap at the
/// start of the file until the next rotation. Returns the number of bytes
/// freed so the UI can show the result.
#[tauri::command]
pub fn clear_logs(app: AppHandle) -> Result<u64, AppError> {
    let dir = app.path().app_log_dir().map_err(|e| AppError::Io {
        message: format!("resolve log dir: {e}"),
    })?;
    if !dir.exists() {
        return Ok(0);
    }

    let mut bytes_freed: u64 = 0;
    let mut removed: usize = 0;
    let mut truncated: usize = 0;
    let entries = std::fs::read_dir(&dir).map_err(|e| AppError::Io {
        message: format!("read log dir: {e}"),
    })?;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = path.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let size = meta.len();
        if name == ACTIVE_LOG_NAME {
            match std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
            {
                Ok(_) => {
                    bytes_freed += size;
                    truncated += 1;
                }
                Err(e) => {
                    log::warn!("could not truncate active log: {e}");
                }
            }
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            bytes_freed += size;
            removed += 1;
        }
    }
    log::info!(
        "cleared logs: removed {removed} rotated file(s), truncated {truncated} active file(s), freed {bytes_freed} bytes from {}",
        redact_path(&dir.to_string_lossy())
    );
    Ok(bytes_freed)
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), AppError> {
    let dir = app.path().app_log_dir().map_err(|e| AppError::Io {
        message: format!("resolve log dir: {e}"),
    })?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| AppError::Io {
            message: format!("create log dir: {e}"),
        })?;
    }

    #[cfg(target_os = "macos")]
    let cmd = std::process::Command::new("open").arg(&dir).spawn();

    #[cfg(target_os = "windows")]
    let cmd = std::process::Command::new("explorer").arg(&dir).spawn();

    #[cfg(target_os = "linux")]
    let cmd = std::process::Command::new("xdg-open").arg(&dir).spawn();

    cmd.map_err(|e| AppError::Io {
        message: e.to_string(),
    })?;
    log::info!("opened log dir {}", redact_path(&dir.to_string_lossy()));
    Ok(())
}

#[tauri::command]
pub async fn history_list(
    store: State<'_, HistoryStore>,
) -> Result<Vec<history::HistoryEntry>, AppError> {
    let s = (*store).clone();
    history::list(s).await
}

#[tauri::command]
pub async fn history_clear(store: State<'_, HistoryStore>) -> Result<(), AppError> {
    let s = (*store).clone();
    history::clear(s).await
}

#[tauri::command]
pub async fn history_delete(store: State<'_, HistoryStore>, id: String) -> Result<(), AppError> {
    let s = (*store).clone();
    history::delete(s, id).await
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), AppError> {
    let allowed = url.starts_with("https://www.threat.rip/")
        || url.starts_with("https://threat.rip/")
        || url.starts_with("https://jlab.threat.rip/")
        || url.starts_with("https://www.virustotal.com/")
        || url.starts_with("https://github.com/NeikiDev/jlab-desktop/");
    if !allowed {
        return Err(AppError::Network {
            message: "url not allowed".into(),
        });
    }

    #[cfg(target_os = "macos")]
    let cmd = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(target_os = "windows")]
    let cmd = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();

    #[cfg(target_os = "linux")]
    let cmd = std::process::Command::new("xdg-open").arg(&url).spawn();

    cmd.map_err(|e| AppError::Io {
        message: e.to_string(),
    })?;
    Ok(())
}

const RELEASES_API: &str = "https://api.github.com/repos/NeikiDev/jlab-desktop/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/NeikiDev/jlab-desktop/releases/latest";

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn history_cap() -> usize {
    crate::history::HISTORY_CAP
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub available: bool,
    pub release_url: String,
}

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim_start_matches('v').trim();
    let core = s.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

#[tauri::command]
pub async fn check_for_update(http: State<'_, HttpClient>) -> Result<UpdateInfo, AppError> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let resp = http
        .0
        .get(RELEASES_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| AppError::Network {
            message: e.to_string(),
        })?;

    if !resp.status().is_success() {
        return Err(AppError::Server {
            status: resp.status().as_u16(),
            message: "could not read latest release".into(),
        });
    }

    let body = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| AppError::InvalidResponse {
            message: format!("parse releases body: {e}"),
        })?;

    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let latest = if tag.is_empty() { None } else { Some(tag) };

    let available = match (
        parse_semver(&current),
        latest.as_deref().and_then(parse_semver),
    ) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    };

    Ok(UpdateInfo {
        current_version: current,
        latest_version: latest,
        available,
        release_url: RELEASES_PAGE.to_string(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn check_status(http: State<'_, HttpClient>) -> Result<StatusInfo, AppError> {
    let start = Instant::now();

    let resp = http
        .0
        .get(STATUS_ENDPOINT)
        .header(CLIENT_HEADER, CLIENT_VALUE)
        .timeout(Duration::from_secs(5))
        .send()
        .await;

    let latency_ms = start.elapsed().as_millis() as u64;

    Ok(match resp {
        Ok(r) => {
            let code = r.status();
            let status_u16 = code.as_u16();
            let ok = code.is_success();
            if ok {
                let version = r.json::<serde_json::Value>().await.ok().and_then(|v| {
                    v.get("version")
                        .and_then(|x| x.as_str())
                        .map(str::to_string)
                });
                StatusInfo {
                    ok: true,
                    status: Some(status_u16),
                    latency_ms,
                    version,
                    error: None,
                }
            } else {
                StatusInfo {
                    ok: false,
                    status: Some(status_u16),
                    latency_ms,
                    version: None,
                    error: Some(code.canonical_reason().unwrap_or("error").to_string()),
                }
            }
        }
        Err(e) => StatusInfo {
            ok: false,
            status: None,
            latency_ms,
            version: None,
            error: Some(e.to_string()),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    // GHSA-9m5v-g42x-xq8f: a malicious container can declare a tiny
    // `uncompressed_size` in the central directory and then stream far more
    // bytes when read. The pre-check passes, the read used to be unbounded,
    // and memory exhausts. The fix caps the read at `max_bytes + 1` and
    // rejects when the cap is hit; this test locks that in by handing in a
    // zip whose CD lies about the inner jar's size.
    #[test]
    fn lying_inner_jar_size_is_rejected() {
        // 2 KiB of zeros stored with no compression. Truth: 2048 bytes.
        let payload = vec![0u8; 2048];

        let mut bytes: Vec<u8> = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut bytes));
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file("inner.jar", opts).unwrap();
            zip.write_all(&payload).unwrap();
            zip.finish().unwrap();
        }

        // Patch the central-directory `uncompressed_size` to a small lie
        // (10 bytes, LE u32), so the pre-check on `entry.size()` passes.
        // The CD record signature is 0x02014b50 in little-endian.
        let cd_sig = [0x50u8, 0x4b, 0x01, 0x02];
        let cd_off = bytes
            .windows(4)
            .position(|w| w == cd_sig)
            .expect("central-directory record present");
        // CD layout: uncompressed_size lives at offset 24..28 from the sig.
        let lie: u32 = 10;
        bytes[cd_off + 24..cd_off + 28].copy_from_slice(&lie.to_le_bytes());

        let max_bytes: u64 = 1024;
        let result = extract_largest_jar_capped(bytes, max_bytes);

        match result {
            Err(AppError::TooLarge { max_mb }) => {
                assert_eq!(max_mb, max_bytes / (1024 * 1024));
            }
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }
}
