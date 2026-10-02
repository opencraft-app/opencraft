//! Builds ordinary compiler-produced ELF and pinned `QuickJS` live PVM guests.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

const QUICKJS_SOURCES: &[&str] = &[
    "quickjs.c",
    "dtoa.c",
    "libregexp.c",
    "libunicode.c",
    "cutils.c",
];

fn main() {
    println!("cargo:rerun-if-changed=../guest/quickjs/actor_guest.c");
    println!("cargo:rerun-if-changed=../guest/elf/static_process.c");
    println!("cargo:rerun-if-changed=../guest/elf/simple_cpp.cpp");
    println!("cargo:rerun-if-changed=../guest/elf/simple_rust.rs");
    println!("cargo:rerun-if-changed=../third_party/quickjs");
    if env::var("TARGET").as_deref() != Ok("x86_64-unknown-linux-gnu") {
        return;
    }

    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let root = manifest.parent().expect("workspace root");
    let quickjs = root.join("third_party/quickjs");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("build output directory"));
    let compiler = env::var("CC").unwrap_or_else(|_| "cc".to_owned());
    let cxx = env::var("CXX").unwrap_or_else(|_| "c++".to_owned());
    let clang = env::var("CLANG").unwrap_or_else(|_| "clang".to_owned());
    let clangxx = env::var("CLANGXX").unwrap_or_else(|_| "clang++".to_owned());
    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_owned());
    let guest = build_quickjs_guest(&compiler, root, &quickjs, &output);
    println!(
        "cargo:rustc-env=MINISANDBOX_QUICKJS_GUEST={}",
        guest.display()
    );
    let static_process = build_static_process(
        &compiler,
        root,
        &output,
        false,
        "minisandbox-static-process",
    );
    println!(
        "cargo:rustc-env=MINISANDBOX_STATIC_PROCESS_GUEST={}",
        static_process.display()
    );
    let static_pie_process = build_static_process(
        &compiler,
        root,
        &output,
        true,
        "minisandbox-static-pie-process",
    );
    println!(
        "cargo:rustc-env=MINISANDBOX_STATIC_PIE_PROCESS_GUEST={}",
        static_pie_process.display()
    );
    let dynamic_process =
        build_dynamic_process(&compiler, root, &output, "minisandbox-dynamic-process");
    println!(
        "cargo:rustc-env=MINISANDBOX_DYNAMIC_PROCESS_GUEST={}",
        dynamic_process.display()
    );
    let dynamic_cpp = build_dynamic_cpp(&cxx, root, &output, "minisandbox-dynamic-cpp");
    println!(
        "cargo:rustc-env=MINISANDBOX_DYNAMIC_CPP_GUEST={}",
        dynamic_cpp.display()
    );
    let clang_static = build_static_process(
        &clang,
        root,
        &output,
        false,
        "minisandbox-clang-static-process",
    );
    println!(
        "cargo:rustc-env=MINISANDBOX_CLANG_STATIC_PROCESS_GUEST={}",
        clang_static.display()
    );
    let clang_static_pie = build_static_process(
        &clang,
        root,
        &output,
        true,
        "minisandbox-clang-static-pie-process",
    );
    println!(
        "cargo:rustc-env=MINISANDBOX_CLANG_STATIC_PIE_PROCESS_GUEST={}",
        clang_static_pie.display()
    );
    let clang_dynamic =
        build_dynamic_process(&clang, root, &output, "minisandbox-clang-dynamic-process");
    println!(
        "cargo:rustc-env=MINISANDBOX_CLANG_DYNAMIC_PROCESS_GUEST={}",
        clang_dynamic.display()
    );
    let clang_dynamic_cpp =
        build_dynamic_cpp(&clangxx, root, &output, "minisandbox-clang-dynamic-cpp");
    println!(
        "cargo:rustc-env=MINISANDBOX_CLANG_DYNAMIC_CPP_GUEST={}",
        clang_dynamic_cpp.display()
    );
    let rust_process = build_rust_process(&rustc, root, &output);
    println!(
        "cargo:rustc-env=MINISANDBOX_RUST_PROCESS_GUEST={}",
        rust_process.display()
    );
}

fn build_quickjs_guest(compiler: &str, root: &Path, quickjs: &Path, output: &Path) -> PathBuf {
    let mut objects = Vec::new();

    for source in QUICKJS_SOURCES {
        let object = output.join(format!("{source}.o"));
        run(
            Command::new(compiler)
                .args([
                    "-std=gnu11",
                    "-O2",
                    "-fwrapv",
                    "-D_GNU_SOURCE",
                    "-DCONFIG_VERSION=\"2026-06-04\"",
                    "-DHAVE_CLOSEFROM",
                    "-Wno-array-bounds",
                    "-Wno-format-truncation",
                    "-Wno-infinite-recursion",
                    "-isystem",
                ])
                .arg(quickjs)
                .arg("-c")
                .arg(quickjs.join(source))
                .arg("-o")
                .arg(&object),
            &format!("compile vendored QuickJS source {source}"),
        );
        objects.push(object);
    }

    let guest = output.join("minisandbox-quickjs-actor-guest");
    let mut link = Command::new(compiler);
    link.args([
        "-std=gnu11",
        "-O2",
        "-fno-pie",
        "-no-pie",
        "-static",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wl,--build-id=none",
        "-isystem",
    ])
    .arg(quickjs)
    .arg(root.join("guest/quickjs/actor_guest.c"));
    link.args(&objects)
        .args(["-lm", "-ldl", "-lpthread", "-o"])
        .arg(&guest);
    run(&mut link, "link the static QuickJS actor guest");

    let strip = env::var("STRIP").unwrap_or_else(|_| "strip".to_owned());
    run(
        Command::new(strip).arg("--strip-all").arg(&guest),
        "strip the QuickJS actor guest",
    );
    let length = fs::metadata(&guest)
        .expect("stat the QuickJS actor guest")
        .len();
    assert!(length > 256 * 1024, "QuickJS guest is unexpectedly small");
    assert!(
        length < 4 * 1024 * 1024,
        "QuickJS guest exceeds the 4 MiB gate"
    );
    guest
}

fn build_static_process(
    compiler: &str,
    root: &Path,
    output: &Path,
    pie: bool,
    name: &str,
) -> PathBuf {
    let guest = output.join(name);
    let mut command = Command::new(compiler);
    command.args(["-std=c11", "-O2"]);
    if pie {
        command.args(["-fPIE", "-static-pie"]);
    } else {
        command.args(["-static", "-no-pie"]);
    }
    command
        .args(["-Wall", "-Wextra", "-Werror", "-Wl,--build-id=none"])
        .arg(root.join("guest/elf/static_process.c"))
        .arg("-o")
        .arg(&guest);
    if compiler.contains("clang") {
        command.arg("-Wno-unused-command-line-argument");
    }
    let description = if pie {
        "build the ordinary static PIE C process guest"
    } else {
        "build the ordinary static C process guest"
    };
    run(&mut command, description);
    guest
}

fn build_dynamic_process(compiler: &str, root: &Path, output: &Path, name: &str) -> PathBuf {
    let guest = output.join(name);
    run(
        Command::new(compiler)
            .args([
                "-std=c11",
                "-O2",
                "-fPIE",
                "-pie",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-Wl,--build-id=none",
            ])
            .arg(root.join("guest/elf/static_process.c"))
            .arg("-o")
            .arg(&guest),
        "build the ordinary dynamically linked PIE process guest",
    );
    guest
}

fn build_dynamic_cpp(compiler: &str, root: &Path, output: &Path, name: &str) -> PathBuf {
    let guest = output.join(name);
    run(
        Command::new(compiler)
            .args([
                "-std=c++17",
                "-O2",
                "-fPIE",
                "-pie",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-Wl,--build-id=none",
            ])
            .arg(root.join("guest/elf/simple_cpp.cpp"))
            .arg("-o")
            .arg(&guest),
        "build the ordinary dynamically linked C++ process guest",
    );
    guest
}

fn build_rust_process(compiler: &str, root: &Path, output: &Path) -> PathBuf {
    let guest = output.join("minisandbox-rust-process");
    run(
        Command::new(compiler)
            .args([
                "--edition=2021",
                "-C",
                "opt-level=2",
                "-C",
                "panic=abort",
                "-C",
                "strip=symbols",
            ])
            .arg(root.join("guest/elf/simple_rust.rs"))
            .arg("-o")
            .arg(&guest),
        "build the ordinary Rust process guest",
    );
    guest
}

fn run(command: &mut Command, description: &str) {
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("cannot {description}: {error}"));
    assert!(status.success(), "cannot {description}: {status}");
}
