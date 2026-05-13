//! Coalesced native notifications. The first qualifying hit starts a
//! per-window buffer; further hits inside `coalesce_window_ms` are folded
//! into the same notification. Posts via `tauri-plugin-notification`.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tokio::time::sleep;

use crate::error::AppError;
use crate::watcher::settings::WatcherSettings;

#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    pub file_name: String,
    pub path: String,
    pub top_severity: String,
    pub signature_count: u32,
    pub critical_count: u32,
    /// Confirmed malware family names (`confirmedFamilies[].name`). Empty
    /// when no family was confirmed by the server.
    pub family_names: Vec<String>,
    /// `Some("quarantined")`, `Some("trashed")`, or `None` if no
    /// auto-action ran for this hit.
    pub action: Option<String>,
    /// `true` when the file was previously quarantined or trashed and has
    /// reappeared in a watched folder. The notification text switches to a
    /// "moved back" line and `action` stays `None` because we do not
    /// auto-action reappearances.
    pub reappeared: bool,
    /// The earlier action label when `reappeared` is true: `"quarantined"`
    /// or `"trashed"`. Lets the notification say "previously quarantined"
    /// vs "previously deleted".
    pub prior_action: Option<String>,
}

#[derive(Default)]
struct Buffer {
    hits: Vec<Hit>,
    timer_running: bool,
}

static BUFFER: Mutex<Option<Buffer>> = Mutex::new(None);

fn with_buffer<R>(f: impl FnOnce(&mut Buffer) -> R) -> R {
    let mut g = BUFFER.lock().unwrap();
    let buf = g.get_or_insert_with(Buffer::default);
    f(buf)
}

/// Record a flagged or auto-deleted scan. Starts the window timer on the
/// first call; subsequent calls inside the window fold into the same
/// notification.
pub fn record_hit(app: &AppHandle, settings: &WatcherSettings, hit: Hit) {
    let window = Duration::from_millis(settings.coalesce_window_ms.max(500));
    let should_start = with_buffer(|buf| {
        buf.hits.push(hit);
        if buf.timer_running {
            false
        } else {
            buf.timer_running = true;
            true
        }
    });
    if !should_start {
        return;
    }
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        sleep(window).await;
        let hits = with_buffer(|buf| {
            let out = std::mem::take(&mut buf.hits);
            buf.timer_running = false;
            out
        });
        if hits.is_empty() {
            return;
        }
        post_notification(&app_clone, &hits);
    });
}

fn post_notification(app: &AppHandle, hits: &[Hit]) {
    let n = hits.len();
    let all_reappeared = !hits.is_empty() && hits.iter().all(|h| h.reappeared);
    let action_summary: Option<&str> = summarize_action(hits);

    let (title, body) = if n == 1 {
        let h = &hits[0];
        if h.reappeared {
            let prior = match h.prior_action.as_deref() {
                Some("trashed") => "deleted",
                _ => "quarantined",
            };
            (
                "Attention: known-bad file is back".to_string(),
                format!(
                    "{} was previously {prior} and was moved into a watched folder again.",
                    h.file_name
                ),
            )
        } else {
            let action = match h.action.as_deref() {
                Some("quarantined") => " (quarantined)",
                Some("trashed") => " (sent to trash)",
                _ => "",
            };
            let body = format!("{}{}", describe_hit(h), action);
            (h.file_name.clone(), body)
        }
    } else {
        let names: Vec<&str> = hits.iter().take(3).map(|h| h.file_name.as_str()).collect();
        let extra = n.saturating_sub(names.len());
        let mut body = names.join(", ");
        if extra > 0 {
            body.push_str(&format!(", +{extra} more"));
        }
        let title = if all_reappeared {
            format!("Attention: {n} known-bad files are back")
        } else {
            match action_summary {
                Some("quarantined") => format!("JLab auto-quarantined {n} risky files"),
                Some("trashed") => format!("JLab auto-deleted {n} risky files"),
                Some(_) => format!("JLab took action on {n} risky files"),
                None => format!("JLab found {n} risky files"),
            }
        };
        (title, body)
    };

    show_native(app, &title, &body);
}

/// Send a single immediate notification, bypassing the coalescing buffer.
/// Used by the "Send test notification" button in the settings UI.
///
/// On Windows the toast can still be suppressed by the OS (Focus assist,
/// per-app notification toggle, missing Start Menu shortcut AUMID). The
/// plugin returns Ok in that case, so success here means the call reached
/// the OS, not that a toast was actually drawn.
pub fn send_test_notification(app: &AppHandle) -> Result<(), AppError> {
    let notif = app.notification();
    if let Ok(state) = notif.permission_state() {
        if matches!(state, PermissionState::Denied) {
            return Err(AppError::NotificationDenied);
        }
        if matches!(
            state,
            PermissionState::Prompt | PermissionState::PromptWithRationale
        ) {
            let _ = notif.request_permission();
        }
    }
    notif
        .builder()
        .title("JLab notifications work")
        .body("Test notification from the folder watcher.")
        .show()
        .map_err(|e| {
            log::warn!("test notification failed: {e}");
            AppError::NotificationDenied
        })
}

fn show_native(app: &AppHandle, title: &str, body: &str) {
    let res = app.notification().builder().title(title).body(body).show();
    if let Err(e) = res {
        log::warn!("native notification failed: {e}");
    }
}

/// Short, human-facing summary of a single hit. Prefers the confirmed
/// malware family name, then falls back to the critical-signature count,
/// then to the top severity. Never reports the total signature count
/// because most of those rows are low-signal noise.
fn describe_hit(h: &Hit) -> String {
    if !h.family_names.is_empty() {
        let head = &h.family_names[0];
        let extra = h.family_names.len() - 1;
        return if extra == 0 {
            format!("{head} detected")
        } else {
            format!("{head} +{extra} more family detected")
        };
    }
    if h.critical_count > 0 {
        let s = if h.critical_count == 1 { "" } else { "s" };
        return format!("{} critical signature{s}", h.critical_count);
    }
    format!("{} severity match", h.top_severity)
}

/// If every hit had the same auto-action label, return it. If actions are
/// mixed or absent, return None so the caller falls back to a generic title.
fn summarize_action(hits: &[Hit]) -> Option<&str> {
    let mut iter = hits.iter().filter_map(|h| h.action.as_deref());
    let first = iter.next()?;
    if iter.all(|a| a == first) && hits.iter().all(|h| h.action.is_some()) {
        Some(first)
    } else {
        None
    }
}
