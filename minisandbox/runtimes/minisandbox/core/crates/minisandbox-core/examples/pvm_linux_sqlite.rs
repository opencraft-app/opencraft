//! Direct-boot PVM Linux with an EROFS lower and SQLite-backed virtual block.

use std::{env, fs, process::ExitCode, time::Duration};

use minisandbox_core::{
    engine::{Engine, PvmReadOnlyImage, PvmSqliteBlockBackend, RunOptions},
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};
use minisandbox_pvm_sys::{PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const BLOCK_SIZE: u64 = 2 * 1024 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-sqlite: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let lower_path = arguments.next().ok_or_else(usage)?;
    let database = arguments.next().ok_or_else(usage)?;
    let cos_root = arguments.next().ok_or_else(usage)?;
    let volume_id = arguments
        .next()
        .ok_or_else(usage)?
        .into_string()
        .map_err(|_| "volume ID is not valid UTF-8".to_owned())?;
    if arguments.next().is_some() {
        return Err(usage());
    }

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let lower_file = fs::File::open(&lower_path)
        .map_err(|error| format!("cannot open {}: {error}", lower_path.to_string_lossy()))?;
    let lower = PvmReadOnlyImage::from_file(lower_file)
        .map_err(|error| format!("cannot map shared EROFS: {error}"))?;
    let backend =
        PvmSqliteBlockBackend::open(database.as_ref(), cos_root.as_ref(), &volume_id, BLOCK_SIZE)
            .map_err(|error| format!("cannot open SQLite block volume: {error}"))?;
    let command_line = format!(
        "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} \
         root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
         init=/sbin/minisandbox-init minisandbox.overlay=1 minisandbox.mode=console \
         virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}",
        lower.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let result = engine
        .run_pvm_linux_with_block_backend(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &lower,
            READ_ONLY_ROOTFS_GPA,
            Box::new(backend),
            RunOptions {
                timeout: Duration::from_secs(3),
            },
        )
        .map_err(|error| format!("PVM Linux SQLite run failed: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(&result.output));
    eprintln!("PVM Linux SQLite outcome: {:?}", result.outcome);
    let marker = b"MINISANDBOX_INIT_READY mode=console";
    if result
        .output
        .windows(marker.len())
        .any(|window| window == marker)
    {
        Ok(())
    } else {
        Err("guest did not finish the writable-root pivot".to_owned())
    }
}

fn usage() -> String {
    "usage: pvm_linux_sqlite <bzImage> <lower.erofs> <blocks.db> <cos-root> <volume-id>".to_owned()
}
