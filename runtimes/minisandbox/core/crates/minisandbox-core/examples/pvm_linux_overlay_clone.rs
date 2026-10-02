//! Warm-checkpoint a writable `OverlayFS` guest and validate private block clones.

use std::{
    env,
    fs::{self, OpenOptions},
    process::ExitCode,
    time::Duration,
};

use minisandbox_core::{
    engine::{Engine, PvmBlockPool, PvmReadOnlyImage, RunOptions},
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};
use minisandbox_pvm_sys::{PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-overlay-clone: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let lower_path = arguments.next().ok_or_else(usage)?;
    let upper_path = arguments.next().ok_or_else(usage)?;
    let pool_path = arguments.next().ok_or_else(usage)?;
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
    fs::create_dir_all(&pool_path)
        .map_err(|error| format!("cannot create {}: {error}", pool_path.to_string_lossy()))?;
    let pool_directory = fs::File::open(&pool_path)
        .map_err(|error| format!("cannot open {}: {error}", pool_path.to_string_lossy()))?;
    let pool = PvmBlockPool::from_directory(pool_directory)
        .map_err(|error| format!("cannot create block pool: {error}"))?;
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
        .warm_pvm_linux_template_with_storage(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &lower,
            READ_ONLY_ROOTFS_GPA,
            upper,
            &pool,
            options,
        )
        .map_err(|error| format!("cannot warm writable template: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    eprintln!(
        "writable template: warm={:?} snapshot={:?} block={:?}",
        template.warmup_latency(),
        template.snapshot_latency(),
        template.block_snapshot_method()
    );
    let results = engine
        .benchmark_pvm_linux_clones(
            &template,
            clone_count,
            b"MINISANDBOX_PYTHON_RESUMED",
            b"MINISANDBOX_PYTHON_DONE",
            options,
        )
        .map_err(|error| format!("writable clone run failed: {error:?}"))?;
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
    "usage: pvm_linux_overlay_clone <bzImage> <lower.erofs> <upper.ext4> <pool-dir> [clone-count]"
        .to_owned()
}
