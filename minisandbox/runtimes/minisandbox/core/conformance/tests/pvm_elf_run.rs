//! Live static-ELF execution through the Rust runtime API.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use std::time::{Duration, Instant};

use minisandbox_core::{
    engine::{Engine, RunOptions, RunOutcome},
    program::Program,
};

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
    let header = HEADER_SIZE;
    elf[header..header + 4].copy_from_slice(&1_u32.to_le_bytes());
    elf[header + 4..header + 8].copy_from_slice(&5_u32.to_le_bytes());
    elf[header + 8..header + 16].copy_from_slice(&(FILE_OFFSET as u64).to_le_bytes());
    elf[header + 16..header + 24].copy_from_slice(&VIRTUAL_ADDRESS.to_le_bytes());
    elf[header + 24..header + 32].copy_from_slice(&VIRTUAL_ADDRESS.to_le_bytes());
    elf[header + 32..header + 40].copy_from_slice(&(code.len() as u64).to_le_bytes());
    elf[header + 40..header + 48].copy_from_slice(&(code.len() as u64).to_le_bytes());
    elf[header + 48..header + 56].copy_from_slice(&0x1000_u64.to_le_bytes());
    elf[FILE_OFFSET..].copy_from_slice(code);
    elf
}

fn elf_with_read_only_data(code: &[u8]) -> Vec<u8> {
    const PROGRAM_HEADER: usize = 64;
    const PROGRAM_HEADER_SIZE: usize = 56;
    const READ_ONLY_HEADER: usize = PROGRAM_HEADER + PROGRAM_HEADER_SIZE;
    const DATA_OFFSET: usize = 0x2000;
    const DATA_ADDRESS: u64 = 0x11_0000;

    let mut elf = minimal_elf(code);
    elf.resize(DATA_OFFSET + 1, 0);
    elf[56..58].copy_from_slice(&2_u16.to_le_bytes());
    elf.copy_within(
        PROGRAM_HEADER..PROGRAM_HEADER + PROGRAM_HEADER_SIZE,
        READ_ONLY_HEADER,
    );
    elf[READ_ONLY_HEADER + 4..READ_ONLY_HEADER + 8].copy_from_slice(&4_u32.to_le_bytes());
    elf[READ_ONLY_HEADER + 8..READ_ONLY_HEADER + 16]
        .copy_from_slice(&(DATA_OFFSET as u64).to_le_bytes());
    elf[READ_ONLY_HEADER + 16..READ_ONLY_HEADER + 24].copy_from_slice(&DATA_ADDRESS.to_le_bytes());
    elf[READ_ONLY_HEADER + 24..READ_ONLY_HEADER + 32].copy_from_slice(&DATA_ADDRESS.to_le_bytes());
    elf[READ_ONLY_HEADER + 32..READ_ONLY_HEADER + 40].copy_from_slice(&1_u64.to_le_bytes());
    elf[READ_ONLY_HEADER + 40..READ_ONLY_HEADER + 48].copy_from_slice(&0x1000_u64.to_le_bytes());
    elf
}

#[test]
fn static_elf_exit_syscall_returns_a_typed_code() {
    let exit_73 = [
        0xb8, 60, 0, 0, 0, // mov eax, SYS_exit
        0xbf, 73, 0, 0, 0, // mov edi, 73
        0x0f, 0x05, // syscall
        0x0f, 0x0b, // ud2 if resumed
    ];
    let program = Program::parse_elf(&minimal_elf(&exit_73)).expect("fixture ELF is valid");
    let engine = Engine::open().expect("the designated host exposes PVM");

    let result = engine.run(&program).expect("the guest run succeeds");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 73 });
    assert!(result.output.is_empty());
}

#[test]
fn static_elf_write_is_captured_before_exit() {
    const ADDRESS: u64 = 0x10_0000;
    const MESSAGE: &[u8] = b"minisandbox\n";
    let mut code = Vec::new();
    code.extend([0xb8, 1, 0, 0, 0]); // mov eax, SYS_write
    code.extend([0xbf, 1, 0, 0, 0]); // mov edi, STDOUT_FILENO
    let message_address = ADDRESS + 41;
    code.extend([0x48, 0xbe]); // mov rsi, imm64
    code.extend(message_address.to_le_bytes());
    code.extend([0xba, 12, 0, 0, 0]); // mov edx, 12
    code.extend([0x0f, 0x05]); // syscall
    code.extend([0xb8, 60, 0, 0, 0]); // mov eax, SYS_exit
    code.extend([0xbf, 73, 0, 0, 0]); // mov edi, 73
    code.extend([0x0f, 0x05, 0x0f, 0x0b]); // syscall; ud2
    assert_eq!(code.len(), 41);
    code.extend(MESSAGE);

    let program = Program::parse_elf(&minimal_elf(&code)).expect("fixture ELF is valid");
    let engine = Engine::open().expect("the designated host exposes PVM");

    let result = engine.run(&program).expect("the guest run succeeds");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 73 });
    assert_eq!(result.output, MESSAGE);
}

#[test]
fn unsupported_syscall_returns_enosys_and_resumes_user_code() {
    let code = [
        0xb8, 0xe7, 0x03, 0, 0, // mov eax, 999
        0x0f, 0x05, // syscall
        0xb8, 60, 0, 0, 0, // mov eax, SYS_exit
        0xbf, 73, 0, 0, 0, // mov edi, 73
        0x0f, 0x05, 0x0f, 0x0b, // syscall; ud2
    ];
    let program = Program::parse_elf(&minimal_elf(&code)).expect("fixture ELF is valid");
    let engine = Engine::open().expect("the designated host exposes PVM");

    let result = engine.run(&program).expect("the guest run succeeds");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 73 });
}

#[test]
fn pure_compute_guest_is_preempted_by_the_monotonic_timeout() {
    let spin = [0xeb, 0xfe]; // jmp $
    let program = Program::parse_elf(&minimal_elf(&spin)).expect("fixture ELF is valid");
    let engine = Engine::open().expect("the designated host exposes PVM");
    let started = Instant::now();

    let result = engine
        .run_with_options(
            &program,
            RunOptions {
                timeout: Duration::from_millis(50),
            },
        )
        .expect("timeout is a typed guest outcome");

    assert_eq!(result.outcome, RunOutcome::TimedOut);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "50ms PVM preemption exceeded the one-second wall-clock gate"
    );
}

#[test]
fn guest_write_to_read_only_elf_segment_faults() {
    let mut code = vec![0x48, 0xb8]; // mov rax, imm64
    code.extend(0x11_0000_u64.to_le_bytes());
    code.extend([0x48, 0xc7, 0x00, 0, 0, 0, 0]); // mov qword ptr [rax], 0
    code.extend([0xb8, 60, 0, 0, 0]); // mov eax, SYS_exit
    code.extend([0xbf, 73, 0, 0, 0]); // mov edi, 73
    code.extend([0x0f, 0x05]); // syscall
    let program =
        Program::parse_elf(&elf_with_read_only_data(&code)).expect("fixture ELF is valid");
    let engine = Engine::open().expect("the designated host exposes PVM");

    let result = engine
        .run(&program)
        .expect("guest fault is a typed outcome");

    assert_eq!(result.outcome, RunOutcome::GuestFault);
}

#[test]
fn vector_zero_event_is_not_misclassified_as_a_syscall() {
    let divide_by_zero = [
        0x31, 0xd2, // xor edx, edx
        0xb8, 1, 0, 0, 0, // mov eax, 1
        0x48, 0xf7, 0xf2, // div rdx
    ];
    let program = Program::parse_elf(&minimal_elf(&divide_by_zero)).expect("fixture ELF is valid");
    let engine = Engine::open().expect("the designated host exposes PVM");

    let result = engine
        .run(&program)
        .expect("divide error is a typed guest fault");

    assert_eq!(result.outcome, RunOutcome::GuestFault);
}
