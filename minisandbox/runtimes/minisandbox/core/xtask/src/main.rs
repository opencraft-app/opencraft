//! Repository maintenance commands.

use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

const PVM_LINUX_REPOSITORY: &str = "loopholelabs/linux-pvm";
const PVM_LINUX_COMMIT: &str = "51ee0edb884b3372c168f58244de58507c99b2f7";
const PVM_LINUX_ARCHIVE_SHA256: &str =
    "cf5e3a36119472d604de5d2207400a1c281ecd6c65fb5d0a88172ead19eaf1d9";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["header"] => header(false),
        ["header", "--check"] => header(true),
        ["audit"] => audit(),
        ["unsafe-audit"] => unsafe_audit(&workspace_root()?),
        ["loc"] => print_loc(&workspace_root()?),
        ["macro-check"] => check_macro_expansion(&workspace_root()?),
        ["c-check"] => c_check(),
        ["c-smoke"] => c_smoke(),
        ["static-release"] => static_release(&workspace_root()?),
        ["pvm-linux", "prepare"] => pvm_linux_prepare(&workspace_root()?),
        ["pvm-linux", "configure"] => pvm_linux_configure(&workspace_root()?),
        ["pvm-linux", "build"] => pvm_linux_build(&workspace_root()?),
        ["pvm-linux", "initramfs"] => pvm_linux_initramfs(&workspace_root()?),
        _ => Err(
            "usage: cargo xtask <header [--check] | audit | unsafe-audit | loc | macro-check | c-check | c-smoke | static-release | pvm-linux <prepare|configure|build|initramfs>>"
                .into(),
        ),
    }
}

fn static_release(root: &Path) -> Result<(), String> {
    const TARGET: &str = "x86_64-unknown-linux-musl";
    command_success(
        Command::new("cargo")
            .args([
                "build",
                "--locked",
                "--release",
                "--target",
                TARGET,
                "--package",
                "minisandbox-init",
                "--bin",
                "minisandbox-init",
                "--package",
                "minisandbox-cli",
                "--bin",
                "minisandbox",
                "--package",
                "pvm-console",
                "--bin",
                "pvm-console",
            ])
            .current_dir(root),
        "build static musl release executables",
    )?;
    for name in ["minisandbox-init", "minisandbox", "pvm-console"] {
        let path = root.join("target").join(TARGET).join("release").join(name);
        validate_static_elf(&path)?;
        let size = fs::metadata(&path)
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?
            .len();
        println!("static release: READY {} ({size} bytes)", path.display());
    }
    Ok(())
}

fn validate_static_elf(path: &Path) -> Result<(), String> {
    const PT_DYNAMIC: u32 = 2;
    const PT_INTERP: u32 = 3;
    const DT_NULL: i64 = 0;
    const DT_NEEDED: i64 = 1;

    let bytes =
        fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if bytes.get(..6) != Some(&[0x7f, b'E', b'L', b'F', 2, 1])
        || !matches!(read_u16_le(&bytes, 16)?, 2 | 3)
        || read_u16_le(&bytes, 18)? != 62
    {
        return Err(format!(
            "{} is not a little-endian x86-64 ELF executable",
            path.display()
        ));
    }
    let program_offset = usize::try_from(read_u64_le(&bytes, 32)?)
        .map_err(|_| format!("{} program offset exceeds usize", path.display()))?;
    let entry_size = usize::from(read_u16_le(&bytes, 54)?);
    let entry_count = usize::from(read_u16_le(&bytes, 56)?);
    if entry_size < 56 || entry_count == 0 {
        return Err(format!("{} has an invalid program table", path.display()));
    }
    for index in 0..entry_count {
        let offset = program_offset
            .checked_add(
                index
                    .checked_mul(entry_size)
                    .ok_or_else(|| format!("{} program table overflow", path.display()))?,
            )
            .ok_or_else(|| format!("{} program table overflow", path.display()))?;
        let segment_type = read_u32_le(&bytes, offset)?;
        if segment_type == PT_INTERP {
            return Err(format!(
                "{} contains PT_INTERP and is dynamically launched",
                path.display()
            ));
        }
        if segment_type != PT_DYNAMIC {
            continue;
        }
        let dynamic_offset_field = offset
            .checked_add(8)
            .ok_or_else(|| format!("{} program table overflow", path.display()))?;
        let dynamic_size_field = offset
            .checked_add(32)
            .ok_or_else(|| format!("{} program table overflow", path.display()))?;
        let dynamic_offset = usize::try_from(read_u64_le(&bytes, dynamic_offset_field)?)
            .map_err(|_| format!("{} dynamic offset exceeds usize", path.display()))?;
        let dynamic_size = usize::try_from(read_u64_le(&bytes, dynamic_size_field)?)
            .map_err(|_| format!("{} dynamic size exceeds usize", path.display()))?;
        let dynamic = bytes
            .get(
                dynamic_offset
                    ..dynamic_offset
                        .checked_add(dynamic_size)
                        .ok_or_else(|| format!("{} dynamic table overflow", path.display()))?,
            )
            .ok_or_else(|| format!("{} has a truncated dynamic table", path.display()))?;
        if dynamic.len() % 16 != 0 {
            return Err(format!("{} has a misaligned dynamic table", path.display()));
        }
        let mut terminated = false;
        for entry in dynamic.chunks_exact(16) {
            let tag = i64::from_le_bytes(entry[..8].try_into().expect("fixed dynamic tag"));
            if tag == DT_NEEDED {
                return Err(format!(
                    "{} contains DT_NEEDED and depends on a shared library",
                    path.display()
                ));
            }
            if tag == DT_NULL {
                terminated = true;
                break;
            }
        }
        if !terminated {
            return Err(format!(
                "{} has an unterminated dynamic table",
                path.display()
            ));
        }
    }
    Ok(())
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let end = offset
        .checked_add(2)
        .ok_or_else(|| "ELF u16 offset overflow".to_owned())?;
    bytes
        .get(offset..end)
        .ok_or_else(|| "truncated ELF u16".to_owned())?
        .try_into()
        .map(u16::from_le_bytes)
        .map_err(|_| "invalid ELF u16".to_owned())
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| "ELF u32 offset overflow".to_owned())?;
    bytes
        .get(offset..end)
        .ok_or_else(|| "truncated ELF u32".to_owned())?
        .try_into()
        .map(u32::from_le_bytes)
        .map_err(|_| "invalid ELF u32".to_owned())
}

fn read_u64_le(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| "ELF u64 offset overflow".to_owned())?;
    bytes
        .get(offset..end)
        .ok_or_else(|| "truncated ELF u64".to_owned())?
        .try_into()
        .map(u64::from_le_bytes)
        .map_err(|_| "invalid ELF u64".to_owned())
}

struct PvmLinuxLayout {
    root: PathBuf,
    source: PathBuf,
    build: PathBuf,
    archive: PathBuf,
}

impl PvmLinuxLayout {
    fn new(workspace: &Path) -> Self {
        let root = workspace.join("target/pvm-linux");
        Self {
            source: root.join("source"),
            build: root.join("build"),
            archive: root.join(format!("linux-{PVM_LINUX_COMMIT}.tar.gz")),
            root,
        }
    }
}

fn pvm_linux_prepare(workspace: &Path) -> Result<(), String> {
    let layout = PvmLinuxLayout::new(workspace);
    fs::create_dir_all(&layout.root)
        .map_err(|error| format!("cannot create {}: {error}", layout.root.display()))?;
    let marker = layout.source.join(".minisandbox-pvm-linux-commit");
    if marker.exists() && layout.source.join("Makefile").is_file() {
        let value = fs::read_to_string(&marker)
            .map_err(|error| format!("cannot read {}: {error}", marker.display()))?;
        if value.trim() == PVM_LINUX_COMMIT {
            println!("PVM Linux source: READY ({})", layout.source.display());
            return Ok(());
        }
        return Err(format!(
            "{} contains a different pinned source; move it aside explicitly",
            layout.source.display()
        ));
    }
    if layout.source.exists() {
        return Err(format!(
            "{} is incomplete; move it aside explicitly before retrying",
            layout.source.display()
        ));
    }
    if !layout.archive.exists() {
        let url =
            format!("https://github.com/{PVM_LINUX_REPOSITORY}/archive/{PVM_LINUX_COMMIT}.tar.gz");
        command_success(
            Command::new("curl")
                .args([
                    "--http1.1",
                    "--fail",
                    "--location",
                    "--retry",
                    "5",
                    "--output",
                ])
                .arg(&layout.archive)
                .arg(url),
            "download pinned PVM Linux source",
        )?;
    }
    verify_sha256(&layout.archive, PVM_LINUX_ARCHIVE_SHA256)?;
    fs::create_dir(&layout.source)
        .map_err(|error| format!("cannot create {}: {error}", layout.source.display()))?;
    command_success(
        Command::new("tar")
            .args(["-xzf"])
            .arg(&layout.archive)
            .args(["--strip-components=1", "-C"])
            .arg(&layout.source),
        "extract pinned PVM Linux source",
    )?;
    fs::write(&marker, format!("{PVM_LINUX_COMMIT}\n"))
        .map_err(|error| format!("cannot write {}: {error}", marker.display()))?;
    println!("PVM Linux source: READY ({})", layout.source.display());
    Ok(())
}

fn pvm_linux_configure(workspace: &Path) -> Result<(), String> {
    pvm_linux_prepare(workspace)?;
    let layout = PvmLinuxLayout::new(workspace);
    fs::create_dir_all(&layout.build)
        .map_err(|error| format!("cannot create {}: {error}", layout.build.display()))?;
    command_success(
        Command::new("make")
            .arg(format!("O={}", layout.build.display()))
            .arg("allnoconfig")
            .current_dir(&layout.source),
        "create minimal Linux config baseline",
    )?;
    install_pvm_linux_overlay(workspace, &layout)?;
    command_success(
        Command::new(layout.source.join("scripts/kconfig/merge_config.sh"))
            .args(["-m", "-O"])
            .arg(&layout.build)
            .arg(layout.build.join(".config"))
            .arg(workspace.join("guest/pvm-linux/minisandbox.config"))
            .current_dir(&layout.source),
        "merge minimal minisandbox PVM Linux config",
    )?;
    command_success(
        Command::new("make")
            .arg(format!("O={}", layout.build.display()))
            .arg("olddefconfig")
            .current_dir(&layout.source),
        "normalize pinned PVM guest config",
    )?;
    println!("PVM Linux config: READY ({})", layout.build.display());
    Ok(())
}

fn install_pvm_linux_overlay(workspace: &Path, layout: &PvmLinuxLayout) -> Result<(), String> {
    apply_pvm_linux_patch(
        &layout.source,
        &workspace
            .join("guest/pvm-linux/patches/0001-map-decompression-output-before-pvm-events.patch"),
        "arch/x86/boot/compressed/misc.c",
        "minisandbox: initialize_identity_maps() replaced the bootloader's",
    )?;
    apply_pvm_linux_patch(
        &layout.source,
        &workspace.join("guest/pvm-linux/patches/0002-register-pmem-resources-without-pci.patch"),
        "arch/x86/kernel/setup.c",
        "minisandbox: PVM guests deliberately omit PCI",
    )?;
    apply_pvm_linux_patch(
        &layout.source,
        &workspace
            .join("guest/pvm-linux/patches/0003-publish-pvm-idle-deadline-to-minisandbox.patch"),
        "arch/x86/kernel/pvm.c",
        "minisandbox_wait_until_enabled",
    )?;
    apply_pvm_linux_patch(
        &layout.source,
        &workspace
            .join("guest/pvm-linux/patches/0004-expose-native-inet-kernel-socket-factory.patch"),
        "net/ipv4/af_inet.c",
        "inet_create_kern_socket",
    )?;
    let driver = layout.source.join("drivers/virt/minisandbox_guest.c");
    fs::copy(
        workspace.join("guest/pvm-linux/minisandbox_guest.c"),
        &driver,
    )
    .map_err(|error| format!("cannot install {}: {error}", driver.display()))?;

    install_minisandbox_guest_kconfig(&layout.source.join("drivers/virt/Kconfig"))?;
    append_once(
        &layout.source.join("drivers/virt/Makefile"),
        "CONFIG_MINISANDBOX_GUEST",
        "obj-$(CONFIG_MINISANDBOX_GUEST) += minisandbox_guest.o\n",
    )?;
    install_pvm_socket_overlay(workspace, &layout.source)
}

fn install_pvm_socket_overlay(workspace: &Path, source: &Path) -> Result<(), String> {
    let guest = workspace.join("socket-service/guest");
    let destination = source.join("net/pvm_socket");
    fs::create_dir_all(&destination)
        .map_err(|error| format!("cannot create {}: {error}", destination.display()))?;
    for file in [
        "Kconfig",
        "Makefile",
        "pvm_socket.c",
        "pvm_socket_abi.h",
        "pvm_socket_local.c",
        "pvm_socket_local.h",
    ] {
        fs::copy(guest.join(file), destination.join(file)).map_err(|error| {
            format!(
                "cannot install PVM socket file {}: {error}",
                destination.join(file).display()
            )
        })?;
    }
    insert_after_once(
        &source.join("net/Kconfig"),
        "source \"net/pvm_socket/Kconfig\"",
        "if NET\n",
        "\nsource \"net/pvm_socket/Kconfig\"\n",
    )?;
    append_once(
        &source.join("net/Makefile"),
        "CONFIG_PVM_SOCKET",
        "obj-$(CONFIG_PVM_SOCKET)\t\t+= pvm_socket/\n",
    )
}

fn insert_after_once(
    path: &Path,
    marker: &str,
    anchor: &str,
    addition: &str,
) -> Result<(), String> {
    let mut contents = fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if contents.contains(marker) {
        return Ok(());
    }
    let index = contents.find(anchor).ok_or_else(|| {
        format!(
            "cannot find insertion anchor {anchor:?} in {}",
            path.display()
        )
    })? + anchor.len();
    contents.insert_str(index, addition);
    fs::write(path, contents).map_err(|error| format!("cannot update {}: {error}", path.display()))
}

fn install_minisandbox_guest_kconfig(path: &Path) -> Result<(), String> {
    const MARKER: &str = "config MINISANDBOX_GUEST";
    const LEGACY: &str = "config MINISANDBOX_GUEST\n\tbool \"minisandbox PVM guest checkpoint control\"\n\tdepends on PVM_GUEST\n\tdefault y\n\thelp\n\t  Expose /dev/minisandbox so a guest process can publish a typed,\n\t  single-vCPU warm-checkpoint boundary to the minisandbox runtime.\n";
    const CURRENT: &str = "config MINISANDBOX_GUEST\n\tbool \"minisandbox PVM guest checkpoint and page-report control\"\n\tdepends on PVM_GUEST\n\tselect PAGE_REPORTING\n\tdefault y\n\thelp\n\t  Publish a typed, single-vCPU warm-checkpoint boundary and report\n\t  buddy-free clone RAM so the minisandbox runtime can discard COW pages.\n";

    let mut contents = fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if contents.contains(CURRENT) {
        return Ok(());
    }
    if contents.contains(LEGACY) {
        contents = contents.replacen(LEGACY, CURRENT, 1);
    } else if contents.contains(MARKER) {
        return Err(format!(
            "{} contains an unknown minisandbox Kconfig stanza",
            path.display()
        ));
    } else {
        if !contents.ends_with('\n') {
            contents.push('\n');
        }
        contents.push('\n');
        contents.push_str(CURRENT);
    }
    fs::write(path, contents).map_err(|error| format!("cannot update {}: {error}", path.display()))
}

fn apply_pvm_linux_patch(
    source: &Path,
    patch: &Path,
    relative_target: &str,
    marker: &str,
) -> Result<(), String> {
    let target = source.join(relative_target);
    let contents = fs::read_to_string(&target)
        .map_err(|error| format!("cannot read {}: {error}", target.display()))?;
    if contents.contains(marker) {
        return Ok(());
    }
    command_success(
        Command::new("patch")
            .args(["--batch", "--forward", "-p1", "-i"])
            .arg(patch)
            .current_dir(source),
        "apply pinned PVM Linux early-boot patch",
    )
}

fn append_once(path: &Path, marker: &str, addition: &str) -> Result<(), String> {
    let mut contents = fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if contents.contains(marker) {
        return Ok(());
    }
    if !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(addition);
    fs::write(path, contents).map_err(|error| format!("cannot update {}: {error}", path.display()))
}

fn pvm_linux_build(workspace: &Path) -> Result<(), String> {
    pvm_linux_configure(workspace)?;
    let layout = PvmLinuxLayout::new(workspace);
    let jobs = std::thread::available_parallelism()
        .map_or(1, std::num::NonZero::get)
        .min(4);
    command_success(
        Command::new("make")
            .arg(format!("O={}", layout.build.display()))
            .arg(format!("-j{jobs}"))
            .arg("bzImage")
            .current_dir(&layout.source),
        "build PVM Linux bzImage",
    )?;
    println!(
        "PVM Linux kernel: READY ({})",
        layout.build.join("arch/x86/boot/bzImage").display()
    );
    Ok(())
}

fn pvm_linux_initramfs(workspace: &Path) -> Result<(), String> {
    let layout = PvmLinuxLayout::new(workspace);
    let root = layout.root.join("initramfs-root");
    fs::create_dir_all(&root)
        .map_err(|error| format!("cannot create {}: {error}", root.display()))?;
    let init = root.join("init");
    let compiler = env::var("CC").unwrap_or_else(|_| "cc".into());
    command_success(
        Command::new(compiler)
            .args([
                "-static", "-Os", "-s", "-std=c17", "-Wall", "-Wextra", "-Werror",
            ])
            .arg(workspace.join("guest/pvm-linux/init.c"))
            .arg("-o")
            .arg(&init),
        "compile PVM Linux smoke init",
    )?;
    let init_bytes = fs::read(&init)
        .map_err(|error| format!("cannot read compiled init {}: {error}", init.display()))?;
    let mut archive = Vec::new();
    append_newc_entry(&mut archive, "init", 0o100_755, &init_bytes)?;
    append_newc_entry(&mut archive, "TRAILER!!!", 0, &[])?;
    let output = layout.root.join("minisandbox-initramfs.cpio");
    fs::write(&output, archive)
        .map_err(|error| format!("cannot write {}: {error}", output.display()))?;
    println!("PVM Linux initramfs: READY ({})", output.display());
    Ok(())
}

fn append_newc_entry(
    archive: &mut Vec<u8>,
    name: &str,
    mode: u32,
    contents: &[u8],
) -> Result<(), String> {
    let name_size = name
        .len()
        .checked_add(1)
        .ok_or_else(|| "cpio name length overflow".to_owned())?;
    let header = format!(
        "070701{ino:08x}{mode:08x}{uid:08x}{gid:08x}{nlink:08x}{mtime:08x}{size:08x}{devmajor:08x}{devminor:08x}{rdevmajor:08x}{rdevminor:08x}{namesize:08x}{check:08x}",
        ino = 1,
        uid = 0,
        gid = 0,
        nlink = 1,
        mtime = 0,
        size = contents.len(),
        devmajor = 0,
        devminor = 0,
        rdevmajor = 0,
        rdevminor = 0,
        namesize = name_size,
        check = 0,
    );
    if header.len() != 110 {
        return Err("internal newc header length mismatch".to_owned());
    }
    archive
        .write_all(header.as_bytes())
        .and_then(|()| archive.write_all(name.as_bytes()))
        .and_then(|()| archive.write_all(&[0]))
        .map_err(|error| format!("cannot assemble initramfs: {error}"))?;
    pad_to_four(archive);
    archive
        .write_all(contents)
        .map_err(|error| format!("cannot assemble initramfs contents: {error}"))?;
    pad_to_four(archive);
    Ok(())
}

fn pad_to_four(bytes: &mut Vec<u8>) {
    while !bytes.len().is_multiple_of(4) {
        bytes.push(0);
    }
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let output = Command::new("sha256sum")
        .arg(path)
        .output()
        .map_err(|error| format!("cannot hash {}: {error}", path.display()))?;
    if !output.status.success() {
        return Err(format!("sha256sum failed for {}", path.display()));
    }
    let actual = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_owned();
    if actual != expected {
        return Err(format!(
            "SHA-256 mismatch for {}: expected {expected}, got {actual}",
            path.display()
        ));
    }
    Ok(())
}

fn c_check() -> Result<(), String> {
    let root = workspace_root()?;
    header(true)?;
    for compiler in ["gcc", "clang"] {
        command_success(
            Command::new(compiler).arg("--version").current_dir(&root),
            &format!("locate {compiler}"),
        )?;
        for standard in ["c11", "c17"] {
            command_success(
                Command::new(compiler)
                    .args([
                        &format!("-std={standard}"),
                        "-Wall",
                        "-Wextra",
                        "-Werror",
                        "-pedantic",
                        "-Iinclude",
                        "-fsyntax-only",
                        "conformance/c/phase1_smoke.c",
                    ])
                    .current_dir(&root),
                &format!("{compiler} {standard} C ABI compile"),
            )?;
            println!("C compile: PASS ({compiler}, {standard})");
        }
    }
    Ok(())
}

fn c_smoke() -> Result<(), String> {
    let root = workspace_root()?;
    c_check()?;
    command_success(
        Command::new("cargo")
            .args(["build", "--package", "minisandbox-capi"])
            .current_dir(&root),
        "build minisandbox static library",
    )?;
    let output_directory = root.join("target/c-smoke");
    fs::create_dir_all(&output_directory).map_err(|error| {
        format!(
            "cannot create C smoke directory {}: {error}",
            output_directory.display()
        )
    })?;
    let executable = output_directory.join("minisandbox-phase1-smoke");
    let compiler = env::var("CC").unwrap_or_else(|_| "cc".into());
    command_success(
        Command::new(&compiler)
            .args([
                "-std=c17",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-pedantic",
                "-Iinclude",
                "conformance/c/phase1_smoke.c",
                "target/debug/libminisandbox_capi.a",
                "-lpthread",
                "-ldl",
                "-lm",
                "-o",
            ])
            .arg(&executable)
            .current_dir(&root),
        "link real C ABI smoke",
    )?;
    command_success(
        Command::new(&executable).current_dir(&root),
        "run real C ABI smoke",
    )?;
    Ok(())
}

fn command_success(command: &mut Command, description: &str) -> Result<(), String> {
    let status = command
        .status()
        .map_err(|error| format!("cannot {description}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{description} failed with {status}"))
    }
}

fn audit() -> Result<(), String> {
    let root = workspace_root()?;
    unsafe_audit(&root)?;
    print_loc(&root)?;
    check_macro_expansion(&root)?;
    Ok(())
}

fn unsafe_audit(root: &Path) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "crates/minisandbox-capi/src/abi.rs",
        "crates/minisandbox-capi/src/exports.rs",
        "crates/minisandbox-init/src/lib.rs",
        "crates/minisandbox-pvm-sys/src/machine.rs",
        "crates/minisandbox-pvm-sys/src/machine/page_reclaim.rs",
        "crates/minisandbox-pvm-sys/src/machine/timeout.rs",
        "crates/minisandbox-pvm-sys/src/signal.rs",
        "socket-service/src/broker.rs",
        "socket-service/src/layout.rs",
        "socket-service/src/ring.rs",
    ];
    const TOKENS: &[&str] = &[
        "unsafe {",
        "unsafe fn",
        "unsafe extern",
        "unsafe impl",
        "#[unsafe(",
    ];
    let mut files = Vec::new();
    collect_files(&root.join("crates"), "rs", &mut files)?;
    collect_files(&root.join("socket-service"), "rs", &mut files)?;
    let mut occurrences = 0_usize;
    let mut violations = Vec::new();
    for path in files {
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if relative.contains("/tests/") {
            continue;
        }
        let source = fs::read_to_string(&path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        let lines: Vec<&str> = source.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            if !TOKENS.iter().any(|token| line.contains(token)) {
                continue;
            }
            occurrences += 1;
            if !ALLOWED.contains(&relative.as_str()) {
                violations.push(format!("{relative}:{}: unsafe outside boundary", index + 1));
            }
            if line.contains("unsafe {") {
                let start = index.saturating_sub(4);
                if !lines[start..index]
                    .iter()
                    .any(|candidate| candidate.contains("SAFETY:"))
                {
                    violations.push(format!(
                        "{relative}:{}: unsafe block lacks nearby SAFETY rationale",
                        index + 1
                    ));
                }
            }
        }
    }
    if violations.is_empty() {
        println!("unsafe audit: PASS ({occurrences} boundary declarations/blocks)");
        Ok(())
    } else {
        Err(format!("unsafe audit failed:\n{}", violations.join("\n")))
    }
}

fn print_loc(root: &Path) -> Result<(), String> {
    let scopes = [
        ("capi", "crates/minisandbox-capi"),
        ("core", "crates/minisandbox-core"),
        ("macros", "crates/minisandbox-macros"),
        ("pvm-sys", "crates/minisandbox-pvm-sys"),
        ("stream-mailbox", "stream-mailbox"),
        ("socket-service", "socket-service"),
        ("conformance", "conformance"),
        ("xtask", "xtask"),
    ];
    let mut total = 0_usize;
    println!("handwritten LOC (nonblank Rust/C):");
    for (name, relative) in scopes {
        let mut files = Vec::new();
        collect_files(&root.join(relative), "rs", &mut files)?;
        collect_files(&root.join(relative), "c", &mut files)?;
        let count = files.iter().try_fold(0_usize, |count, path| {
            fs::read_to_string(path)
                .map(|source| {
                    count
                        + source
                            .lines()
                            .filter(|line| !line.trim().is_empty())
                            .count()
                })
                .map_err(|error| format!("cannot read {}: {error}", path.display()))
        })?;
        total += count;
        println!("  {name:12} {count:5}");
    }
    println!("  {:12} {total:5}", "total");
    Ok(())
}

fn check_macro_expansion(root: &Path) -> Result<(), String> {
    let packages = [
        "minisandbox-macros",
        "minisandbox-pvm-sys",
        "minisandbox-core",
        "minisandbox-capi",
    ];
    println!("compiler-expanded library LOC:");
    for package in packages {
        let output = Command::new("cargo")
            .args([
                "rustc",
                "--quiet",
                "--package",
                package,
                "--lib",
                "--",
                "-Zunpretty=expanded",
            ])
            .env("RUSTC_BOOTSTRAP", "1")
            .current_dir(root)
            .output()
            .map_err(|error| format!("cannot expand {package}: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "cannot expand {package}: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let lines = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count();
        println!("  {package:24} {lines:5}");
    }
    println!("macro expansion: PASS");
    Ok(())
}

fn collect_files(
    directory: &Path,
    extension: &str,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("cannot read {}: {error}", directory.display()))?
    {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("._"))
        {
            continue;
        }
        if path.is_dir() {
            collect_files(&path, extension, output)?;
        } else if path.extension().is_some_and(|found| found == extension) {
            output.push(path);
        }
    }
    Ok(())
}

fn header(check: bool) -> Result<(), String> {
    let root = workspace_root()?;
    let crate_dir = root.join("crates/minisandbox-capi");
    let config = cbindgen::Config::from_file(root.join("cbindgen.toml"))
        .map_err(|error| format!("cannot read cbindgen.toml: {error}"))?;
    let bindings = cbindgen::Builder::new()
        .with_config(config)
        .with_crate(crate_dir)
        .generate()
        .map_err(|error| format!("cannot generate C header: {error}"))?;

    let mut generated = Vec::new();
    bindings.write(&mut generated);
    let path = root.join("include/minisandbox.h");
    if check {
        let tracked =
            fs::read(&path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if tracked != generated {
            return Err(format!(
                "{} is stale; run `cargo xtask header`",
                path.display()
            ));
        }
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| format!("{} has no parent", path.display()))?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        fs::write(&path, generated)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    }
    Ok(())
}

fn workspace_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "xtask manifest has no workspace parent".into())
}
