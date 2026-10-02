//! Live stable-C-ABI coverage for an unmodified ELF and supplied shared libraries.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use core::ffi::c_void;

use minisandbox_capi::{
    ByteSlice, GuestFile, Handle, RunOptions, RuntimeOptions, Status, minisandbox_instance_create,
    minisandbox_instance_exit_code, minisandbox_instance_run_process_with_files,
    minisandbox_program_load, minisandbox_release, minisandbox_runtime_create,
};

unsafe extern "C" fn capture(context: *mut c_void, bytes: *const u8, length: usize) -> Status {
    if context.is_null() || bytes.is_null() {
        return Status::InvalidArgument;
    }
    // SAFETY: The synchronous callback contract keeps both ranges live.
    let output = unsafe { &mut *context.cast::<Vec<u8>>() };
    // SAFETY: The runtime supplies exactly `length` readable bytes.
    output.extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, length) });
    Status::Ok
}

fn bytes(value: &[u8]) -> ByteSlice {
    ByteSlice {
        bytes: value.as_ptr(),
        length: value.len(),
    }
}

#[test]
fn c_abi_runs_unmodified_sha256sum_with_exact_runtime_files() {
    let executable =
        std::fs::read("/usr/bin/sha256sum").expect("the designated host provides the system ELF");
    let crypto = std::fs::read("/lib64/libcrypto.so.3")
        .expect("the designated runtime bundle provides libcrypto");
    let zlib =
        std::fs::read("/lib64/libz.so.1").expect("the designated runtime bundle provides zlib");
    let file_paths: [&[u8]; 2] = [b"/lib64/libcrypto.so.3", b"/lib64/libz.so.1"];
    let file_contents = [&crypto[..], &zlib[..]];
    let files = [
        GuestFile {
            path: bytes(file_paths[0]),
            contents: bytes(file_contents[0]),
        },
        GuestFile {
            path: bytes(file_paths[1]),
            contents: bytes(file_contents[1]),
        },
    ];

    let runtime_options = RuntimeOptions::default();
    let mut runtime: Handle = 0;
    // SAFETY: Options and output storage remain live for the call.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(
                std::ptr::addr_of!(runtime_options),
                std::ptr::addr_of_mut!(runtime),
            )
        },
        Status::Ok
    );
    let mut program = 0;
    // SAFETY: ELF bytes and output storage remain live for the call.
    assert_eq!(
        unsafe {
            minisandbox_program_load(
                runtime,
                executable.as_ptr(),
                executable.len(),
                std::ptr::addr_of_mut!(program),
            )
        },
        Status::Ok
    );
    let mut instance = 0;
    // SAFETY: Output storage remains live for the call.
    assert_eq!(
        unsafe { minisandbox_instance_create(runtime, program, &raw mut instance) },
        Status::Ok
    );

    let argument_data: [&[u8]; 1] = [b"/usr/bin/sha256sum"];
    let arguments = argument_data.map(bytes);
    let environment_data: [&[u8]; 1] = [b"LC_ALL=C"];
    let environment = environment_data.map(bytes);
    let stdin = b"abc";
    let options = RunOptions::default();
    let mut output: Vec<u8> = Vec::new();
    // SAFETY: Every descriptor, byte range, option, and callback context stays
    // live until the synchronous call returns.
    assert_eq!(
        unsafe {
            minisandbox_instance_run_process_with_files(
                instance,
                arguments.as_ptr(),
                arguments.len(),
                environment.as_ptr(),
                environment.len(),
                stdin.as_ptr(),
                stdin.len(),
                files.as_ptr(),
                files.len(),
                std::ptr::addr_of!(options),
                Some(capture),
                std::ptr::from_mut(&mut output).cast(),
            )
        },
        Status::Ok
    );
    assert_eq!(
        output,
        b"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n"
    );
    let mut exit_code = -1;
    // SAFETY: Exit-code output storage remains live for the call.
    assert_eq!(
        unsafe { minisandbox_instance_exit_code(instance, &raw mut exit_code) },
        Status::Ok
    );
    assert_eq!(exit_code, 0);

    for handle in [instance, program, runtime] {
        assert_eq!(minisandbox_release(handle), Status::Ok);
    }
}
