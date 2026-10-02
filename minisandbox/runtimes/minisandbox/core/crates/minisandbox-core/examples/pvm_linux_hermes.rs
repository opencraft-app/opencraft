//! Boot the pinned whole-process Hermes Agent profile with an unprivileged runtime user.

#[path = "pvm_linux_hermes/mock_openai.rs"]
mod mock_openai;

use std::{
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant},
};

use http_body_util::{BodyExt, Empty};
use hyper::{Request, body::Bytes, header};
use hyper_util::rt::TokioIo;

use minisandbox_core::{
    control::{CommandSpec, SandboxControl},
    engine::{
        Engine, HOST_LOOPBACK_ALIAS, PvmBlockPool, PvmLinuxCloneResult, PvmLinuxInstance,
        PvmLinuxTemplate, PvmReadOnlyImage, RunOptions, RunOutcome,
    },
    pvm_linux::{MAX_PVM_LINUX_MEMORY_SIZE, READ_ONLY_APP_GPA, READ_ONLY_ROOTFS_GPA},
};
use minisandbox_pvm_sys::{PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 acpi=off pci=off noapic clocksource=tsc tsc=reliable quiet loglevel=3";
const DEFAULT_MEMORY_MIB: usize = 2048;
const DEFAULT_SHM_MIB: usize = 1024;
const MAX_MEMORY_MIB: usize = MAX_PVM_LINUX_MEMORY_SIZE / (1024 * 1024);
const MAX_STARTUP_CLONES: usize = 64;
// Product runners enter once with a coarse safety deadline. Lifecycle control
// uses the explicit one-shot cancellation capability rather than polling.
const PRODUCT_RUN_DEADLINE: Duration = Duration::from_mins(10);
const RESUMED_MARKER: &[u8] = b"MINISANDBOX_HERMES_RESUMED";
const E2E_MODEL: &str = "minisandbox-e2e";
const E2E_PROMPT: &str =
    "MINISANDBOX_HERMES_E2E_PROMPT: reply with exactly MINISANDBOX_HERMES_E2E_OK";
const REAL_E2E_MARKER: &[u8] = b"MINISANDBOX_HERMES_REAL_E2E_OK";
const REAL_E2E_PROMPT: &str = "Reply with exactly MINISANDBOX_HERMES_REAL_E2E_OK";
const GATEWAY_API_PORT: u16 = 8642;
const GATEWAY_API_KEY: &str = "minisandbox-hermes-gateway-e2e-key";
const GATEWAY_PARALLEL_CLIENTS: usize = 4;

struct HermesArguments {
    kernel_path: PathBuf,
    base_path: PathBuf,
    app_path: PathBuf,
    upper_path: PathBuf,
    pool_path: PathBuf,
    memory_mib: usize,
    startup_clones: Option<usize>,
    concurrent_startup: bool,
    concurrent_chat_clones: Option<usize>,
    concurrent_warm_chat_clones: Option<usize>,
    concurrent_gateway_clones: Option<usize>,
    real_chat: Option<RealChatArguments>,
}

struct RealChatArguments {
    provider: String,
    model: String,
    credential_env: String,
    credential: OsString,
}

struct ChatCloneResult {
    index: usize,
    create_latency: Duration,
    ready_latency: Duration,
    process_to_answer: Duration,
    clone_to_answer: Duration,
}

struct GatewayCloneResult {
    index: usize,
    create_latency: Duration,
    control_ready_latency: Duration,
    gateway_ready_latency: Duration,
    total_latency: Duration,
}

#[derive(Clone, Copy)]
enum ChatMode {
    FreshProcess,
    WarmDaemon,
}

impl ChatMode {
    const fn name(self) -> &'static str {
        match self {
            Self::FreshProcess => "fresh-process",
            Self::WarmDaemon => "warm-daemon",
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-hermes: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let HermesArguments {
        kernel_path,
        base_path,
        app_path,
        upper_path,
        pool_path,
        memory_mib,
        startup_clones,
        concurrent_startup,
        concurrent_chat_clones,
        concurrent_warm_chat_clones,
        concurrent_gateway_clones,
        real_chat,
    } = parse_arguments()?;
    let memory_size = memory_mib
        .checked_mul(1024 * 1024)
        .ok_or_else(|| "Hermes memory size overflowed".to_owned())?;
    let shm_mib = DEFAULT_SHM_MIB.min(memory_mib / 2).max(32);

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.display()))?;
    let base = open_read_only_image(&base_path, "base")?;
    let app = open_read_only_image(&app_path, "Hermes application")?;
    let upper = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&upper_path)
        .map_err(|error| format!("cannot open {} read-write: {error}", upper_path.display()))?;
    fs::create_dir_all(&pool_path)
        .map_err(|error| format!("cannot create {}: {error}", pool_path.display()))?;
    let pool_directory = fs::File::open(&pool_path)
        .map_err(|error| format!("cannot open {}: {error}", pool_path.display()))?;
    let pool = PvmBlockPool::from_directory(pool_directory)
        .map_err(|error| format!("cannot create block pool: {error}"))?;

    let command_line = format!(
        "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} \
         memmap={:#x}!{READ_ONLY_APP_GPA:#x} \
         root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
         init=/sbin/minisandbox-init minisandbox.overlay=1 minisandbox.app_layer=1 \
         minisandbox.shm_mib={shm_mib} \
         virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}",
        base.len(),
        app.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let template = engine
        .warm_pvm_linux_template_with_layered_storage(
            &kernel,
            &[],
            command_line.as_bytes(),
            memory_size,
            &base,
            &app,
            upper,
            &pool,
            RunOptions {
                timeout: Duration::from_mins(3),
            },
        )
        .map_err(|error| format!("cannot warm Hermes template: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    if !contains(template.warm_output(), b"MINISANDBOX_HERMES_WARM_READY") {
        return Err("Hermes warm probe did not publish its revision marker".to_owned());
    }
    eprintln!(
        "Hermes template: memory_mib={memory_mib} shm_mib={shm_mib} warm={:?} snapshot={:?} block={:?}",
        template.warmup_latency(),
        template.snapshot_latency(),
        template.block_snapshot_method()
    );
    if let Some(clone_count) = startup_clones {
        return benchmark_startup(&engine, &template, clone_count, concurrent_startup);
    }
    if let Some(clone_count) = concurrent_chat_clones {
        return benchmark_chat_concurrently(
            &engine,
            &template,
            clone_count,
            ChatMode::FreshProcess,
        );
    }
    if let Some(clone_count) = concurrent_warm_chat_clones {
        return benchmark_chat_concurrently(&engine, &template, clone_count, ChatMode::WarmDaemon);
    }
    if let Some(clone_count) = concurrent_gateway_clones {
        return benchmark_gateway_concurrently(&engine, &template, clone_count);
    }
    if let Some(real_chat) = real_chat {
        return benchmark_real_chat(&engine, &template, &real_chat);
    }

    let instance = engine
        .clone_pvm_linux_template(&template)
        .map_err(|error| format!("cannot clone Hermes template: {error:?}"))?;
    with_running_instance(instance, |control, _ingress| exercise_hermes(control))?;
    let daemon = engine
        .clone_pvm_linux_template(&template)
        .map_err(|error| format!("cannot clone Hermes daemon template: {error:?}"))?;
    with_running_instance(daemon, exercise_gateway_daemon)?;
    Ok(())
}

fn open_read_only_image(path: &Path, label: &str) -> Result<PvmReadOnlyImage, String> {
    let file =
        fs::File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    PvmReadOnlyImage::from_file(file).map_err(|error| format!("cannot map {label} EROFS: {error}"))
}

fn with_running_instance<T>(
    mut instance: PvmLinuxInstance,
    operation: impl FnOnce(
        &SandboxControl,
        &pvm_socket_service::SocketIngressHandle,
    ) -> Result<T, String>,
) -> Result<T, String> {
    let control = instance.sandbox_control();
    let ingress = instance.socket_ingress();
    let canceller = instance.run_canceller();
    std::thread::scope(|scope| {
        let runner = scope.spawn(move || -> Result<Vec<u8>, String> {
            let run = instance
                .run_for(RunOptions {
                    timeout: PRODUCT_RUN_DEADLINE,
                })
                .map_err(|error| format!("Hermes PVM runner failed: {error:?}"))?;
            if run.outcome != RunOutcome::Cancelled {
                return Err(format!(
                    "Hermes clone unexpectedly stopped: {:?}",
                    run.outcome
                ));
            }
            Ok(run.output)
        });
        let result = operation(&control, &ingress);
        let cancellation = canceller
            .cancel()
            .map_err(|error| format!("cannot cancel Hermes PVM runner: {error}"));
        let output = runner
            .join()
            .map_err(|_| "Hermes PVM runner panicked".to_owned())??;
        cancellation?;
        print!("{}", String::from_utf8_lossy(&output));
        result
    })
}

fn parse_arguments() -> Result<HermesArguments, String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let base_path = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let app_path = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let upper_path = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let pool_path = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let memory_mib = arguments
        .next()
        .map(|value| {
            value
                .to_string_lossy()
                .parse::<usize>()
                .map_err(|error| format!("invalid memory MiB: {error}"))
        })
        .transpose()?
        .unwrap_or(DEFAULT_MEMORY_MIB);
    let mut startup_clones = None;
    let mut concurrent_startup = false;
    let mut concurrent_chat_clones = None;
    let mut concurrent_warm_chat_clones = None;
    let mut concurrent_gateway_clones = None;
    let mut real_chat = None;
    if let Some(flag) = arguments.next() {
        match flag.to_str() {
            Some("--startup-clones" | "--concurrent-startup-clones") => {
                concurrent_startup = flag == "--concurrent-startup-clones";
                startup_clones = Some(parse_clone_count(&mut arguments)?);
            }
            Some("--concurrent-chat-clones") => {
                concurrent_chat_clones = Some(parse_clone_count(&mut arguments)?);
            }
            Some("--concurrent-warm-chat-clones") => {
                concurrent_warm_chat_clones = Some(parse_clone_count(&mut arguments)?);
            }
            Some("--concurrent-gateway-clones") => {
                concurrent_gateway_clones = Some(parse_clone_count(&mut arguments)?);
            }
            Some("--real-chat") => {
                real_chat = Some(parse_real_chat(&mut arguments)?);
            }
            _ => return Err(usage()),
        }
    }
    if !(1024..=MAX_MEMORY_MIB).contains(&memory_mib)
        || startup_clones
            .or(concurrent_chat_clones)
            .or(concurrent_warm_chat_clones)
            .or(concurrent_gateway_clones)
            .is_some_and(|count| !(1..=MAX_STARTUP_CLONES).contains(&count))
        || arguments.next().is_some()
    {
        return Err(usage());
    }
    Ok(HermesArguments {
        kernel_path,
        base_path,
        app_path,
        upper_path,
        pool_path,
        memory_mib,
        startup_clones,
        concurrent_startup,
        concurrent_chat_clones,
        concurrent_warm_chat_clones,
        concurrent_gateway_clones,
        real_chat,
    })
}

fn parse_clone_count(arguments: &mut impl Iterator<Item = OsString>) -> Result<usize, String> {
    arguments
        .next()
        .ok_or_else(usage)?
        .to_string_lossy()
        .parse::<usize>()
        .map_err(|error| format!("invalid clone count: {error}"))
}

fn parse_real_chat(
    arguments: &mut impl Iterator<Item = OsString>,
) -> Result<RealChatArguments, String> {
    let provider = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(usage)?;
    let model = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(usage)?;
    let credential_env = arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(usage)?;
    let allowed = matches!(
        (provider.as_str(), credential_env.as_str()),
        ("openrouter", "OPENROUTER_API_KEY")
            | ("openai-api", "OPENAI_API_KEY")
            | ("anthropic", "ANTHROPIC_API_KEY")
            | ("gemini", "GEMINI_API_KEY")
            | ("xai", "XAI_API_KEY")
            | ("deepseek", "DEEPSEEK_API_KEY")
            | ("mistral", "MISTRAL_API_KEY")
            | ("together", "TOGETHER_API_KEY")
    );
    if !allowed {
        return Err(format!(
            "credential environment {credential_env} is not allowlisted for Hermes provider {provider}"
        ));
    }
    if model.is_empty()
        || model.len() > 256
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
    {
        return Err("real-chat model must be a 1..256-byte provider model token".to_owned());
    }
    let credential = env::var(&credential_env)
        .ok()
        .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)
        .map(OsString::from)
        .ok_or_else(|| {
            format!("{credential_env} is missing, non-UTF-8, empty, or larger than 16 KiB")
        })?;
    Ok(RealChatArguments {
        provider,
        model,
        credential_env,
        credential,
    })
}

fn benchmark_startup(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    clone_count: usize,
    concurrent: bool,
) -> Result<(), String> {
    let started = Instant::now();
    let options = RunOptions {
        timeout: Duration::from_secs(5),
    };
    let results = if concurrent {
        benchmark_startup_concurrently(engine, template, clone_count, options)
    } else {
        engine
            .benchmark_pvm_linux_clones(
                template,
                clone_count,
                RESUMED_MARKER,
                RESUMED_MARKER,
                options,
            )
            .map_err(|error| format!("Hermes startup benchmark failed: {error:?}"))
    }?;
    let batch = started.elapsed();
    let mut create_micros = Vec::with_capacity(results.len());
    let mut resume_micros = Vec::with_capacity(results.len());
    let mut ready_micros = Vec::with_capacity(results.len());
    for (index, result) in results.iter().enumerate() {
        let create = result.create_latency.as_micros();
        let resume = result.resume_latency.as_micros();
        create_micros.push(create);
        resume_micros.push(resume);
        ready_micros.push(create + resume);
        println!(
            "HERMES_STARTUP concurrent={concurrent} clone={index} create_us={create} resume_us={resume} private_kib={}",
            result.private_pages * 4
        );
    }
    create_micros.sort_unstable();
    resume_micros.sort_unstable();
    ready_micros.sort_unstable();
    println!(
        "MINISANDBOX_HERMES_STARTUP_OK concurrent={concurrent} clones={} batch_ms={:.3} create_p50_us={} create_max_us={} resume_p50_us={} resume_max_us={} ready_p50_us={} ready_max_us={}",
        results.len(),
        batch.as_secs_f64() * 1_000.0,
        percentile(&create_micros, 50),
        create_micros.last().copied().unwrap_or_default(),
        percentile(&resume_micros, 50),
        resume_micros.last().copied().unwrap_or_default(),
        percentile(&ready_micros, 50),
        ready_micros.last().copied().unwrap_or_default(),
    );
    Ok(())
}

fn benchmark_startup_concurrently(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    clone_count: usize,
    options: RunOptions,
) -> Result<Vec<PvmLinuxCloneResult>, String> {
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..clone_count)
            .map(|_| {
                scope.spawn(|| {
                    let mut instance = engine
                        .clone_pvm_linux_template(template)
                        .map_err(|error| format!("cannot create Hermes clone: {error:?}"))?;
                    instance
                        .run_until_markers(RESUMED_MARKER, RESUMED_MARKER, options)
                        .map_err(|error| format!("cannot resume Hermes clone: {error:?}"))
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| "Hermes startup worker panicked".to_owned())?
            })
            .collect()
    })
}

fn benchmark_chat_concurrently(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    clone_count: usize,
    mode: ChatMode,
) -> Result<(), String> {
    let provider = mock_openai::MockOpenAiServer::start(clone_count)?;
    let base_url = format!("http://{}:{}/v1", HOST_LOOPBACK_ALIAS, provider.port());
    let batch_started = Instant::now();
    let results: Vec<ChatCloneResult> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..clone_count)
            .map(|index| {
                let base_url = &base_url;
                scope.spawn(move || {
                    let clone_started = Instant::now();
                    let instance = engine
                        .clone_pvm_linux_template(template)
                        .map_err(|error| format!("cannot create Hermes chat clone: {error:?}"))?;
                    let create_latency = clone_started.elapsed();
                    let (ready_latency, process_to_answer, clone_to_answer) =
                        with_running_instance(instance, |control, _ingress| {
                            control.ping(Duration::from_secs(10)).map_err(|error| {
                                format!("Hermes chat clone control ping failed: {error}")
                            })?;
                            let ready_latency = clone_started.elapsed();
                            let process_to_answer = match mode {
                                ChatMode::FreshProcess => execute_local_chat(control, base_url)?,
                                ChatMode::WarmDaemon => execute_warm_local_chat(control, base_url)?,
                            };
                            Ok((ready_latency, process_to_answer, clone_started.elapsed()))
                        })?;
                    Ok(ChatCloneResult {
                        index,
                        create_latency,
                        ready_latency,
                        process_to_answer,
                        clone_to_answer,
                    })
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| "Hermes chat worker panicked".to_owned())?
            })
            .collect::<Result<Vec<_>, String>>()
    })?;
    let batch_latency = batch_started.elapsed();
    let report = provider.finish()?;
    if report.chat_requests != clone_count {
        return Err(format!(
            "mock provider received {} chats, expected {clone_count}",
            report.chat_requests
        ));
    }

    let mut create_micros = Vec::with_capacity(results.len());
    let mut ready_micros = Vec::with_capacity(results.len());
    let mut process_micros = Vec::with_capacity(results.len());
    let mut answer_micros = Vec::with_capacity(results.len());
    for result in &results {
        let create = result.create_latency.as_micros();
        let ready = result.ready_latency.as_micros();
        let process = result.process_to_answer.as_micros();
        let answer = result.clone_to_answer.as_micros();
        create_micros.push(create);
        ready_micros.push(ready);
        process_micros.push(process);
        answer_micros.push(answer);
        println!(
            "HERMES_CHAT mode={} clone={} create_us={create} ready_us={ready} process_to_answer_us={process} clone_to_answer_us={answer}",
            mode.name(),
            result.index
        );
    }
    create_micros.sort_unstable();
    ready_micros.sort_unstable();
    process_micros.sort_unstable();
    answer_micros.sort_unstable();
    println!(
        "MINISANDBOX_HERMES_CHAT_BENCH_OK mode={} clones={} batch_ms={:.3} create_p50_us={} create_max_us={} ready_p50_us={} ready_max_us={} process_to_answer_p50_us={} process_to_answer_max_us={} clone_to_answer_p50_us={} clone_to_answer_max_us={} provider_first_request_ms={:.3} provider_requests={}",
        mode.name(),
        results.len(),
        batch_latency.as_secs_f64() * 1_000.0,
        percentile(&create_micros, 50),
        create_micros.last().copied().unwrap_or_default(),
        percentile(&ready_micros, 50),
        ready_micros.last().copied().unwrap_or_default(),
        percentile(&process_micros, 50),
        process_micros.last().copied().unwrap_or_default(),
        percentile(&answer_micros, 50),
        answer_micros.last().copied().unwrap_or_default(),
        report.first_chat_request.unwrap_or_default().as_secs_f64() * 1_000.0,
        report.requests,
    );
    Ok(())
}

fn benchmark_gateway_concurrently(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    clone_count: usize,
) -> Result<(), String> {
    let batch_started = Instant::now();
    let results: Vec<GatewayCloneResult> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..clone_count)
            .map(|index| {
                scope.spawn(move || {
                    let clone_started = Instant::now();
                    let instance = engine
                        .clone_pvm_linux_template(template)
                        .map_err(|error| format!("cannot create Hermes daemon clone: {error:?}"))?;
                    let create_latency = clone_started.elapsed();
                    let (ready_latency, gateway_latency, clone_to_gateway_ready) =
                        with_running_instance(instance, |control, _ingress| {
                            control.ping(Duration::from_secs(10)).map_err(|error| {
                                format!("Hermes daemon clone control ping failed: {error}")
                            })?;
                            let ready_latency = clone_started.elapsed();
                            let gateway_latency = launch_gateway(control, false)?;
                            Ok((ready_latency, gateway_latency, clone_started.elapsed()))
                        })?;
                    Ok(GatewayCloneResult {
                        index,
                        create_latency,
                        control_ready_latency: ready_latency,
                        gateway_ready_latency: gateway_latency,
                        total_latency: clone_to_gateway_ready,
                    })
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| "Hermes daemon benchmark worker panicked".to_owned())?
            })
            .collect::<Result<Vec<_>, String>>()
    })?;
    let batch_latency = batch_started.elapsed();
    let mut create_micros = Vec::with_capacity(results.len());
    let mut control_micros = Vec::with_capacity(results.len());
    let mut gateway_micros = Vec::with_capacity(results.len());
    let mut total_micros = Vec::with_capacity(results.len());
    for result in &results {
        let create = result.create_latency.as_micros();
        let control = result.control_ready_latency.as_micros();
        let gateway = result.gateway_ready_latency.as_micros();
        let total = result.total_latency.as_micros();
        create_micros.push(create);
        control_micros.push(control);
        gateway_micros.push(gateway);
        total_micros.push(total);
        println!(
            "HERMES_GATEWAY clone={} create_us={create} control_ready_us={control} gateway_ready_us={gateway} clone_to_gateway_ready_us={total}",
            result.index
        );
    }
    create_micros.sort_unstable();
    control_micros.sort_unstable();
    gateway_micros.sort_unstable();
    total_micros.sort_unstable();
    println!(
        "MINISANDBOX_HERMES_GATEWAY_BENCH_OK clones={} batch_ms={:.3} create_p50_us={} create_max_us={} control_ready_p50_us={} control_ready_max_us={} gateway_ready_p50_us={} gateway_ready_max_us={} clone_to_gateway_ready_p50_us={} clone_to_gateway_ready_max_us={}",
        results.len(),
        batch_latency.as_secs_f64() * 1_000.0,
        percentile(&create_micros, 50),
        create_micros.last().copied().unwrap_or_default(),
        percentile(&control_micros, 50),
        control_micros.last().copied().unwrap_or_default(),
        percentile(&gateway_micros, 50),
        gateway_micros.last().copied().unwrap_or_default(),
        percentile(&total_micros, 50),
        total_micros.last().copied().unwrap_or_default(),
    );
    Ok(())
}

fn benchmark_real_chat(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    real_chat: &RealChatArguments,
) -> Result<(), String> {
    let clone_started = Instant::now();
    let instance = engine
        .clone_pvm_linux_template(template)
        .map_err(|error| format!("cannot create Hermes real-chat clone: {error:?}"))?;
    let create_latency = clone_started.elapsed();
    let (ready_latency, process_to_answer, clone_to_answer, response_bytes) =
        with_running_instance(instance, |control, _ingress| {
            control
                .ping(Duration::from_secs(10))
                .map_err(|error| format!("Hermes real-chat control ping failed: {error}"))?;
            let ready_latency = clone_started.elapsed();
            let process_started = Instant::now();
            let chat = control
                .execute(
                    &hermes_command("/opt/hermes/.venv/bin/hermes")
                        .args([
                            "-z",
                            REAL_E2E_PROMPT,
                            "--provider",
                            &real_chat.provider,
                            "--model",
                            &real_chat.model,
                            "--ignore-user-config",
                            "--ignore-rules",
                        ])
                        .env(
                            real_chat.credential_env.clone(),
                            real_chat.credential.clone(),
                        ),
                    Duration::from_mins(5),
                )
                .map_err(|error| format!("Hermes real-provider chat failed: {error}"))?;
            let process_to_answer = process_started.elapsed();
            if chat.exit_code != 0 || !contains(&chat.stdout, REAL_E2E_MARKER) {
                return Err(format!(
                    "Hermes real provider did not return the requested marker: exit={} stdout_bytes={} stderr_bytes={}",
                    chat.exit_code,
                    chat.stdout.len(),
                    chat.stderr.len()
                ));
            }
            Ok((
                ready_latency,
                process_to_answer,
                clone_started.elapsed(),
                chat.stdout.len(),
            ))
        })?;
    println!(
        "MINISANDBOX_HERMES_REAL_E2E_OK provider={} model={} create_ms={:.3} ready_ms={:.3} process_to_answer_ms={:.3} clone_to_answer_ms={:.3} response_bytes={response_bytes}",
        real_chat.provider,
        real_chat.model,
        create_latency.as_secs_f64() * 1_000.0,
        ready_latency.as_secs_f64() * 1_000.0,
        process_to_answer.as_secs_f64() * 1_000.0,
        clone_to_answer.as_secs_f64() * 1_000.0,
    );
    Ok(())
}

fn percentile(samples: &[u128], percentile: usize) -> u128 {
    let index = samples
        .len()
        .saturating_mul(percentile)
        .div_ceil(100)
        .saturating_sub(1);
    samples.get(index).copied().unwrap_or_default()
}

fn exercise_hermes(control: &SandboxControl) -> Result<(), String> {
    control
        .ping(Duration::from_secs(3))
        .map_err(|error| format!("Hermes control ping failed: {error}"))?;
    let identity = control
        .execute(
            &hermes_command("/usr/bin/id").arg("-u"),
            Duration::from_secs(5),
        )
        .map_err(|error| format!("Hermes identity check failed: {error}"))?;
    if identity.stdout != b"10000\n" || identity.exit_code != 0 {
        return Err(format!("Hermes did not run as UID 10000: {identity:?}"));
    }

    let permissions = control
        .execute(
            &hermes_command("/bin/sh").args([
                "-c",
                "set -eu; test ! -w /opt/hermes; test ! -r /dev/minisandbox; touch /opt/data/.minisandbox-write-test; rm /opt/data/.minisandbox-write-test; printf HERMES_PERMISSIONS_OK",
            ]),
            Duration::from_secs(5),
        )
        .map_err(|error| format!("Hermes permission check failed: {error}"))?;
    if permissions.stdout != b"HERMES_PERMISSIONS_OK" || permissions.exit_code != 0 {
        return Err(format!("Hermes permission policy failed: {permissions:?}"));
    }

    let checkpoint = control
        .execute(
            &CommandSpec::new("/usr/bin/python3").args([
                "-c",
                "import errno,fcntl,os\nfd=os.open('/dev/minisandbox',os.O_RDWR|os.O_CLOEXEC)\ntry:\n fcntl.ioctl(fd,0xB701,0)\nexcept OSError as error:\n assert error.errno==errno.EALREADY,error\n print('MINISANDBOX_CHECKPOINT_ONESHOT_OK',end='')\nelse:\n raise RuntimeError('second checkpoint unexpectedly succeeded')",
            ]),
            Duration::from_secs(5),
        )
        .map_err(|error| format!("Hermes checkpoint one-shot probe failed: {error}"))?;
    if checkpoint.stdout != b"MINISANDBOX_CHECKPOINT_ONESHOT_OK" || checkpoint.exit_code != 0 {
        return Err(format!(
            "Hermes checkpoint was not rejected after clone resume: {checkpoint:?}"
        ));
    }
    println!("MINISANDBOX_CHECKPOINT_ONESHOT_OK");

    let version = control
        .execute(
            &hermes_command("/opt/hermes/.venv/bin/hermes").arg("--version"),
            Duration::from_secs(45),
        )
        .map_err(|error| format!("Hermes version command failed: {error}"))?;
    let version_text = if version.stdout.is_empty() {
        &version.stderr
    } else {
        &version.stdout
    };
    if version.exit_code != 0 || version_text.is_empty() {
        return Err(format!(
            "Hermes version command returned no version: {version:?}"
        ));
    }
    println!(
        "MINISANDBOX_HERMES_OK uid=10000 install=ro data=rw version={}",
        String::from_utf8_lossy(version_text).trim()
    );

    let chat_started = Instant::now();
    let chat = control
        .execute(
            &hermes_command("/opt/hermes/.venv/bin/hermes").args([
                "chat",
                "-q",
                "Reply with exactly MINISANDBOX_HERMES_CHAT_OK",
            ]),
            Duration::from_secs(15),
        )
        .map_err(|error| format!("Hermes credential-free chat check failed: {error}"))?;
    let chat_startup = chat_started.elapsed();
    let reports_missing_credentials = contains(&chat.stdout, b"no API keys or providers found")
        || contains(&chat.stderr, b"no API keys or providers found");
    let recommends_setup =
        contains(&chat.stdout, b"hermes setup") || contains(&chat.stderr, b"hermes setup");
    if chat.exit_code == 0 || !reports_missing_credentials || !recommends_setup {
        return Err(format!(
            "Hermes chat did not reach the expected no-credential guard: {chat:?}"
        ));
    }
    println!(
        "MINISANDBOX_HERMES_NO_CREDENTIALS_OK exit={} startup_ms={:.3}",
        chat.exit_code,
        chat_startup.as_secs_f64() * 1_000.0,
    );
    exercise_local_chat(control)?;
    exercise_warm_local_chat(control)?;
    Ok(())
}

fn exercise_gateway_daemon(
    control: &SandboxControl,
    ingress: &pvm_socket_service::SocketIngressHandle,
) -> Result<(), String> {
    control
        .ping(Duration::from_secs(3))
        .map_err(|error| format!("Hermes daemon control ping failed: {error}"))?;
    let ready = launch_gateway(control, true)?;
    gateway_http_probe(ingress, "/v1/models", None, 401, b"gateway_auth_failed")?;
    gateway_http_probe(
        ingress,
        "/v1/models",
        Some(GATEWAY_API_KEY),
        200,
        b"\"object\": \"list\"",
    )?;

    let parallel_started = Instant::now();
    let health_responses = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..GATEWAY_PARALLEL_CLIENTS)
            .map(|_| {
                scope.spawn(|| {
                    gateway_http_probe(
                        ingress,
                        "/health",
                        None,
                        200,
                        b"\"platform\": \"hermes-agent\"",
                    )
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| "Hermes gateway HTTP client panicked".to_owned())?
            })
            .collect::<Result<Vec<_>, String>>()
    })?;
    debug_assert_eq!(health_responses.len(), GATEWAY_PARALLEL_CLIENTS);
    println!(
        "MINISANDBOX_HERMES_GATEWAY_FD_E2E_OK guest_port={GATEWAY_API_PORT} clients={GATEWAY_PARALLEL_CLIENTS} ready_ms={:.3} parallel_ms={:.3}",
        ready.as_secs_f64() * 1_000.0,
        parallel_started.elapsed().as_secs_f64() * 1_000.0,
    );
    Ok(())
}

fn launch_gateway(control: &SandboxControl, enable_api_server: bool) -> Result<Duration, String> {
    let started = Instant::now();
    let mut command = hermes_command("/opt/hermes/.venv/bin/python").args([
        "/opt/minisandbox/hermes-launch.py",
        "--timeout",
        "90",
    ]);
    if enable_api_server {
        command = command
            .args([
                "--env",
                "API_SERVER_ENABLED",
                "--env",
                "API_SERVER_HOST",
                "--env",
                "API_SERVER_PORT",
                "--env",
                "API_SERVER_KEY",
            ])
            .env("API_SERVER_ENABLED", "true")
            .env("API_SERVER_HOST", "127.0.0.1")
            .env("API_SERVER_PORT", GATEWAY_API_PORT.to_string())
            .env("API_SERVER_KEY", GATEWAY_API_KEY);
    }
    let launch = control
        .execute(&command, Duration::from_secs(100))
        .map_err(|error| format!("Hermes daemon launch failed: {error}"))?;
    if launch.exit_code != 0
        || !contains(
            &launch.stdout,
            b"MINISANDBOX_HERMES_GATEWAY_READY state=running",
        )
    {
        return Err(format!(
            "Hermes daemon did not reach its upstream running state: {launch:?}"
        ));
    }
    let status = control
        .execute(
            &hermes_command("/opt/hermes/.venv/bin/python").args([
                "-c",
                "import json\nfrom pathlib import Path\np=Path('/opt/data/gateway_state.json')\nv=json.loads(p.read_text())\nassert v['gateway_state']=='running',v\nassert isinstance(v['pid'],int) and v['pid']>1,v\nprint('MINISANDBOX_HERMES_GATEWAY_STATUS_OK',end='')",
            ]),
            Duration::from_secs(5),
        )
        .map_err(|error| format!("Hermes daemon status probe failed: {error}"))?;
    if status.exit_code != 0 || status.stdout != b"MINISANDBOX_HERMES_GATEWAY_STATUS_OK" {
        return Err(format!("Hermes daemon status is invalid: {status:?}"));
    }
    Ok(started.elapsed())
}

fn gateway_http_probe(
    ingress: &pvm_socket_service::SocketIngressHandle,
    path: &str,
    bearer: Option<&str>,
    expected_status: u16,
    body_marker: &[u8],
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let stream = loop {
        match ingress.connect_tcp_with_timeout(GATEWAY_API_PORT, Duration::from_secs(2)) {
            Ok(stream) => break stream,
            Err(pvm_socket_service::SocketIngressError::Rejected) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(format!(
                    "cannot connect an FD to Hermes gateway port {GATEWAY_API_PORT}: {error}"
                ));
            }
        }
    };
    stream
        .set_nonblocking(true)
        .map_err(|error| format!("cannot make Hermes gateway FD nonblocking: {error}"))?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|error| format!("cannot create Hermes gateway HTTP runtime: {error}"))?;
    runtime.block_on(async move {
        tokio::time::timeout(Duration::from_secs(10), async move {
            let stream = tokio::net::TcpStream::from_std(stream)
                .map_err(|error| format!("cannot adopt Hermes gateway FD: {error}"))?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream))
                    .await
                    .map_err(|error| format!("Hermes gateway HTTP handshake failed: {error}"))?;
            let _connection = tokio::spawn(connection);
            let mut request = Request::builder()
                .method(hyper::Method::GET)
                .uri(path)
                .header(header::HOST, "hermes")
                .header(header::CONNECTION, "close");
            if let Some(key) = bearer {
                request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
            }
            let request = request
                .body(Empty::<Bytes>::new())
                .map_err(|error| format!("cannot build Hermes gateway HTTP request: {error}"))?;
            let response = sender
                .send_request(request)
                .await
                .map_err(|error| format!("Hermes gateway HTTP request failed: {error}"))?;
            if response.status().as_u16() != expected_status {
                return Err(format!(
                    "unexpected Hermes gateway HTTP status: expected {expected_status}, received {}",
                    response.status()
                ));
            }
            require_streaming_body_marker(response.into_body(), body_marker).await
        })
        .await
        .map_err(|_| "Hermes gateway HTTP request exceeded its absolute deadline".to_owned())?
    })
}

async fn require_streaming_body_marker(
    mut body: hyper::body::Incoming,
    marker: &[u8],
) -> Result<(), String> {
    if marker.is_empty() {
        return Err("Hermes gateway HTTP marker must not be empty".to_owned());
    }
    let mut prefix = vec![0_usize; marker.len()];
    for index in 1..marker.len() {
        let mut matched = prefix[index - 1];
        while matched > 0 && marker[index] != marker[matched] {
            matched = prefix[matched - 1];
        }
        if marker[index] == marker[matched] {
            matched += 1;
        }
        prefix[index] = matched;
    }
    let mut matched = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| format!("cannot stream Hermes HTTP body: {error}"))?;
        let Some(data) = frame.data_ref() else {
            continue;
        };
        for byte in data {
            while matched > 0 && *byte != marker[matched] {
                matched = prefix[matched - 1];
            }
            if *byte == marker[matched] {
                matched += 1;
                if matched == marker.len() {
                    return Ok(());
                }
            }
        }
    }
    Err(format!(
        "Hermes gateway HTTP body ended before marker {}",
        String::from_utf8_lossy(marker)
    ))
}

fn exercise_local_chat(control: &SandboxControl) -> Result<(), String> {
    let provider = mock_openai::MockOpenAiServer::start(1)?;
    let base_url = format!("http://{}:{}/v1", HOST_LOOPBACK_ALIAS, provider.port());
    let response_latency = execute_local_chat(control, &base_url)?;
    let report = provider.finish()?;
    if report.chat_requests != 1 {
        return Err(format!(
            "deterministic provider received {} chats, expected one",
            report.chat_requests
        ));
    }
    println!(
        "MINISANDBOX_HERMES_LOCAL_E2E_OK process_to_request_ms={:.3} process_to_answer_ms={:.3} provider_requests={}",
        report.first_chat_request.unwrap_or_default().as_secs_f64() * 1_000.0,
        response_latency.as_secs_f64() * 1_000.0,
        report.requests,
    );
    Ok(())
}

fn exercise_warm_local_chat(control: &SandboxControl) -> Result<(), String> {
    let provider = mock_openai::MockOpenAiServer::start(1)?;
    let base_url = format!("http://{}:{}/v1", HOST_LOOPBACK_ALIAS, provider.port());
    let response_latency = execute_warm_local_chat(control, &base_url)?;
    let report = provider.finish()?;
    if report.chat_requests != 1 {
        return Err(format!(
            "warm deterministic provider received {} chats, expected one",
            report.chat_requests
        ));
    }
    println!(
        "MINISANDBOX_HERMES_WARM_E2E_OK process_to_request_ms={:.3} process_to_answer_ms={:.3} provider_requests={}",
        report.first_chat_request.unwrap_or_default().as_secs_f64() * 1_000.0,
        response_latency.as_secs_f64() * 1_000.0,
        report.requests,
    );
    Ok(())
}

fn execute_local_chat(control: &SandboxControl, base_url: &str) -> Result<Duration, String> {
    let started = Instant::now();
    let chat = control
        .execute(
            &hermes_command("/opt/hermes/.venv/bin/hermes")
                .args([
                    "-z",
                    E2E_PROMPT,
                    "--provider",
                    "openrouter",
                    "--model",
                    E2E_MODEL,
                    "--ignore-user-config",
                    "--ignore-rules",
                ])
                .env("OPENROUTER_API_KEY", "minisandbox-local-e2e-not-a-secret")
                .env("OPENROUTER_BASE_URL", base_url),
            Duration::from_mins(3),
        )
        .map_err(|error| format!("Hermes deterministic E2E chat failed: {error}"))?;
    let response_latency = started.elapsed();
    if chat.exit_code != 0 || !contains(&chat.stdout, mock_openai::RESPONSE_MARKER) {
        return Err(format!(
            "Hermes did not consume the deterministic provider response: {chat:?}"
        ));
    }
    Ok(response_latency)
}

fn execute_warm_local_chat(control: &SandboxControl, base_url: &str) -> Result<Duration, String> {
    let started = Instant::now();
    let chat = control
        .execute(
            &hermes_command("/opt/hermes/.venv/bin/python")
                .args([
                    "/opt/minisandbox/hermes-invoke.py",
                    "--prompt",
                    E2E_PROMPT,
                    "--provider",
                    "openrouter",
                    "--model",
                    E2E_MODEL,
                    "--credential-env",
                    "OPENROUTER_API_KEY",
                    "--base-url",
                    base_url,
                ])
                .env("OPENROUTER_API_KEY", "minisandbox-local-e2e-not-a-secret"),
            Duration::from_mins(3),
        )
        .map_err(|error| format!("Hermes warm deterministic E2E chat failed: {error}"))?;
    let response_latency = started.elapsed();
    if chat.exit_code != 0 || !contains(&chat.stdout, mock_openai::RESPONSE_MARKER) {
        return Err(format!(
            "Hermes warm daemon did not consume the deterministic provider response: {chat:?}"
        ));
    }
    Ok(response_latency)
}

fn hermes_command(program: &str) -> CommandSpec {
    CommandSpec::new(program)
        .env("HOME", "/opt/data")
        .env("HERMES_HOME", "/opt/data")
        .env("HERMES_WRITE_SAFE_ROOT", "/opt/data")
        .env("HERMES_DISABLE_LAZY_INSTALLS", "1")
        .env("HERMES_WEB_DIST", "/opt/hermes/hermes_cli/web_dist")
        .env("HERMES_TUI_DIR", "/opt/hermes/ui-tui")
        .env("PLAYWRIGHT_BROWSERS_PATH", "/opt/hermes/.playwright")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUNBUFFERED", "1")
        .env(
            "PATH",
            "/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .cwd("/opt/data")
        .user_name("hermes")
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn usage() -> String {
    "usage: pvm_linux_hermes <bzImage> <base.erofs> <hermes-app.erofs> <upper.ext4> <pool-dir> [memory-mib: 1024..3072] [--startup-clones|--concurrent-startup-clones|--concurrent-chat-clones|--concurrent-warm-chat-clones|--concurrent-gateway-clones 1..64 | --real-chat <provider> <model> <credential-env>]"
        .to_owned()
}
