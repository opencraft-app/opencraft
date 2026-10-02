//! Warm-checkpoint and fork PVM guests using database-backed block volumes.

use std::{env, fs, process::ExitCode, time::Duration};

use minisandbox_core::{
    engine::{Engine, PvmReadOnlyImage, RunOptions},
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
            eprintln!("pvm-linux-sqlite-clone: {error}");
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
    let clone_count = arguments
        .next()
        .map(|value| {
            value
                .to_string_lossy()
                .parse::<usize>()
                .map_err(|error| format!("invalid clone count: {error}"))
        })
        .transpose()?
        .unwrap_or(2);
    if clone_count < 2 || arguments.next().is_some() {
        return Err(usage());
    }

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let lower_file = fs::File::open(&lower_path)
        .map_err(|error| format!("cannot open {}: {error}", lower_path.to_string_lossy()))?;
    let lower = PvmReadOnlyImage::from_file(lower_file)
        .map_err(|error| format!("cannot map shared EROFS: {error}"))?;
    let command_line = format!(
        "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} \
         root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
         init=/sbin/minisandbox-init minisandbox.overlay=1 \
         minisandbox.block_clone_test=1 \
         virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}",
        lower.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let options = RunOptions {
        timeout: Duration::from_secs(30),
    };
    let template = engine
        .warm_pvm_linux_template_with_sqlite_storage(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &lower,
            READ_ONLY_ROOTFS_GPA,
            database.as_ref(),
            cos_root.as_ref(),
            &volume_id,
            BLOCK_SIZE,
            options,
        )
        .map_err(|error| format!("cannot warm SQLite-backed template: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    if !template.has_database_backed_block() {
        return Err("template did not retain a database-backed block snapshot".to_owned());
    }
    eprintln!(
        "SQLite template: warm={:?} snapshot={:?}",
        template.warmup_latency(),
        template.snapshot_latency()
    );
    let results = engine
        .benchmark_pvm_linux_clones(
            &template,
            clone_count,
            b"MINISANDBOX_PYTHON_RESUMED",
            b"MINISANDBOX_PYTHON_DONE",
            options,
        )
        .map_err(|error| format!("SQLite-backed clone run failed: {error:?}"))?;
    for (index, result) in results.iter().enumerate() {
        if !result
            .output
            .windows(b"MINISANDBOX_PYTHON_DISK_PRIVATE_OK".len())
            .any(|window| window == b"MINISANDBOX_PYTHON_DISK_PRIVATE_OK")
        {
            return Err(format!("clone {index} did not prove private disk state"));
        }
        eprintln!(
            "clone {index}: create={:?} resume={:?} complete={:?} private_pages={}",
            result.create_latency,
            result.resume_latency,
            result.completion_latency,
            result.private_pages
        );
    }
    Ok(())
}

fn usage() -> String {
    "usage: pvm_linux_sqlite_clone <bzImage> <lower.erofs> <blocks.db> <cos-root> <volume-id> [clone-count]"
        .to_owned()
}
