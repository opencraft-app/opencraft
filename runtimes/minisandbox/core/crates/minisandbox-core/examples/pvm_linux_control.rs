//! Exercise the same-binary guest control agent across a warm PVM checkpoint.

use std::{
    env, fs,
    process::ExitCode,
    time::{Duration, Instant},
};

use minisandbox_core::{
    control::{CommandSpec, ControlError, PtySize, SandboxControl},
    engine::{Engine, PvmReadOnlyImage, RunOptions, RunOutcome},
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const SIGTERM: i32 = 15;
const LINUX_EAGAIN: i32 = 11;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-control: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let rootfs_path = arguments.next().ok_or_else(usage)?;
    if arguments.next().is_some() {
        return Err(usage());
    }
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
        .map_err(|error| format!("cannot warm control template: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));

    let mut instance = engine
        .clone_pvm_linux_template(&template)
        .map_err(|error| format!("cannot clone control template: {error:?}"))?;
    let control = instance.sandbox_control();
    std::thread::scope(|scope| -> Result<(), String> {
        let runner = scope.spawn(move || {
            instance.run_for(RunOptions {
                timeout: Duration::from_secs(8),
            })
        });
        let operation = exercise_control(&control);
        let run = runner
            .join()
            .map_err(|_| "PVM control runner panicked".to_owned())?
            .map_err(|error| format!("PVM control runner failed: {error:?}"))?;
        print!("{}", String::from_utf8_lossy(&run.output));
        if run.outcome != RunOutcome::TimedOut {
            return Err(format!(
                "control clone unexpectedly stopped: {:?}",
                run.outcome
            ));
        }
        operation
    })
}

fn exercise_control(control: &SandboxControl) -> Result<(), String> {
    control
        .ping(Duration::from_secs(2))
        .map_err(|error| format!("control ping failed: {error}"))?;
    let output = control
        .execute(
            &CommandSpec::new("/usr/bin/python3")
                .args([
                    "-c",
                    "import os,sys; sys.stdout.write(f\"CONTROL_STDOUT42\\nSTRUCTURED={os.getcwd()}:{os.environ['CONTROL_ENV']}:{sys.argv[1]}\"); sys.stderr.write('CONTROL_STDERR')",
                    "payload",
                ])
                .env("CONTROL_ENV", "explicit")
                .cwd("/tmp"),
            Duration::from_secs(2),
        )
        .map_err(|error| format!("control exec failed: {error}"))?;
    if output.stdout != b"CONTROL_STDOUT42\nSTRUCTURED=/tmp:explicit:payload"
        || output.stderr != b"CONTROL_STDERR"
        || output.exit_code != 0
    {
        return Err(format!("unexpected command output: {output:?}"));
    }

    let mut stdin = control
        .start(
            &CommandSpec::new("/usr/bin/python3").args([
                "-c",
                "import sys; sys.stdout.write('stdin=' + sys.stdin.readline().rstrip('\\n'))",
            ]),
            Duration::from_secs(2),
        )
        .map_err(|error| format!("stdin command start failed: {error}"))?;
    stdin
        .write_stdin(b"hello\n")
        .map_err(|error| format!("stdin command write failed: {error}"))?;
    let output = stdin
        .collect()
        .map_err(|error| format!("stdin command collect failed: {error}"))?;
    if output.stdout != b"stdin=hello" || output.exit_code != 0 {
        return Err(format!("unexpected stdin result: {output:?}"));
    }

    exercise_identity_and_terminal(control)?;
    exercise_deadline_and_backpressure(control)?;

    let mut signalled = control
        .start(
            &CommandSpec::new("/bin/sleep").arg("30"),
            Duration::from_secs(2),
        )
        .map_err(|error| format!("signal command start failed: {error}"))?;
    signalled
        .signal(SIGTERM)
        .map_err(|error| format!("signal command failed: {error}"))?;
    let output = signalled
        .collect()
        .map_err(|error| format!("signal command collect failed: {error}"))?;
    if output.exit_code != 143 {
        return Err(format!("unexpected signal result: {output:?}"));
    }
    let parallel_started = Instant::now();
    std::thread::scope(|scope| -> Result<(), String> {
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let control = control.clone();
                scope.spawn(move || {
                    let output = format!("parallel-{index}");
                    control
                        .execute(
                            &CommandSpec::new("/usr/bin/printf").arg(&output),
                            Duration::from_secs(3),
                        )
                        .map(|output| (index, output))
                        .map_err(|error| format!("parallel command {index} failed: {error}"))
                })
            })
            .collect();
        for worker in workers {
            let (index, output) = worker
                .join()
                .map_err(|_| "parallel control worker panicked".to_owned())??;
            if output.stdout != format!("parallel-{index}").as_bytes() || output.exit_code != 0 {
                return Err(format!("unexpected parallel result {index}: {output:?}"));
            }
        }
        Ok(())
    })?;
    println!(
        "MINISANDBOX_CONTROL_OK pid={} structured=1 user=nobody pty=33x101 stdin=stdin=hello signal={} deadline=1 stdin_backpressure=EAGAIN parallel=8 parallel_ms={:.3}",
        output.guest_pid,
        output.exit_code,
        parallel_started.elapsed().as_secs_f64() * 1_000.0
    );
    Ok(())
}

fn exercise_deadline_and_backpressure(control: &SandboxControl) -> Result<(), String> {
    let deadline_started = Instant::now();
    let deadline = control.execute_with_timeouts(
        &CommandSpec::new("/usr/bin/python3").args([
            "-c",
            "import sys,time\nwhile True:\n sys.stdout.write('x'); sys.stdout.flush(); time.sleep(.01)",
        ]),
        Duration::from_secs(2),
        Duration::from_millis(100),
    );
    if !matches!(deadline, Err(ControlError::DeadlineExceeded)) {
        return Err(format!("command deadline did not expire: {deadline:?}"));
    }
    if deadline_started.elapsed() > Duration::from_secs(1) {
        return Err("command deadline was renewed by periodic output".to_owned());
    }

    let mut blocked = control
        .start(
            &CommandSpec::new("/bin/sleep").arg("30"),
            Duration::from_secs(2),
        )
        .map_err(|error| format!("backpressure command start failed: {error}"))?;
    let fragment = vec![b'x'; 16 * 1024];
    let mut accepted = 0;
    for _ in 0..32 {
        match blocked.write_stdin(&fragment) {
            Ok(()) => accepted += 1,
            Err(ControlError::ActionFailed {
                errno: LINUX_EAGAIN,
            }) => {
                if accepted == 0 {
                    return Err("stdin queue rejected its first fragment".to_owned());
                }
                return Ok(());
            }
            Err(error) => return Err(format!("unexpected stdin action failure: {error}")),
        }
    }
    Err("stdin queue never exposed its fixed backpressure bound".to_owned())
}

fn exercise_identity_and_terminal(control: &SandboxControl) -> Result<(), String> {
    let nobody = control
        .execute(
            &CommandSpec::new("/usr/bin/python3")
                .args([
                    "-c",
                    "import os; print(f'USER={os.getuid()}:{os.getgid()}')",
                ])
                .cwd("/tmp")
                .user_name("nobody"),
            Duration::from_secs(2),
        )
        .map_err(|error| format!("named-user command failed: {error}"))?;
    if nobody.stdout != b"USER=65534:65534\n" || nobody.exit_code != 0 {
        return Err(format!("unexpected named-user result: {nobody:?}"));
    }

    let mut terminal = control
        .start(
            &CommandSpec::new("/usr/bin/python3")
                .args([
                    "-c",
                    "import fcntl,struct,sys,termios; sys.stdin.readline(); r,c,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8)); print(f'PTY={r}x{c}',flush=True)",
                ])
                .terminal(PtySize::new(24, 80)),
            Duration::from_secs(2),
        )
        .map_err(|error| format!("PTY command start failed: {error}"))?;
    terminal
        .resize(PtySize::new(33, 101))
        .and_then(|()| terminal.write_stdin(b"continue\n"))
        .map_err(|error| format!("PTY interaction failed: {error}"))?;
    let terminal = terminal
        .collect()
        .map_err(|error| format!("PTY collect failed: {error}"))?;
    if terminal.exit_code != 0 || !contains(&terminal.stdout, b"PTY=33x101") {
        return Err(format!("unexpected PTY result: {terminal:?}"));
    }
    Ok(())
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn usage() -> String {
    "usage: pvm_linux_control <bzImage> <root.erofs>".to_owned()
}
