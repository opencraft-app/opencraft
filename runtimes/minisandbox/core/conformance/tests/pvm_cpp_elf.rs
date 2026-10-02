//! Live conformance for an ordinary compiler-produced dynamic C++ ELF.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_core::{
    engine::{Engine, RunOutcome},
    program::Program,
};

#[test]
fn ordinary_dynamic_cpp_runs_with_controlled_standard_library_dependencies() {
    let bytes = std::fs::read(env!("MINISANDBOX_DYNAMIC_CPP_GUEST"))
        .expect("the conformance build produced the ordinary dynamic C++ ELF");
    let program =
        Program::parse_elf(&bytes).expect("ordinary dynamic C++ ELF satisfies the loader");
    let result = Engine::open()
        .expect("the designated host exposes PVM")
        .run(&program)
        .expect("the controlled C++ runtime executes inside PVM");

    assert_eq!(
        result.outcome,
        RunOutcome::Exited { code: 45 },
        "dynamic loader output: {}",
        String::from_utf8_lossy(&result.output)
    );
    assert_eq!(result.output, b"ordinary-dynamic-cpp\n");
}
