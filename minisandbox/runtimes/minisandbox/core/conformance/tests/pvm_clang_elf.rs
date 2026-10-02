//! Live ELF compatibility matrix produced by the host Clang toolchain.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_core::{
    engine::{Engine, RunOutcome},
    program::Program,
};

fn load(path: &str) -> Program {
    let bytes = std::fs::read(path).expect("the conformance build produced the Clang ELF");
    Program::parse_elf(&bytes).expect("the Clang ELF satisfies the loader")
}

#[test]
fn clang_static_exec_runs() {
    let program = load(env!("MINISANDBOX_CLANG_STATIC_PROCESS_GUEST"));
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("the Clang static ELF runs inside PVM");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 37 });
    assert_eq!(result.output, b"ordinary-static-c\n");
}

#[test]
fn clang_static_pie_runs() {
    let program = load(env!("MINISANDBOX_CLANG_STATIC_PIE_PROCESS_GUEST"));
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("the Clang static PIE runs inside PVM");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 37 });
    assert_eq!(result.output, b"ordinary-static-c\n");
}

#[test]
fn clang_dynamic_c_receives_process_inputs() {
    let program = load(env!("MINISANDBOX_CLANG_DYNAMIC_PROCESS_GUEST"));
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run_process(
            &program,
            &[b"custom-program", b"alpha", b"beta"],
            &[b"MODE=conformance"],
            b"input-42\n",
        )
        .expect("the Clang dynamic C ELF runs inside PVM");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 38 });
    assert_eq!(result.output, b"args-env-stdin\n");
}

#[test]
fn clang_dynamic_cpp_runs() {
    let program = load(env!("MINISANDBOX_CLANG_DYNAMIC_CPP_GUEST"));
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("the Clang dynamic C++ ELF runs inside PVM");

    assert_eq!(result.outcome, RunOutcome::Exited { code: 45 });
    assert_eq!(result.output, b"ordinary-dynamic-cpp\n");
}
