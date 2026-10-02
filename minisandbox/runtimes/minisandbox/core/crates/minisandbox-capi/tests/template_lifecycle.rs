//! Stable C ABI lifecycle for sealed templates and ephemeral COW instances.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_capi::{
    Handle, RunOptions, RuntimeOptions, Status, minisandbox_instance_dirty_pages,
    minisandbox_instance_fork, minisandbox_instance_run, minisandbox_program_load,
    minisandbox_release, minisandbox_runtime_create, minisandbox_template_create,
};

#[test]
fn template_and_cow_instance_handles_are_typed_generation_checked_and_live() {
    let options = RuntimeOptions::default();
    let mut runtime: Handle = 0;
    // SAFETY: The input and output pointers remain valid for the call.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::addr_of_mut!(runtime))
        },
        Status::Ok
    );
    let elf = cow_elf();
    let mut program = 0;
    // SAFETY: The ELF slice and output storage remain valid for the call.
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
    let mut template = 0;
    // SAFETY: The output pointer names writable handle storage.
    assert_eq!(
        unsafe { minisandbox_template_create(runtime, program, std::ptr::addr_of_mut!(template)) },
        Status::Ok
    );
    assert_ne!(template, 0);

    let mut instance = 0;
    // SAFETY: The output pointer names writable handle storage.
    assert_eq!(
        unsafe { minisandbox_instance_fork(runtime, template, std::ptr::addr_of_mut!(instance)) },
        Status::Ok
    );
    let run = RunOptions::default();
    // SAFETY: The run-options pointer is readable; no callback context is used.
    assert_eq!(
        unsafe {
            minisandbox_instance_run(
                instance,
                std::ptr::addr_of!(run),
                None,
                std::ptr::null_mut(),
            )
        },
        Status::Ok
    );
    let mut dirty_pages = u64::MAX;
    // SAFETY: The output pointer names writable u64 storage.
    assert_eq!(
        unsafe { minisandbox_instance_dirty_pages(instance, std::ptr::addr_of_mut!(dirty_pages)) },
        Status::Ok
    );
    assert_eq!(dirty_pages, 1);
    // SAFETY: The run-options pointer is readable; a template instance is
    // intentionally one-shot even though its metrics remain queryable.
    assert_eq!(
        unsafe {
            minisandbox_instance_run(
                instance,
                std::ptr::addr_of!(run),
                None,
                std::ptr::null_mut(),
            )
        },
        Status::InvalidArgument
    );

    assert_eq!(minisandbox_release(instance), Status::Ok);
    let mut replacement = 0;
    // SAFETY: The output pointer names writable handle storage.
    assert_eq!(
        unsafe {
            minisandbox_instance_fork(runtime, template, std::ptr::addr_of_mut!(replacement))
        },
        Status::Ok
    );
    assert_ne!(replacement, instance);
    assert_eq!(minisandbox_release(instance), Status::InvalidHandle);
    let mut wrong_kind = 0;
    // SAFETY: The output pointer names writable handle storage.
    assert_eq!(
        unsafe { minisandbox_instance_fork(runtime, program, std::ptr::addr_of_mut!(wrong_kind)) },
        Status::WrongHandleKind
    );

    assert_eq!(minisandbox_release(replacement), Status::Ok);
    assert_eq!(minisandbox_release(template), Status::Ok);
    assert_eq!(minisandbox_release(template), Status::InvalidHandle);
    assert_eq!(minisandbox_release(program), Status::Ok);
    assert_eq!(minisandbox_release(runtime), Status::Ok);
}

fn cow_elf() -> Vec<u8> {
    const HEADER_SIZE: usize = 64;
    const PHDR_SIZE: usize = 56;
    const CODE_OFFSET: usize = 0x1000;
    const DATA_OFFSET: usize = 0x2000;
    const CODE_ADDRESS: u64 = 0x10_0000;
    const DATA_ADDRESS: u64 = 0x11_0000;

    let mut code = vec![0x48, 0xb8];
    code.extend(DATA_ADDRESS.to_le_bytes());
    code.extend([0xc6, 0x00, 75]);
    code.extend([0x0f, 0xb6, 0x38]);
    code.extend([0xb8, 60, 0, 0, 0, 0x0f, 0x05]);

    let mut elf = vec![0_u8; DATA_OFFSET + 1];
    elf[..16].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    elf[16..18].copy_from_slice(&2_u16.to_le_bytes());
    elf[18..20].copy_from_slice(&62_u16.to_le_bytes());
    elf[20..24].copy_from_slice(&1_u32.to_le_bytes());
    elf[24..32].copy_from_slice(&CODE_ADDRESS.to_le_bytes());
    elf[32..40].copy_from_slice(&(HEADER_SIZE as u64).to_le_bytes());
    elf[52..54].copy_from_slice(
        &u16::try_from(HEADER_SIZE)
            .expect("ELF header size fits u16")
            .to_le_bytes(),
    );
    elf[54..56].copy_from_slice(
        &u16::try_from(PHDR_SIZE)
            .expect("program header size fits u16")
            .to_le_bytes(),
    );
    elf[56..58].copy_from_slice(&2_u16.to_le_bytes());

    write_phdr(
        &mut elf[HEADER_SIZE..HEADER_SIZE + PHDR_SIZE],
        5,
        CODE_OFFSET as u64,
        CODE_ADDRESS,
        code.len() as u64,
    );
    write_phdr(
        &mut elf[HEADER_SIZE + PHDR_SIZE..HEADER_SIZE + PHDR_SIZE * 2],
        6,
        DATA_OFFSET as u64,
        DATA_ADDRESS,
        1,
    );
    elf[CODE_OFFSET..CODE_OFFSET + code.len()].copy_from_slice(&code);
    elf[DATA_OFFSET] = 42;
    elf
}

fn write_phdr(header: &mut [u8], flags: u32, offset: u64, address: u64, size: u64) {
    header[0..4].copy_from_slice(&1_u32.to_le_bytes());
    header[4..8].copy_from_slice(&flags.to_le_bytes());
    header[8..16].copy_from_slice(&offset.to_le_bytes());
    header[16..24].copy_from_slice(&address.to_le_bytes());
    header[24..32].copy_from_slice(&address.to_le_bytes());
    header[32..40].copy_from_slice(&size.to_le_bytes());
    header[40..48].copy_from_slice(&size.to_le_bytes());
    header[48..56].copy_from_slice(&0x1000_u64.to_le_bytes());
}
