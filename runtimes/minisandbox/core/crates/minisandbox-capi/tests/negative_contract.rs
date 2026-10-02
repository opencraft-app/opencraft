//! Defensive validation for the stable C entry points.

use minisandbox_capi::{
    ByteSlice, GuestFile, Handle, RunOptions, RuntimeOptions, Status, minisandbox_instance_create,
    minisandbox_instance_exit_code, minisandbox_instance_run,
    minisandbox_instance_run_process_with_files, minisandbox_program_load, minisandbox_release,
    minisandbox_runtime_create,
};

#[test]
fn null_pointers_are_rejected_before_dereference() {
    let options = RuntimeOptions::default();
    let mut runtime: Handle = 0;
    // SAFETY: Each null is intentional; the other pointer, when present,
    // addresses a live ABI value.
    assert_eq!(
        unsafe { minisandbox_runtime_create(std::ptr::null(), std::ptr::addr_of_mut!(runtime)) },
        Status::InvalidArgument
    );
    // SAFETY: The null output pointer is the input under test.
    assert_eq!(
        unsafe { minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::null_mut()) },
        Status::InvalidArgument
    );
    // SAFETY: Both pointers address live ABI values.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::addr_of_mut!(runtime))
        },
        Status::Ok
    );

    let mut program = 0;
    // SAFETY: The null byte pointer is intentional and output storage is live.
    assert_eq!(
        unsafe {
            minisandbox_program_load(
                runtime,
                std::ptr::null(),
                0,
                std::ptr::addr_of_mut!(program),
            )
        },
        Status::InvalidArgument
    );
    let elf = minimal_elf(&[0x0f, 0x05]);
    // SAFETY: ELF bytes are live and the null output pointer is intentional.
    assert_eq!(
        unsafe { minisandbox_program_load(runtime, elf.as_ptr(), elf.len(), std::ptr::null_mut()) },
        Status::InvalidArgument
    );
    // SAFETY: Input and output storage remain live for the call.
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

    // SAFETY: The null output pointer is the input under test.
    assert_eq!(
        unsafe { minisandbox_instance_create(runtime, program, std::ptr::null_mut()) },
        Status::InvalidArgument
    );
    let mut instance = 0;
    // SAFETY: Output storage is live.
    assert_eq!(
        unsafe { minisandbox_instance_create(runtime, program, std::ptr::addr_of_mut!(instance),) },
        Status::Ok
    );
    // SAFETY: The null options pointer is the input under test.
    assert_eq!(
        unsafe { minisandbox_instance_run(instance, std::ptr::null(), None, std::ptr::null_mut()) },
        Status::InvalidArgument
    );
    // SAFETY: The null exit-code pointer is the input under test.
    assert_eq!(
        unsafe { minisandbox_instance_exit_code(instance, std::ptr::null_mut()) },
        Status::InvalidArgument
    );

    assert_eq!(minisandbox_release(instance), Status::Ok);
    assert_eq!(minisandbox_release(program), Status::Ok);
    assert_eq!(minisandbox_release(runtime), Status::Ok);
}

#[test]
fn guest_file_descriptors_are_validated_before_use() {
    let run = RunOptions::default();
    // SAFETY: The null file-array pointer with a nonzero count is intentional;
    // all other zero-length ranges are valid empty inputs.
    assert_eq!(
        unsafe {
            minisandbox_instance_run_process_with_files(
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                1,
                std::ptr::addr_of!(run),
                None,
                std::ptr::null_mut(),
            )
        },
        Status::InvalidArgument
    );
    let path = b"/fixture";
    let invalid_file = GuestFile {
        path: ByteSlice {
            bytes: path.as_ptr(),
            length: path.len(),
        },
        contents: ByteSlice {
            bytes: std::ptr::null(),
            length: 1,
        },
    };
    // SAFETY: The invalid nested content pointer is intentional and the outer
    // descriptor plus all other input ranges remain readable.
    assert_eq!(
        unsafe {
            minisandbox_instance_run_process_with_files(
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::addr_of!(invalid_file),
                1,
                std::ptr::addr_of!(run),
                None,
                std::ptr::null_mut(),
            )
        },
        Status::InvalidArgument
    );
}

#[test]
fn handle_kind_is_checked_for_every_typed_operation() {
    let options = RuntimeOptions::default();
    let mut runtime = 0;
    // SAFETY: Input and output storage are live ABI values.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::addr_of_mut!(runtime))
        },
        Status::Ok
    );

    let mut instance = 0;
    // SAFETY: Output storage is live; the runtime-as-program mismatch is the
    // contract error under test.
    assert_eq!(
        unsafe { minisandbox_instance_create(runtime, runtime, std::ptr::addr_of_mut!(instance),) },
        Status::WrongHandleKind
    );
    let mut exit_code = 0;
    // SAFETY: Output storage is live; the runtime-as-instance mismatch is the
    // contract error under test.
    assert_eq!(
        unsafe { minisandbox_instance_exit_code(runtime, std::ptr::addr_of_mut!(exit_code)) },
        Status::WrongHandleKind
    );
    let run = RunOptions::default();
    // SAFETY: Options are live; the runtime-as-instance mismatch is the input
    // under test and no callback context is used.
    assert_eq!(
        unsafe {
            minisandbox_instance_run(runtime, std::ptr::addr_of!(run), None, std::ptr::null_mut())
        },
        Status::WrongHandleKind
    );

    assert_eq!(minisandbox_release(runtime), Status::Ok);
    assert_eq!(minisandbox_release(0), Status::InvalidHandle);
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
