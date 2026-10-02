//! Live stable-C-ABI coverage for warmed `QuickJS` Actor turns.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use core::ffi::c_void;

use minisandbox_capi::{
    Handle, RunOptions, RuntimeOptions, Status, minisandbox_actor_template_warm,
    minisandbox_instance_dirty_pages, minisandbox_instance_exit_code, minisandbox_instance_fork,
    minisandbox_instance_run, minisandbox_instance_run_turn, minisandbox_program_load,
    minisandbox_release, minisandbox_runtime_create,
};

const DEPLOYMENT: &[u8] = br"
globalThis.actorState = { value: 7 };
globalThis.handle = (input) => ({ value: actorState.value * input.factor });
";

unsafe extern "C" fn capture(context: *mut c_void, bytes: *const u8, length: usize) -> Status {
    if context.is_null() || bytes.is_null() {
        return Status::InvalidArgument;
    }
    // SAFETY: The runtime callback contract keeps both ranges live for this call.
    let output = unsafe { &mut *context.cast::<Vec<u8>>() };
    // SAFETY: The runtime supplies exactly `length` readable output bytes.
    output.extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, length) });
    Status::Ok
}

#[test]
fn c_abi_warms_and_runs_one_quickjs_actor_turn() {
    let mut runtime: Handle = 0;
    let runtime_options = RuntimeOptions::default();
    // SAFETY: Both option and output pointers remain live for the call.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(
                std::ptr::addr_of!(runtime_options),
                std::ptr::addr_of_mut!(runtime),
            )
        },
        Status::Ok
    );

    let guest = std::fs::read(env!("MINISANDBOX_QUICKJS_GUEST"))
        .expect("the conformance build produced the static QuickJS guest");
    let mut program = 0;
    // SAFETY: Guest bytes and output storage remain live for the call.
    assert_eq!(
        unsafe {
            minisandbox_program_load(
                runtime,
                guest.as_ptr(),
                guest.len(),
                std::ptr::addr_of_mut!(program),
            )
        },
        Status::Ok
    );

    let mut template = 0;
    let invalid_deployment = b"globalThis.handle = (";
    // SAFETY: Invalid deployment bytes and output storage are readable/writable.
    assert_eq!(
        unsafe {
            minisandbox_actor_template_warm(
                runtime,
                program,
                invalid_deployment.as_ptr(),
                invalid_deployment.len(),
                std::ptr::addr_of_mut!(template),
            )
        },
        Status::GuestFault
    );
    assert_eq!(template, 0);
    // SAFETY: Deployment bytes and output storage remain live for the call.
    assert_eq!(
        unsafe {
            minisandbox_actor_template_warm(
                runtime,
                program,
                DEPLOYMENT.as_ptr(),
                DEPLOYMENT.len(),
                std::ptr::addr_of_mut!(template),
            )
        },
        Status::Ok
    );
    let mut instance = 0;
    // SAFETY: The output handle pointer remains live for the call.
    assert_eq!(
        unsafe { minisandbox_instance_fork(runtime, template, std::ptr::addr_of_mut!(instance),) },
        Status::Ok
    );

    let input = br#"{"factor":6}"#;
    let options = RunOptions::default();
    let mut output: Vec<u8> = Vec::new();
    // SAFETY: The options pointer is valid. Actor templates require the turn
    // entry point, and this rejected call must not consume the instance.
    assert_eq!(
        unsafe {
            minisandbox_instance_run(
                instance,
                std::ptr::addr_of!(options),
                None,
                std::ptr::null_mut(),
            )
        },
        Status::InvalidArgument
    );
    // SAFETY: Input, options, callback, and callback context remain valid.
    assert_eq!(
        unsafe {
            minisandbox_instance_run_turn(
                instance,
                input.as_ptr(),
                input.len(),
                std::ptr::addr_of!(options),
                Some(capture),
                std::ptr::from_mut(&mut output).cast(),
            )
        },
        Status::Ok
    );
    assert_eq!(output, br#"{"value":42}"#);
    let mut exit_code = -1;
    // SAFETY: The exit-code output pointer remains live for the call.
    assert_eq!(
        unsafe { minisandbox_instance_exit_code(instance, std::ptr::addr_of_mut!(exit_code)) },
        Status::Ok
    );
    assert_eq!(exit_code, 0);
    let mut dirty_pages = 0;
    // SAFETY: The dirty-page output pointer remains live for the call.
    assert_eq!(
        unsafe { minisandbox_instance_dirty_pages(instance, std::ptr::addr_of_mut!(dirty_pages),) },
        Status::Ok
    );
    assert!(dirty_pages > 0);

    for handle in [instance, template, program, runtime] {
        assert_eq!(minisandbox_release(handle), Status::Ok);
    }
}
