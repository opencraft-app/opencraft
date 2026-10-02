//! Live PVM copy-on-write master/child isolation conformance.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_core::{
    engine::{Engine, RunOutcome},
    memory::GuestAddress,
    program::Program,
};

const CODE_ADDRESS: u64 = 0x10_0000;
const DATA_ADDRESS: u64 = 0x11_0000;
const TEMPLATE_BYTE: u8 = 0x2a;
const CHILD_BYTE: u8 = 0x4b;

fn cow_elf(writes_data: bool) -> Vec<u8> {
    const ELF_HEADER_SIZE: usize = 64;
    const PROGRAM_HEADER_SIZE: usize = 56;
    const CODE_OFFSET: usize = 0x1000;
    const DATA_OFFSET: usize = 0x2000;

    let mut code = vec![0x48, 0xb8]; // mov rax, DATA_ADDRESS
    code.extend(DATA_ADDRESS.to_le_bytes());
    if writes_data {
        code.extend([0xc6, 0x00, CHILD_BYTE]); // first write
        code.extend([0xc6, 0x00, CHILD_BYTE]); // same-page write must not copy again
    }
    code.extend([0x0f, 0xb6, 0x38]); // movzx edi, byte ptr [rax]
    code.extend([0xb8, 60, 0, 0, 0]); // mov eax, SYS_exit
    code.extend([0x0f, 0x05, 0x0f, 0x0b]); // syscall; ud2

    let mut elf = vec![0_u8; DATA_OFFSET + 1];
    elf[..16].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    elf[16..18].copy_from_slice(&2_u16.to_le_bytes());
    elf[18..20].copy_from_slice(&62_u16.to_le_bytes());
    elf[20..24].copy_from_slice(&1_u32.to_le_bytes());
    elf[24..32].copy_from_slice(&CODE_ADDRESS.to_le_bytes());
    elf[32..40].copy_from_slice(&(ELF_HEADER_SIZE as u64).to_le_bytes());
    elf[52..54].copy_from_slice(
        &u16::try_from(ELF_HEADER_SIZE)
            .expect("ELF header size fits u16")
            .to_le_bytes(),
    );
    elf[54..56].copy_from_slice(
        &u16::try_from(PROGRAM_HEADER_SIZE)
            .expect("program header size fits u16")
            .to_le_bytes(),
    );
    elf[56..58].copy_from_slice(&2_u16.to_le_bytes());

    let code_header = ELF_HEADER_SIZE;
    elf[code_header..code_header + 4].copy_from_slice(&1_u32.to_le_bytes());
    elf[code_header + 4..code_header + 8].copy_from_slice(&5_u32.to_le_bytes());
    elf[code_header + 8..code_header + 16].copy_from_slice(&(CODE_OFFSET as u64).to_le_bytes());
    elf[code_header + 16..code_header + 24].copy_from_slice(&CODE_ADDRESS.to_le_bytes());
    elf[code_header + 24..code_header + 32].copy_from_slice(&CODE_ADDRESS.to_le_bytes());
    elf[code_header + 32..code_header + 40].copy_from_slice(&(code.len() as u64).to_le_bytes());
    elf[code_header + 40..code_header + 48].copy_from_slice(&(code.len() as u64).to_le_bytes());
    elf[code_header + 48..code_header + 56].copy_from_slice(&0x1000_u64.to_le_bytes());

    let data_header = code_header + PROGRAM_HEADER_SIZE;
    elf[data_header..data_header + 4].copy_from_slice(&1_u32.to_le_bytes());
    elf[data_header + 4..data_header + 8].copy_from_slice(&6_u32.to_le_bytes());
    elf[data_header + 8..data_header + 16].copy_from_slice(&(DATA_OFFSET as u64).to_le_bytes());
    elf[data_header + 16..data_header + 24].copy_from_slice(&DATA_ADDRESS.to_le_bytes());
    elf[data_header + 24..data_header + 32].copy_from_slice(&DATA_ADDRESS.to_le_bytes());
    elf[data_header + 32..data_header + 40].copy_from_slice(&1_u64.to_le_bytes());
    elf[data_header + 40..data_header + 48].copy_from_slice(&0x1000_u64.to_le_bytes());
    elf[data_header + 48..data_header + 56].copy_from_slice(&0x1000_u64.to_le_bytes());

    elf[CODE_OFFSET..CODE_OFFSET + code.len()].copy_from_slice(&code);
    elf[DATA_OFFSET] = TEMPLATE_BYTE;
    elf
}

#[test]
fn child_first_write_copies_one_page_and_preserves_master_and_sibling() {
    let engine = Engine::open().expect("the designated host exposes PVM");
    let program = Program::parse_elf(&cow_elf(true)).expect("the COW fixture ELF is valid");
    let template = engine
        .seal_template(&program)
        .expect("the warmed image can be sealed as a COW template");
    let data = GuestAddress::new(DATA_ADDRESS).expect("the data address is canonical");
    let mut child = engine
        .fork_template(&template)
        .expect("the first child has a private VM/vCPU and shared clean pages");
    let sibling = engine
        .fork_template(&template)
        .expect("the sibling has a private VM/vCPU and shared clean pages");

    assert_eq!(template.read_memory(data, 1).unwrap(), [TEMPLATE_BYTE]);
    assert_eq!(child.read_memory(data, 1).unwrap(), [TEMPLATE_BYTE]);
    assert_eq!(sibling.read_memory(data, 1).unwrap(), [TEMPLATE_BYTE]);
    assert_eq!(child.stats().dirty_data_pages, 0);
    assert_eq!(sibling.stats().dirty_data_pages, 0);
    assert_eq!(child.backing_id(), template.backing_id());
    assert_eq!(sibling.backing_id(), template.backing_id());

    let result = child
        .run()
        .expect("the COW page fault is handled and resumed");

    assert_eq!(
        result.outcome,
        RunOutcome::Exited {
            code: i32::from(CHILD_BYTE)
        }
    );
    assert_eq!(child.read_memory(data, 1).unwrap(), [CHILD_BYTE]);
    assert_eq!(child.stats().dirty_data_pages, 1);
    assert_eq!(child.stats().cow_faults, 1);
    assert_eq!(template.live_private_data_pages(), 1);
    assert_eq!(template.read_memory(data, 1).unwrap(), [TEMPLATE_BYTE]);
    assert_eq!(sibling.read_memory(data, 1).unwrap(), [TEMPLATE_BYTE]);

    drop(child);
    assert_eq!(template.live_private_data_pages(), 0);
    assert_eq!(template.read_memory(data, 1).unwrap(), [TEMPLATE_BYTE]);
}

#[test]
fn clean_read_keeps_all_template_data_pages_shared() {
    let engine = Engine::open().expect("the designated host exposes PVM");
    let program = Program::parse_elf(&cow_elf(false)).expect("the read fixture ELF is valid");
    let template = engine
        .seal_template(&program)
        .expect("the image can be sealed as a COW template");
    let mut child = engine
        .fork_template(&template)
        .expect("the child shares clean data pages");

    let result = child.run().expect("a clean read completes without a fault");

    assert_eq!(
        result.outcome,
        RunOutcome::Exited {
            code: i32::from(TEMPLATE_BYTE)
        }
    );
    assert_eq!(child.stats().dirty_data_pages, 0);
    assert_eq!(child.stats().cow_faults, 0);
    assert_eq!(template.live_private_data_pages(), 0);
}

#[test]
fn repeated_fork_run_destroy_returns_to_the_clean_template() {
    const TURNS: usize = 32;
    let engine = Engine::open().expect("the designated host exposes PVM");
    let program = Program::parse_elf(&cow_elf(true)).expect("the COW fixture ELF is valid");
    let template = engine
        .seal_template(&program)
        .expect("the image can be sealed as a COW template");
    let data = GuestAddress::new(DATA_ADDRESS).expect("the data address is canonical");
    let started = std::time::Instant::now();

    for _ in 0..TURNS {
        let mut child = engine
            .fork_template(&template)
            .expect("each turn receives a fresh VM/vCPU");
        let result = child.run().expect("each COW turn completes");
        assert_eq!(
            result.outcome,
            RunOutcome::Exited {
                code: i32::from(CHILD_BYTE)
            }
        );
        assert_eq!(child.stats().dirty_data_pages, 1);
        drop(child);
        assert_eq!(template.live_private_data_pages(), 0);
    }

    assert_eq!(template.read_memory(data, 1).unwrap(), [TEMPLATE_BYTE]);
    eprintln!(
        "PVM COW {TURNS}-turn fork/run/destroy elapsed: {:?}",
        started.elapsed()
    );
}
