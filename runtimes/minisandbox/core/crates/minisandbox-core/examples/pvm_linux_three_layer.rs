//! Validate fixed base EROFS, application EROFS, and private ext4 layers.

use std::{
    env,
    fs::{self, OpenOptions},
    process::ExitCode,
    time::Duration,
};

use minisandbox_core::{
    engine::{Engine, PvmBlockPool, PvmLinuxTemplate, PvmReadOnlyImage, RunOptions, RunOutcome},
    pvm_linux::{READ_ONLY_APP_GPA, READ_ONLY_ROOTFS_GPA},
};
use minisandbox_pvm_sys::{PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-three-layer: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let base_path = arguments.next().ok_or_else(usage)?;
    let app_path = arguments.next().ok_or_else(usage)?;
    let upper_path = arguments.next().ok_or_else(usage)?;
    let pool_path = arguments.next().ok_or_else(usage)?;
    let marker_path = arguments.next().ok_or_else(usage)?;
    let expected_marker = arguments
        .next()
        .ok_or_else(usage)?
        .to_string_lossy()
        .into_owned()
        .into_bytes();
    if arguments.next().is_some() {
        return Err(usage());
    }

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let base = open_read_only_image(&base_path, "base")?;
    let app = open_read_only_image(&app_path, "application")?;
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
         memmap={:#x}!{READ_ONLY_APP_GPA:#x} \
         root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
         init=/sbin/minisandbox-init minisandbox.overlay=1 \
         minisandbox.app_layer=1 minisandbox.block_clone_test=1 \
         virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}",
        base.len(),
        app.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let options = RunOptions {
        timeout: Duration::from_secs(30),
    };
    let template = engine
        .warm_pvm_linux_template_with_layered_storage(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &base,
            &app,
            upper,
            &pool,
            options,
        )
        .map_err(|error| format!("cannot warm three-layer template: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    validate_layers(
        &engine,
        &template,
        [base.backing_id(), app.backing_id()],
        &marker_path,
        &expected_marker,
        options,
    )?;

    println!(
        "MINISANDBOX_THREE_LAYER_OK base_backing={} app_backing={} private_clones=2",
        base.backing_id(),
        app.backing_id()
    );
    Ok(())
}

fn validate_layers(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    expected_backings: [u64; 2],
    marker_path: &std::ffi::OsStr,
    expected_marker: &[u8],
    options: RunOptions,
) -> Result<(), String> {
    if template.read_only_backing_ids() != expected_backings {
        return Err("template did not retain both immutable backings in order".to_owned());
    }

    let clone_results = engine
        .benchmark_pvm_linux_clones(
            template,
            2,
            b"MINISANDBOX_PYTHON_RESUMED",
            b"MINISANDBOX_PYTHON_DONE",
            options,
        )
        .map_err(|error| format!("three-layer sibling run failed: {error:?}"))?;
    for (index, result) in clone_results.iter().enumerate() {
        if !contains(&result.output, b"MINISANDBOX_PYTHON_DISK_PRIVATE_OK") {
            return Err(format!("clone {index} did not prove private ext4 state"));
        }
    }

    let mut instance = engine
        .clone_pvm_linux_template(template)
        .map_err(|error| format!("cannot clone three-layer template: {error:?}"))?;
    let files = instance.sandbox_files();
    std::thread::scope(|scope| -> Result<(), String> {
        let runner = scope.spawn(move || {
            instance.run_for(RunOptions {
                timeout: Duration::from_secs(10),
            })
        });
        let marker = files
            .read(marker_path, Duration::from_secs(3))
            .map_err(|error| format!("cannot read layered marker: {error}"))?;
        let outcome = runner
            .join()
            .map_err(|_| "three-layer runner panicked".to_owned())?
            .map_err(|error| format!("three-layer runner failed: {error:?}"))?;
        if outcome.outcome != RunOutcome::TimedOut {
            return Err(format!("three-layer clone stopped: {:?}", outcome.outcome));
        }
        if marker != expected_marker {
            return Err(format!(
                "layered marker mismatch: expected {:?}, got {:?}",
                String::from_utf8_lossy(expected_marker),
                String::from_utf8_lossy(&marker)
            ));
        }
        Ok(())
    })?;

    Ok(())
}

fn open_read_only_image(path: &std::ffi::OsStr, label: &str) -> Result<PvmReadOnlyImage, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("cannot open {} {label}: {error}", path.to_string_lossy()))?;
    PvmReadOnlyImage::from_file(file)
        .map_err(|error| format!("cannot map shared {label} EROFS: {error}"))
}

fn contains(output: &[u8], marker: &[u8]) -> bool {
    output.windows(marker.len()).any(|window| window == marker)
}

fn usage() -> String {
    "usage: pvm_linux_three_layer <bzImage> <base.erofs> <app.erofs> <upper.ext4> <pool-dir> <marker-path> <expected-marker>".to_owned()
}
