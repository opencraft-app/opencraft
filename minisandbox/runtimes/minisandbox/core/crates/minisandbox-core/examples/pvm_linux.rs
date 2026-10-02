//! Direct-boot smoke runner for the pinned PVM Linux guest.

use std::{env, fs, process::ExitCode, time::Duration};

use minisandbox_core::{
    engine::{Engine, PvmReadOnlyImage, RunOptions},
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-smoke: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments
        .next()
        .ok_or_else(|| "usage: pvm_linux <bzImage> <initramfs.cpio>".to_owned())?;
    let initramfs_path = arguments
        .next()
        .ok_or_else(|| "usage: pvm_linux <bzImage> <initramfs.cpio> [root.erofs]".to_owned())?;
    let rootfs_path = arguments.next();
    if arguments.next().is_some() {
        return Err("usage: pvm_linux <bzImage> <initramfs.cpio> [root.erofs]".to_owned());
    }
    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let initramfs = fs::read(&initramfs_path)
        .map_err(|error| format!("cannot read {}: {error}", initramfs_path.to_string_lossy()))?;
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let options = RunOptions {
        timeout: Duration::from_secs(10),
    };
    let (result, expected_markers): (_, &[&[u8]]) = if let Some(rootfs_path) = rootfs_path {
        let rootfs = fs::File::open(&rootfs_path)
            .map_err(|error| format!("cannot open {}: {error}", rootfs_path.to_string_lossy()))?;
        let rootfs = PvmReadOnlyImage::from_file(rootfs)
            .map_err(|error| format!("cannot map shared EROFS: {error}"))?;
        let command_line = format!(
            "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro init=/sbin/minisandbox-init",
            rootfs.len()
        );
        let result = engine
            .run_pvm_linux_with_sealed_read_only_image(
                &kernel,
                &initramfs,
                command_line.as_bytes(),
                MEMORY_SIZE,
                &rootfs,
                READ_ONLY_ROOTFS_GPA,
                options,
            )
            .map_err(|error| format!("PVM Linux EROFS/DAX run failed: {error:?}"))?;
        (result, &[b"MINISANDBOX_EROFS_DAX_OK".as_slice()])
    } else {
        let command_line = format!("{COMMON_COMMAND_LINE} rdinit=/init");
        let result = engine
            .run_pvm_linux(
                &kernel,
                &initramfs,
                command_line.as_bytes(),
                MEMORY_SIZE,
                options,
            )
            .map_err(|error| format!("PVM Linux run failed: {error:?}"))?;
        (result, &[b"MINISANDBOX_PVM_LINUX_OK".as_slice()])
    };
    print!("{}", String::from_utf8_lossy(&result.output));
    eprintln!("PVM Linux outcome: {:?}", result.outcome);
    if expected_markers.iter().any(|marker| {
        result
            .output
            .windows(marker.len())
            .any(|window| window == *marker)
    }) {
        Ok(())
    } else {
        Err(format!(
            "guest did not publish any expected marker: {}",
            expected_markers
                .iter()
                .map(|marker| String::from_utf8_lossy(marker))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
}
