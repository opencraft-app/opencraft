//! Structured direct execution and attached terminal sessions.

use std::{
	ffi::OsString,
	fs::File,
	io::{self, Read, Write},
	os::{fd::AsRawFd, unix::ffi::OsStringExt},
	process::{Child, Command, ExitStatus, Stdio},
	sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel},
	thread,
	time::{Duration, Instant},
};

use minisandbox_control_protocol::{
	Header, Opcode, WireActionResult, WireCommandSpec, WirePtySize, WireUser, decode_action_request,
};

use super::{read_frame, wire_io_error, write_failure, write_frame};

const OUTPUT_CHUNK: usize = 16 * 1024;
const EVENT_QUEUE: usize = 16;
const STDIN_QUEUE: usize = 8;
const MAX_PASSWD_BYTES: u64 = 1024 * 1024;
type CommandDecodeResult = Result<(WireCommandSpec, Option<Duration>), (i32, &'static [u8])>;

pub(super) fn execute(
	mut stream: std::net::TcpStream,
	request_id: u64,
	payload: &[u8],
) -> io::Result<()> {
	let (spec, command_timeout) = match decode_command(payload) {
		Ok(command) => command,
		Err((errno, message)) => return write_failure(&mut stream, request_id, errno, message),
	};
	let terminal = spec.terminal;
	let (mut command, terminal_master) = match prepare_command(spec) {
		Ok(prepared) => prepared,
		Err(error) => {
			write_failure(
				&mut stream,
				request_id,
				error.raw_os_error().unwrap_or(libc::EINVAL),
				b"could not prepare command",
			)?;
			return Ok(());
		}
	};
	let mut child = match command.spawn() {
		Ok(child) => child,
		Err(error) => {
			let errno = error.raw_os_error().unwrap_or(libc::EIO);
			write_failure(&mut stream, request_id, errno, b"could not start command")?;
			return Ok(());
		}
	};
	// `Command` retains its configured `Stdio` objects so it can be spawned
	// again. Drop it now; otherwise the parent keeps PTY slave descriptors
	// open and the master never observes EOF after the child exits.
	drop(command);
	let pid = i32::try_from(child.id()).map_err(|_| io::Error::other("guest PID exceeds i32"))?;
	let result = (|| {
		write_frame(
			&mut stream,
			Header::new(Opcode::Started, request_id, 0, pid).map_err(wire_io_error)?,
			&[],
		)?;
		let command_deadline = deadline_after(command_timeout)?;

		let (events, receiver) = sync_channel(EVENT_QUEUE);
		let reader = stream.try_clone()?;
		spawn_control_reader(reader, request_id, events.clone())?;
		let terminal_control = if let Some(master) = terminal_master {
			spawn_output_reader(master.try_clone()?, OutputKind::Pty, events.clone())?;
			let input = spawn_stdin_writer(master.try_clone()?, true)?;
			Some((master, input))
		} else {
			let stdout = child
				.stdout
				.take()
				.ok_or_else(|| io::Error::other("child stdout pipe missing"))?;
			spawn_output_reader(stdout, OutputKind::Stdout, events.clone())?;
			let stderr = child
				.stderr
				.take()
				.ok_or_else(|| io::Error::other("child stderr pipe missing"))?;
			spawn_output_reader(stderr, OutputKind::Stderr, events)?;
			let stdin = child
				.stdin
				.take()
				.ok_or_else(|| io::Error::other("child stdin pipe missing"))?;
			let input = spawn_stdin_writer(stdin, false)?;
			return drive_command(
				&mut stream,
				&mut child,
				pid,
				request_id,
				&receiver,
				&input,
				None,
				false,
				command_deadline,
			);
		};
		let (master, input) = terminal_control.expect("terminal branch returns a master");
		drive_command(
			&mut stream,
			&mut child,
			pid,
			request_id,
			&receiver,
			&input,
			Some(&master),
			terminal.is_some(),
			command_deadline,
		)
	})();
	if result.is_err() {
		let _ = stream.shutdown(std::net::Shutdown::Both);
		let _ = signal_group(pid, libc::SIGKILL);
		let _ = child.wait();
	}
	result
}

fn decode_command(payload: &[u8]) -> CommandDecodeResult {
	let spec = WireCommandSpec::decode(payload)
		.map_err(|_| (libc::EINVAL, &b"invalid structured command"[..]))?;
	let command_timeout = (spec.timeout_ms != 0).then(|| Duration::from_millis(spec.timeout_ms));
	if deadline_after(command_timeout).is_err() {
		return Err((
			libc::EOVERFLOW,
			&b"command deadline is not representable"[..],
		));
	}
	Ok((spec, command_timeout))
}

fn deadline_after(timeout: Option<Duration>) -> io::Result<Option<Instant>> {
	timeout
		.map(|timeout| {
			Instant::now()
				.checked_add(timeout)
				.ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW))
		})
		.transpose()
}

fn prepare_command(spec: WireCommandSpec) -> io::Result<(Command, Option<File>)> {
	let credentials = resolve_user(&spec.user)?;
	let mut command = Command::new(OsString::from_vec(spec.program));
	command
		.args(spec.arguments.into_iter().map(OsString::from_vec))
		.env_clear()
		.envs(
			spec.environment
				.into_iter()
				.map(|(key, value)| (OsString::from_vec(key), OsString::from_vec(value))),
		)
		.current_dir(OsString::from_vec(spec.cwd));
	let terminal = spec.terminal.is_some();
	let terminal_master = if let Some(size) = spec.terminal {
		let (master, slave) = crate::open_pty(size)?;
		command
			.stdin(Stdio::from(slave.try_clone()?))
			.stdout(Stdio::from(slave.try_clone()?))
			.stderr(Stdio::from(slave));
		Some(master)
	} else {
		command
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		None
	};
	crate::configure_command_child(&mut command, terminal, credentials);
	Ok((command, terminal_master))
}

fn resolve_user(user: &WireUser) -> io::Result<Option<(u32, u32)>> {
	match user {
		WireUser::Current => Ok(None),
		WireUser::Ids { uid, gid } => Ok(Some((*uid, *gid))),
		WireUser::Name(name) => resolve_passwd(name).map(Some),
	}
}

fn resolve_passwd(expected: &[u8]) -> io::Result<(u32, u32)> {
	let file = File::open("/etc/passwd")?;
	let metadata = file.metadata()?;
	if !metadata.is_file() || metadata.len() > MAX_PASSWD_BYTES {
		return Err(io::Error::from_raw_os_error(libc::EFBIG));
	}
	let capacity =
		usize::try_from(metadata.len()).map_err(|_| io::Error::from_raw_os_error(libc::EFBIG))?;
	let mut passwd = Vec::with_capacity(capacity);
	file.take(MAX_PASSWD_BYTES + 1).read_to_end(&mut passwd)?;
	if passwd.len() as u64 > MAX_PASSWD_BYTES {
		return Err(io::Error::from_raw_os_error(libc::EFBIG));
	}
	for line in passwd.split(|byte| *byte == b'\n') {
		let fields: Vec<&[u8]> = line.split(|byte| *byte == b':').collect();
		if fields.len() >= 4 && fields[0] == expected {
			let uid = parse_id(fields[2])?;
			let gid = parse_id(fields[3])?;
			return Ok((uid, gid));
		}
	}
	Err(io::Error::from_raw_os_error(libc::ENOENT))
}

fn parse_id(bytes: &[u8]) -> io::Result<u32> {
	if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"invalid passwd numeric ID",
		));
	}
	bytes.iter().try_fold(0_u32, |value, byte| {
		value
			.checked_mul(10)
			.and_then(|value| value.checked_add(u32::from(*byte - b'0')))
			.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "passwd ID overflow"))
	})
}

enum WorkerEvent {
	Control(Header, Vec<u8>),
	Disconnected,
	Output(OutputKind, Vec<u8>),
	OutputClosed(OutputKind),
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum OutputKind {
	Stdout,
	Stderr,
	Pty,
}

fn spawn_control_reader(
	mut stream: std::net::TcpStream,
	request_id: u64,
	events: SyncSender<WorkerEvent>,
) -> io::Result<()> {
	thread::Builder::new()
		.name("minisandbox-control-input".to_owned())
		.spawn(move || {
			loop {
				match read_frame(&mut stream) {
					Ok(Some((header, payload)))
						if header.request_id == request_id
							&& matches!(
								header.opcode,
								Opcode::Stdin | Opcode::Signal | Opcode::PtyResize
							) =>
					{
						if events.send(WorkerEvent::Control(header, payload)).is_err() {
							break;
						}
					}
					Ok(None | Some(_)) | Err(_) => {
						let _ = events.send(WorkerEvent::Disconnected);
						break;
					}
				}
			}
		})?;
	Ok(())
}

fn spawn_output_reader(
	mut output: impl Read + Send + 'static,
	kind: OutputKind,
	events: SyncSender<WorkerEvent>,
) -> io::Result<()> {
	thread::Builder::new()
		.name("minisandbox-control-output".to_owned())
		.spawn(move || {
			let mut buffer = [0_u8; OUTPUT_CHUNK];
			loop {
				match output.read(&mut buffer) {
					Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
					Ok(0) | Err(_) => {
						let _ = events.send(WorkerEvent::OutputClosed(kind));
						break;
					}
					Ok(length) => {
						if events
							.send(WorkerEvent::Output(kind, buffer[..length].to_vec()))
							.is_err()
						{
							break;
						}
					}
				}
			}
		})?;
	Ok(())
}

fn spawn_stdin_writer(
	mut input: impl Write + Send + 'static,
	terminal: bool,
) -> io::Result<SyncSender<Vec<u8>>> {
	let (sender, receiver) = sync_channel::<Vec<u8>>(STDIN_QUEUE);
	thread::Builder::new()
		.name("minisandbox-control-stdin".to_owned())
		.spawn(move || {
			while let Ok(bytes) = receiver.recv() {
				if bytes.is_empty() {
					if terminal {
						let _ = input.write_all(&[4]);
					}
					break;
				}
				if input.write_all(&bytes).is_err() {
					break;
				}
			}
		})?;
	Ok(sender)
}

#[allow(clippy::too_many_arguments)]
fn drive_command(
	stream: &mut std::net::TcpStream,
	child: &mut Child,
	pid: libc::pid_t,
	request_id: u64,
	events: &Receiver<WorkerEvent>,
	stdin: &SyncSender<Vec<u8>>,
	terminal_master: Option<&File>,
	terminal: bool,
	command_deadline: Option<Instant>,
) -> io::Result<()> {
	let mut exit = None;
	let mut stdout_open = true;
	let mut stderr_open = !terminal;
	let mut stdin_closed = false;
	loop {
		match events.recv_timeout(next_wait(command_deadline)) {
			Ok(WorkerEvent::Control(header, payload)) => {
				let (action_id, body) = decode_action_request(&payload).map_err(wire_io_error)?;
				match header.opcode {
					Opcode::Stdin => {
						let length = u32::try_from(body.len())
							.map_err(|_| io::Error::from_raw_os_error(libc::EOVERFLOW))?;
						let result = if stdin_closed {
							Err(libc::EPIPE)
						} else {
							match stdin.try_send(body.to_vec()) {
								Ok(()) => {
									stdin_closed = body.is_empty();
									Ok(length)
								}
								Err(TrySendError::Full(_)) => Err(libc::EAGAIN),
								Err(TrySendError::Disconnected(_)) => Err(libc::EPIPE),
							}
						};
						write_action_result(stream, request_id, action_id, result)?;
					}
					Opcode::Signal => {
						let result = signal_group(pid, header.value)
							.map(|()| 0)
							.map_err(|error| error.raw_os_error().unwrap_or(libc::EIO));
						write_action_result(stream, request_id, action_id, result)?;
					}
					Opcode::PtyResize => {
						let Some(master) = terminal_master else {
							write_action_result(stream, request_id, action_id, Err(libc::ENOTTY))?;
							continue;
						};
						let size = WirePtySize::decode(body).map_err(wire_io_error)?;
						let result = crate::resize_pty(master.as_raw_fd(), size)
							.map(|()| 0)
							.map_err(|error| error.raw_os_error().unwrap_or(libc::EIO));
						write_action_result(stream, request_id, action_id, result)?;
					}
					_ => unreachable!("control reader filters opcodes"),
				}
			}
			Ok(WorkerEvent::Disconnected) => {
				let _ = signal_group(pid, libc::SIGKILL);
				let _ = child.wait();
				return Ok(());
			}
			Ok(WorkerEvent::Output(kind, payload)) => {
				let opcode = match kind {
					OutputKind::Stdout => Opcode::Stdout,
					OutputKind::Stderr => Opcode::Stderr,
					OutputKind::Pty => Opcode::PtyData,
				};
				write_frame(
					stream,
					Header::new(opcode, request_id, payload.len(), 0).map_err(wire_io_error)?,
					&payload,
				)?;
			}
			Ok(WorkerEvent::OutputClosed(OutputKind::Stdout | OutputKind::Pty)) => {
				stdout_open = false;
			}
			Ok(WorkerEvent::OutputClosed(OutputKind::Stderr)) => stderr_open = false,
			Err(RecvTimeoutError::Timeout) => {}
			Err(RecvTimeoutError::Disconnected) => {
				return Err(io::Error::other("command worker channels stopped"));
			}
		}
		if exit.is_none() {
			exit = child.try_wait()?;
		}
		if exit.is_none() && deadline_reached(command_deadline) {
			let _ = signal_group(pid, libc::SIGKILL);
			let _ = child.wait();
			write_failure(
				stream,
				request_id,
				libc::ETIMEDOUT,
				b"command deadline exceeded",
			)?;
			return Ok(());
		}
		if let Some(status) = exit
			&& !stdout_open
			&& !stderr_open
		{
			write_frame(
				stream,
				Header::new(Opcode::Exit, request_id, 0, normalized_status(status))
					.map_err(wire_io_error)?,
				&[],
			)?;
			return Ok(());
		}
	}
}

fn write_action_result(
	stream: &mut std::net::TcpStream,
	request_id: u64,
	action_id: u64,
	result: Result<u32, i32>,
) -> io::Result<()> {
	let (accepted_bytes, errno) = match result {
		Ok(accepted_bytes) => (accepted_bytes, 0),
		Err(errno) => (
			0,
			errno
				.checked_abs()
				.filter(|errno| (1..=4095).contains(errno))
				.unwrap_or(libc::EIO),
		),
	};
	let payload = WireActionResult {
		action_id,
		accepted_bytes,
		errno,
	}
	.encode()
	.map_err(wire_io_error)?;
	write_frame(
		stream,
		Header::new(Opcode::ActionResult, request_id, payload.len(), 0).map_err(wire_io_error)?,
		&payload,
	)
}

fn next_wait(deadline: Option<Instant>) -> Duration {
	const POLL: Duration = Duration::from_millis(10);
	deadline.map_or(POLL, |deadline| {
		deadline.saturating_duration_since(Instant::now()).min(POLL)
	})
}

fn deadline_reached(deadline: Option<Instant>) -> bool {
	deadline.is_some_and(|deadline| Instant::now() >= deadline)
}

fn signal_group(pid: libc::pid_t, signal: libc::c_int) -> io::Result<()> {
	crate::forward_to_group(pid, signal)
}

fn normalized_status(status: ExitStatus) -> i32 {
	use std::os::unix::process::ExitStatusExt;

	status
		.code()
		.or_else(|| status.signal().map(|signal| 128_i32.saturating_add(signal)))
		.unwrap_or(255)
		.clamp(0, 255)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn passwd_ids_are_strictly_decimal() {
		assert_eq!(parse_id(b"1000").expect("parse"), 1000);
		assert!(parse_id(b"").is_err());
		assert!(parse_id(b"-1").is_err());
		assert!(parse_id(b"4294967296").is_err());
	}
}
