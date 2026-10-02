//! Real Linux/ext4/PVM lifecycle soak over the SQLite/COS reference backend.

use std::{
    env,
    error::Error,
    fmt::Write as _,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant},
};

use minisandbox_block_backend::{EmulatorObjectStore, SqliteBlockBackend};
use minisandbox_block_engine::{
    BlockEngine, BlockMetaRepository, BlockRepositoryConfig, MAX_COMPACTION_ROWS, RepositoryStats,
    RetentionCompactionResult,
};
use minisandbox_core::{
    engine::{Engine, PvmReadOnlyImage, RunOptions},
    pvm_linux::{READ_ONLY_APP_GPA, READ_ONLY_ROOTFS_GPA},
};
use minisandbox_pvm_sys::{PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const IMPORT_CHUNK_BYTES: usize = 512 * 1024;
const GUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RESUMED_MARKER: &[u8] = b"MINISANDBOX_PYTHON_RESUMED";
const COMPLETE_MARKER: &[u8] = b"MINISANDBOX_PYTHON_DONE";
const PRIVATE_DISK_MARKER: &[u8] = b"MINISANDBOX_PYTHON_DISK_PRIVATE_OK";
const BLOCK_STRESS_MARKER: &[u8] = b"MINISANDBOX_PYTHON_BLOCK_STRESS_OK";

#[derive(Debug)]
struct Config {
    kernel: PathBuf,
    lower: PathBuf,
    app_layer: Option<PathBuf>,
    seed_ext4: PathBuf,
    evidence: PathBuf,
    duration: Duration,
    clones_per_wave: usize,
    settle_baseline: bool,
    guest_stress: bool,
    guest_timeout: Duration,
}

#[derive(Debug, Default)]
struct ImportReport {
    scanned_bytes: u64,
    nonzero_bytes: u64,
    write_operations: u64,
    elapsed: Duration,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-sqlite-soak: {error}");
            ExitCode::FAILURE
        }
    }
}

#[allow(clippy::too_many_lines)]
fn run() -> Result<(), Box<dyn Error>> {
    let config = parse_args()?;
    prepare_evidence_directory(&config.evidence)?;
    let database = config.evidence.join("blocks.db");
    let cos_root = config.evidence.join("cos");
    let summary_path = config.evidence.join("summary.txt");
    let mut summary = String::new();

    let logical_size = fs::metadata(&config.seed_ext4)?.len();
    if logical_size == 0 || !logical_size.is_multiple_of(4096) {
        return Err("seed ext4 size must be a non-zero multiple of 4 KiB".into());
    }
    let source_volume = format!("pvm-soak-source-{}", std::process::id());
    let import = import_sparse_ext4(
        &config.seed_ext4,
        &database,
        &cos_root,
        &source_volume,
        logical_size,
        config.settle_baseline,
    )?;
    record(
        &mut summary,
        format_args!(
            "IMPORT scanned_bytes={} nonzero_bytes={} writes={} elapsed_ms={}",
            import.scanned_bytes,
            import.nonzero_bytes,
            import.write_operations,
            import.elapsed.as_millis()
        ),
    );

    let kernel = fs::read(&config.kernel)?;
    let lower = PvmReadOnlyImage::from_file(File::open(&config.lower)?)?;
    let app_layer = match &config.app_layer {
        Some(path) => Some(PvmReadOnlyImage::from_file(File::open(path)?)?),
        None => None,
    };
    let mut command_line = format!(
        "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x}",
        lower.len()
    );
    if let Some(app_layer) = &app_layer {
        write!(
            command_line,
            " memmap={:#x}!{READ_ONLY_APP_GPA:#x}",
            app_layer.len()
        )?;
    }
    command_line.push_str(
        " root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
         init=/sbin/minisandbox-init minisandbox.overlay=1 \
         minisandbox.block_clone_test=1",
    );
    if app_layer.is_some() {
        command_line.push_str(" minisandbox.app_layer=1");
    }
    if config.guest_stress {
        command_line.push_str(" minisandbox.block_stress=1");
    }
    write!(
        command_line,
        " virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}"
    )?;
    let engine = Engine::open().map_err(|error| format!("cannot open PVM: {error:?}"))?;
    let run_options = RunOptions {
        timeout: config.guest_timeout,
    };
    let template = if let Some(app_layer) = &app_layer {
        engine.warm_pvm_linux_template_with_layered_sqlite_storage(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &lower,
            app_layer,
            &database,
            &cos_root,
            &source_volume,
            logical_size,
            run_options,
        )
    } else {
        engine.warm_pvm_linux_template_with_sqlite_storage(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &lower,
            READ_ONLY_ROOTFS_GPA,
            &database,
            &cos_root,
            &source_volume,
            logical_size,
            run_options,
        )
    }
    .map_err(|error| format!("cannot warm SQLite-backed PVM template: {error:?}"))?;
    if !template.has_database_backed_block() {
        return Err("warm template lost its database-backed block root".into());
    }
    require_marker(
        template.warm_output(),
        b"MINISANDBOX_PYTHON_WARM_READY",
        "warm output",
    )?;
    if app_layer.is_some() {
        require_marker(
            template.warm_output(),
            b"lowerdir=/run/minisandbox-app:/",
            "layered warm root",
        )?;
    }
    record(
        &mut summary,
        format_args!(
            "TEMPLATE warm_ms={} snapshot_ms={} logical_size={logical_size} app_layer={} guest_stress={} guest_timeout_ms={}",
            template.warmup_latency().as_millis(),
            template.snapshot_latency().as_millis(),
            app_layer.is_some(),
            config.guest_stress,
            config.guest_timeout.as_millis()
        ),
    );

    compact_all(&database)?;
    let baseline = repository_stats(&database)?;
    require_lifecycle_counts(&baseline, 0, 1, 1, "post-template baseline")?;
    let started = Instant::now();
    let mut wave = 0_u64;
    let mut completed_clones = 0_u64;
    while wave < 2 || started.elapsed() < config.duration {
        wave = wave.checked_add(1).ok_or("wave counter overflow")?;
        let concurrent = wave.is_multiple_of(2);
        let wave_started = Instant::now();
        let results = if concurrent {
            engine.benchmark_pvm_linux_clones_concurrently(
                &template,
                config.clones_per_wave,
                RESUMED_MARKER,
                COMPLETE_MARKER,
                run_options,
            )
        } else {
            engine.benchmark_pvm_linux_clones(
                &template,
                config.clones_per_wave,
                RESUMED_MARKER,
                COMPLETE_MARKER,
                run_options,
            )
        }
        .map_err(|error| format!("clone wave {wave} failed: {error:?}"))?;
        for (index, result) in results.iter().enumerate() {
            require_marker(
                &result.output,
                PRIVATE_DISK_MARKER,
                &format!("wave {wave} clone {index}"),
            )?;
            if config.guest_stress {
                require_marker(
                    &result.output,
                    BLOCK_STRESS_MARKER,
                    &format!("wave {wave} clone {index} block stress"),
                )?;
            }
        }
        completed_clones = completed_clones
            .checked_add(u64::try_from(results.len())?)
            .ok_or("clone counter overflow")?;
        compact_all(&database)?;
        let stats = repository_stats(&database)?;
        require_lifecycle_counts(&stats, 0, completed_clones + 1, 1, &format!("wave {wave}"))?;
        require_steady_reachable_state(&baseline, &stats, wave)?;
        let max_create = results
            .iter()
            .map(|result| result.create_latency)
            .max()
            .unwrap_or_default();
        let max_complete = results
            .iter()
            .map(|result| result.completion_latency)
            .max()
            .unwrap_or_default();
        record(
            &mut summary,
            format_args!(
                "WAVE index={wave} mode={} clones={} elapsed_ms={} max_create_us={} max_complete_us={} retired={} versions={} hot_bytes={} packs={} delta_layers={}",
                if concurrent {
                    "concurrent"
                } else {
                    "sequential"
                },
                results.len(),
                wave_started.elapsed().as_millis(),
                max_create.as_micros(),
                max_complete.as_micros(),
                stats.retired_volumes,
                stats.versions,
                stats.hot_payload_bytes,
                stats.packs,
                stats.delta_layers
            ),
        );
    }

    drop(template);
    drain_gc(&database, &cos_root)?;
    compact_all(&database)?;
    let final_stats = repository_stats(&database)?;
    require_lifecycle_counts(
        &final_stats,
        0,
        completed_clones + 1,
        0,
        "final template destruction",
    )?;
    if final_stats.versions != 0
        || final_stats.delta_heads != 0
        || final_stats.hot_payload_bytes != 0
        || final_stats.cold_locations != 0
        || final_stats.packs != 0
        || final_stats.pending_gc_tasks != 0
        || final_stats.operation_results != 0
        || final_stats.flush_barriers != 0
    {
        return Err(format!("final storage references were not reclaimed: {final_stats:?}").into());
    }
    let database_bytes = fs::metadata(&database)?.len();
    record(
        &mut summary,
        format_args!(
            "PASS waves={wave} clones={completed_clones} duration_ms={} database_bytes={database_bytes} retired_tombstones={} completed_gc={} residual_delta_layers={}",
            started.elapsed().as_millis(),
            final_stats.retired_volumes,
            final_stats.completed_gc_tasks,
            final_stats.delta_layers
        ),
    );
    let mut summary_file = File::create(summary_path)?;
    summary_file.write_all(summary.as_bytes())?;
    summary_file.sync_all()?;
    Ok(())
}

fn parse_args() -> Result<Config, Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let kernel = PathBuf::from(args.next().ok_or_else(usage)?);
    let lower = PathBuf::from(args.next().ok_or_else(usage)?);
    let seed_ext4 = PathBuf::from(args.next().ok_or_else(usage)?);
    let evidence = PathBuf::from(args.next().ok_or_else(usage)?);
    let mut app_layer = None;
    let mut duration = Duration::from_mins(5);
    let mut clones_per_wave = 4_usize;
    let mut settle_baseline = false;
    let mut guest_stress = false;
    let mut guest_timeout = GUEST_TIMEOUT;
    while let Some(argument) = args.next() {
        let argument = argument.to_str().ok_or("argument is not valid UTF-8")?;
        match argument {
            "--duration-seconds" => {
                duration = Duration::from_secs(parse_value(&mut args, argument)?);
            }
            "--clones-per-wave" => clones_per_wave = parse_value(&mut args, argument)?,
            "--settle-baseline" => settle_baseline = true,
            "--app-layer" => {
                app_layer = Some(PathBuf::from(args.next().ok_or_else(usage)?));
            }
            "--guest-stress" => guest_stress = true,
            "--guest-timeout-seconds" => {
                guest_timeout = Duration::from_secs(parse_value(&mut args, argument)?);
            }
            _ => return Err(format!("unknown argument {argument}\n{}", usage()).into()),
        }
    }
    if !(2..=64).contains(&clones_per_wave) {
        return Err("clones per wave must be between 2 and 64".into());
    }
    if guest_timeout.is_zero() {
        return Err("guest timeout must be non-zero".into());
    }
    Ok(Config {
        kernel,
        lower,
        app_layer,
        seed_ext4,
        evidence,
        duration,
        clones_per_wave,
        settle_baseline,
        guest_stress,
        guest_timeout,
    })
}

fn parse_value<T: std::str::FromStr>(
    args: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> Result<T, Box<dyn Error>>
where
    T::Err: Error + 'static,
{
    let value = args.next().ok_or_else(usage)?;
    Ok(value
        .to_str()
        .ok_or("value is not valid UTF-8")?
        .parse()
        .map_err(|error| format!("invalid {name}: {error}"))?)
}

fn usage() -> String {
    "usage: pvm-linux-sqlite-soak <bzImage> <lower.erofs> <seed.ext4> <evidence-dir> [--duration-seconds N] [--clones-per-wave N] [--settle-baseline] [--app-layer FILE] [--guest-stress] [--guest-timeout-seconds N]".to_owned()
}

fn prepare_evidence_directory(path: &Path) -> Result<(), Box<dyn Error>> {
    if path.exists() {
        if fs::read_dir(path)?.next().is_some() {
            return Err("evidence directory must be absent or empty".into());
        }
    } else {
        fs::create_dir_all(path)?;
    }
    Ok(())
}

fn import_sparse_ext4(
    seed: &Path,
    database: &Path,
    cos_root: &Path,
    volume_id: &str,
    logical_size: u64,
    settle_baseline: bool,
) -> Result<ImportReport, Box<dyn Error>> {
    let started = Instant::now();
    let mut source = File::open(seed)?;
    let mut backend = SqliteBlockBackend::open(database, cos_root, volume_id, logical_size)?;
    let mut buffer = vec![0_u8; IMPORT_CHUNK_BYTES];
    let mut offset = 0_u64;
    let mut report = ImportReport::default();
    while offset < logical_size {
        let length = usize::try_from((logical_size - offset).min(IMPORT_CHUNK_BYTES as u64))?;
        source.read_exact(&mut buffer[..length])?;
        report.scanned_bytes = report
            .scanned_bytes
            .checked_add(u64::try_from(length)?)
            .ok_or("import byte counter overflow")?;
        let blocks = buffer[..length].chunks(4096).collect::<Vec<_>>();
        let mut run_start = None;
        for block_index in 0..=blocks.len() {
            let nonzero = blocks
                .get(block_index)
                .is_some_and(|block| block.iter().any(|byte| *byte != 0));
            if nonzero && run_start.is_none() {
                run_start = Some(block_index);
            }
            if !nonzero && let Some(first_block) = run_start.take() {
                let first_byte = first_block.checked_mul(4096).ok_or("run offset overflow")?;
                let last_byte = block_index.checked_mul(4096).ok_or("run end overflow")?;
                let run = &buffer[first_byte..last_byte];
                let block_offset = offset
                    .checked_add(u64::try_from(first_byte)?)
                    .ok_or("offset overflow")?;
                backend.write_at(block_offset, run, false)?;
                report.nonzero_bytes = report
                    .nonzero_bytes
                    .checked_add(u64::try_from(run.len())?)
                    .ok_or("nonzero byte counter overflow")?;
                report.write_operations = report
                    .write_operations
                    .checked_add(1)
                    .ok_or("write counter overflow")?;
            }
        }
        offset = offset
            .checked_add(u64::try_from(length)?)
            .ok_or("import offset overflow")?;
    }
    backend.flush()?;
    if settle_baseline {
        backend.settle_all(65_536)?;
    }
    drop(backend);
    if settle_baseline {
        let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(database))?;
        let generation = repository.acquire_settler()?;
        if generation > 1 {
            repository.close_settler_retry_window(generation - 1)?;
        }
    }
    report.elapsed = started.elapsed();
    Ok(report)
}

fn compact_all(database: &Path) -> Result<(), Box<dyn Error>> {
    let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(database))?;
    for _ in 0..65_536 {
        let result = repository.compact_retained_history(MAX_COMPACTION_ROWS)?;
        if compaction_empty(&result) {
            return Ok(());
        }
    }
    Err("metadata compaction did not quiesce".into())
}

const fn compaction_empty(result: &RetentionCompactionResult) -> bool {
    result.operation_results == 0
        && result.flush_barriers == 0
        && result.delta_heads == 0
        && result.versions == 0
        && result.pack_intents == 0
        && result.settlement_rounds == 0
}

fn drain_gc(database: &Path, cos_root: &Path) -> Result<(), Box<dyn Error>> {
    let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(database))?;
    let store = EmulatorObjectStore::open(cos_root)?;
    let mut engine = BlockEngine::new(repository, store);
    for _ in 0..65_536 {
        let report = engine.gc_once()?;
        if report.task.is_none() {
            return Ok(());
        }
        if !report.completed {
            return Err("deterministic COS emulator left an indeterminate GC task".into());
        }
    }
    Err("exact-key GC did not quiesce".into())
}

fn repository_stats(database: &Path) -> Result<RepositoryStats, Box<dyn Error>> {
    Ok(BlockMetaRepository::open(BlockRepositoryConfig::new(database))?.stats()?)
}

fn require_lifecycle_counts(
    stats: &RepositoryStats,
    active_volumes: u64,
    retired_volumes: u64,
    snapshots: u64,
    context: &str,
) -> Result<(), Box<dyn Error>> {
    if stats.volumes != active_volumes
        || stats.retired_volumes != retired_volumes
        || stats.snapshots != snapshots
    {
        return Err(format!(
            "{context}: lifecycle mismatch, expected active={active_volumes} retired={retired_volumes} snapshots={snapshots}, got {stats:?}"
        )
        .into());
    }
    Ok(())
}

fn require_steady_reachable_state(
    baseline: &RepositoryStats,
    current: &RepositoryStats,
    wave: u64,
) -> Result<(), Box<dyn Error>> {
    if current.versions != baseline.versions
        || current.delta_heads != baseline.delta_heads
        || current.hot_payload_bytes != baseline.hot_payload_bytes
        || current.cold_locations != baseline.cold_locations
        || current.packs != baseline.packs
        || current.pending_gc_tasks != 0
        || current.operation_results != 0
        || current.flush_barriers != 0
    {
        return Err(format!(
            "wave {wave}: destroyed clones changed reachable template state; baseline={baseline:?}, current={current:?}"
        )
        .into());
    }
    Ok(())
}

fn require_marker(output: &[u8], marker: &[u8], context: &str) -> Result<(), Box<dyn Error>> {
    if marker.is_empty() || !output.windows(marker.len()).any(|window| window == marker) {
        return Err(format!(
            "{context}: missing marker {}; output={}",
            String::from_utf8_lossy(marker),
            String::from_utf8_lossy(output)
        )
        .into());
    }
    Ok(())
}

fn record(summary: &mut String, arguments: std::fmt::Arguments<'_>) {
    println!("{arguments}");
    writeln!(summary, "{arguments}").expect("writing to String cannot fail");
}
