use std::{
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process,
    str::FromStr,
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use minisandbox_block_engine::{
    BLOCK_SIZE, BlockMetaRepository, BlockRepositoryConfig, CommitRangeWriteRequest,
    MAX_WRITE_BYTES, RangeWriteOutcome,
};

const LOGICAL_SIZE: u64 = 2 * 1024 * 1024 * 1024;
const LOGICAL_BLOCKS: u64 = LOGICAL_SIZE / BLOCK_SIZE;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Sequential,
    Random,
    Hotspot,
    Replay,
}

impl Mode {
    const fn name(self) -> &'static str {
        match self {
            Self::Sequential => "sequential",
            Self::Random => "random",
            Self::Hotspot => "hotspot",
            Self::Replay => "replay",
        }
    }
}

impl FromStr for Mode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "sequential" => Ok(Self::Sequential),
            "random" => Ok(Self::Random),
            "hotspot" => Ok(Self::Hotspot),
            "replay" => Ok(Self::Replay),
            _ => Err(format!(
                "unknown mode {value:?}; expected sequential, random, hotspot, or replay"
            )),
        }
    }
}

#[derive(Debug)]
struct Config {
    path: PathBuf,
    operations: u32,
    blocks_per_request: u32,
    concurrency: usize,
    queue_capacity: usize,
    mode: Mode,
    keep: bool,
}

#[derive(Default)]
struct WorkerResult {
    applied: u64,
    replayed: u64,
    latencies_us: Vec<u64>,
}

#[derive(Clone, Copy)]
struct CpuTime {
    user: Duration,
    system: Duration,
}

#[allow(clippy::too_many_lines)]
fn main() -> Result<(), Box<dyn Error>> {
    let config = parse_args(env::args().skip(1))?;
    if config.path.exists() {
        return Err(format!(
            "refusing to overwrite existing database: {}",
            config.path.display()
        )
        .into());
    }

    let repository = Arc::new(BlockMetaRepository::open(
        BlockRepositoryConfig::new(&config.path).with_queue_capacity(config.queue_capacity),
    )?);
    repository.create_volume("bench", LOGICAL_SIZE)?;

    let barrier = Arc::new(Barrier::new(config.concurrency + 1));
    let mut workers = Vec::with_capacity(config.concurrency);
    let operation_count = u64::from(config.operations);
    let base = operation_count / config.concurrency as u64;
    let remainder = operation_count % config.concurrency as u64;
    let mut operation_start = 0_u64;

    for worker_id in 0..config.concurrency {
        let worker_operations = base + u64::from((worker_id as u64) < remainder);
        let repository = Arc::clone(&repository);
        let barrier = Arc::clone(&barrier);
        let mode = config.mode;
        workers.push(thread::spawn(move || {
            barrier.wait();
            run_worker(
                repository.as_ref(),
                mode,
                worker_id,
                operation_start,
                worker_operations,
                config.blocks_per_request,
            )
        }));
        operation_start += worker_operations;
    }

    let cpu_before = process_cpu_time()?;
    let started = Instant::now();
    barrier.wait();

    let mut combined = WorkerResult::default();
    for worker in workers {
        let result = worker.join().map_err(|_| "benchmark worker panicked")??;
        combined.applied += result.applied;
        combined.replayed += result.replayed;
        combined.latencies_us.extend(result.latencies_us);
    }
    let elapsed = started.elapsed();
    let cpu_after = process_cpu_time()?;
    let stats = repository.stats()?;
    let runtime = repository.runtime_stats();
    let db_bytes = file_size(&config.path);
    let wal_path = sidecar(&config.path, "-wal");
    let wal_bytes = file_size(&wal_path);
    drop(repository);

    combined.latencies_us.sort_unstable();
    let throughput = f64::from(config.operations) / elapsed.as_secs_f64();
    let total_blocks = u64::from(config.operations) * u64::from(config.blocks_per_request);
    let mib_per_second = throughput * f64::from(config.blocks_per_request) / 256.0;
    let cpu_seconds = duration_delta(cpu_after.user, cpu_before.user).as_secs_f64()
        + duration_delta(cpu_after.system, cpu_before.system).as_secs_f64();
    let cpu_cores = cpu_seconds / elapsed.as_secs_f64();

    println!(
        concat!(
            "{{\"mode\":\"{}\",\"operations\":{},\"blocks_per_request\":{},",
            "\"total_blocks\":{},\"concurrency\":{},",
            "\"queue_capacity\":{},\"wall_ms\":{:.3},\"ops_per_second\":{:.3},",
            "\"logical_mib_per_second\":{:.3},\"cpu_seconds\":{:.6},",
            "\"average_cpu_cores\":{:.3},\"latency_us_p50\":{},",
            "\"latency_us_p95\":{},\"latency_us_p99\":{},\"latency_us_max\":{},",
            "\"applied\":{},\"replayed\":{},\"versions\":{},\"delta_heads\":{},",
            "\"range_transactions\":{},\"range_operations\":{},\"range_blocks\":{},",
            "\"max_range_operations\":{},\"max_range_blocks\":{},",
            "\"hot_payload_bytes\":{},\"db_bytes\":{},\"wal_bytes\":{},",
            "\"path\":\"{}\"}}"
        ),
        config.mode.name(),
        config.operations,
        config.blocks_per_request,
        total_blocks,
        config.concurrency,
        config.queue_capacity,
        elapsed.as_secs_f64() * 1000.0,
        throughput,
        mib_per_second,
        cpu_seconds,
        cpu_cores,
        percentile(&combined.latencies_us, 50),
        percentile(&combined.latencies_us, 95),
        percentile(&combined.latencies_us, 99),
        combined.latencies_us.last().copied().unwrap_or(0),
        combined.applied,
        combined.replayed,
        stats.versions,
        stats.delta_heads,
        runtime.range_transactions,
        runtime.range_operations,
        runtime.range_blocks,
        runtime.max_range_operations,
        runtime.max_range_blocks,
        stats.hot_payload_bytes,
        db_bytes,
        wal_bytes,
        config.path.display(),
    );

    if !config.keep {
        remove_database_files(&config.path)?;
    }
    Ok(())
}

fn run_worker(
    repository: &BlockMetaRepository,
    mode: Mode,
    worker_id: usize,
    operation_start: u64,
    operations: u64,
    blocks_per_request: u32,
) -> Result<WorkerResult, minisandbox_block_engine::BlockRepositoryError> {
    let mut result = WorkerResult {
        latencies_us: Vec::with_capacity(usize::try_from(operations).unwrap_or(usize::MAX)),
        ..WorkerResult::default()
    };
    let mut random = 0x9e37_79b9_7f4a_7c15_u64 ^ (worker_id as u64 + 1);
    for local_index in 0..operations {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        let global_hint = operation_start.wrapping_add(local_index);
        let block_count = u64::from(blocks_per_request);
        let start_positions = LOGICAL_BLOCKS - block_count + 1;
        let block_no = match mode {
            Mode::Sequential => global_hint.wrapping_mul(block_count) % start_positions,
            Mode::Random => random % start_positions,
            Mode::Hotspot | Mode::Replay => 0,
        };
        let op_id = if mode == Mode::Replay {
            "replay-one".to_owned()
        } else {
            format!("w{worker_id}-{local_index}")
        };
        let payload_byte = if mode == Mode::Replay {
            0xa5
        } else {
            (random ^ global_hint).to_le_bytes()[0]
        };
        let request = CommitRangeWriteRequest {
            volume_id: "bench".to_owned(),
            writer_epoch: 1,
            op_id,
            offset: block_no * BLOCK_SIZE,
            bytes: vec![
                payload_byte;
                usize::try_from(block_count * BLOCK_SIZE).expect("bounded write fits usize")
            ],
        };
        let started = Instant::now();
        let write = repository.commit_range_write(request)?;
        result
            .latencies_us
            .push(u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX));
        if write.replayed {
            result.replayed += 1;
        } else if matches!(write.outcome, RangeWriteOutcome::Applied { .. }) {
            result.applied += 1;
        }
    }
    Ok(result)
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Config, Box<dyn Error>> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let mut config = Config {
        path: env::temp_dir().join(format!(
            "minisandbox-sqlite-block-{}-{nonce}.db",
            process::id()
        )),
        operations: 10_000,
        blocks_per_request: 1,
        concurrency: 1,
        queue_capacity: 256,
        mode: Mode::Random,
        keep: false,
    };
    let mut args = args;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--path" => config.path = PathBuf::from(required_value(&mut args, "--path")?),
            "--operations" => {
                config.operations = required_value(&mut args, "--operations")?.parse()?;
            }
            "--blocks-per-request" => {
                config.blocks_per_request =
                    required_value(&mut args, "--blocks-per-request")?.parse()?;
            }
            "--concurrency" => {
                config.concurrency = required_value(&mut args, "--concurrency")?.parse()?;
            }
            "--queue-capacity" => {
                config.queue_capacity = required_value(&mut args, "--queue-capacity")?.parse()?;
            }
            "--mode" => config.mode = required_value(&mut args, "--mode")?.parse()?,
            "--keep" => config.keep = true,
            "--help" | "-h" => {
                println!(
                    "usage: minisandbox-sqlite-block-bench [--path FILE] [--operations N] \
                     [--blocks-per-request N] \
                     [--concurrency N] [--queue-capacity N] \
                     [--mode sequential|random|hotspot|replay] [--keep]"
                );
                process::exit(0);
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    if config.operations == 0 || config.concurrency == 0 || config.queue_capacity == 0 {
        return Err("operations, concurrency, and queue capacity must be non-zero".into());
    }
    let max_blocks = MAX_WRITE_BYTES / usize::try_from(BLOCK_SIZE)?;
    if config.blocks_per_request == 0 || usize::try_from(config.blocks_per_request)? > max_blocks {
        return Err(format!("blocks per request must be in 1..={max_blocks}").into());
    }
    Ok(config)
}

fn required_value(
    args: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<String, Box<dyn Error>> {
    args.next()
        .ok_or_else(|| format!("missing value for {option}").into())
}

fn percentile(sorted: &[u64], percentile: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = (sorted.len() - 1) * percentile / 100;
    sorted[index]
}

fn process_cpu_time() -> Result<CpuTime, Box<dyn Error>> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: `getrusage` initializes the pointed-to `rusage` on success, and
    // the pointer is valid for the duration of the call.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: the successful call above initialized the complete value.
    let usage = unsafe { usage.assume_init() };
    Ok(CpuTime {
        user: timeval_duration(usage.ru_utime),
        system: timeval_duration(usage.ru_stime),
    })
}

fn timeval_duration(value: libc::timeval) -> Duration {
    Duration::new(
        value.tv_sec.try_into().unwrap_or(0),
        u32::try_from(value.tv_usec)
            .unwrap_or(0)
            .saturating_mul(1000),
    )
}

fn duration_delta(after: Duration, before: Duration) -> Duration {
    after.checked_sub(before).unwrap_or_default()
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |metadata| metadata.len())
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn remove_database_files(path: &Path) -> Result<(), std::io::Error> {
    for candidate in [
        path.to_path_buf(),
        sidecar(path, "-wal"),
        sidecar(path, "-shm"),
    ] {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
