//! Embedded Tencent TAT runtime for Vela Computer.
//!
//! This crate deliberately does not expose the original process entrypoint.
//! The Go daemon owns process lifetime; this library owns one Tokio runtime
//! thread and supports a single start/close cycle per process.

mod common;
mod executor;
mod network;
mod tssh;

use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;
use std::ptr;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, anyhow};
use network::Tag;
use tokio::runtime::Builder;
use tokio::sync::oneshot;

const OK: i32 = 0;
const INVALID_ARGUMENT: i32 = 2;
const ALREADY_STARTED: i32 = 3;
const OPERATION_FAILED: i32 = 4;

static STARTED: AtomicBool = AtomicBool::new(false);
pub static EXE_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
});

thread_local! {
    static LAST_ERROR: RefCell<CString> =
        RefCell::new(CString::new("").expect("empty CString"));
}

pub struct VelaTatHandle {
    cancel: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<Result<()>>>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn vela_tat_register(
    state_root: *const c_char,
    region: *const c_char,
    register_code_id: *const c_char,
    register_code_value: *const c_char,
    tags_json: *const c_char,
) -> i32 {
    clear_last_error();
    let result = (|| {
        let state_root = unsafe { required_string(state_root, "state_root") }?;
        let region = unsafe { required_string(region, "region") }?;
        let register_code_id = unsafe { required_string(register_code_id, "register_code_id") }?;
        let register_code_value =
            unsafe { required_string(register_code_value, "register_code_value") }?;
        let tags_json = unsafe { required_string(tags_json, "tags_json") }?;
        let tags: Vec<Tag> = serde_json::from_str(&tags_json).context("decode TAT tags")?;
        if tags.is_empty() || tags.len() > 10 {
            return Err(anyhow!("TAT tags must contain 1..10 entries"));
        }
        common::config::initialize_state_root(state_root)?;
        network::register(&region, &register_code_id, &register_code_value, tags)
            .context("register managed TAT instance")
    })();
    result_code(result)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn vela_tat_start(
    state_root: *const c_char,
    out_handle: *mut *mut VelaTatHandle,
) -> i32 {
    clear_last_error();
    if out_handle.is_null() {
        set_last_error("out_handle is required");
        return INVALID_ARGUMENT;
    }
    // SAFETY: The pointer was checked above and is owned by the caller.
    unsafe { *out_handle = ptr::null_mut() };
    let state_root = match unsafe { required_string(state_root, "state_root") } {
        Ok(value) => value,
        Err(error) => return result_code(Err(error)),
    };
    if STARTED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        set_last_error("embedded TAT can only start once per process");
        return ALREADY_STARTED;
    }
    if let Err(error) = common::config::initialize_state_root(state_root) {
        set_last_error(&format!("{error:#}"));
        return OPERATION_FAILED;
    }
    let (cancel, receiver) = oneshot::channel();
    let worker = thread::Builder::new()
        .name("vela-tat".to_string())
        .spawn(move || run_tat(receiver));
    let worker = match worker {
        Ok(value) => value,
        Err(error) => {
            set_last_error(&format!("start TAT runtime thread: {error}"));
            return OPERATION_FAILED;
        }
    };
    let handle = Box::new(VelaTatHandle {
        cancel: Some(cancel),
        thread: Some(worker),
    });
    // SAFETY: Ownership of this Box is transferred to vela_tat_close.
    unsafe { *out_handle = Box::into_raw(handle) };
    OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn vela_tat_close(handle: *mut VelaTatHandle) -> i32 {
    clear_last_error();
    if handle.is_null() {
        set_last_error("TAT handle is required");
        return INVALID_ARGUMENT;
    }
    // SAFETY: The API contract requires exactly one close for a successful
    // start handle.
    let mut handle = unsafe { Box::from_raw(handle) };
    if let Some(cancel) = handle.cancel.take() {
        let _ = cancel.send(());
    }
    let result = match handle.thread.take() {
        Some(worker) => worker
            .join()
            .map_err(|_| anyhow!("TAT runtime thread panicked"))
            .and_then(|value| value),
        None => Err(anyhow!("TAT runtime thread is missing")),
    };
    result_code(result)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn vela_tat_last_error(destination: *mut c_char, capacity: usize) -> usize {
    LAST_ERROR.with(|slot| {
        let value = slot.borrow();
        let bytes = value.as_bytes_with_nul();
        if !destination.is_null() && capacity > 0 {
            let count = bytes.len().min(capacity);
            // SAFETY: The caller provides a writable buffer with capacity
            // bytes. Both regions are non-overlapping.
            unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), destination.cast::<u8>(), count) };
            if count == capacity {
                // SAFETY: capacity is non-zero and destination is writable.
                unsafe { *destination.add(capacity - 1) = 0 };
            }
        }
        bytes.len()
    })
}

fn run_tat(cancel: oneshot::Receiver<()>) -> Result<()> {
    let runtime = Builder::new_multi_thread()
        .worker_threads(common::sysinfo::parallelism())
        .enable_all()
        .build()
        .context("build embedded TAT Tokio runtime")?;
    runtime.block_on(async move {
        network::check_register_info().await;
        executor::run().await;
        tssh::run().await;
        tokio::select! {
            _ = network::ws::run() => {
                Err(anyhow!("TAT websocket loop exited unexpectedly"))
            }
            _ = cancel => Ok(()),
        }
    })
}

unsafe fn required_string(value: *const c_char, name: &str) -> Result<String> {
    if value.is_null() {
        return Err(anyhow!("{name} is required"));
    }
    // SAFETY: The caller promises a NUL-terminated pointer valid for the
    // duration of this call.
    let value = unsafe { CStr::from_ptr(value) }
        .to_str()
        .with_context(|| format!("{name} must be UTF-8"))?;
    if value.is_empty() {
        return Err(anyhow!("{name} is required"));
    }
    Ok(value.to_owned())
}

fn result_code(result: Result<()>) -> i32 {
    match result {
        Ok(()) => OK,
        Err(error) => {
            set_last_error(&format!("{error:#}"));
            OPERATION_FAILED
        }
    }
}

fn clear_last_error() {
    set_last_error("");
}

fn set_last_error(value: &str) {
    let sanitized = value.replace('\0', "\u{fffd}");
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = CString::new(sanitized).expect("sanitized CString");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_arguments_are_rejected_without_panicking() {
        let code = unsafe { vela_tat_start(ptr::null(), ptr::null_mut()) };
        assert_eq!(code, INVALID_ARGUMENT);
        let required = unsafe { vela_tat_last_error(ptr::null_mut(), 0) };
        assert!(required > 1);
    }

    #[test]
    fn last_error_is_nul_terminated_when_truncated() {
        set_last_error("a rather long failure");
        let mut output = [1_i8; 5];
        let required = unsafe { vela_tat_last_error(output.as_mut_ptr(), output.len()) };
        assert!(required > output.len());
        assert_eq!(output[output.len() - 1], 0);
    }
}
