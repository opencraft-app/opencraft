//! Explicit local-terminal runner for the disposable PVM Linux console.

mod terminal;

use std::{
    env,
    error::Error,
    ffi::OsString,
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::Arc,
    sync::mpsc::{Receiver, SyncSender, TryRecvError, sync_channel},
    thread,
    time::Duration,
};

use minisandbox_core::pvm_linux::{PvmLinuxImage, READ_ONLY_ROOTFS_GPA};
use minisandbox_pvm_sys::{
    PVM_VIRTIO_BLK_IRQ_GSI, PVM_VIRTIO_BLK_MMIO_BASE, PvmDevice, PvmExit, PvmReadOnlyImage,
};
use pvm_socket_service::{AllowAll, BrokerHandle, ServiceMemory, SocketBroker};

use crate::terminal::RawTerminal;

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable quiet loglevel=3";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const INPUT_CHUNK_SIZE: usize = 64;
const INPUT_QUEUE_DEPTH: usize = 4;
const RUN_SLICE: Duration = Duration::from_millis(50);
const DEFAULT_UPPER_NAME: &str = "minisandbox-upper-2g.ext4";
const USAGE: &str =
    "usage: pvm-console [--upper <upper.ext4> | --read-only] <bzImage> <root.erofs>";

#[derive(Clone, Copy)]
struct InputChunk {
    bytes: [u8; INPUT_CHUNK_SIZE],
    length: usize,
}

enum InputEvent {
    Bytes(InputChunk),
    Detach,
}

impl InputChunk {
    fn read() -> io::Result<Option<Self>> {
        let mut bytes = [0; INPUT_CHUNK_SIZE];
        let length = io::stdin().lock().read(&mut bytes)?;
        Ok((length != 0).then_some(Self { bytes, length }))
    }
}

fn main() -> ExitCode {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() == 1 && matches!(arguments[0].to_str(), Some("-h" | "--help")) {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match run(arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-console: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<(), Box<dyn Error>> {
    let arguments = ConsoleArguments::parse(arguments)?;

    let kernel = fs::read(&arguments.kernel)?;
    let rootfs = PvmReadOnlyImage::from_file(fs::File::open(&arguments.rootfs)?)?;
    let mut command_line = format!(
        "{COMMON_COMMAND_LINE} memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro init=/sbin/minisandbox-init minisandbox.mode=console",
        rootfs.len()
    );
    if arguments.upper.is_some() {
        write!(
            command_line,
            " virtio_mmio.device=4K@{PVM_VIRTIO_BLK_MMIO_BASE:#x}:{PVM_VIRTIO_BLK_IRQ_GSI}"
        )?;
    }
    let image = PvmLinuxImage::from_bzimage(&kernel, &[], command_line.as_bytes(), MEMORY_SIZE)?;
    let device = PvmDevice::open()?;
    let _capabilities = device.capabilities()?;
    let mut machine = device.create_linux_machine_with_read_only_image(
        image.memory_size(),
        &rootfs,
        READ_ONLY_ROOTFS_GPA,
    )?;
    if let Some(upper) = arguments.upper {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&upper)
            .map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "cannot open writable layer {}: {error}; build the default with `python3 rootfs/build.py upper` or select --read-only",
                        upper.display()
                    ),
                )
            })?;
        machine.attach_virtio_block(file)?;
        eprintln!("pvm-console: writable layer {}", upper.display());
    } else {
        eprintln!("pvm-console: read-only root requested");
    }
    let socket_memory = ServiceMemory::new(1)?;
    let socket_irq = socket_memory.attach(&mut machine)?;
    let socket_broker = SocketBroker::spawn(
        socket_memory,
        socket_irq,
        Arc::new(AllowAll),
        Arc::new(AllowAll),
    )?;
    machine.write_memory(0, image.boot_memory())?;
    if !image.initramfs().is_empty() {
        machine.write_memory(image.initramfs_range().start, image.initramfs())?;
    }
    machine.configure_linux_entry(image.boot_config())?;

    eprintln!("pvm-console: local terminal attached; press Ctrl-] to detach");
    let _terminal = RawTerminal::enable()?;
    let (sender, receiver) = sync_channel(INPUT_QUEUE_DEPTH);
    let _input_thread = thread::Builder::new()
        .name("pvm-console-stdin".to_owned())
        .spawn(move || read_stdin(&sender))?;
    let console_result = run_console(&mut machine, &receiver, &socket_broker);
    let broker_result = socket_broker.shutdown();
    console_result?;
    broker_result?;
    Ok(())
}

struct ConsoleArguments {
    kernel: PathBuf,
    rootfs: PathBuf,
    upper: Option<PathBuf>,
}

impl ConsoleArguments {
    fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut paths = Vec::new();
        let mut upper = None;
        let mut read_only = false;
        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            if argument == "--upper" {
                if upper.is_some() {
                    return Err(format!("--upper may be supplied only once\n{USAGE}"));
                }
                upper =
                    Some(PathBuf::from(arguments.next().ok_or_else(|| {
                        format!("--upper requires a path\n{USAGE}")
                    })?));
            } else if argument == "--read-only" {
                read_only = true;
            } else if argument.as_encoded_bytes().starts_with(b"-") {
                return Err(format!(
                    "unknown option {}\n{USAGE}",
                    argument.to_string_lossy()
                ));
            } else {
                paths.push(PathBuf::from(argument));
            }
        }
        if read_only && upper.is_some() {
            return Err(format!("--upper conflicts with --read-only\n{USAGE}"));
        }
        if paths.len() != 2 {
            return Err(USAGE.to_owned());
        }
        let kernel = paths.remove(0);
        let rootfs = paths.remove(0);
        let upper = if read_only {
            None
        } else {
            Some(upper.unwrap_or_else(|| default_upper_path(&rootfs)))
        };
        Ok(Self {
            kernel,
            rootfs,
            upper,
        })
    }
}

fn default_upper_path(rootfs: &Path) -> PathBuf {
    rootfs
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(DEFAULT_UPPER_NAME)
}

fn read_stdin(sender: &SyncSender<InputEvent>) {
    loop {
        match InputChunk::read() {
            Ok(Some(mut chunk)) => {
                if let Some(detach) = chunk.bytes[..chunk.length]
                    .iter()
                    .position(|byte| *byte == 0x1d)
                {
                    chunk.length = detach;
                    if chunk.length != 0 && sender.send(InputEvent::Bytes(chunk)).is_err() {
                        return;
                    }
                    let _ = sender.send(InputEvent::Detach);
                    return;
                }
                if sender.send(InputEvent::Bytes(chunk)).is_err() {
                    return;
                }
            }
            Ok(None) | Err(_) => return,
        }
    }
}

fn run_console(
    machine: &mut minisandbox_pvm_sys::PvmMachine,
    input: &Receiver<InputEvent>,
    socket_broker: &BrokerHandle,
) -> Result<(), Box<dyn Error>> {
    let mut pending = None;
    let mut pending_offset = 0;
    let mut input_disconnected = false;
    let mut stdout = io::stdout().lock();

    loop {
        if pending.is_none() && !input_disconnected {
            match input.try_recv() {
                Ok(InputEvent::Bytes(chunk)) => {
                    pending = Some(chunk);
                    pending_offset = 0;
                }
                Ok(InputEvent::Detach) => return Ok(()),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => input_disconnected = true,
            }
        }
        if let Some(chunk) = pending {
            let accepted =
                machine.queue_console_input(&chunk.bytes[pending_offset..chunk.length])?;
            pending_offset += accepted;
            if pending_offset == chunk.length {
                pending = None;
            }
        }

        match machine.run_once_with_timeout(RUN_SLICE)? {
            PvmExit::ConsoleWrite { data } => {
                stdout.write_all(&data)?;
                stdout.flush()?;
            }
            PvmExit::Halted => {
                // Linux idle HLT keeps interrupts enabled. `poweroff -f`
                // reaches the terminal CLI;HLT loop with IF clear.
                if machine.cpu_state()?.rflags & (1 << 9) == 0 {
                    return Ok(());
                }
            }
            PvmExit::TimedOut => {}
            PvmExit::Cancelled => return Err("guest runner was cancelled".into()),
            PvmExit::WaitUntil { .. } => {
                return Err("WAIT_UNTIL escaped the timed PVM runner".into());
            }
            PvmExit::Shutdown => return Err("guest shut down".into()),
            PvmExit::Event {
                vector,
                error_code,
                address,
            } => {
                return Err(
                    format!("guest event {vector} error {error_code:#x} at {address:#x}").into(),
                );
            }
            PvmExit::ReadOnlyMemoryWrite { address, data } => {
                return Err(
                    format!("guest write to read-only image at {address:#x}: {data:02x?}").into(),
                );
            }
            PvmExit::IoOut { port, data } => {
                return Err(format!("unexpected guest I/O port {port:#x}: {data:02x?}").into());
            }
            PvmExit::ServiceNotify { queues } => {
                let _ = queues;
                socket_broker.notify_guest_requests()?;
            }
            PvmExit::GuestExit { status: 0 } => return Ok(()),
            PvmExit::GuestExit { status } => {
                return Err(format!("guest exited with status {status}").into());
            }
            PvmExit::Unexpected { description } => return Err(description.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ConsoleArguments, default_upper_path};
    use std::{ffi::OsString, path::Path};

    fn parse(arguments: &[&str]) -> ConsoleArguments {
        ConsoleArguments::parse(arguments.iter().map(OsString::from)).expect("valid arguments")
    }

    #[test]
    fn writable_layer_is_the_default() {
        let arguments = parse(&["kernel", "images/root.erofs"]);
        assert_eq!(
            arguments.upper.as_deref(),
            Some(Path::new("images/minisandbox-upper-2g.ext4"))
        );
        assert_eq!(
            default_upper_path(Path::new("root.erofs")),
            Path::new("minisandbox-upper-2g.ext4")
        );
    }

    #[test]
    fn writable_layer_can_be_selected_or_disabled() {
        let selected = parse(&["--upper", "state.ext4", "kernel", "root.erofs"]);
        assert_eq!(selected.upper.as_deref(), Some(Path::new("state.ext4")));
        let read_only = parse(&["--read-only", "kernel", "root.erofs"]);
        assert!(read_only.upper.is_none());
    }

    #[test]
    fn conflicting_layer_modes_are_rejected() {
        assert!(
            ConsoleArguments::parse(
                ["--read-only", "--upper", "state", "kernel", "root"]
                    .into_iter()
                    .map(OsString::from)
            )
            .is_err()
        );
    }
}
