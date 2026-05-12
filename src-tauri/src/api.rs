use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::multipart::{Form, Part};
use reqwest::{Client, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Notify;

use crate::error::AppError;
use crate::history::{self, HistoryStore};
use crate::paths;

/// Resolve the log directory the app actually writes to. Mirrors the choice
/// `lib.rs::run` makes when configuring the log plugin: prefer the friendly
/// folder (`<base>/JLab[/logs]`), fall back to Tauri's `app_log_dir()` if
/// the platform resolver is unavailable.
fn resolve_log_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    if let Some(p) = paths::friendly_log_dir() {
        return Ok(p);
    }
    app.path().app_log_dir().map_err(|e| AppError::Io {
        message: format!("resolve log dir: {e}"),
    })
}

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
//
// Generic over `R: Read + Seek` so callers can hand in either a
// `std::fs::File` (the production path, no full-archive buffering) or a
// `Cursor<Vec<u8>>` (tests). `zip::ZipArchive` only needs `Read + Seek`,
// not a contiguous slice in memory.
fn extract_largest_jar_from_reader<R: std::io::Read + std::io::Seek>(
    reader: R,
    max_bytes: u64,
) -> Result<(Vec<u8>, String, usize), AppError> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| AppError::InvalidArchive {
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

/// Tracks every in-flight scan so `cancel_scan` can cancel all of them.
///
/// The previous design stored a single `Option<Arc<Notify>>`, so a second
/// `scan_jar` call would overwrite the first token and the earlier scan
/// could no longer be cancelled (#66). The UI today only launches one scan
/// at a time, but the folder watcher and any scripted Tauri harness can
/// trigger concurrent calls. We now keep one token per job and signal them
/// all on cancel.
#[derive(Default)]
pub struct ScanJobs {
    cancel: Mutex<Vec<Arc<Notify>>>,
}

impl ScanJobs {
    fn install(&self, token: &Arc<Notify>) {
        if let Ok(mut g) = self.cancel.lock() {
            g.push(token.clone());
        }
    }

    fn clear_if_current(&self, token: &Arc<Notify>) {
        if let Ok(mut g) = self.cancel.lock() {
            g.retain(|c| !Arc::ptr_eq(c, token));
        }
    }

    fn signal(&self) {
        if let Ok(g) = self.cancel.lock() {
            for c in g.iter() {
                c.notify_waiters();
            }
        }
    }
}

pub struct HttpClient(pub Client);

/// Where a scan request originated. Manual scans (drag-drop, file picker)
/// emit phase events to the frontend; watcher auto-scans do not, since the
/// watcher panel has its own status surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanSource {
    Manual,
    Watcher,
}

impl ScanSource {
    pub fn as_history_tag(self) -> &'static str {
        match self {
            ScanSource::Manual => "manual",
            ScanSource::Watcher => "watcher",
        }
    }
}

/// Result of a successful scan. Manual scans wrap this into a JSON envelope
/// string for the IPC return value; the watcher consumes it directly so it
/// can decide on coalescing and auto-delete without re-parsing.
pub struct ScanOutcome {
    pub scan: serde_json::Value,
    pub threat_intel: serde_json::Value,
    pub sha256: String,
    #[allow(dead_code)]
    pub upload_name: String,
    #[allow(dead_code)]
    pub upload_size: u64,
}

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
    source: ScanSource,
    started: Instant,
    phase: &'static str,
    status: &'static str,
    detail: Option<String>,
) {
    if source != ScanSource::Manual {
        return;
    }
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

    let result = run_scan(&app, &http.0, &cancel, started, path, ScanSource::Manual).await;

    jobs.clear_if_current(&cancel);

    match &result {
        Ok(_) => emit_phase(&app, ScanSource::Manual, started, "done", "ok", None),
        Err(AppError::Cancelled) => {
            emit_phase(&app, ScanSource::Manual, started, "cancelled", "done", None)
        }
        Err(e) => emit_phase(
            &app,
            ScanSource::Manual,
            started,
            "failed",
            "error",
            Some(e.to_string()),
        ),
    }

    result.map(|o| {
        let envelope = serde_json::json!({
            "scan": o.scan,
            "threatIntel": o.threat_intel,
            "sha256": o.sha256,
        });
        envelope.to_string()
    })
}

/// Run a scan and return the parsed outcome. Shared by the manual `scan_jar`
/// command and the folder watcher. The watcher passes `ScanSource::Watcher`
/// to suppress phase events and to tag the history entry.
pub async fn run_scan(
    app: &AppHandle,
    client: &Client,
    cancel: &Arc<Notify>,
    started: Instant,
    path: String,
    source: ScanSource,
) -> Result<ScanOutcome, AppError> {
    emit_phase(app, source, started, "validate", "running", None);
    let p = Path::new(&path);
    let metadata = tokio::fs::metadata(p).await?;
    // `metadata.len()` is only reliable for regular files. A symlink to
    // `/dev/zero`, a FIFO with a live writer, or a character device reports
    // 0 (or an arbitrary large number) and would slip past the 50 MB cap,
    // causing the later read to grow until the host is OOM-killed. Reject
    // anything that is not a plain file before any size check or read.
    if !metadata.is_file() {
        let ext = extension_lower(p);
        return Err(AppError::UnsupportedFile {
            extension: ext,
            allowed: allowed_exts(),
        });
    }
    if metadata.len() > MAX_BYTES {
        return Err(AppError::TooLarge {
            max_mb: MAX_BYTES / (1024 * 1024),
        });
    }
    let size = metadata.len();

    // The watcher's "hold until scanned" feature renames the file to add a
    // `.jlab-pending` suffix while the scan is in flight. The file is on
    // disk at the suffixed path, but for extension validation and for the
    // multipart upload's filename we want the original name.
    let logical_path = path
        .strip_suffix(crate::watcher::core::HOLD_SUFFIX)
        .map(PathBuf::from)
        .unwrap_or_else(|| p.to_path_buf());
    let logical_p: &Path = logical_path.as_path();

    let file_name = logical_p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.jar")
        .to_string();

    let ext = extension_lower(logical_p);
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
        source,
        started,
        "validate",
        "done",
        Some(format!("{size} bytes, .{ext_str}")),
    );

    emit_phase(app, source, started, "read", "running", None);
    let read_started = Instant::now();

    let (bytes, upload_name) = if is_container {
        // Stream the outer archive: open it inside the blocking task and
        // hand the file handle straight to `zip::ZipArchive`. Avoids a
        // 50 MB `Vec<u8>` allocation per scan that the previous
        // `tokio::fs::read` -> `Cursor` path required (see issue #22 and the
        // CLAUDE.md note in the "Performance" section).
        let path_owned = path.clone();
        let ext_for_err = ext.clone();
        let (extracted, inner_name, jar_count) = tokio::select! {
            biased;
            _ = cancel.notified() => return Err(AppError::Cancelled),
            res = tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, String, usize), AppError> {
                use std::io::{Read, Seek, SeekFrom};
                let mut f = std::fs::File::open(&path_owned)
                    .map_err(|e| AppError::Io { message: e.to_string() })?;
                // Renamed text files (e.g. someone dropping `notes.txt` as
                // `pack.zip`) get the same UnsupportedFile error the buffered
                // path produced. Done inside the blocking task so we don't need
                // a separate async pre-read.
                let mut header = [0u8; 4];
                if f.read_exact(&mut header).is_err() || !has_zip_magic(&header) {
                    return Err(AppError::UnsupportedFile {
                        extension: ext_for_err,
                        allowed: allowed_exts(),
                    });
                }
                f.seek(SeekFrom::Start(0))
                    .map_err(|e| AppError::Io { message: e.to_string() })?;
                extract_largest_jar_from_reader(f, MAX_BYTES)
            }) => {
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
            source,
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
        // Plain `.jar`: we still need the bytes in memory to compute sha256
        // and build the multipart upload, so the buffered read stays.
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
        emit_phase(
            app,
            source,
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
        source,
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
        source,
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
                source,
                started,
                "server",
                "done",
                Some(format!("HTTP {}", status.as_u16())),
            );
            emit_phase(app, source, started, "parse", "running", None);
            let body_fut = response.bytes();
            let body = tokio::select! {
                biased;
                _ = cancel.notified() => return Err(AppError::Cancelled),
                res = body_fut => res.map_err(|e| {
                    log::error!("reading body failed: {e}");
                    AppError::InvalidResponse { message: format!("read body: {e}") }
                })?,
            };
            let body_len = body.len();
            log::info!(
                "scan ok body={body_len} bytes elapsed={}ms",
                started.elapsed().as_millis()
            );

            // Parse straight from the `Bytes` buffer. `serde_json::from_slice`
            // validates UTF-8 inside string fields itself, so an explicit
            // `from_utf8` pass is redundant. Skipping it removes a second
            // walk over the body and keeps the peak allocation at one buffer
            // plus the parsed `Value`.
            emit_phase(
                app,
                source,
                started,
                "parse",
                "done",
                Some(format!("{body_len} bytes")),
            );

            let scan_value: serde_json::Value = serde_json::from_slice(&body).map_err(|e| {
                log::error!("scan body parse failed: {e}");
                AppError::InvalidResponse {
                    message: format!("scan json: {e}"),
                }
            })?;

            // Persist a small history entry on the side. We never fail the
            // scan if disk IO is misbehaving: log and move on so the user
            // still sees their result.
            let store: HistoryStore = (*app.state::<HistoryStore>()).clone();
            let entry = history::build_entry(
                &scan_value,
                &upload_name,
                upload_size as u64,
                &sha256,
                source.as_history_tag(),
            );
            if let Err(e) = history::append(store, entry).await {
                log::warn!("history append failed: {e}");
            }

            Ok(ScanOutcome {
                scan: scan_value,
                threat_intel,
                sha256,
                upload_name,
                upload_size: upload_size as u64,
            })
        }
        StatusCode::PAYLOAD_TOO_LARGE => {
            log::warn!("scan rejected by server: 413 too large");
            emit_phase(
                app,
                source,
                started,
                "server",
                "error",
                Some("HTTP 413".into()),
            );
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
                source,
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
                source,
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
    let dir = resolve_log_dir(&app)?;
    if !dir.exists() {
        return Ok(0);
    }
    read_log_dir_total(&dir).map_err(|e| AppError::Io {
        message: format!("read log dir: {e}"),
    })
}

/// Delete rotated log files and reset the active `debug.log`.
///
/// `tauri-plugin-log` keeps the active log file handle open and keeps writing
/// from its current offset, so we cannot just truncate the file in place: the
/// plugin would fill the gap with NUL bytes until the next rotation, leaving
/// the log mostly garbage when the user attaches it to a support thread
/// (#43).
///
/// On Unix we instead rename the active log out of the way and unlink the
/// renamed copy. The plugin keeps writing into the now-orphaned inode (which
/// disappears when the process exits), and the next log line lands in a
/// freshly-created `debug.log` with no NUL prefix. On Windows we fall back to
/// the in-place truncate because rename-while-open is rejected by the OS;
/// the NUL-prefix issue still applies there until `tauri-plugin-log` exposes
/// a `rotate_now()` API upstream.
///
/// Returns the number of bytes freed so the UI can show the result.
#[tauri::command]
pub fn clear_logs(app: AppHandle) -> Result<u64, AppError> {
    let dir = resolve_log_dir(&app)?;
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
            #[cfg(unix)]
            {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let rotated = path.with_file_name(format!("debug-cleared-{stamp}.log"));
                if std::fs::rename(&path, &rotated).is_ok() {
                    match std::fs::remove_file(&rotated) {
                        Ok(()) => bytes_freed += size,
                        Err(e) => log::warn!(
                            "rotated active log to {} but could not unlink: {e}",
                            redact_path(&rotated.to_string_lossy())
                        ),
                    }
                    truncated += 1;
                    continue;
                }
            }
            // Windows path, plus last-resort fallback if rename failed on Unix.
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
                    log::warn!(
                        "could not truncate active log {}: {e}",
                        redact_path(&path.to_string_lossy())
                    );
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
        "cleared logs: removed {removed} rotated file(s), reset {truncated} active file(s), freed {bytes_freed} bytes from {}",
        redact_path(&dir.to_string_lossy())
    );
    Ok(bytes_freed)
}

#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), AppError> {
    let dir = resolve_log_dir(&app)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| AppError::Io {
            message: format!("create log dir: {e}"),
        })?;
    }

    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Io {
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

/// Accepts any `https://github.com/<owner>/<repo>` URL (with optional sub-path,
/// query, or fragment). Used so RatterScanner verified-source links to
/// third-party repos open in the browser, while still rejecting things like
/// `https://github.com.attacker.example/`.
fn is_github_repo_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    // Stop the path at the first `?` or `#`, then split into segments.
    let path = rest.split(['?', '#']).next().unwrap_or("");
    let mut segments = path.split('/');
    let owner = segments.next().unwrap_or("");
    let repo = segments.next().unwrap_or("");
    let valid_segment = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && !s.starts_with('.')
            && !s.ends_with('.')
            && !s.contains("..")
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    };
    valid_segment(owner) && valid_segment(repo)
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), AppError> {
    let allowed = url.starts_with("https://www.threat.rip/")
        || url.starts_with("https://threat.rip/")
        || url.starts_with("https://jlab.threat.rip/")
        || url.starts_with("https://www.virustotal.com/")
        || url.starts_with("https://discord.gg/")
        || url.starts_with("https://discord.com/invite/")
        || is_github_repo_url(&url);
    if !allowed {
        return Err(AppError::Network {
            message: "url not allowed".into(),
        });
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| AppError::Io {
            message: e.to_string(),
        })
}

// `releases/latest` excludes prereleases by default, so update notifications
// only ever offer stable releases. A user on `0.2.1-rc1` is offered `0.2.1`
// stable, never a hypothetical `0.2.2-rc1`. If we ever want to surface newer
// prereleases to users already on a prerelease, switch to
// `releases?per_page=10` and pick the highest tag the comparator allows.
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

/// Parse a version string into `(major, minor, patch)` plus an optional
/// prerelease tag. Build metadata (`+...`) is ignored, matching semver.
///
/// We deliberately keep the prerelease as a string and compare it
/// lexicographically. That's not full semver precedence, but it is enough
/// for the shapes this project uses (`-rc1`, `-beta.2`, `-alpha`) and avoids
/// pulling in the `semver` crate for one comparison site.
fn parse_version(s: &str) -> Option<((u64, u64, u64), Option<String>)> {
    let s = s.trim_start_matches('v').trim();
    let (core, pre) = match s.split_once('-') {
        Some((c, rest)) => {
            let pre = rest.split('+').next().unwrap_or("");
            (
                c,
                if pre.is_empty() {
                    None
                } else {
                    Some(pre.to_string())
                },
            )
        }
        None => (s.split('+').next().unwrap_or(s), None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some(((major, minor, patch), pre))
}

/// Returns true when `latest` is strictly newer than `current`.
///
/// Semver rule we care about: a release without a prerelease tag ranks above
/// any release with one that shares the same numeric core. So `0.2.1` beats
/// `0.2.1-rc1`, but `0.2.1-rc1` does not beat `0.2.1`. Two prereleases on
/// the same core are compared lexicographically.
fn is_newer(current: &str, latest: &str) -> bool {
    let Some((c_core, c_pre)) = parse_version(current) else {
        return false;
    };
    let Some((l_core, l_pre)) = parse_version(latest) else {
        return false;
    };
    if l_core != c_core {
        return l_core > c_core;
    }
    match (c_pre.as_deref(), l_pre.as_deref()) {
        (None, None) => false,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (Some(c), Some(l)) => l > c,
    }
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

    let available = latest
        .as_deref()
        .map(|l| is_newer(&current, l))
        .unwrap_or(false);

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
        let result = extract_largest_jar_from_reader(Cursor::new(bytes), max_bytes);

        match result {
            Err(AppError::TooLarge { max_mb }) => {
                assert_eq!(max_mb, max_bytes / (1024 * 1024));
            }
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    // Locks in the streaming path: build a real outer zip on disk, hand the
    // file handle (not a pre-buffered Vec) to extract_largest_jar_from_reader,
    // and confirm the inner jar bytes round-trip.
    #[test]
    fn extracts_largest_jar_from_file_handle() {
        let payload_small = b"PK\x03\x04small jar bytes".to_vec();
        let payload_big = b"PK\x03\x04this is the bigger jar".to_vec();

        let mut bytes: Vec<u8> = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut bytes));
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file("libs/small.jar", opts).unwrap();
            zip.write_all(&payload_small).unwrap();
            zip.start_file("payload/big.jar", opts).unwrap();
            zip.write_all(&payload_big).unwrap();
            zip.start_file("readme.txt", opts).unwrap();
            zip.write_all(b"not a jar").unwrap();
            zip.finish().unwrap();
        }

        let dir = std::env::temp_dir().join(format!(
            "jlab-stream-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("outer.zip");
        std::fs::write(&path, &bytes).unwrap();

        let f = std::fs::File::open(&path).unwrap();
        let (extracted, inner_name, jar_count) =
            extract_largest_jar_from_reader(f, 64 * 1024).unwrap();

        assert_eq!(jar_count, 2);
        assert_eq!(inner_name, "big.jar");
        assert_eq!(extracted, payload_big);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_version_keeps_prerelease_and_drops_build() {
        assert_eq!(parse_version("0.2.1"), Some(((0, 2, 1), None)));
        assert_eq!(parse_version("v0.2.1"), Some(((0, 2, 1), None)));
        assert_eq!(
            parse_version("0.2.1-rc1"),
            Some(((0, 2, 1), Some("rc1".into())))
        );
        assert_eq!(
            parse_version("0.2.1-beta.2"),
            Some(((0, 2, 1), Some("beta.2".into())))
        );
        // Build metadata is ignored on both sides.
        assert_eq!(parse_version("0.2.1+commit.abc"), Some(((0, 2, 1), None)));
        assert_eq!(
            parse_version("0.2.1-rc1+commit.abc"),
            Some(((0, 2, 1), Some("rc1".into())))
        );
        assert_eq!(parse_version("garbage"), None);
    }

    // Issue #18 regression: a user on a prerelease should be told about the
    // matching stable release.
    #[test]
    fn rc_user_sees_stable_release() {
        assert!(is_newer("0.2.1-rc1", "0.2.1"));
        assert!(is_newer("v0.2.1-rc1", "v0.2.1"));
    }

    #[test]
    fn stable_user_does_not_get_offered_prerelease_with_same_core() {
        assert!(!is_newer("0.2.1", "0.2.1-rc1"));
    }

    #[test]
    fn newer_core_always_wins_regardless_of_prerelease() {
        assert!(is_newer("0.2.1", "0.2.2"));
        assert!(is_newer("0.2.1", "0.2.2-rc1"));
        assert!(is_newer("0.2.1-rc9", "0.2.2-rc1"));
        assert!(!is_newer("0.2.2", "0.2.1"));
    }

    #[test]
    fn equal_versions_are_not_newer() {
        assert!(!is_newer("0.2.1", "0.2.1"));
        assert!(!is_newer("0.2.1-rc1", "0.2.1-rc1"));
    }

    #[test]
    fn two_prereleases_compared_lexicographically() {
        assert!(is_newer("0.2.1-rc1", "0.2.1-rc2"));
        assert!(!is_newer("0.2.1-rc2", "0.2.1-rc1"));
        // alpha < beta < rc lexicographically, which is what we want here.
        assert!(is_newer("0.2.1-alpha", "0.2.1-beta"));
    }

    #[test]
    fn unparseable_input_is_treated_as_no_update() {
        assert!(!is_newer("garbage", "0.2.1"));
        assert!(!is_newer("0.2.1", "garbage"));
    }

    #[test]
    fn github_repo_url_accepts_third_party_repos() {
        assert!(is_github_repo_url(
            "https://github.com/some-owner/some-repo"
        ));
        assert!(is_github_repo_url(
            "https://github.com/NeikiDev/jlab-desktop/"
        ));
        assert!(is_github_repo_url(
            "https://github.com/NeikiDev/jlab-desktop/releases/latest"
        ));
        assert!(is_github_repo_url(
            "https://github.com/owner/repo?tab=readme"
        ));
        assert!(is_github_repo_url("https://github.com/a/b#frag"));
        assert!(is_github_repo_url("https://github.com/o.w-n_er/repo.name"));
    }

    #[test]
    fn github_repo_url_rejects_lookalikes_and_garbage() {
        // host smuggling
        assert!(!is_github_repo_url(
            "https://github.com.attacker.example/owner/repo"
        ));
        assert!(!is_github_repo_url(
            "https://attacker.example/github.com/owner/repo"
        ));
        // wrong scheme
        assert!(!is_github_repo_url("http://github.com/owner/repo"));
        // missing repo segment
        assert!(!is_github_repo_url("https://github.com/owner"));
        assert!(!is_github_repo_url("https://github.com/owner/"));
        assert!(!is_github_repo_url("https://github.com/"));
        // path traversal-ish
        assert!(!is_github_repo_url("https://github.com/../repo"));
        assert!(!is_github_repo_url("https://github.com/owner/.."));
        // dot-edge segments: GitHub's own rules forbid these shapes,
        // so the validator should match. See issue #61.
        assert!(!is_github_repo_url("https://github.com/.evil/.repo"));
        assert!(!is_github_repo_url("https://github.com/evil./repo."));
        assert!(!is_github_repo_url("https://github.com/foo..bar/baz"));
        assert!(!is_github_repo_url("https://github.com/owner/foo.."));
        // disallowed chars
        assert!(!is_github_repo_url("https://github.com/own er/repo"));
    }
}
