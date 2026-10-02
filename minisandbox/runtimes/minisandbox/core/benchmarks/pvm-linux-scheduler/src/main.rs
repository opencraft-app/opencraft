//! Standalone PVM Linux nested-scheduling benchmark harness.

use std::{
    collections::BTreeMap,
    env, fs,
    process::ExitCode,
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};

use minisandbox_core::engine::{
    Engine, EngineError, PvmLinuxCloneResult, PvmLinuxTemplate, PvmReadOnlyImage, PvmRunStats,
    RunOptions, RunOutcome,
};
use minisandbox_core::pvm_linux::READ_ONLY_ROOTFS_GPA;

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const RESUMED_MARKER: &[u8] = b"MSBENCH_RESUMED";
const COMPLETED_MARKER: &[u8] = b"MSBENCH_DONE";
const IDLE_READY_MARKER: &[u8] = b"MSBENCH_IDLE_READY";
const IDLE_RESULT_MARKER: &[u8] = b"MSBENCH_RESULT mode=idle";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IdleVariant {
    Baseline,
    HaltPollOff,
    WaitUntil,
}

impl IdleVariant {
    fn from_mode(mode: &str) -> Option<Self> {
        match mode {
            "idle" => Some(Self::Baseline),
            "idle-halt-poll-off" => Some(Self::HaltPollOff),
            "idle-wait-until" => Some(Self::WaitUntil),
            _ => None,
        }
    }

    const fn wait_until(self) -> bool {
        matches!(self, Self::WaitUntil)
    }

    const fn halt_poll_off(self) -> bool {
        matches!(self, Self::HaltPollOff)
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-scheduler-bench: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let rootfs_path = arguments.next().ok_or_else(usage)?;
    let mode = arguments
        .next()
        .ok_or_else(usage)?
        .into_string()
        .map_err(|_| usage())?;
    validate_mode(&mode)?;
    let counts = parse_counts(&arguments.next().ok_or_else(usage)?.to_string_lossy())?;
    let amount = arguments
        .next()
        .ok_or_else(usage)?
        .to_string_lossy()
        .parse::<u64>()
        .map_err(|error| format!("invalid amount: {error}"))?;
    if amount == 0 || (mode == "timer-storm" && amount > 10_000) || arguments.next().is_some() {
        return Err(usage());
    }

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let rootfs = fs::File::open(&rootfs_path)
        .map_err(|error| format!("cannot open {}: {error}", rootfs_path.to_string_lossy()))?;
    let rootfs = PvmReadOnlyImage::from_file(rootfs)
        .map_err(|error| format!("cannot map benchmark EROFS: {error}"))?;
    let idle_variant = IdleVariant::from_mode(&mode);
    let guest_mode = if idle_variant.is_some() {
        "idle"
    } else {
        &mode
    };
    let wait_until = if idle_variant.is_some_and(IdleVariant::wait_until) {
        " minisandbox.wait_until=1"
    } else {
        ""
    };
    let command_line = format!(
        "{COMMON_COMMAND_LINE}{wait_until} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro init=/sbin/minisandbox-init msbench.mode={guest_mode} msbench.amount={amount}",
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
                timeout: Duration::from_secs(30),
            },
        )
        .map_err(|error| format!("cannot warm benchmark template: {error:?}"))?;
    eprintln!(
        "template mode={mode} warmup_ms={:.3} snapshot_ms={:.3} ram_mib={} host_cpus={}",
        template.warmup_latency().as_secs_f64() * 1000.0,
        template.snapshot_latency().as_secs_f64() * 1000.0,
        template.memory_size() / (1024 * 1024),
        thread::available_parallelism().map_or(1, std::num::NonZero::get),
    );

    for count in counts {
        if let Some(variant) = idle_variant {
            run_idle_batch(&engine, &template, &mode, variant, count, amount)?;
        } else {
            run_completed_batch(&engine, &template, &mode, count, amount)?;
        }
    }
    Ok(())
}

fn run_completed_batch(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    mode: &str,
    count: usize,
    amount: u64,
) -> Result<(), String> {
    let before = ResourceUsage::capture()?;
    let started = Instant::now();
    let results = engine
        .benchmark_pvm_linux_clones_concurrently(
            template,
            count,
            RESUMED_MARKER,
            COMPLETED_MARKER,
            RunOptions {
                timeout: Duration::from_secs(30),
            },
        )
        .map_err(|error| format!("{mode} {count}-clone batch failed: {error:?}"))?;
    let wall_ns = started.elapsed().as_nanos();
    let usage = ResourceUsage::capture()?.delta(before);
    let guest_total = aggregate_primary_metric(mode, &results)?;
    let private_pages: usize = results.iter().map(|result| result.private_pages).sum();
    let reclaimed_pages: usize = results.iter().map(|result| result.reclaimed_pages).sum();
    println!(
        "{{\"kind\":\"batch\",\"mode\":\"{mode}\",\"clones\":{count},\"amount\":{amount},\"wall_ns\":{wall_ns},\"host_cpu_ns\":{},\"voluntary_cs\":{},\"involuntary_cs\":{},\"max_rss_kib\":{},\"guest_total\":{guest_total},\"private_pages\":{private_pages},\"reclaimed_pages\":{reclaimed_pages}}}",
        usage.cpu_ns, usage.voluntary, usage.involuntary, usage.max_rss_kib,
    );
    print_guest_results(&results);
    Ok(())
}

#[allow(clippy::too_many_lines)]
fn run_idle_batch(
    engine: &Engine,
    template: &PvmLinuxTemplate,
    mode: &str,
    variant: IdleVariant,
    count: usize,
    duration_ms: u64,
) -> Result<(), String> {
    let create_started = Instant::now();
    let mut instances = Vec::with_capacity(count);
    for _ in 0..count {
        let instance = engine
            .clone_pvm_linux_template(template)
            .map_err(|error| format!("cannot create idle clone: {error:?}"))?;
        if variant.halt_poll_off() {
            instance
                .set_halt_poll_ns(0)
                .map_err(|error| format!("cannot disable halt polling: {error:?}"))?;
        }
        instances.push(instance);
    }
    let create_ns = create_started.elapsed().as_nanos();
    let resident_before_kib = current_rss_kib()?;
    let ready = Arc::new(Barrier::new(count + 1));
    let start = Arc::new(Barrier::new(count + 1));
    let stopped = Arc::new(Barrier::new(count + 1));
    let finish = Arc::new(Barrier::new(count + 1));
    let (results, wall_ns, usage, pit_usage) = thread::scope(|scope| -> Result<_, String> {
        let mut workers = Vec::with_capacity(count);
        for mut instance in instances {
            let ready = Arc::clone(&ready);
            let start = Arc::clone(&start);
            let stopped = Arc::clone(&stopped);
            let finish = Arc::clone(&finish);
            workers.push(
                thread::Builder::new()
                    .stack_size(256 * 1024)
                    .spawn_scoped(scope, move || {
                        let ready_result = instance.run_until_markers(
                            RESUMED_MARKER,
                            IDLE_READY_MARKER,
                            RunOptions {
                                timeout: Duration::from_secs(30),
                            },
                        );
                        if ready_result.is_ok() {
                            instance.reset_run_stats();
                        }
                        ready.wait();
                        start.wait();

                        let thread_before = ResourceUsage::capture_thread();
                        let run_result = ready_result.and_then(|_| {
                            instance
                                .run_for(RunOptions {
                                    timeout: Duration::from_millis(duration_ms),
                                })
                                .and_then(|result| {
                                    if result.outcome == RunOutcome::TimedOut {
                                        Ok(result.output)
                                    } else {
                                        Err(EngineError::LinuxCheckpoint(format!(
                                            "idle interval ended as {:?}",
                                            result.outcome
                                        )))
                                    }
                                })
                        });
                        let thread_usage = thread_before.and_then(|before| {
                            ResourceUsage::capture_thread().map(|now| now.delta(before))
                        });
                        let stats = instance.run_stats();
                        stopped.wait();
                        finish.wait();

                        let interval_output = run_result
                            .map_err(|error| format!("idle interval failed: {error:?}"))?;
                        let thread_usage = thread_usage?;
                        let completion = instance
                            .run_until_markers(
                                IDLE_RESULT_MARKER,
                                COMPLETED_MARKER,
                                RunOptions {
                                    timeout: Duration::from_secs(10),
                                },
                            )
                            .map_err(|error| format!("cannot collect idle result: {error:?}"))?;
                        Ok::<_, String>(IdleWorkerResult {
                            stats,
                            runner_cpu_ns: thread_usage.cpu_ns,
                            interval_output,
                            completion,
                        })
                    })
                    .map_err(|error| format!("cannot spawn idle clone worker: {error}"))?,
            );
        }

        ready.wait();
        let pit_before = KvmPitUsage::capture()?;
        let before = ResourceUsage::capture()?;
        let started = Instant::now();
        start.wait();
        stopped.wait();
        let wall_ns = started.elapsed().as_nanos();
        let usage = ResourceUsage::capture()?.delta(before);
        let pit_usage = KvmPitUsage::capture()?.delta(&pit_before);
        finish.wait();

        let mut results = Vec::with_capacity(count);
        for worker in workers {
            results.push(
                worker
                    .join()
                    .map_err(|_| "idle clone worker panicked".to_owned())??,
            );
        }
        Ok((results, wall_ns, usage, pit_usage))
    })?;
    let run_stats = sum_run_stats(results.iter().map(|result| result.stats));
    let runner_cpu_ns: u128 = results.iter().map(|result| result.runner_cpu_ns).sum();
    let guest_interrupts = sum_idle_metric(&results, "interrupts")?;
    let guest_timer_interrupts = sum_idle_metric(&results, "timer_interrupts")?;
    println!(
        "{{\"kind\":\"idle\",\"mode\":\"{mode}\",\"clones\":{count},\"duration_ms\":{duration_ms},\"create_ns\":{create_ns},\"wall_ns\":{wall_ns},\"host_cpu_ns\":{},\"runner_cpu_ns\":{runner_cpu_ns},\"voluntary_cs\":{},\"involuntary_cs\":{},\"resident_before_kib\":{resident_before_kib},\"max_rss_kib\":{},\"kvm_pit_cpu_ns\":{},\"kvm_pit_threads\":{},\"kvm_runs\":{},\"hlt_exits\":{},\"uart_io_exits\":{},\"cmos_io_exits\":{},\"io_delay_exits\":{},\"block_mmio_exits\":{},\"wait_until_exits\":{},\"wait_until_arms\":{},\"wait_until_parks\":{},\"wait_until_short\":{},\"wait_deadline_wakes\":{},\"wait_device_wakes\":{},\"requested_wait_ns\":{},\"guest_interrupts\":{guest_interrupts},\"guest_timer_interrupts\":{guest_timer_interrupts}}}",
        usage.cpu_ns,
        usage.voluntary,
        usage.involuntary,
        usage.max_rss_kib,
        pit_usage.cpu_ns,
        pit_usage.threads,
        run_stats.kvm_runs,
        run_stats.hlt_exits,
        run_stats.uart_io_exits,
        run_stats.cmos_io_exits,
        run_stats.io_delay_exits,
        run_stats.block_mmio_exits,
        run_stats.wait_until_exits,
        run_stats.wait_until_arms,
        run_stats.wait_until_parks,
        run_stats.wait_until_short,
        run_stats.wait_deadline_wakes,
        run_stats.wait_device_wakes,
        run_stats.requested_wait_ns,
    );
    let completions: Vec<_> = results
        .into_iter()
        .enumerate()
        .map(|(index, result)| {
            if result
                .interval_output
                .windows(b"WARNING:".len())
                .any(|window| window == b"WARNING:")
                || result
                    .interval_output
                    .windows(b"Kernel panic".len())
                    .any(|window| window == b"Kernel panic")
            {
                eprintln!(
                    "idle guest[{index}] interval console: {}",
                    String::from_utf8_lossy(&result.interval_output)
                );
            }
            result.completion
        })
        .collect();
    if env::var_os("MSBENCH_PRINT_GUEST_RESULTS").is_none_or(|value| value != "0") {
        print_guest_results(&completions);
    }
    Ok(())
}

struct IdleWorkerResult {
    stats: PvmRunStats,
    runner_cpu_ns: u128,
    interval_output: Vec<u8>,
    completion: PvmLinuxCloneResult,
}

fn sum_run_stats(stats: impl Iterator<Item = PvmRunStats>) -> PvmRunStats {
    stats.fold(PvmRunStats::default(), |mut total, value| {
        total.kvm_runs = total.kvm_runs.saturating_add(value.kvm_runs);
        total.hlt_exits = total.hlt_exits.saturating_add(value.hlt_exits);
        total.uart_io_exits = total.uart_io_exits.saturating_add(value.uart_io_exits);
        total.cmos_io_exits = total.cmos_io_exits.saturating_add(value.cmos_io_exits);
        total.io_delay_exits = total.io_delay_exits.saturating_add(value.io_delay_exits);
        total.block_mmio_exits = total
            .block_mmio_exits
            .saturating_add(value.block_mmio_exits);
        total.wait_until_exits = total
            .wait_until_exits
            .saturating_add(value.wait_until_exits);
        total.wait_until_arms = total.wait_until_arms.saturating_add(value.wait_until_arms);
        total.wait_until_parks = total
            .wait_until_parks
            .saturating_add(value.wait_until_parks);
        total.wait_until_short = total
            .wait_until_short
            .saturating_add(value.wait_until_short);
        total.wait_deadline_wakes = total
            .wait_deadline_wakes
            .saturating_add(value.wait_deadline_wakes);
        total.wait_device_wakes = total
            .wait_device_wakes
            .saturating_add(value.wait_device_wakes);
        total.requested_wait_ns = total
            .requested_wait_ns
            .saturating_add(value.requested_wait_ns);
        total
    })
}

fn sum_idle_metric(results: &[IdleWorkerResult], key: &str) -> Result<u128, String> {
    results.iter().try_fold(0_u128, |total, result| {
        Ok(total + u128::from(metric(guest_result_line(&result.completion.output)?, key)?))
    })
}

fn aggregate_primary_metric(mode: &str, results: &[PvmLinuxCloneResult]) -> Result<u128, String> {
    let key = match mode {
        "cpu-python" | "cpu-v8" | "fairness" => "ops",
        "cpu-sha256" => "bytes",
        "wakeup" => "samples",
        "exit" => "exits",
        "timer-storm" => "timers",
        _ => return Err(format!("mode {mode} has no primary metric")),
    };
    results.iter().try_fold(0_u128, |total, result| {
        let line = guest_result_line(&result.output)?;
        let value = if mode == "fairness" {
            ["ops0", "ops1", "ops2", "ops3"]
                .iter()
                .try_fold(0_u128, |sum, child_key| {
                    Ok::<u128, String>(sum + u128::from(metric(line, child_key)?))
                })?
        } else {
            u128::from(metric(line, key)?)
        };
        Ok(total + value)
    })
}

fn print_guest_results(results: &[PvmLinuxCloneResult]) {
    for (index, result) in results.iter().enumerate() {
        let line = guest_result_line(&result.output).unwrap_or("MSBENCH_RESULT missing");
        println!(
            "guest[{index}] create_ns={} resume_ns={} completion_ns={} private_pages={} reports={} reclaimed_pages={} {line}",
            result.create_latency.as_nanos(),
            result.resume_latency.as_nanos(),
            result.completion_latency.as_nanos(),
            result.private_pages,
            result.page_reports,
            result.reclaimed_pages,
        );
    }
}

fn guest_result_line(output: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(output)
        .map_err(|error| format!("guest output is not UTF-8: {error}"))?
        .lines()
        .find(|line| line.starts_with("MSBENCH_RESULT "))
        .ok_or_else(|| "guest output omitted MSBENCH_RESULT".to_owned())
}

fn metric(line: &str, key: &str) -> Result<u64, String> {
    let prefix = format!("{key}=");
    line.split_ascii_whitespace()
        .find_map(|field| field.strip_prefix(&prefix))
        .ok_or_else(|| format!("result omitted {key}: {line}"))?
        .parse::<u64>()
        .map_err(|error| format!("invalid {key} metric: {error}"))
}

fn validate_mode(mode: &str) -> Result<(), String> {
    match mode {
        "cpu-python" | "cpu-sha256" | "cpu-v8" | "wakeup" | "fairness" | "exit" | "timer-storm"
        | "idle" | "idle-halt-poll-off" | "idle-wait-until" => Ok(()),
        _ => Err(format!("unsupported mode {mode}; {}", usage())),
    }
}

fn parse_counts(text: &str) -> Result<Vec<usize>, String> {
    let counts: Vec<usize> = text
        .split(',')
        .map(|field| {
            field
                .parse::<usize>()
                .map_err(|error| format!("invalid clone count {field}: {error}"))
        })
        .collect::<Result<_, _>>()?;
    if counts.is_empty() || counts.iter().any(|count| *count == 0 || *count > 4096) {
        return Err("clone counts must be between 1 and 4096".to_owned());
    }
    Ok(counts)
}

fn current_rss_kib() -> Result<u64, String> {
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|error| format!("cannot read process status: {error}"))?;
    let line = status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .ok_or_else(|| "process status omitted VmRSS".to_owned())?;
    line.split_ascii_whitespace()
        .nth(1)
        .ok_or_else(|| "VmRSS omitted its value".to_owned())?
        .parse::<u64>()
        .map_err(|error| format!("invalid VmRSS: {error}"))
}

#[derive(Clone, Copy)]
struct ResourceUsage {
    cpu_ns: u128,
    voluntary: i64,
    involuntary: i64,
    max_rss_kib: i64,
}

impl ResourceUsage {
    fn capture() -> Result<Self, String> {
        Self::capture_for(libc::RUSAGE_SELF)
    }

    fn capture_thread() -> Result<Self, String> {
        Self::capture_for(libc::RUSAGE_THREAD)
    }

    fn capture_for(who: libc::c_int) -> Result<Self, String> {
        // SAFETY: `usage` is writable storage and `RUSAGE_SELF` requests the
        // requested process or calling-thread counters.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(who, &raw mut usage) } != 0 {
            return Err(format!(
                "getrusage failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self {
            cpu_ns: timeval_ns(usage.ru_utime) + timeval_ns(usage.ru_stime),
            voluntary: usage.ru_nvcsw,
            involuntary: usage.ru_nivcsw,
            max_rss_kib: usage.ru_maxrss,
        })
    }

    fn delta(self, previous: Self) -> Self {
        Self {
            cpu_ns: self.cpu_ns.saturating_sub(previous.cpu_ns),
            voluntary: self.voluntary.saturating_sub(previous.voluntary),
            involuntary: self.involuntary.saturating_sub(previous.involuntary),
            max_rss_kib: self.max_rss_kib,
        }
    }
}

#[derive(Default)]
struct KvmPitUsage {
    runtime_ns: BTreeMap<u32, u64>,
    cpu_ns: u128,
    threads: usize,
}

impl KvmPitUsage {
    fn capture() -> Result<Self, String> {
        let mut runtime_ns = BTreeMap::new();
        let process_id = std::process::id().to_string();
        let expected_name = format!("kvm-pit/{process_id}");
        let proc = fs::read_dir("/proc")
            .map_err(|error| format!("cannot scan /proc for kvm-pit threads: {error}"))?;
        for process in proc.flatten() {
            if !process
                .file_name()
                .as_encoded_bytes()
                .iter()
                .all(u8::is_ascii_digit)
            {
                continue;
            }
            let Ok(tasks) = fs::read_dir(process.path().join("task")) else {
                continue;
            };
            for task in tasks.flatten() {
                let Ok(comm) = fs::read_to_string(task.path().join("comm")) else {
                    continue;
                };
                if comm.trim() != expected_name {
                    continue;
                }
                let Ok(schedstat) = fs::read_to_string(task.path().join("schedstat")) else {
                    continue;
                };
                let Some(cpu_ns) = schedstat
                    .split_ascii_whitespace()
                    .next()
                    .and_then(|field| field.parse::<u64>().ok())
                else {
                    continue;
                };
                let Some(thread_id) = task
                    .file_name()
                    .to_str()
                    .and_then(|field| field.parse::<u32>().ok())
                else {
                    continue;
                };
                runtime_ns.insert(thread_id, cpu_ns);
            }
        }
        let cpu_ns = runtime_ns.values().copied().map(u128::from).sum();
        Ok(Self {
            cpu_ns,
            threads: runtime_ns.len(),
            runtime_ns,
        })
    }

    fn delta(self, previous: &Self) -> Self {
        let runtime_ns: BTreeMap<_, _> = self
            .runtime_ns
            .iter()
            .filter_map(|(thread, current)| {
                previous
                    .runtime_ns
                    .get(thread)
                    .map(|before| (*thread, current.saturating_sub(*before)))
            })
            .collect();
        Self {
            cpu_ns: runtime_ns.values().copied().map(u128::from).sum(),
            threads: self.threads,
            runtime_ns,
        }
    }
}

fn timeval_ns(value: libc::timeval) -> u128 {
    u128::try_from(value.tv_sec).unwrap_or_default() * 1_000_000_000
        + u128::try_from(value.tv_usec).unwrap_or_default() * 1_000
}

fn usage() -> String {
    "usage: pvm-linux-scheduler-bench <bzImage> <root.erofs> <cpu-python|cpu-sha256|cpu-v8|wakeup|fairness|exit|timer-storm|idle|idle-halt-poll-off|idle-wait-until> <counts> <milliseconds-or-exits>".to_owned()
}
