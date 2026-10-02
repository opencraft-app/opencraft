//! Minimal static ELF64 loader contracts.

use minisandbox_core::{
    memory::MAX_LOWER_CANONICAL,
    program::{Program, ProgramError, SegmentPermissions},
};

fn minimal_elf(code: &[u8], memory_size: u64) -> Vec<u8> {
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

    let header = HEADER_SIZE;
    elf[header..header + 4].copy_from_slice(&1_u32.to_le_bytes());
    elf[header + 4..header + 8].copy_from_slice(&5_u32.to_le_bytes());
    elf[header + 8..header + 16].copy_from_slice(&(FILE_OFFSET as u64).to_le_bytes());
    elf[header + 16..header + 24].copy_from_slice(&VIRTUAL_ADDRESS.to_le_bytes());
    elf[header + 24..header + 32].copy_from_slice(&VIRTUAL_ADDRESS.to_le_bytes());
    elf[header + 32..header + 40].copy_from_slice(&(code.len() as u64).to_le_bytes());
    elf[header + 40..header + 48].copy_from_slice(&memory_size.to_le_bytes());
    elf[header + 48..header + 56].copy_from_slice(&0x1000_u64.to_le_bytes());
    elf[FILE_OFFSET..].copy_from_slice(code);
    elf
}

#[test]
fn malformed_or_wrong_architecture_headers_have_specific_errors() {
    let valid = minimal_elf(&[0x0f, 0x05], 2);
    assert_eq!(
        Program::parse_elf(&valid[..32]),
        Err(ProgramError::Truncated)
    );

    let mut wrong_class = valid.clone();
    wrong_class[4] = 1;
    assert_eq!(
        Program::parse_elf(&wrong_class),
        Err(ProgramError::UnsupportedClass)
    );

    let mut wrong_endian = valid.clone();
    wrong_endian[5] = 2;
    assert_eq!(
        Program::parse_elf(&wrong_endian),
        Err(ProgramError::UnsupportedEndian)
    );

    let mut wrong_machine = valid;
    wrong_machine[18..20].copy_from_slice(&3_u16.to_le_bytes());
    assert_eq!(
        Program::parse_elf(&wrong_machine),
        Err(ProgramError::WrongMachine)
    );
}

#[test]
fn unsafe_or_inconsistent_segment_layouts_are_rejected() {
    const PROGRAM_HEADER: usize = 64;
    let valid = minimal_elf(&[0x0f, 0x05], 2);

    let mut writable_executable = valid.clone();
    writable_executable[PROGRAM_HEADER + 4..PROGRAM_HEADER + 8]
        .copy_from_slice(&7_u32.to_le_bytes());
    assert_eq!(
        Program::parse_elf(&writable_executable),
        Err(ProgramError::WritableExecutable)
    );

    let mut undersized_memory = valid.clone();
    undersized_memory[PROGRAM_HEADER + 40..PROGRAM_HEADER + 48]
        .copy_from_slice(&1_u64.to_le_bytes());
    assert_eq!(
        Program::parse_elf(&undersized_memory),
        Err(ProgramError::MemorySmallerThanFile)
    );

    let mut out_of_bounds = valid.clone();
    out_of_bounds[PROGRAM_HEADER + 8..PROGRAM_HEADER + 16].copy_from_slice(&u64::MAX.to_le_bytes());
    assert_eq!(
        Program::parse_elf(&out_of_bounds),
        Err(ProgramError::SegmentOutOfBounds)
    );

    let mut entry_outside_code = valid;
    entry_outside_code[24..32].copy_from_slice(&0x20_0000_u64.to_le_bytes());
    assert_eq!(
        Program::parse_elf(&entry_outside_code),
        Err(ProgramError::EntryNotExecutable)
    );
}

#[test]
fn minimal_static_elf_load_segment_is_parsed() {
    let elf = minimal_elf(&[0x0f, 0x05], 16);
    let program = Program::parse_elf(&elf).expect("the minimal ELF is valid");

    assert_eq!(program.entry().get(), 0x10_0000);
    assert_eq!(program.segments().len(), 1);
    let segment = &program.segments()[0];
    assert_eq!(segment.virtual_address().get(), 0x10_0000);
    assert_eq!(segment.file_bytes(), &[0x0f, 0x05]);
    assert_eq!(segment.memory_size(), 16);
    assert_eq!(segment.permissions(), SegmentPermissions::READ_EXECUTE);
}

#[test]
fn static_pie_receives_a_fixed_safe_load_bias() {
    let mut elf = minimal_elf(&[0x0f, 0x05], 16);
    elf[16..18].copy_from_slice(&3_u16.to_le_bytes());
    let program = Program::parse_elf(&elf).expect("static PIE is a supported ELF type");

    assert_eq!(program.entry().get(), 0x50_0000);
    assert_eq!(program.segments()[0].virtual_address().get(), 0x50_0000);
}

#[test]
fn userspace_dynamic_interpreter_is_preserved_for_controlled_resolution() {
    const SECOND_PROGRAM_HEADER: usize = 64 + 56;
    const INTERPRETER_OFFSET: usize = 0x200;
    const INTERPRETER: &[u8] = b"/lib64/ld-linux-x86-64.so.2\0";
    let mut elf = minimal_elf(&[0x0f, 0x05], 16);
    elf[16..18].copy_from_slice(&3_u16.to_le_bytes());
    elf[56..58].copy_from_slice(&2_u16.to_le_bytes());
    elf[SECOND_PROGRAM_HEADER..SECOND_PROGRAM_HEADER + 4].copy_from_slice(&3_u32.to_le_bytes());
    elf[SECOND_PROGRAM_HEADER + 8..SECOND_PROGRAM_HEADER + 16]
        .copy_from_slice(&(INTERPRETER_OFFSET as u64).to_le_bytes());
    elf[SECOND_PROGRAM_HEADER + 32..SECOND_PROGRAM_HEADER + 40]
        .copy_from_slice(&(INTERPRETER.len() as u64).to_le_bytes());
    elf[INTERPRETER_OFFSET..INTERPRETER_OFFSET + INTERPRETER.len()].copy_from_slice(INTERPRETER);

    let program = Program::parse_elf(&elf).expect("the interpreter request is syntactically valid");
    assert_eq!(
        program.interpreter(),
        Some(INTERPRETER.strip_suffix(&[0]).unwrap())
    );
    assert_eq!(program.load_bias(), 0x40_0000);
}

#[test]
fn overlapping_load_segments_are_rejected_during_parsing() {
    const PROGRAM_HEADER: usize = 64;
    const PROGRAM_HEADER_SIZE: usize = 56;
    let mut elf = minimal_elf(&[0x0f, 0x05], 0x1000);
    elf[56..58].copy_from_slice(&2_u16.to_le_bytes());
    elf.copy_within(
        PROGRAM_HEADER..PROGRAM_HEADER + PROGRAM_HEADER_SIZE,
        PROGRAM_HEADER + PROGRAM_HEADER_SIZE,
    );

    assert_eq!(
        Program::parse_elf(&elf),
        Err(ProgramError::OverlappingSegments)
    );
}

#[test]
fn read_only_load_segment_preserves_elf_permissions() {
    const PROGRAM_HEADER: usize = 64;
    const PROGRAM_HEADER_SIZE: usize = 56;
    const READ_ONLY_HEADER: usize = PROGRAM_HEADER + PROGRAM_HEADER_SIZE;
    let mut elf = minimal_elf(&[0x0f, 0x05], 0x1000);
    elf[56..58].copy_from_slice(&2_u16.to_le_bytes());
    elf.copy_within(
        PROGRAM_HEADER..PROGRAM_HEADER + PROGRAM_HEADER_SIZE,
        READ_ONLY_HEADER,
    );
    elf[READ_ONLY_HEADER + 4..READ_ONLY_HEADER + 8].copy_from_slice(&4_u32.to_le_bytes());
    elf[READ_ONLY_HEADER + 16..READ_ONLY_HEADER + 24].copy_from_slice(&0x11_0000_u64.to_le_bytes());
    elf[READ_ONLY_HEADER + 24..READ_ONLY_HEADER + 32].copy_from_slice(&0x11_0000_u64.to_le_bytes());
    elf[READ_ONLY_HEADER + 32..READ_ONLY_HEADER + 40].copy_from_slice(&0_u64.to_le_bytes());

    let program = Program::parse_elf(&elf).expect("read-only data is a valid load segment");

    assert_eq!(program.segments().len(), 2);
    assert_eq!(
        program.segments()[1].permissions(),
        SegmentPermissions::READ_ONLY
    );
}

#[test]
fn load_segment_range_must_remain_lower_canonical() {
    const PROGRAM_HEADER: usize = 64;
    let start = MAX_LOWER_CANONICAL - 1;
    let mut elf = minimal_elf(&[0x0f, 0x05], 3);
    elf[24..32].copy_from_slice(&start.to_le_bytes());
    elf[PROGRAM_HEADER + 16..PROGRAM_HEADER + 24].copy_from_slice(&start.to_le_bytes());
    elf[PROGRAM_HEADER + 24..PROGRAM_HEADER + 32].copy_from_slice(&start.to_le_bytes());

    assert_eq!(
        Program::parse_elf(&elf),
        Err(ProgramError::NonCanonicalSegment)
    );
}
