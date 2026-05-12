//! Watched-folders auto-scan subsystem.
//!
//! Opt-in, off by default. A `notify`-based filesystem subscriber watches one
//! or more user-chosen folders, debounces events, filters to supported
//! extensions, and funnels new or modified files through the existing
//! `scan_jar` HTTP pipeline at a hard cap of 12 requests / minute (the public
//! API allows 15/min). Hits at or above the user's alert threshold raise
//! coalesced native notifications.
//!
//! This is **not** an antivirus. The watcher does not block file I/O, does
//! not install drivers, and never touches files the user did not point it at.
//! Destructive options (auto-delete, hold-until-scanned) are opt-in.

pub mod commands;
pub mod core;
pub mod hold;
pub mod notify;
pub mod quarantine;
pub mod rescan;
pub mod settings;
pub mod trash;
pub mod tray;

pub use core::WatcherStore;
