//! Version discovery and thread-local error reporting through the C ABI.

use std::ffi::CStr;

use minisandbox_capi::{
    Status, abi_version, minisandbox_abi_version, minisandbox_last_error,
    minisandbox_runtime_create,
};

#[test]
fn exported_abi_version_matches_the_structure_version() {
    assert_eq!(minisandbox_abi_version(), abi_version());
}

#[test]
fn last_error_describes_the_most_recent_failed_call() {
    // SAFETY: Null pointers are deliberately passed to verify validation occurs
    // before either pointer is dereferenced.
    assert_eq!(
        unsafe { minisandbox_runtime_create(std::ptr::null(), std::ptr::null_mut()) },
        Status::InvalidArgument
    );

    let pointer = minisandbox_last_error();
    assert!(!pointer.is_null());
    // SAFETY: The C ABI promises a process-owned NUL-terminated string that
    // remains live until the next minisandbox call on this thread.
    let message = unsafe { CStr::from_ptr(pointer) };
    assert_eq!(message.to_bytes(), b"invalid argument");
}
