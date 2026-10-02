//! Live end-to-end execution through only stable C ABI entry points.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use core::ffi::c_void;

use minisandbox_capi::{
    Handle, RunOptions, RuntimeOptions, Status, minisandbox_instance_create,
    minisandbox_instance_exit_code, minisandbox_instance_run, minisandbox_program_load,
    minisandbox_release, minisandbox_runtime_create,
};

#[test]
fn c_abi_captures_output_and_exit_code_from_a_live_pvm_guest() {
    let runtime_options = RuntimeOptions::default();
    let mut runtime: Handle = 0;
    // SAFETY: Both pointers address valid public ABI values.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(
                std::ptr::addr_of!(runtime_options),
                std::ptr::addr_of_mut!(runtime),
            )
        },
        Status::Ok
    );
    let elf = write_exit_elf();
    let mut program = 0;
    // SAFETY: Input bytes and output storage remain valid for the call.
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
    // SAFETY: Output storage remains valid for the call.
    assert_eq!(
        unsafe { minisandbox_instance_create(runtime, program, std::ptr::addr_of_mut!(instance)) },
        Status::Ok
    );
    let run_options = RunOptions {
        timeout_ns: 1_000_000_000,
        ..RunOptions::default()
    };
    let mut output: Vec<u8> = Vec::new();

    // SAFETY: Options and callback context remain valid until the synchronous
    // call returns; `capture_output` obeys the declared C callback contract.
    let run_status = unsafe {
        minisandbox_instance_run(
            instance,
            std::ptr::addr_of!(run_options),
            Some(capture_output),
            std::ptr::addr_of_mut!(output).cast::<c_void>(),
        )
    };

    assert_eq!(run_status, Status::Ok);
    assert_eq!(output, b"minisandbox\n");
    let mut exit_code = 0;
    // SAFETY: `exit_code` is writable for the duration of the call.
    assert_eq!(
        unsafe { minisandbox_instance_exit_code(instance, std::ptr::addr_of_mut!(exit_code)) },
        Status::Ok
    );
    assert_eq!(exit_code, 73);
    assert_eq!(minisandbox_release(instance), Status::Ok);
    assert_eq!(minisandbox_release(program), Status::Ok);
    assert_eq!(minisandbox_release(runtime), Status::Ok);
}

#[test]
fn callback_failure_is_reported_as_host_error() {
    let (runtime, program, instance) = create_live_instance();
    let run_options = RunOptions {
        timeout_ns: 1_000_000_000,
        ..RunOptions::default()
    };

    // SAFETY: Options remain live for the synchronous call and the callback
    // ignores its otherwise valid arguments.
    let status = unsafe {
        minisandbox_instance_run(
            instance,
            std::ptr::addr_of!(run_options),
            Some(reject_output),
            std::ptr::null_mut(),
        )
    };

    assert_eq!(status, Status::HostError);
    release_live_instance(runtime, program, instance);
}

#[test]
fn callback_reentry_on_the_running_instance_is_busy() {
    let (runtime, program, instance) = create_live_instance();
    let run_options = RunOptions {
        timeout_ns: 1_000_000_000,
        ..RunOptions::default()
    };
    let mut context = ReentryContext {
        instance,
        options: std::ptr::addr_of!(run_options),
        observed: Status::Internal,
    };

    // SAFETY: Options and callback context remain live until the synchronous
    // call returns; `reenter_instance` only makes another ABI call.
    let status = unsafe {
        minisandbox_instance_run(
            instance,
            std::ptr::addr_of!(run_options),
            Some(reenter_instance),
            std::ptr::addr_of_mut!(context).cast(),
        )
    };

    assert_eq!(status, Status::Ok);
    assert_eq!(context.observed, Status::Busy);
    release_live_instance(runtime, program, instance);
}

struct ReentryContext {
    instance: Handle,
    options: *const RunOptions,
    observed: Status,
}

unsafe extern "C" fn reject_output(
    _context: *mut c_void,
    _bytes: *const u8,
    _length: usize,
) -> Status {
    Status::InvalidArgument
}

unsafe extern "C" fn reenter_instance(
    context: *mut c_void,
    _bytes: *const u8,
    _length: usize,
) -> Status {
    // SAFETY: The outer run supplies a live `ReentryContext` for the complete
    // synchronous callback invocation.
    let context = unsafe { &mut *context.cast::<ReentryContext>() };
    // SAFETY: The instance and options are the still-live values owned by the
    // outer test; no callback context is needed for the nested call.
    context.observed = unsafe {
        minisandbox_instance_run(
            context.instance,
            context.options,
            None,
            std::ptr::null_mut(),
        )
    };
    Status::Ok
}

fn create_live_instance() -> (Handle, Handle, Handle) {
    let runtime_options = RuntimeOptions::default();
    let mut runtime = 0;
    // SAFETY: Both pointers address live public ABI values.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(
                std::ptr::addr_of!(runtime_options),
                std::ptr::addr_of_mut!(runtime),
            )
        },
        Status::Ok
    );
    let elf = write_exit_elf();
    let mut program = 0;
    // SAFETY: The ELF and output storage remain live for the call.
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
        unsafe { minisandbox_instance_create(runtime, program, std::ptr::addr_of_mut!(instance),) },
        Status::Ok
    );
    (runtime, program, instance)
}

fn release_live_instance(runtime: Handle, program: Handle, instance: Handle) {
    assert_eq!(minisandbox_release(instance), Status::Ok);
    assert_eq!(minisandbox_release(program), Status::Ok);
    assert_eq!(minisandbox_release(runtime), Status::Ok);
}

unsafe extern "C" fn capture_output(
    context: *mut c_void,
    bytes: *const u8,
    length: usize,
) -> Status {
    if context.is_null() || bytes.is_null() {
        return Status::InvalidArgument;
    }
    // SAFETY: The run call supplies the live Vec context and a readable output
    // slice whose lifetime covers this synchronous callback.
    let output = unsafe { &mut *context.cast::<Vec<u8>>() };
    // SAFETY: The callback contract guarantees `length` readable bytes.
    output.extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, length) });
    Status::Ok
}

fn write_exit_elf() -> Vec<u8> {
    const ADDRESS: u64 = 0x10_0000;
    const MESSAGE: &[u8] = b"minisandbox\n";
    let mut code = Vec::new();
    code.extend([0xb8, 1, 0, 0, 0]);
    code.extend([0xbf, 1, 0, 0, 0]);
    code.extend([0x48, 0xbe]);
    code.extend((ADDRESS + 41).to_le_bytes());
    code.extend([0xba, 12, 0, 0, 0]);
    code.extend([0x0f, 0x05]);
    code.extend([0xb8, 60, 0, 0, 0]);
    code.extend([0xbf, 73, 0, 0, 0]);
    code.extend([0x0f, 0x05, 0x0f, 0x0b]);
    code.extend(MESSAGE);
    minimal_elf(&code)
}

fn minimal_elf(code: &[u8]) -> Vec<u8> {
    const HEADER_SIZE: usize = 64;
    const PROGRAM_HEADER_SIZE: usize = 56;
    const FILE_OFFSET: usize = 0x1000;
    const VIRTUAL_ADDRESS: u64 = 0x10_0000;
    let mut elf = vec![0_u8; FILE_OFFSET + code.len()];
    elf[..16].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    elf[16..18].copy_from_slice(&2_u16.to_le_bytes());
    elf[18..20].copy_from_slice(&62_u16.to_le_bytes());
    elf[20..24].copy_from_slice(&1_u32.to_le_bytes());
    elf[24..32].copy_from_slice(&VIRTUAL_ADDRESS.to_le_bytes());
    elf[32..40].copy_from_slice(&(HEADER_SIZE as u64).to_le_bytes());
    elf[52..54].copy_from_slice(&64_u16.to_le_bytes());
    elf[54..56].copy_from_slice(
        &u16::try_from(PROGRAM_HEADER_SIZE)
            .expect("program header size fits u16")
            .to_le_bytes(),
    );
    elf[56..58].copy_from_slice(&1_u16.to_le_bytes());
    elf[HEADER_SIZE..HEADER_SIZE + 4].copy_from_slice(&1_u32.to_le_bytes());
    elf[HEADER_SIZE + 4..HEADER_SIZE + 8].copy_from_slice(&5_u32.to_le_bytes());
    elf[HEADER_SIZE + 8..HEADER_SIZE + 16].copy_from_slice(&(FILE_OFFSET as u64).to_le_bytes());
    elf[HEADER_SIZE + 16..HEADER_SIZE + 24].copy_from_slice(&VIRTUAL_ADDRESS.to_le_bytes());
    elf[HEADER_SIZE + 24..HEADER_SIZE + 32].copy_from_slice(&VIRTUAL_ADDRESS.to_le_bytes());
    elf[HEADER_SIZE + 32..HEADER_SIZE + 40].copy_from_slice(&(code.len() as u64).to_le_bytes());
    elf[HEADER_SIZE + 40..HEADER_SIZE + 48].copy_from_slice(&(code.len() as u64).to_le_bytes());
    elf[HEADER_SIZE + 48..HEADER_SIZE + 56].copy_from_slice(&0x1000_u64.to_le_bytes());
    elf[FILE_OFFSET..].copy_from_slice(code);
    elf
}
