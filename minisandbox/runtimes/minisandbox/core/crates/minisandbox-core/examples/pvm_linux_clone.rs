//! Warm `CPython` checkpoint and multi-clone COW benchmark.

use std::{
    env, fs,
    process::ExitCode,
    time::{Duration, Instant},
};

use minisandbox_core::engine::{
    Engine, PvmLinuxCloneResult, PvmLinuxTemplate, PvmReadOnlyImage, RunOptions,
};
use minisandbox_core::pvm_linux::READ_ONLY_ROOTFS_GPA;

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const RESUMED_MARKER: &[u8] = b"MINISANDBOX_PYTHON_RESUMED";
const COMPLETED_MARKER: &[u8] = b"MINISANDBOX_PYTHON_DONE checksum=2080";
const RECLAIMED_MARKER: &[u8] = b"MINISANDBOX_PYTHON_RECLAIM_READY";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-clone: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let rootfs_path = arguments.next().ok_or_else(usage)?;
    let clone_count = arguments
        .next()
        .map(|value| {
            value
                .to_string_lossy()
                .parse::<usize>()
                .map_err(|error| format!("invalid clone count: {error}"))
        })
        .transpose()?
        .unwrap_or(4);
    let mode = arguments
        .next()
        .map(|value| {
            if value == "--reclaim" {
                Ok((true, false))
            } else if value == "--concurrent-reclaim" {
                Ok((true, true))
            } else {
                Err(usage())
            }
        })
        .transpose()?
        .unwrap_or((false, false));
    if arguments.next().is_some() || clone_count == 0 {
        return Err(usage());
    }
    let (reclaim, concurrent) = mode;
    let completed_marker = if reclaim {
        RECLAIMED_MARKER
    } else {
        COMPLETED_MARKER
    };

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let rootfs = fs::File::open(&rootfs_path)
        .map_err(|error| format!("cannot open {}: {error}", rootfs_path.to_string_lossy()))?;
    let rootfs = PvmReadOnlyImage::from_file(rootfs)
        .map_err(|error| format!("cannot map shared EROFS: {error}"))?;
    let command_line = format!(
        "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro init=/sbin/minisandbox-init",
        rootfs.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let template = engine
        .warm_pvm_linux_template(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &rootfs,
            READ_ONLY_ROOTFS_GPA,
            RunOptions {
                timeout: Duration::from_secs(20),
            },
        )
        .map_err(|error| format!("cannot create warm Python template: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    eprintln!(
        "template: warmup={:.3} ms snapshot={:.3} ms ram={} MiB ram_backing={} erofs_backing={}",
        template.warmup_latency().as_secs_f64() * 1_000.0,
        template.snapshot_latency().as_secs_f64() * 1_000.0,
        template.memory_size() / (1024 * 1024),
        template.memory_backing_id(),
        template.rootfs_backing_id(),
    );

    let batch_started = Instant::now();
    let results = benchmark_clones(
        &engine,
        &template,
        clone_count,
        completed_marker,
        reclaim,
        concurrent,
    )?;
    let batch_elapsed = batch_started.elapsed();
    print_results(&results, concurrent, batch_elapsed);
    Ok(())
}

fn print_results(results: &[PvmLinuxCloneResult], concurrent: bool, batch_elapsed: Duration) {
    for (index, result) in results.iter().enumerate() {
        let clock = String::from_utf8_lossy(&result.output)
            .lines()
            .find(|line| line.starts_with("MINISANDBOX_PYTHON_CLOCK "))
            .unwrap_or("MINISANDBOX_PYTHON_CLOCK missing")
            .to_owned();
        let last_line = String::from_utf8_lossy(&result.output)
            .lines()
            .last()
            .unwrap_or_default()
            .to_owned();
        println!(
            "clone[{index}]: create={:.3} ms resume={:.3} ms done={:.3} ms private_pages={} private_KiB={} page_reports={} reclaimed_pages={} clock={clock} marker={last_line}",
            result.create_latency.as_secs_f64() * 1_000.0,
            result.resume_latency.as_secs_f64() * 1_000.0,
            result.completion_latency.as_secs_f64() * 1_000.0,
            result.private_pages,
            result.private_pages * 4,
            result.page_reports,
            result.reclaimed_pages,
        );
    }
    let total_private_pages: usize = results.iter().map(|result| result.private_pages).sum();
    let total_reclaimed_pages: usize = results.iter().map(|result| result.reclaimed_pages).sum();
    println!(
        "batch: concurrent={concurrent} clones={} wall={:.3} ms total_private_pages={total_private_pages} total_reclaimed_pages={total_reclaimed_pages}",
        results.len(),
        batch_elapsed.as_secs_f64() * 1_000.0,
    );
}

fn benchmark_clones(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    clone_count: usize,
    completed_marker: &[u8],
    reclaim: bool,
    concurrent: bool,
) -> Result<Vec<PvmLinuxCloneResult>, String> {
    let options = RunOptions {
        timeout: Duration::from_secs(if reclaim { 10 } else { 5 }),
    };
    let results = if concurrent {
        engine.benchmark_pvm_linux_clones_concurrently(
            template,
            clone_count,
            RESUMED_MARKER,
            completed_marker,
            options,
        )
    } else {
        engine.benchmark_pvm_linux_clones(
            template,
            clone_count,
            RESUMED_MARKER,
            completed_marker,
            options,
        )
    };
    results.map_err(|error| format!("clone benchmark failed: {error:?}"))
}

fn usage() -> String {
    "usage: pvm_linux_clone <bzImage> <root.erofs> [clone-count] [--reclaim|--concurrent-reclaim]"
        .to_owned()
}
