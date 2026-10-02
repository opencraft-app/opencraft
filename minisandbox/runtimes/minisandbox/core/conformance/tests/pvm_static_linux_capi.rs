//! Live stable-C-ABI coverage for static and dynamic Linux process inputs.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use core::ffi::c_void;

use minisandbox_capi::{
    ByteSlice, Handle, RunOptions, RuntimeOptions, Status, minisandbox_instance_create,
    minisandbox_instance_exit_code, minisandbox_instance_run_process, minisandbox_program_load,
    minisandbox_release, minisandbox_runtime_create,
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

#[test]
fn c_abi_runs_static_and_dynamic_processes_with_complete_inputs() {
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
    for guest in [
        env!("MINISANDBOX_STATIC_PROCESS_GUEST"),
        env!("MINISANDBOX_DYNAMIC_PROCESS_GUEST"),
    ] {
        let elf = std::fs::read(guest).expect("the conformance build produced the process ELF");
        let mut program = 0;
        // SAFETY: ELF bytes and output storage remain live for the call.
        assert_eq!(
            unsafe {
                minisandbox_program_load(
                    runtime,
                    elf.as_ptr(),
                    elf.len(),
                    std::ptr::addr_of_mut!(program),
                )
            },
            Status::Ok
        );
        let mut instance = 0;
        // SAFETY: Output storage remains live for the call.
        assert_eq!(
            unsafe {
                minisandbox_instance_create(runtime, program, std::ptr::addr_of_mut!(instance))
            },
            Status::Ok
        );

        let argument_bytes: [&[u8]; 3] = [b"custom-program", b"alpha", b"beta"];
        let arguments = argument_bytes.map(|bytes| ByteSlice {
            bytes: bytes.as_ptr(),
            length: bytes.len(),
        });
        let environment_bytes = b"MODE=conformance";
        let environment = [ByteSlice {
            bytes: environment_bytes.as_ptr(),
            length: environment_bytes.len(),
        }];
        let stdin = b"input-42\n";
        let options = RunOptions::default();
        let mut output: Vec<u8> = Vec::new();
        // SAFETY: Every descriptor, byte range, option, and callback context
        // stays live until the synchronous call returns.
        assert_eq!(
            unsafe {
                minisandbox_instance_run_process(
                    instance,
                    arguments.as_ptr(),
                    arguments.len(),
                    environment.as_ptr(),
                    environment.len(),
                    stdin.as_ptr(),
                    stdin.len(),
                    std::ptr::addr_of!(options),
                    Some(capture),
                    std::ptr::from_mut(&mut output).cast(),
                )
            },
            Status::Ok,
            "guest={guest}"
        );
        assert_eq!(output, b"args-env-stdin\n", "guest={guest}");
        let mut exit_code = -1;
        // SAFETY: Exit-code output storage remains live for the call.
        assert_eq!(
            unsafe { minisandbox_instance_exit_code(instance, std::ptr::addr_of_mut!(exit_code)) },
            Status::Ok
        );
        assert_eq!(exit_code, 38, "guest={guest}");

        for handle in [instance, program] {
            assert_eq!(minisandbox_release(handle), Status::Ok);
        }
    }
    assert_eq!(minisandbox_release(runtime), Status::Ok);
}
