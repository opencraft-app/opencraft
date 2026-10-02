//! Program loading through the exported C calling convention.

use minisandbox_capi::{
    Handle, RuntimeOptions, Status, minisandbox_instance_create, minisandbox_program_load,
    minisandbox_release, minisandbox_runtime_create,
};

#[test]
fn validated_elf_bytes_create_a_releasable_program_handle() {
    let options = RuntimeOptions::default();
    let mut runtime: Handle = 0;
    // SAFETY: Both pointers address valid public ABI values.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::addr_of_mut!(runtime))
        },
        Status::Ok
    );
    let elf = minimal_elf(&[0x0f, 0x05]);
    let mut program: Handle = 0;

    // SAFETY: The ELF slice remains readable and the output handle writable
    // for the duration of this call.
    let status = unsafe {
        minisandbox_program_load(
            runtime,
            elf.as_ptr(),
            elf.len(),
            std::ptr::addr_of_mut!(program),
        )
    };

    assert_eq!(status, Status::Ok);
    assert_ne!(program, 0);
    assert_eq!(minisandbox_release(program), Status::Ok);
    assert_eq!(minisandbox_release(runtime), Status::Ok);
}

#[test]
fn runtime_and_program_create_a_releasable_instance_handle() {
    let options = RuntimeOptions::default();
    let mut runtime = 0;
    // SAFETY: Both pointers address valid public ABI values.
    assert_eq!(
        unsafe {
            minisandbox_runtime_create(std::ptr::addr_of!(options), std::ptr::addr_of_mut!(runtime))
        },
        Status::Ok
    );
    let elf = minimal_elf(&[0x0f, 0x05]);
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

    // SAFETY: `out_instance` points to writable handle storage.
    let status =
        unsafe { minisandbox_instance_create(runtime, program, std::ptr::addr_of_mut!(instance)) };

    assert_eq!(status, Status::Ok);
    assert_ne!(instance, 0);
    assert_eq!(minisandbox_release(instance), Status::Ok);
    assert_eq!(minisandbox_release(program), Status::Ok);
    assert_eq!(minisandbox_release(runtime), Status::Ok);
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
    elf[52..54].copy_from_slice(
        &u16::try_from(HEADER_SIZE)
            .expect("ELF header size fits u16")
            .to_le_bytes(),
    );
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
