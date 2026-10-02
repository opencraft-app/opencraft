//! Runtime handle lifecycle through the exported C calling convention.

use minisandbox_capi::{
    Handle, RuntimeOptions, Status, minisandbox_release, minisandbox_runtime_create,
};

#[repr(C)]
struct ExtendedOptions {
    known: RuntimeOptions,
    future: u64,
}

#[test]
fn runtime_handle_is_generation_checked_and_double_release_is_rejected() {
    let options = RuntimeOptions::default();
    let mut runtime: Handle = 0;

    // SAFETY: Both pointers refer to initialized, correctly sized Rust values
    // whose layouts are the public C ABI contract.
    let status = unsafe {
        minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::addr_of_mut!(runtime))
    };

    assert_eq!(status, Status::Ok);
    assert_ne!(runtime, 0);
    assert_eq!(minisandbox_release(runtime), Status::Ok);
    assert_eq!(minisandbox_release(runtime), Status::InvalidHandle);
}

#[test]
fn runtime_options_validate_the_versioned_structure_prefix() {
    let mut handle = 0;
    let short = RuntimeOptions {
        struct_size: 4,
        ..RuntimeOptions::default()
    };
    // SAFETY: The pointers address valid ABI values for the duration of each call.
    let short_status = unsafe {
        minisandbox_runtime_create(std::ptr::addr_of!(short), std::ptr::addr_of_mut!(handle))
    };
    assert_eq!(short_status, Status::InvalidArgument);
    assert_eq!(handle, 0);

    let wrong_version = RuntimeOptions {
        abi_version: 2 << 16,
        ..RuntimeOptions::default()
    };
    // SAFETY: The pointers address valid ABI values for the duration of the call.
    let version_status = unsafe {
        minisandbox_runtime_create(
            std::ptr::addr_of!(wrong_version),
            std::ptr::addr_of_mut!(handle),
        )
    };
    assert_eq!(version_status, Status::InvalidArgument);
    assert_eq!(handle, 0);

    let extended_size =
        u32::try_from(std::mem::size_of::<ExtendedOptions>()).expect("fixture size fits u32");
    let extended = ExtendedOptions {
        known: RuntimeOptions {
            struct_size: extended_size,
            ..RuntimeOptions::default()
        },
        future: 0,
    };
    // SAFETY: The extended allocation begins with the public options prefix
    // and remains readable for its advertised size.
    let long_status = unsafe {
        minisandbox_runtime_create(
            std::ptr::addr_of!(extended).cast(),
            std::ptr::addr_of_mut!(handle),
        )
    };
    assert_eq!(long_status, Status::Ok);
    assert_eq!(minisandbox_release(handle), Status::Ok);
}
