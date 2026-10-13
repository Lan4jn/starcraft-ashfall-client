use std::path::Path;

#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(test)]
static INJECT_REPLACE_FAILURE: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
pub(crate) fn set_inject_replace_failure(inject: bool) {
    INJECT_REPLACE_FAILURE.store(inject, Ordering::SeqCst);
}

#[cfg(test)]
fn is_inject_replace_failure() -> bool {
    INJECT_REPLACE_FAILURE.load(Ordering::SeqCst)
}

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
use windows_sys::Win32::Foundation::GetLastError;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, ReplaceFileW};

#[cfg(windows)]
const MOVEFILE_REPLACE_EXISTING: u32 = 1;
#[cfg(windows)]
const MOVEFILE_WRITE_THROUGH: u32 = 8;
#[cfg(windows)]
const ERROR_FILE_NOT_FOUND: u32 = 2;

#[cfg(windows)]
fn to_wide_null(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Safely and atomically replaces `target` with `temp`.
/// On Windows:
/// - If `target` exists, uses `ReplaceFileW` with flags=0 (temporary file is already synced via `sync_all`).
/// - If `target` does not exist (first creation), uses `MoveFileExW`.
///
/// Does not delete existing valid files beforehand.
#[cfg(windows)]
pub fn safe_replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if is_inject_replace_failure() {
        return Err(std::io::Error::other(
            "injected safe_replace failure for test",
        ));
    }

    let temp_w = to_wide_null(temp);
    let target_w = to_wide_null(target);

    if target.exists() {
        let success = unsafe {
            ReplaceFileW(
                target_w.as_ptr(),
                temp_w.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if success != 0 {
            return Ok(());
        }

        // Check if failed because file was concurrently removed
        if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            let move_res = unsafe {
                MoveFileExW(
                    temp_w.as_ptr(),
                    target_w.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            if move_res != 0 {
                return Ok(());
            }
        }
        return Err(std::io::Error::last_os_error());
    }

    let move_res = unsafe {
        MoveFileExW(
            temp_w.as_ptr(),
            target_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if move_res != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
pub fn safe_replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if is_inject_replace_failure() {
        return Err(std::io::Error::other(
            "injected safe_replace failure for test",
        ));
    }
    std::fs::rename(temp, target)
}
