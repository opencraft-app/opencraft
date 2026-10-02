//! Direct-boot the shared EROFS lower plus a writable virtio-blk ext4 upper.

use std::{
    env,
    fs::{self, OpenOptions},
    process::ExitCode,
    time::Duration,
};

use minisandbox_core::{
    engine::{Engine, PvmReadOnlyImage, RunOptions},
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};
use minisandbox_pvm_sys::{PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-overlay: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let lower_path = arguments.next().ok_or_else(usage)?;
    let upper_path = arguments.next().ok_or_else(usage)?;
    if arguments.next().is_some() {
        return Err(usage());
    }

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let lower_file = fs::File::open(&lower_path)
        .map_err(|error| format!("cannot open {}: {error}", lower_path.to_string_lossy()))?;
    let lower = PvmReadOnlyImage::from_file(lower_file)
        .map_err(|error| format!("cannot map shared EROFS: {error}"))?;
    let upper = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&upper_path)
        .map_err(|error| {
            format!(
                "cannot open {} read-write: {error}",
                upper_path.to_string_lossy()
            )
        })?;
    let command_line = format!(
        "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} \
         root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
         init=/sbin/minisandbox-init minisandbox.overlay=1 \
         virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}",
        lower.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let result = engine
        .run_pvm_linux_with_storage(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &lower,
            READ_ONLY_ROOTFS_GPA,
            upper,
            RunOptions {
                timeout: Duration::from_secs(30),
            },
        )
        .map_err(|error| format!("PVM Linux overlay run failed: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(&result.output));
    eprintln!("PVM Linux overlay outcome: {:?}", result.outcome);
    let marker = b"MINISANDBOX_OVERLAYFS_OK";
    if result
        .output
        .windows(marker.len())
        .any(|window| window == marker)
    {
        Ok(())
    } else {
        Err("guest did not publish MINISANDBOX_OVERLAYFS_OK".to_owned())
    }
}

fn usage() -> String {
    "usage: pvm_linux_overlay <bzImage> <lower.erofs> <upper.ext4>".to_owned()
}
