//! Standalone PVM Linux `TCP_RR` and `TCP_STREAM` benchmark harness.

use std::{
    env, fs,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, TcpListener, TcpStream},
    process::ExitCode,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use minisandbox_core::engine::{
    BrokerStats, Engine, HOST_LOOPBACK_ALIAS, PvmLinuxCloneResult, PvmReadOnlyImage, RunOptions,
    TcpAllowList,
};
use minisandbox_core::pvm_linux::READ_ONLY_ROOTFS_GPA;
use pvm_socket_service::SocketIngressHandle;

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const MAX_IO_SIZE: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 128;
const MAX_CLONES: usize = 128;
const MAX_TOTAL_CONNECTIONS: usize = 512;
const MAX_RR_ITERATIONS: u64 = 1_000_000;
const MAX_RR_RATE: u64 = 100_000;
const MIN_RATE_DURATION_MS: u64 = 100;
const MAX_RATE_DURATION_MS: u64 = 60_000;
const MAX_RR_SAMPLES_PER_CLONE: u64 = 4_000_000;
const MAX_STREAM_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_GUEST_BUFFER_BYTES: usize = 128 * 1024 * 1024;
const HEADER_BYTES: usize = 32;
const HEADER_MAGIC: &[u8; 8] = b"MSNET001";
const READY_BYTE: u8 = 0xa5;
const START_BYTE: u8 = 0x5a;
const RESUMED_MARKER: &[u8] = b"MSSOCKBENCH_RESUMED";
const COMPLETED_MARKER: &[u8] = b"MSSOCKBENCH_DONE";
const RUN_TIMEOUT: Duration = Duration::from_mins(2);
const INGRESS_GUEST_PORT: u16 = 18_080;
const MAX_CONCURRENT_INGRESS_PER_LISTENER: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Rr,
    RrRate,
    StreamTx,
    StreamRx,
    IngressRr,
    IngressRrRate,
    IngressStreamTx,
    IngressStreamRx,
}

impl Mode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "tcp-rr" => Ok(Self::Rr),
            "tcp-rr-rate" => Ok(Self::RrRate),
            "tcp-stream-tx" => Ok(Self::StreamTx),
            "tcp-stream-rx" => Ok(Self::StreamRx),
            "ingress-tcp-rr" => Ok(Self::IngressRr),
            "ingress-tcp-rr-rate" => Ok(Self::IngressRrRate),
            "ingress-tcp-stream-tx" => Ok(Self::IngressStreamTx),
            "ingress-tcp-stream-rx" => Ok(Self::IngressStreamRx),
            _ => Err(format!("unsupported mode {value}; {}", usage())),
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Rr => "tcp-rr",
            Self::RrRate => "tcp-rr-rate",
            Self::StreamTx => "tcp-stream-tx",
            Self::StreamRx => "tcp-stream-rx",
            Self::IngressRr => "ingress-tcp-rr",
            Self::IngressRrRate => "ingress-tcp-rr-rate",
            Self::IngressStreamTx => "ingress-tcp-stream-tx",
            Self::IngressStreamRx => "ingress-tcp-stream-rx",
        }
    }

    const fn code(self) -> u32 {
        match self {
            Self::Rr | Self::IngressRr => 1,
            Self::StreamTx | Self::IngressStreamTx => 2,
            Self::StreamRx | Self::IngressStreamRx => 3,
            Self::RrRate | Self::IngressRrRate => 4,
        }
    }

    const fn is_rr(self) -> bool {
        matches!(
            self,
            Self::Rr | Self::RrRate | Self::IngressRr | Self::IngressRrRate
        )
    }

    const fn is_ingress(self) -> bool {
        matches!(
            self,
            Self::IngressRr | Self::IngressRrRate | Self::IngressStreamTx | Self::IngressStreamRx
        )
    }

    const fn is_fixed_rate(self) -> bool {
        matches!(self, Self::RrRate | Self::IngressRrRate)
    }
}

#[derive(Clone, Copy)]
struct Config {
    mode: Mode,
    io_size: usize,
    connections: usize,
    clones: usize,
    amount: u64,
    warmup: u32,
    server_delay: Duration,
}

#[derive(Default)]
struct ServerMetrics {
    connections: usize,
    payload_bytes: u128,
    measured_operations: u128,
    cpu_ns: u128,
    connect_latency_ns: Vec<u64>,
}

impl Config {
    fn measured_rr_iterations(self) -> Result<u64, String> {
        match self.mode {
            Mode::Rr | Mode::IngressRr => Ok(self.amount),
            Mode::RrRate | Mode::IngressRrRate => self
                .amount
                .checked_mul(u64::from(self.warmup))
                .map(|product| product / 1_000)
                .filter(|iterations| *iterations != 0)
                .ok_or_else(|| "fixed-rate RR iteration count overflowed or is zero".to_owned()),
            Mode::StreamTx | Mode::StreamRx | Mode::IngressStreamTx | Mode::IngressStreamRx => {
                Err("stream mode has no RR iteration count".to_owned())
            }
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-socket-bench: {error}");
            ExitCode::FAILURE
        }
    }
}

#[allow(clippy::too_many_lines)]
fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let rootfs_path = arguments.next().ok_or_else(usage)?;
    let mode = Mode::parse(&arguments.next().ok_or_else(usage)?.to_string_lossy())?;
    let io_size = parse_argument::<usize>(&mut arguments, "I/O size")?;
    let connections = parse_argument::<usize>(&mut arguments, "connection count")?;
    let clones = parse_argument::<usize>(&mut arguments, "clone count")?;
    let amount = parse_argument::<u64>(&mut arguments, "iteration/byte count")?;
    let control = parse_argument::<u64>(&mut arguments, "server delay/rate duration")?;
    if arguments.next().is_some() {
        return Err(usage());
    }
    if io_size == 0
        || io_size > MAX_IO_SIZE
        || connections == 0
        || connections > MAX_CONNECTIONS
        || clones == 0
        || clones > MAX_CLONES
        || amount == 0
        || (matches!(mode, Mode::Rr | Mode::IngressRr)
            && (amount > MAX_RR_ITERATIONS || control > 1_000_000))
        || (mode.is_fixed_rate()
            && (amount > MAX_RR_RATE
                || !(MIN_RATE_DURATION_MS..=MAX_RATE_DURATION_MS).contains(&control)))
        || (!mode.is_rr() && control > 1_000_000)
        || (mode.is_ingress() && connections > MAX_CONCURRENT_INGRESS_PER_LISTENER)
    {
        return Err("benchmark arguments exceed documented bounds".to_owned());
    }
    let total_connections = connections
        .checked_mul(clones)
        .ok_or_else(|| "total connection count overflowed".to_owned())?;
    let guest_buffer_bytes = io_size
        .checked_mul(connections)
        .and_then(|value| value.checked_mul(2))
        .ok_or_else(|| "guest socket buffer size overflowed".to_owned())?;
    let warmup = match mode {
        Mode::Rr | Mode::IngressRr => {
            u32::try_from(amount.min(1_000)).map_err(|_| "RR warmup overflowed".to_owned())?
        }
        Mode::RrRate | Mode::IngressRrRate => {
            u32::try_from(control).map_err(|_| "RR duration overflowed".to_owned())?
        }
        Mode::StreamTx | Mode::StreamRx | Mode::IngressStreamTx | Mode::IngressStreamRx => 0,
    };
    let server_delay = if mode.is_fixed_rate() {
        Duration::ZERO
    } else {
        Duration::from_micros(control)
    };
    let preliminary = Config {
        mode,
        io_size,
        connections,
        clones,
        amount,
        warmup,
        server_delay,
    };
    let rr_samples = if mode.is_rr() {
        preliminary
            .measured_rr_iterations()?
            .checked_mul(connections as u64)
            .ok_or_else(|| "guest RR sample count overflowed".to_owned())?
    } else {
        0
    };
    if total_connections > MAX_TOTAL_CONNECTIONS
        || guest_buffer_bytes > MAX_GUEST_BUFFER_BYTES
        || (mode.is_rr() && rr_samples > MAX_RR_SAMPLES_PER_CLONE)
        || (!mode.is_rr() && amount > MAX_STREAM_BYTES)
    {
        return Err("benchmark workload exceeds bounded host/guest resources".to_owned());
    }
    let config = preliminary;

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let rootfs = fs::File::open(&rootfs_path)
        .map_err(|error| format!("cannot open {}: {error}", rootfs_path.to_string_lossy()))?;
    let rootfs = PvmReadOnlyImage::from_file(rootfs)
        .map_err(|error| format!("cannot map benchmark EROFS: {error}"))?;
    let listener = if config.mode.is_ingress() {
        None
    } else {
        Some(
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .map_err(|error| format!("cannot bind benchmark loopback server: {error}"))?,
        )
    };
    let port = match &listener {
        Some(listener) => listener
            .local_addr()
            .map_err(|error| format!("cannot inspect benchmark listener: {error}"))?
            .port(),
        None => INGRESS_GUEST_PORT,
    };
    let command_line = format!(
        "{COMMON_COMMAND_LINE} loglevel=3 memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro init=/sbin/minisandbox-init mssock.mode={} mssock.port={port} mssock.io_size={} mssock.connections={} mssock.amount={} mssock.warmup={}",
        rootfs.len(),
        config.mode.name(),
        config.io_size,
        config.connections,
        config.amount,
        config.warmup,
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
                timeout: Duration::from_secs(30),
            },
        )
        .map_err(|error| format!("cannot warm socket benchmark template: {error:?}"))?;
    eprintln!(
        "template mode={} warmup_ms={:.3} snapshot_ms={:.3} port={port}",
        config.mode.name(),
        template.warmup_latency().as_secs_f64() * 1_000.0,
        template.snapshot_latency().as_secs_f64() * 1_000.0,
    );

    let mut instances = Vec::with_capacity(config.clones);
    let mut ingress_handles = Vec::with_capacity(config.clones);
    for _ in 0..config.clones {
        let policy = if config.mode.is_ingress() {
            TcpAllowList::default()
        } else {
            TcpAllowList::default().allow(IpAddr::V4(HOST_LOOPBACK_ALIAS), port..=port)
        };
        let instance = engine
            .clone_pvm_linux_template_with_tcp_policy(&template, Arc::new(policy))
            .map_err(|error| format!("cannot restore benchmark clone: {error:?}"))?;
        if config.mode.is_ingress() {
            ingress_handles.push(instance.socket_ingress());
        }
        instances.push(instance);
    }

    let before = ResourceUsage::capture()?;
    let batch_started = Instant::now();
    let server = thread::Builder::new()
        .name("pvm-socket-benchmark-server".to_owned())
        .spawn(move || match listener {
            Some(listener) => run_server(&listener, config),
            None => run_ingress_server(ingress_handles, port, config),
        })
        .map_err(|error| format!("cannot spawn benchmark server: {error}"))?;
    let clone_results = thread::scope(|scope| -> Result<Vec<PvmLinuxCloneResult>, String> {
        let workers: Vec<_> = instances
            .into_iter()
            .map(|mut instance| {
                scope.spawn(move || {
                    instance.run_until_markers(
                        RESUMED_MARKER,
                        COMPLETED_MARKER,
                        RunOptions {
                            timeout: RUN_TIMEOUT,
                        },
                    )
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| "benchmark clone worker panicked".to_owned())?
                    .map_err(|error| format!("benchmark clone failed: {error:?}"))
            })
            .collect()
    })?;
    let server_metrics = server
        .join()
        .map_err(|_| "benchmark server panicked".to_owned())??;
    let batch_wall_ns = batch_started.elapsed().as_nanos();
    let usage = ResourceUsage::capture()?.delta(before);
    publish_batch(
        config,
        &clone_results,
        &server_metrics,
        batch_wall_ns,
        usage,
    )?;
    Ok(())
}

fn parse_argument<T>(
    arguments: &mut impl Iterator<Item = std::ffi::OsString>,
    name: &str,
) -> Result<T, String>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    arguments
        .next()
        .ok_or_else(usage)?
        .to_string_lossy()
        .parse::<T>()
        .map_err(|error| format!("invalid {name}: {error}"))
}

fn run_server(listener: &TcpListener, config: Config) -> Result<ServerMetrics, String> {
    let expected = config
        .connections
        .checked_mul(config.clones)
        .ok_or_else(|| "server connection count overflowed".to_owned())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("cannot make benchmark listener nonblocking: {error}"))?;
    let deadline = Instant::now() + RUN_TIMEOUT;
    let mut workers = Vec::with_capacity(expected);
    while workers.len() < expected {
        match listener.accept() {
            Ok((stream, _)) => {
                workers.push(
                    thread::Builder::new()
                        .name(format!("pvm-socket-peer-{}", workers.len()))
                        .spawn(move || handle_connection(stream, config))
                        .map_err(|error| format!("cannot spawn TCP peer: {error}"))?,
                );
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "accepted only {} of {expected} benchmark connections",
                        workers.len()
                    ));
                }
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(format!("benchmark accept failed: {error}")),
        }
    }

    workers
        .into_iter()
        .try_fold(ServerMetrics::default(), |mut total, worker| {
            let current = worker
                .join()
                .map_err(|_| "benchmark TCP peer panicked".to_owned())??;
            total.connections += current.connections;
            total.payload_bytes += current.payload_bytes;
            total.measured_operations += current.measured_operations;
            total.cpu_ns += current.cpu_ns;
            total.connect_latency_ns.extend(current.connect_latency_ns);
            Ok(total)
        })
}

fn run_ingress_server(
    handles: Vec<SocketIngressHandle>,
    guest_port: u16,
    config: Config,
) -> Result<ServerMetrics, String> {
    let expected = handles
        .len()
        .checked_mul(config.connections)
        .ok_or_else(|| "ingress connection count overflowed".to_owned())?;
    let mut workers = Vec::with_capacity(expected);
    for handle in handles {
        for _ in 0..config.connections {
            let handle = handle.clone();
            workers.push(
                thread::Builder::new()
                    .name(format!("pvm-socket-ingress-peer-{}", workers.len()))
                    .spawn(move || -> Result<ServerMetrics, String> {
                        let cpu_started = thread_cpu_ns()?;
                        let started = Instant::now();
                        let stream = handle.connect_tcp(guest_port).map_err(|error| {
                            format!("cannot inject benchmark TCP stream: {error}")
                        })?;
                        let connect_latency =
                            u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
                        let mut metrics = handle_connection(stream, config)?;
                        metrics.cpu_ns = thread_cpu_ns()?.saturating_sub(cpu_started);
                        metrics.connect_latency_ns.push(connect_latency);
                        Ok(metrics)
                    })
                    .map_err(|error| format!("cannot spawn ingress TCP peer: {error}"))?,
            );
        }
    }
    workers
        .into_iter()
        .try_fold(ServerMetrics::default(), |mut total, worker| {
            let current = worker
                .join()
                .map_err(|_| "ingress benchmark TCP peer panicked".to_owned())??;
            total.connections += current.connections;
            total.payload_bytes += current.payload_bytes;
            total.measured_operations += current.measured_operations;
            total.cpu_ns += current.cpu_ns;
            total.connect_latency_ns.extend(current.connect_latency_ns);
            Ok(total)
        })
}

fn handle_connection(mut stream: TcpStream, config: Config) -> Result<ServerMetrics, String> {
    let cpu_started = thread_cpu_ns()?;
    let mut result = handle_connection_inner(&mut stream, config)?;
    result.cpu_ns = thread_cpu_ns()?.saturating_sub(cpu_started);
    Ok(result)
}

fn handle_connection_inner(
    stream: &mut TcpStream,
    config: Config,
) -> Result<ServerMetrics, String> {
    stream
        .set_read_timeout(Some(RUN_TIMEOUT))
        .map_err(|error| format!("cannot set peer read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(RUN_TIMEOUT))
        .map_err(|error| format!("cannot set peer write timeout: {error}"))?;
    let mut header = [0_u8; HEADER_BYTES];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("cannot read benchmark header: {error}"))?;
    let parsed = parse_header(&header)?;
    if parsed.mode != config.mode.code()
        || parsed.io_size != config.io_size
        || parsed.amount != config.amount
        || parsed.warmup != config.warmup
        || parsed.seed == 0
        || usize::try_from(parsed.seed).unwrap_or(usize::MAX) > config.connections
    {
        return Err("guest benchmark header does not match host configuration".to_owned());
    }
    stream
        .write_all(&[READY_BYTE])
        .map_err(|error| format!("cannot publish benchmark readiness: {error}"))?;
    let mut start = [0_u8; 1];
    stream
        .read_exact(&mut start)
        .map_err(|error| format!("cannot read benchmark start signal: {error}"))?;
    if start[0] != START_BYTE {
        return Err("guest sent an invalid benchmark start signal".to_owned());
    }

    match config.mode {
        Mode::Rr | Mode::RrRate | Mode::IngressRr | Mode::IngressRrRate => {
            serve_rr(stream, config, parsed.seed)
        }
        Mode::StreamTx | Mode::IngressStreamTx => receive_stream(stream, config, parsed.seed),
        Mode::StreamRx | Mode::IngressStreamRx => send_stream(stream, config, parsed.seed),
    }
}

struct ParsedHeader {
    mode: u32,
    io_size: usize,
    amount: u64,
    warmup: u32,
    seed: u32,
}

fn parse_header(header: &[u8; HEADER_BYTES]) -> Result<ParsedHeader, String> {
    if &header[..HEADER_MAGIC.len()] != HEADER_MAGIC {
        return Err("guest sent an invalid benchmark magic".to_owned());
    }
    let mode = u32::from_be_bytes(header[8..12].try_into().expect("fixed header range"));
    let io_size = usize::try_from(u32::from_be_bytes(
        header[12..16].try_into().expect("fixed header range"),
    ))
    .map_err(|_| "guest I/O size does not fit usize".to_owned())?;
    let amount = u64::from_be_bytes(header[16..24].try_into().expect("fixed header range"));
    let warmup = u32::from_be_bytes(header[24..28].try_into().expect("fixed header range"));
    let seed = u32::from_be_bytes(header[28..32].try_into().expect("fixed header range"));
    Ok(ParsedHeader {
        mode,
        io_size,
        amount,
        warmup,
        seed,
    })
}

fn serve_rr(stream: &mut TcpStream, config: Config, seed: u32) -> Result<ServerMetrics, String> {
    let mut payload = vec![0_u8; config.io_size];
    let measured = config.measured_rr_iterations()?;
    let warmup = if matches!(config.mode, Mode::Rr | Mode::IngressRr) {
        u64::from(config.warmup)
    } else {
        0
    };
    let total = measured
        .checked_add(warmup)
        .ok_or_else(|| "RR exchange count overflowed".to_owned())?;
    for _ in 0..total {
        stream
            .read_exact(&mut payload)
            .map_err(|error| format!("cannot receive RR request: {error}"))?;
        verify_pattern(&payload, 0, seed)?;
        delayed(config.server_delay);
        stream
            .write_all(&payload)
            .map_err(|error| format!("cannot send RR response: {error}"))?;
    }
    Ok(ServerMetrics {
        connections: 1,
        payload_bytes: u128::from(measured) * config.io_size as u128 * 2,
        measured_operations: u128::from(measured),
        cpu_ns: 0,
        connect_latency_ns: Vec::new(),
    })
}

fn receive_stream(
    stream: &mut TcpStream,
    config: Config,
    seed: u32,
) -> Result<ServerMetrics, String> {
    let mut buffer = vec![0_u8; config.io_size];
    let mut offset = 0_u64;
    while offset < config.amount {
        let remaining = usize::try_from((config.amount - offset).min(config.io_size as u64))
            .map_err(|_| "stream receive size does not fit usize".to_owned())?;
        stream
            .read_exact(&mut buffer[..remaining])
            .map_err(|error| format!("cannot receive TCP stream: {error}"))?;
        verify_pattern(&buffer[..remaining], offset, seed)?;
        offset += remaining as u64;
        delayed(config.server_delay);
    }
    stream
        .write_all(&[READY_BYTE])
        .map_err(|error| format!("cannot acknowledge TCP stream: {error}"))?;
    Ok(ServerMetrics {
        connections: 1,
        payload_bytes: u128::from(config.amount),
        measured_operations: 0,
        cpu_ns: 0,
        connect_latency_ns: Vec::new(),
    })
}

fn send_stream(stream: &mut TcpStream, config: Config, seed: u32) -> Result<ServerMetrics, String> {
    let mut buffer = vec![0_u8; config.io_size];
    let mut offset = 0_u64;
    while offset < config.amount {
        let remaining = usize::try_from((config.amount - offset).min(config.io_size as u64))
            .map_err(|_| "stream transmit size does not fit usize".to_owned())?;
        fill_pattern(&mut buffer[..remaining], offset, seed);
        stream
            .write_all(&buffer[..remaining])
            .map_err(|error| format!("cannot send TCP stream: {error}"))?;
        offset += remaining as u64;
        delayed(config.server_delay);
    }
    let mut acknowledgement = [0_u8; 1];
    stream
        .read_exact(&mut acknowledgement)
        .map_err(|error| format!("cannot read TCP stream acknowledgement: {error}"))?;
    if acknowledgement[0] != READY_BYTE {
        return Err("guest sent an invalid stream acknowledgement".to_owned());
    }
    Ok(ServerMetrics {
        connections: 1,
        payload_bytes: u128::from(config.amount),
        measured_operations: 0,
        cpu_ns: 0,
        connect_latency_ns: Vec::new(),
    })
}

fn pattern_byte(position: u64, seed: u32) -> u8 {
    u8::try_from((position * 131 + u64::from(seed) * 17 + 29) % 251)
        .expect("pattern byte is bounded")
}

fn fill_pattern(buffer: &mut [u8], offset: u64, seed: u32) {
    for (index, byte) in buffer.iter_mut().enumerate() {
        *byte = pattern_byte(offset + index as u64, seed);
    }
}

fn verify_pattern(buffer: &[u8], offset: u64, seed: u32) -> Result<(), String> {
    for (index, byte) in buffer.iter().copied().enumerate() {
        let position = offset + index as u64;
        let expected = pattern_byte(position, seed);
        if byte != expected {
            return Err(format!(
                "payload mismatch at byte {position}: received {byte}, expected {expected}"
            ));
        }
    }
    Ok(())
}

fn delayed(duration: Duration) {
    if !duration.is_zero() {
        thread::sleep(duration);
    }
}

fn publish_batch(
    config: Config,
    results: &[PvmLinuxCloneResult],
    server: &ServerMetrics,
    batch_wall_ns: u128,
    usage: ResourceUsage,
) -> Result<(), String> {
    let metric_key = if config.mode.is_rr() {
        "iterations"
    } else {
        "total_bytes"
    };
    let rate_key = if config.mode.is_rr() {
        "ops_per_sec"
    } else {
        "mib_per_sec"
    };
    let mut guest_work = 0_u128;
    let mut guest_rate_sum = 0.0_f64;
    let mut private_pages = 0_usize;
    let mut socket_stats = BrokerStats::default();
    for result in results {
        let line = guest_result_line(&result.output)?;
        guest_work += u128::from(metric_u64(line, metric_key)?);
        guest_rate_sum += metric_f64(line, rate_key)?;
        private_pages += result.private_pages;
        add_broker_stats(&mut socket_stats, result.socket_stats);
    }
    if server.connections != config.connections * config.clones {
        return Err("server completed an unexpected number of connections".to_owned());
    }
    let mut connect_latency_ns = server.connect_latency_ns.clone();
    connect_latency_ns.sort_unstable();
    let connect_p50_ns = sample_percentile(&connect_latency_ns, 50, 100);
    let connect_p99_ns = sample_percentile(&connect_latency_ns, 99, 100);
    let connect_max_ns = connect_latency_ns.last().copied().unwrap_or_default();
    let nonserver_cpu_ns = usage.cpu_ns.saturating_sub(server.cpu_ns);
    let other_runtime_cpu_ns =
        nonserver_cpu_ns.saturating_sub(u128::from(socket_stats.broker_cpu_ns));
    println!(
        "{{\"kind\":\"batch\",\"mode\":\"{}\",\"io_bytes\":{},\"connections_per_clone\":{},\"clones\":{},\"amount_per_connection\":{},\"server_delay_us\":{},\"rate_duration_ms\":{},\"batch_wall_ns\":{batch_wall_ns},\"host_cpu_ns\":{},\"server_cpu_ns\":{},\"nonserver_cpu_ns\":{nonserver_cpu_ns},\"broker_cpu_ns\":{},\"other_runtime_cpu_ns\":{other_runtime_cpu_ns},\"voluntary_cs\":{},\"involuntary_cs\":{},\"guest_work\":{guest_work},\"guest_rate_sum\":{guest_rate_sum:.3},\"server_payload_bytes\":{},\"server_operations\":{},\"private_pages\":{private_pages},\"connect_samples\":{},\"connect_p50_ns\":{connect_p50_ns},\"connect_p99_ns\":{connect_p99_ns},\"connect_max_ns\":{connect_max_ns},\"guest_doorbells\":{},\"guest_irq_injections\":{},\"poll_wakeups\":{},\"reactor_turns\":{},\"commands_drained\":{},\"events_published\":{},\"tx_slots\":{},\"tx_bytes\":{},\"rx_slots\":{},\"rx_bytes\":{}}}",
        config.mode.name(),
        config.io_size,
        config.connections,
        config.clones,
        config.amount,
        config.server_delay.as_micros(),
        if config.mode.is_fixed_rate() {
            config.warmup
        } else {
            0
        },
        usage.cpu_ns,
        server.cpu_ns,
        socket_stats.broker_cpu_ns,
        usage.voluntary,
        usage.involuntary,
        server.payload_bytes,
        server.measured_operations,
        connect_latency_ns.len(),
        socket_stats.guest_doorbells,
        socket_stats.guest_irq_injections,
        socket_stats.poll_wakeups,
        socket_stats.reactor_turns,
        socket_stats.commands_drained,
        socket_stats.events_published,
        socket_stats.tx_slots,
        socket_stats.tx_bytes,
        socket_stats.rx_slots,
        socket_stats.rx_bytes,
    );
    for (index, result) in results.iter().enumerate() {
        println!(
            "guest[{index}] create_ns={} resume_ns={} completion_ns={} private_pages={} reports={} reclaimed_pages={} broker_cpu_ns={} doorbells={} guest_irqs={} poll_wakeups={} reactor_turns={} {}",
            result.create_latency.as_nanos(),
            result.resume_latency.as_nanos(),
            result.completion_latency.as_nanos(),
            result.private_pages,
            result.page_reports,
            result.reclaimed_pages,
            result.socket_stats.broker_cpu_ns,
            result.socket_stats.guest_doorbells,
            result.socket_stats.guest_irq_injections,
            result.socket_stats.poll_wakeups,
            result.socket_stats.reactor_turns,
            guest_result_line(&result.output)?,
        );
    }
    Ok(())
}

fn sample_percentile(samples: &[u64], numerator: usize, denominator: usize) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let rank = samples
        .len()
        .saturating_mul(numerator)
        .div_ceil(denominator)
        .clamp(1, samples.len());
    samples[rank - 1]
}

fn add_broker_stats(total: &mut BrokerStats, current: BrokerStats) {
    total.guest_doorbells = total
        .guest_doorbells
        .saturating_add(current.guest_doorbells);
    total.poll_wakeups = total.poll_wakeups.saturating_add(current.poll_wakeups);
    total.reactor_turns = total.reactor_turns.saturating_add(current.reactor_turns);
    total.commands_drained = total
        .commands_drained
        .saturating_add(current.commands_drained);
    total.events_published = total
        .events_published
        .saturating_add(current.events_published);
    total.guest_irq_injections = total
        .guest_irq_injections
        .saturating_add(current.guest_irq_injections);
    total.tx_slots = total.tx_slots.saturating_add(current.tx_slots);
    total.tx_bytes = total.tx_bytes.saturating_add(current.tx_bytes);
    total.rx_slots = total.rx_slots.saturating_add(current.rx_slots);
    total.rx_bytes = total.rx_bytes.saturating_add(current.rx_bytes);
    total.broker_cpu_ns = total.broker_cpu_ns.saturating_add(current.broker_cpu_ns);
}

fn guest_result_line(output: &[u8]) -> Result<&str, String> {
    let text = std::str::from_utf8(output)
        .map_err(|error| format!("guest output is not UTF-8: {error}"))?;
    if let Some(failure) = text
        .lines()
        .find(|line| line.starts_with("MSSOCKBENCH_FAIL "))
    {
        return Err(format!("guest benchmark failed: {failure}"));
    }
    text.lines()
        .find(|line| line.starts_with("MSSOCKBENCH_RESULT "))
        .ok_or_else(|| "guest omitted MSSOCKBENCH_RESULT".to_owned())
}

fn metric_u64(line: &str, key: &str) -> Result<u64, String> {
    metric_text(line, key)?
        .parse::<u64>()
        .map_err(|error| format!("invalid {key} metric: {error}"))
}

fn metric_f64(line: &str, key: &str) -> Result<f64, String> {
    metric_text(line, key)?
        .parse::<f64>()
        .map_err(|error| format!("invalid {key} metric: {error}"))
}

fn metric_text<'a>(line: &'a str, key: &str) -> Result<&'a str, String> {
    let prefix = format!("{key}=");
    line.split_ascii_whitespace()
        .find_map(|field| field.strip_prefix(&prefix))
        .ok_or_else(|| format!("guest result omitted {key}: {line}"))
}

#[derive(Clone, Copy)]
struct ResourceUsage {
    cpu_ns: u128,
    voluntary: i64,
    involuntary: i64,
}

impl ResourceUsage {
    fn capture() -> Result<Self, String> {
        // SAFETY: `usage` is writable storage and `RUSAGE_SELF` aggregates all
        // host threads owned by this standalone benchmark process.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &raw mut usage) } != 0 {
            return Err(format!(
                "getrusage failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self {
            cpu_ns: timeval_ns(usage.ru_utime) + timeval_ns(usage.ru_stime),
            voluntary: usage.ru_nvcsw,
            involuntary: usage.ru_nivcsw,
        })
    }

    fn delta(self, previous: Self) -> Self {
        Self {
            cpu_ns: self.cpu_ns.saturating_sub(previous.cpu_ns),
            voluntary: self.voluntary.saturating_sub(previous.voluntary),
            involuntary: self.involuntary.saturating_sub(previous.involuntary),
        }
    }
}

fn timeval_ns(value: libc::timeval) -> u128 {
    u128::try_from(value.tv_sec).unwrap_or_default() * 1_000_000_000
        + u128::try_from(value.tv_usec).unwrap_or_default() * 1_000
}

fn thread_cpu_ns() -> Result<u128, String> {
    let mut value = std::mem::MaybeUninit::<libc::timespec>::uninit();
    // SAFETY: `value` is writable storage for one complete `timespec`.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, value.as_mut_ptr()) } != 0 {
        return Err(format!(
            "thread CPU clock failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: successful `clock_gettime` initialized the complete value.
    let value = unsafe { value.assume_init() };
    Ok(
        u128::try_from(value.tv_sec).unwrap_or_default() * 1_000_000_000
            + u128::try_from(value.tv_nsec).unwrap_or_default(),
    )
}

fn usage() -> String {
    "usage: pvm-linux-socket-bench <bzImage> <root.erofs> <tcp-rr|tcp-rr-rate|tcp-stream-tx|tcp-stream-rx|ingress-tcp-rr|ingress-tcp-rr-rate|ingress-tcp-stream-tx|ingress-tcp-stream-rx> <io-bytes> <connections-per-clone> <clones> <RR-iterations, target-RR/s, or stream-bytes per connection> <server-delay-us, or duration-ms for *tcp-rr-rate>".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        Config, HEADER_BYTES, HEADER_MAGIC, Mode, fill_pattern, parse_header, verify_pattern,
    };
    use std::time::Duration;

    #[test]
    fn parses_fixed_wire_header() {
        let mut header = [0_u8; HEADER_BYTES];
        header[..8].copy_from_slice(HEADER_MAGIC);
        header[8..12].copy_from_slice(&1_u32.to_be_bytes());
        header[12..16].copy_from_slice(&1024_u32.to_be_bytes());
        header[16..24].copy_from_slice(&10_000_u64.to_be_bytes());
        header[24..28].copy_from_slice(&1000_u32.to_be_bytes());
        header[28..32].copy_from_slice(&7_u32.to_be_bytes());

        let parsed = parse_header(&header).expect("valid header");
        assert_eq!(parsed.mode, 1);
        assert_eq!(parsed.io_size, 1024);
        assert_eq!(parsed.amount, 10_000);
        assert_eq!(parsed.warmup, 1000);
        assert_eq!(parsed.seed, 7);
    }

    #[test]
    fn rejects_invalid_wire_magic() {
        let header = [0_u8; HEADER_BYTES];
        assert!(parse_header(&header).is_err());
    }

    #[test]
    fn deterministic_pattern_detects_corruption() {
        let mut payload = [0_u8; 4096];
        fill_pattern(&mut payload, 12_345, 9);
        verify_pattern(&payload, 12_345, 9).expect("matching payload");
        payload[997] ^= 1;
        assert!(verify_pattern(&payload, 12_345, 9).is_err());
    }

    #[test]
    fn fixed_rate_work_is_bounded_and_exact() {
        let config = Config {
            mode: Mode::RrRate,
            io_size: 32,
            connections: 1,
            clones: 1,
            amount: 1_000,
            warmup: 5_000,
            server_delay: Duration::ZERO,
        };
        assert_eq!(config.measured_rr_iterations().unwrap(), 5_000);
    }
}
