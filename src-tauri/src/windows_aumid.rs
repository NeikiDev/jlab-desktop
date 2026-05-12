//! Make Windows actually draw the toast notifications we ask for.
//!
//! For an MSIX/UWP app the package manifest tells the Shell about the
//! AppUserModelID. For a plain desktop bundle (our case) we have to do two
//! things ourselves, or the Action Center silently drops the toast and the
//! plugin's `.show()` still returns `Ok`:
//!
//! 1. Write `HKCU\Software\Classes\AppUserModelId\<aumid>` with at least a
//!    `DisplayName`. Without this entry the Shell does not consider the AUMID
//!    registered and refuses to render the toast.
//! 2. Bind the AUMID to the current process via
//!    `SetCurrentProcessExplicitAppUserModelID`, so the Shell groups the
//!    toast with our taskbar entry instead of dropping it.
//!
//! Doing both at startup makes the toast pipeline work from an installed MSI
//! launched anywhere (Start menu, desktop shortcut, taskbar pin, direct exe),
//! from a portable copy, and from `tauri dev`.
//!
//! References:
//! - <https://learn.microsoft.com/en-us/windows/win32/shell/appids>
//! - <https://github.com/tauri-apps/plugins-workspace/issues/1545>

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

fn to_wide_null(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Bind this process to `aumid`. Call this before any window or notification
/// is created, otherwise Windows may have already bound the process to a
/// fallback AUMID (often `Microsoft.Windows.Explorer` or none at all).
pub fn bind_process_aumid(aumid: &str) -> io::Result<()> {
    let w = to_wide_null(aumid);
    // SAFETY: `w` is a null-terminated UTF-16 buffer that outlives the call.
    let hr = unsafe { SetCurrentProcessExplicitAppUserModelID(w.as_ptr()) };
    if hr < 0 {
        Err(io::Error::from_raw_os_error(hr))
    } else {
        Ok(())
    }
}

/// Idempotently register `aumid` in HKCU so the Shell will draw toasts for it.
/// Writes `DisplayName` (required) and, if provided, `IconUri` (path to a
/// .png/.ico file). The icon is optional; without it Windows shows a generic
/// app icon but the toast still appears.
pub fn register_aumid(aumid: &str, display_name: &str, icon_uri: Option<&str>) -> io::Result<()> {
    let sub_key = format!("Software\\Classes\\AppUserModelId\\{aumid}");
    let sub_key_w = to_wide_null(&sub_key);

    let mut hkey: HKEY = std::ptr::null_mut();
    // SAFETY: all pointers are valid for the duration of the call and the
    // out-parameter receives a fresh HKEY we close below.
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            sub_key_w.as_ptr(),
            0,
            std::ptr::null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        )
    };
    if rc != 0 {
        return Err(io::Error::from_raw_os_error(rc as i32));
    }

    let write_sz = |name: &str, value: &str| -> io::Result<()> {
        let name_w = to_wide_null(name);
        let value_w = to_wide_null(value);
        let bytes = (value_w.len() * std::mem::size_of::<u16>()) as u32;
        // SAFETY: hkey is open, name/value are null-terminated UTF-16, byte
        // count matches the buffer size.
        let rc = unsafe {
            RegSetValueExW(
                hkey,
                name_w.as_ptr(),
                0,
                REG_SZ,
                value_w.as_ptr() as *const u8,
                bytes,
            )
        };
        if rc != 0 {
            Err(io::Error::from_raw_os_error(rc as i32))
        } else {
            Ok(())
        }
    };

    let display_res = write_sz("DisplayName", display_name);
    let icon_res = match icon_uri {
        Some(uri) => write_sz("IconUri", uri),
        None => Ok(()),
    };

    // SAFETY: hkey was opened above and is closed exactly once here.
    unsafe { RegCloseKey(hkey) };

    display_res.and(icon_res)
}
