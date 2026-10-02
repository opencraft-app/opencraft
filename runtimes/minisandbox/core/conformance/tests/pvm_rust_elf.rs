//! Live conformance for an ordinary rustc-produced Linux ELF.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_core::{
    engine::{Engine, RunOutcome},
    program::Program,
};

#[test]
fn ordinary_rust_process_runs_with_the_linux_process_contract() {
    let bytes = std::fs::read(env!("MINISANDBOX_RUST_PROCESS_GUEST"))
        .expect("the conformance build produced the ordinary Rust ELF");
    let program = Program::parse_elf(&bytes).expect("the Rust ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("the Rust process reaches a typed PVM outcome");

    assert_eq!(
        result.outcome,
        RunOutcome::Exited { code: 46 },
        "Rust process output: {}",
        String::from_utf8_lossy(&result.output)
    );
    assert_eq!(result.output, b"ordinary-rust\n");
}
