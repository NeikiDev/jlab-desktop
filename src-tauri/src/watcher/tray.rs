//! System tray icon + menu. Built lazily on the first time the user
//! enables "minimize to tray". The tray persists for the rest of the
//! session; toggling the setting off only changes whether the X button
//! hides or quits.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;

static TRAY_BUILT: AtomicBool = AtomicBool::new(false);

const TRAY_ID: &str = "jlab-tray";
const MENU_OPEN: &str = "tray_open";
const MENU_PAUSE: &str = "tray_pause";
const MENU_QUIT: &str = "tray_quit";

pub fn ensure_tray(app: &AppHandle) -> Result<(), AppError> {
    if TRAY_BUILT.load(Ordering::Acquire) {
        return Ok(());
    }
    let open = MenuItem::with_id(app, MENU_OPEN, "Open JLab Desktop", true, None::<&str>).map_err(
        |e| AppError::WatcherIo {
            message: format!("tray menu: {e}"),
        },
    )?;
    let pause =
        MenuItem::with_id(app, MENU_PAUSE, "Pause watcher", true, None::<&str>).map_err(|e| {
            AppError::WatcherIo {
                message: format!("tray menu: {e}"),
            }
        })?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| AppError::WatcherIo {
        message: format!("tray menu: {e}"),
    })?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>).map_err(|e| {
        AppError::WatcherIo {
            message: format!("tray menu: {e}"),
        }
    })?;
    let menu =
        Menu::with_items(app, &[&open, &pause, &sep, &quit]).map_err(|e| AppError::WatcherIo {
            message: format!("tray menu: {e}"),
        })?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| AppError::WatcherIo {
            message: "no default window icon for tray".into(),
        })?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_OPEN => show_main_window(app),
            MENU_PAUSE => toggle_pause(app),
            MENU_QUIT => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| AppError::WatcherIo {
            message: format!("tray build: {e}"),
        })?;

    TRAY_BUILT.store(true, Ordering::Release);
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn toggle_pause(app: &AppHandle) {
    let store = match app.try_state::<crate::watcher::WatcherStore>() {
        Some(s) => (*s).clone(),
        None => return,
    };
    let now_enabled = store.snapshot_settings().enabled;
    let new_enabled = !now_enabled;
    let app_clone = app.clone();
    let res = store.mutate_settings(&app_clone, |s| {
        s.enabled = new_enabled;
    });
    if let Err(e) = res {
        log::warn!("toggle pause failed: {e}");
        return;
    }
    if new_enabled {
        if let Err(e) = store.start(app) {
            log::warn!("watcher start failed: {e}");
        }
    } else {
        store.stop(app);
    }
    let _ = app.emit(
        "watcher://event",
        serde_json::json!({ "type": "state-changed" }),
    );
}
