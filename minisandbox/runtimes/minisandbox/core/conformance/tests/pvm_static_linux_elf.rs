//! Live conformance for an ordinary compiler-produced static Linux ELF.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_core::{
    engine::{Engine, EngineError, RunOutcome},
    program::Program,
};

#[test]
fn ordinary_static_c_process_runs_with_linux_startup_contract() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("ordinary static C ELF runs through the generic process path");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 37 });
    assert_eq!(result.output, b"ordinary-static-c\n");
}

#[test]
fn ordinary_static_c_process_receives_arguments_environment_and_stdin() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(
            &program,
            &[b"custom-program", b"alpha", b"beta"],
            &[b"MODE=conformance"],
            b"input-42\n",
        )
        .expect("the generic process receives its complete input contract");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 38 });
    assert_eq!(result.output, b"args-env-stdin\n");
}

#[test]
fn ordinary_static_pie_process_runs_at_a_safe_load_bias() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PIE_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static PIE C ELF");
    let program = Program::parse_elf(&bytes).expect("static PIE ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("ordinary static PIE C ELF runs through the generic process path");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 37 });
    assert_eq!(result.output, b"ordinary-static-c\n");
    assert_eq!(result.output, b"ordinary-static-c\n");
}

#[test]
fn ordinary_static_c_process_uses_bounded_anonymous_mmap() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(&program, &[b"custom-program", b"mmap"], &[], &[])
        .expect("ordinary static C ELF reaches a typed mmap outcome");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 39 });
    assert_eq!(result.output, b"anonymous-mmap\n");
}

#[test]
fn anonymous_mapping_permissions_and_unmap_are_enforced() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let engine = Engine::open().expect("the designated host exposes PVM");

    for mode in [b"readonly-mmap".as_slice(), b"munmap-fault".as_slice()] {
        let result = engine
            .run_process(&program, &[b"custom-program", mode], &[], &[])
            .expect("invalid anonymous-page access reaches a typed outcome");
        assert_eq!(result.outcome, RunOutcome::GuestFault, "mode={mode:?}");
    }
}

#[test]
fn anonymous_mapping_can_be_protected_then_unmapped() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(&program, &[b"custom-program", b"mprotect-unmap"], &[], &[])
        .expect("anonymous mapping permission and lifetime changes succeed");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 42 });
    assert_eq!(result.output, b"mprotect-unmap\n");
}

#[test]
fn host_output_capture_cannot_read_supervisor_only_guest_pages() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(
            &program,
            &[b"custom-program", b"host-read-isolation"],
            &[],
            &[],
        )
        .expect("invalid output pointers receive a Linux error");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 43 });
    assert!(result.output.is_empty());
}

#[test]
fn host_input_service_respects_live_user_page_permissions() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(
            &program,
            &[b"custom-program", b"host-write-permissions"],
            &[],
            b"x",
        )
        .expect("host input observes current user PTE permissions");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 44 });
    assert!(result.output.is_empty());
}

#[test]
fn ordinary_static_c_process_observes_sandboxed_system_identity_and_time() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(&program, &[b"custom-program", b"system"], &[], &[])
        .expect("ordinary static C ELF receives sandboxed system services");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 40 });
    assert_eq!(result.output, b"sandbox-system-info\n");
}

#[test]
fn ordinary_dynamic_pie_runs_with_the_controlled_linux_runtime() {
    let bytes = std::fs::read(env!("MINISANDBOX_DYNAMIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary dynamic PIE C ELF");
    let program = Program::parse_elf(&bytes)
        .expect("ordinary dynamic PIE requests the supported Linux interpreter");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("the controlled interpreter and libc run inside PVM");

    assert_eq!(
        result.outcome,
        RunOutcome::Exited { code: 37 },
        "dynamic loader output: {}",
        String::from_utf8_lossy(&result.output)
    );
    assert_eq!(result.output, b"ordinary-static-c\n");
}

#[test]
fn ordinary_dynamic_pie_receives_arguments_environment_and_stdin() {
    let bytes = std::fs::read(env!("MINISANDBOX_DYNAMIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary dynamic PIE C ELF");
    let program = Program::parse_elf(&bytes)
        .expect("ordinary dynamic PIE requests the supported Linux interpreter");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(
            &program,
            &[b"custom-program", b"alpha", b"beta"],
            &[b"MODE=conformance"],
            b"input-42\n",
        )
        .expect("the dynamically linked process receives its complete input contract");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 38 });
    assert_eq!(result.output, b"args-env-stdin\n");
}

#[test]
fn dynamic_interpreter_outside_the_allowlist_is_rejected() {
    const SUPPORTED: &[u8] = b"/lib64/ld-linux-x86-64.so.2";
    const REJECTED: &[u8] = b"/tmp64/ld-linux-x86-64.so.2";
    let mut bytes = std::fs::read(env!("MINISANDBOX_DYNAMIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary dynamic PIE C ELF");
    let offset = bytes
        .windows(SUPPORTED.len())
        .position(|window| window == SUPPORTED)
        .expect("the fixture carries the expected PT_INTERP path");
    bytes[offset..offset + REJECTED.len()].copy_from_slice(REJECTED);
    let program = Program::parse_elf(&bytes).expect("the replacement interpreter is valid ELF");

    assert!(matches!(
        Engine::open()
            .expect("the designated host exposes PVM")
            .run(&program),
        Err(EngineError::UnsupportedInterpreter)
    ));
}

#[test]
fn generic_process_inputs_are_rejected_before_unbounded_host_copies() {
    let bytes = std::fs::read(env!("MINISANDBOX_STATIC_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary static C ELF");
    let program = Program::parse_elf(&bytes).expect("ordinary static C ELF satisfies the loader");
    let engine = Engine::open().expect("the designated host exposes PVM");

    assert!(matches!(
        engine.run_process(&program, &[b"bad\0argument"], &[], &[]),
        Err(EngineError::InvalidProcessInput)
    ));
    let oversized_stdin = vec![0_u8; 1024 * 1024 + 1];
    assert!(matches!(
        engine.run_process(&program, &[b"/minisandbox/program"], &[], &oversized_stdin,),
        Err(EngineError::ProcessInputTooLarge)
    ));
}
