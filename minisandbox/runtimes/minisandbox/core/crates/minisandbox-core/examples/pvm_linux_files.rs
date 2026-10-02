//! Exercise the bounded file API on a writable `OverlayFS` PVM clone.

use std::{
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    process::ExitCode,
    time::{Duration, Instant},
};

use minisandbox_core::{
    control::{ControlError, FileKind, SandboxFiles},
    engine::{Engine, PvmBlockPool, PvmReadOnlyImage, RunOptions, RunOutcome},
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};
use minisandbox_pvm_sys::{PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const LINUX_ENOENT: i32 = 2;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-files: {error}");
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
    if arguments.next().is_some() {
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
         virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}",
        lower.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let options = RunOptions {
        timeout: Duration::from_secs(20),
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

    let mut instance = engine
        .clone_pvm_linux_template(&template)
        .map_err(|error| format!("cannot clone writable template: {error:?}"))?;
    let files = instance.sandbox_files();
    std::thread::scope(|scope| -> Result<(), String> {
        let runner = scope.spawn(move || {
            instance.run_for(RunOptions {
                timeout: Duration::from_secs(10),
            })
        });
        let operation = exercise_files(&files);
        let run = runner
            .join()
            .map_err(|_| "PVM file API runner panicked".to_owned())?
            .map_err(|error| format!("PVM file API runner failed: {error:?}"))?;
        print!("{}", String::from_utf8_lossy(&run.output));
        if run.outcome != RunOutcome::TimedOut {
            return Err(format!(
                "file API clone unexpectedly stopped: {:?}",
                run.outcome
            ));
        }
        operation
    })
}

fn exercise_files(files: &SandboxFiles) -> Result<(), String> {
    let timeout = Duration::from_secs(3);
    files
        .make_dir("/var/tmp/minisandbox-files/nested", true, timeout)
        .map_err(display("mkdir"))?;
    let data: Vec<u8> = (0..MAX_TEST_BYTES)
        .map(|index| u8::try_from(index % 251).expect("modulo value fits u8"))
        .collect();
    let started = Instant::now();
    files
        .write(
            "/var/tmp/minisandbox-files/nested/input.bin",
            &data,
            timeout,
        )
        .map_err(display("write"))?;
    let write_latency = started.elapsed();
    let started = Instant::now();
    let read_back = files
        .read("/var/tmp/minisandbox-files/nested/input.bin", timeout)
        .map_err(display("read"))?;
    let read_latency = started.elapsed();
    if read_back != data {
        return Err("file read did not match the streamed write".to_owned());
    }
    let info = files
        .stat("/var/tmp/minisandbox-files/nested/input.bin", timeout)
        .map_err(display("stat"))?;
    if info.kind != FileKind::File || info.size != data.len() as u64 {
        return Err(format!("unexpected file metadata: {info:?}"));
    }
    let entries = files
        .list("/var/tmp/minisandbox-files/nested", timeout)
        .map_err(display("list"))?;
    if entries.len() != 1 || entries[0].name != OsStr::new("input.bin") {
        return Err(format!("unexpected directory listing: {entries:?}"));
    }
    files
        .rename(
            "/var/tmp/minisandbox-files/nested/input.bin",
            "/var/tmp/minisandbox-files/nested/output.bin",
            timeout,
        )
        .map_err(display("rename"))?;
    let parallel_started = Instant::now();
    std::thread::scope(|scope| -> Result<(), String> {
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let files = files.clone();
                scope.spawn(move || {
                    let path = format!("/var/tmp/minisandbox-files/parallel-{index}");
                    let contents = format!("parallel-file-{index}");
                    files
                        .write(&path, contents.as_bytes(), timeout)
                        .and_then(|()| files.read(&path, timeout))
                        .map(|read| (index, contents, read))
                        .map_err(|error| format!("parallel file {index} failed: {error}"))
                })
            })
            .collect();
        for worker in workers {
            let (index, expected, read) = worker
                .join()
                .map_err(|_| "parallel file worker panicked".to_owned())??;
            if read != expected.as_bytes() {
                return Err(format!("parallel file {index} mismatched"));
            }
        }
        Ok(())
    })?;
    match files.stat("/definitely-missing", timeout) {
        Err(ControlError::Remote {
            errno: LINUX_ENOENT,
            ..
        }) => {}
        result => return Err(format!("missing path did not return ENOENT: {result:?}")),
    }
    files
        .remove("/var/tmp/minisandbox-files", true, timeout)
        .map_err(display("remove"))?;
    println!(
        "MINISANDBOX_FILES_OK bytes={} write_ms={:.3} read_ms={:.3} parallel=8 parallel_ms={:.3}",
        data.len(),
        write_latency.as_secs_f64() * 1_000.0,
        read_latency.as_secs_f64() * 1_000.0,
        parallel_started.elapsed().as_secs_f64() * 1_000.0
    );
    Ok(())
}

const MAX_TEST_BYTES: usize = 160 * 1024;

fn display(operation: &'static str) -> impl FnOnce(ControlError) -> String {
    move |error| format!("file {operation} failed: {error}")
}

fn usage() -> String {
    "usage: pvm_linux_files <bzImage> <lower.erofs> <upper.ext4> <pool-dir>".to_owned()
}
