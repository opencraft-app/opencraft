//! Live conformance for unmodified simple ELF programs from the designated host.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_core::{
    engine::{Engine, ProcessFile, RunOutcome},
    program::Program,
};

fn load(path: &str) -> Program {
    let bytes = std::fs::read(path).expect("the designated host provides the system ELF");
    Program::parse_elf(&bytes).expect("the unmodified system ELF satisfies the loader")
}

#[test]
fn unmodified_system_true_runs() {
    let program = load("/usr/bin/true");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(&program, &[b"/usr/bin/true"], &[], &[])
        .expect("the unmodified system true ELF runs inside PVM");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 0 });
    assert!(result.output.is_empty());
}

#[test]
fn unmodified_system_printf_receives_arguments() {
    let program = load("/usr/bin/printf");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(
            &program,
            &[b"/usr/bin/printf", b"system-elf:%s\\n", b"ok"],
            &[b"LC_ALL=C"],
            &[],
        )
        .expect("the unmodified system printf ELF runs inside PVM");

    assert_eq!(
        result.outcome,
        RunOutcome::Exited { code: 0 },
        "printf output: {}",
        String::from_utf8_lossy(&result.output)
    );
    assert_eq!(result.output, b"system-elf:ok\n");
}

#[test]
fn unmodified_system_sha256sum_streams_stdin() {
    let program = load("/usr/bin/sha256sum");
    let crypto = std::fs::read("/lib64/libcrypto.so.3")
        .expect("the designated runtime bundle provides libcrypto");
    let zlib =
        std::fs::read("/lib64/libz.so.1").expect("the designated runtime bundle provides zlib");
    let files = [
        ProcessFile {
            path: b"/lib64/libcrypto.so.3",
            bytes: &crypto,
        },
        ProcessFile {
            path: b"/lib64/libz.so.1",
            bytes: &zlib,
        },
    ];
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process_with_files(
            &program,
            &[b"/usr/bin/sha256sum"],
            &[b"LC_ALL=C"],
            b"abc",
            &files,
        )
        .expect("the unmodified system sha256sum ELF runs inside PVM");

    assert_eq!(
        result.outcome,
        RunOutcome::Exited { code: 0 },
        "sha256sum output: {}",
        String::from_utf8_lossy(&result.output)
    );
    assert_eq!(
        result.output,
        b"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n"
    );
}
