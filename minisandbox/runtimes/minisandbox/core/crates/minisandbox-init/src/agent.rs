//! Clone-local control agent served by the same binary as PID 1.

mod commands;
mod files;

use std::{
	io::{self, Read, Write},
	net::{Ipv4Addr, TcpListener, TcpStream},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	thread,
};

use minisandbox_control_protocol::{
	CONTROL_PORT, HEADER_SIZE, Header, MAX_CONTROL_CONNECTIONS, Opcode,
};

pub(crate) fn spawn() -> io::Result<libc::pid_t> {
	// Bind before fork. A successful return therefore guarantees that the
	// listener exists before a warm workload can publish its checkpoint.
	let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, CONTROL_PORT))?;
	let child = crate::fork_single_threaded()?;
	if child == 0 {
		let status = run(&listener).map_or(1, |()| 0);
		crate::exit_immediately(status)
	}
	drop(listener);
	Ok(child)
}

fn run(listener: &TcpListener) -> io::Result<()> {
	let active = Arc::new(AtomicUsize::new(0));
	for accepted in listener.incoming() {
		let stream = match accepted {
			Ok(stream) => stream,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
			Err(error) => return Err(error),
		};
		let admitted = active
			.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
				(current < MAX_CONTROL_CONNECTIONS).then_some(current + 1)
			})
			.is_ok();
		if !admitted {
			drop(stream);
			continue;
		}
		let worker_active = Arc::clone(&active);
		let spawned = thread::Builder::new()
			.name("minisandbox-control".to_owned())
			.spawn(move || {
				if let Err(error) = handle_connection(stream) {
					eprintln!("minisandbox-control: connection failed: {error}");
				}
				let previous = worker_active.fetch_sub(1, Ordering::AcqRel);
				debug_assert_ne!(previous, 0);
			});
		if let Err(error) = spawned {
			let previous = active.fetch_sub(1, Ordering::AcqRel);
			debug_assert_ne!(previous, 0);
			return Err(error);
		}
	}
	Ok(())
}

fn handle_connection(mut stream: TcpStream) -> io::Result<()> {
	let Some((header, payload)) = read_frame(&mut stream)? else {
		return Ok(());
	};
	match header.opcode {
		Opcode::Ping => write_frame(
			&mut stream,
			Header::new(Opcode::Pong, header.request_id, 0, 0).map_err(wire_io_error)?,
			&[],
		),
		Opcode::Exec => commands::execute(stream, header.request_id, &payload),
		Opcode::FileRead
		| Opcode::FileWrite
		| Opcode::FileStat
		| Opcode::FileList
		| Opcode::FileMkdir
		| Opcode::FileRemove
		| Opcode::FileRename => files::handle(&mut stream, header, &payload),
		_ => write_failure(
			&mut stream,
			header.request_id,
			libc::EPROTO,
			b"unexpected initial operation",
		),
	}
}

fn read_frame(stream: &mut TcpStream) -> io::Result<Option<(Header, Vec<u8>)>> {
	let mut bytes = [0_u8; HEADER_SIZE];
	match stream.read_exact(&mut bytes) {
		Ok(()) => {}
		Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
		Err(error) => return Err(error),
	}
	let header = Header::decode(&bytes).map_err(wire_io_error)?;
	let length = usize::try_from(header.payload_len)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "payload length overflow"))?;
	let mut payload = vec![0_u8; length];
	stream.read_exact(&mut payload)?;
	Ok(Some((header, payload)))
}

fn write_frame(stream: &mut TcpStream, header: Header, payload: &[u8]) -> io::Result<()> {
	if usize::try_from(header.payload_len).ok() != Some(payload.len()) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"header payload length mismatch",
		));
	}
	stream.write_all(&header.encode())?;
	stream.write_all(payload)
}

fn write_failure(
	stream: &mut TcpStream,
	request_id: u64,
	errno: i32,
	message: &[u8],
) -> io::Result<()> {
	let errno = errno
		.checked_abs()
		.filter(|errno| (1..=4095).contains(errno))
		.unwrap_or(libc::EIO);
	write_frame(
		stream,
		Header::new(Opcode::Failed, request_id, message.len(), -errno).map_err(wire_io_error)?,
		message,
	)
}

fn wire_io_error(error: impl std::error::Error + Send + Sync + 'static) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, error)
}

#[cfg(test)]
mod tests {
	use std::{
		io::{Read, Write},
		net::{Ipv4Addr, TcpListener, TcpStream},
		thread,
		time::{Duration, Instant},
	};

	use minisandbox_control_protocol::{
		HEADER_SIZE, Header, Opcode, WireActionResult, WireCommandSpec, WirePtySize, WireUser,
		encode_action_request,
	};

	use super::handle_connection;

	#[test]
	fn one_connection_executes_and_separates_output() {
		let (mut client, worker) = control_pair();
		send_command(
			&mut client,
			9,
			"/bin/sh",
			&["-c", "printf stdout; printf stderr >&2; exit 7"],
		);

		let mut stdout = Vec::new();
		let mut stderr = Vec::new();
		let mut started = false;
		loop {
			let (header, payload) = receive_frame(&mut client);
			match header.opcode {
				Opcode::Started => started = true,
				Opcode::Stdout => stdout.extend_from_slice(&payload),
				Opcode::Stderr => stderr.extend_from_slice(&payload),
				Opcode::Exit => {
					assert_eq!(header.value, 7);
					break;
				}
				_ => panic!("unexpected response {:?}", header.opcode),
			}
		}
		assert!(started);
		assert_eq!(stdout, b"stdout");
		assert_eq!(stderr, b"stderr");
		worker.join().expect("control worker");
	}

	#[test]
	fn disconnect_kills_and_reaps_the_command_group() {
		let (mut client, worker) = control_pair();
		send_command(&mut client, 11, "/bin/sleep", &["30"]);
		let (started, payload) = receive_frame(&mut client);
		assert_eq!(started.opcode, Opcode::Started);
		assert!(payload.is_empty());
		drop(client);
		worker.join().expect("control worker");
		assert!(!crate::process_exists(started.value).expect("process check"));
	}

	#[test]
	fn attached_pty_resizes_and_streams_without_agent_helpers() {
		let (mut client, worker) = control_pair();
		let payload = WireCommandSpec {
            program: b"/usr/bin/python3".to_vec(),
            arguments: vec![
                b"-c".to_vec(),
                b"import fcntl,struct,sys,termios; sys.stdin.readline(); r,c,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8)); print(f'SIZE={r}x{c}',flush=True)".to_vec(),
            ],
            environment: Vec::new(),
            cwd: b"/".to_vec(),
            user: WireUser::Current,
            terminal: Some(WirePtySize {
                rows: 24,
                columns: 80,
                pixel_width: 0,
                pixel_height: 0,
            }),
            timeout_ms: 0,
        }
        .encode()
        .expect("encode PTY command");
		send_payload(&mut client, Opcode::Exec, 12, &payload);
		assert_eq!(receive_frame(&mut client).0.opcode, Opcode::Started);
		let resized = WirePtySize {
			rows: 33,
			columns: 101,
			pixel_width: 0,
			pixel_height: 0,
		}
		.encode()
		.expect("encode resize");
		send_payload(
			&mut client,
			Opcode::PtyResize,
			12,
			&encode_action_request(1, &resized).expect("encode resize action"),
		);
		assert_action_result(&mut client, 1, 0, 0);
		send_payload(
			&mut client,
			Opcode::Stdin,
			12,
			&encode_action_request(2, b"continue\n").expect("encode stdin action"),
		);
		assert_action_result(&mut client, 2, 9, 0);

		let mut output = Vec::new();
		loop {
			let (header, payload) = receive_frame(&mut client);
			match header.opcode {
				Opcode::PtyData => output.extend_from_slice(&payload),
				Opcode::Exit => {
					assert_eq!(header.value, 0);
					break;
				}
				_ => panic!("unexpected PTY response {:?}", header.opcode),
			}
		}
		assert!(
			output
				.windows(b"SIZE=33x101".len())
				.any(|window| window == b"SIZE=33x101"),
			"PTY output: {}",
			String::from_utf8_lossy(&output)
		);
		worker.join().expect("control worker");
	}

	#[test]
	fn command_deadline_kills_a_process_that_keeps_producing_output() {
		let (mut client, worker) = control_pair();
		client
			.set_read_timeout(Some(Duration::from_secs(2)))
			.expect("read timeout");
		send_command_with_timeout(
			&mut client,
			13,
			"/bin/sh",
			&["-c", "while :; do printf x; /bin/sleep 0.01; done"],
			80,
		);

		let started_at = Instant::now();
		let mut output_bytes = 0;
		let (started, payload) = receive_frame(&mut client);
		assert_eq!(started.opcode, Opcode::Started);
		assert!(payload.is_empty());
		let guest_pid = started.value;
		loop {
			let (header, payload) = receive_frame(&mut client);
			match header.opcode {
				Opcode::Stdout => output_bytes += payload.len(),
				Opcode::Failed => {
					assert_eq!(header.value, -libc::ETIMEDOUT);
					assert_eq!(payload, b"command deadline exceeded");
					break;
				}
				opcode => panic!("unexpected deadline response {opcode:?}"),
			}
		}
		worker.join().expect("control worker");
		assert!(output_bytes > 0);
		assert!(started_at.elapsed() < Duration::from_secs(1));
		assert!(!crate::process_exists(guest_pid).expect("process check"));
	}

	#[test]
	fn full_stdin_queue_returns_eagain_instead_of_false_success() {
		let (mut client, worker) = control_pair();
		client
			.set_read_timeout(Some(Duration::from_secs(2)))
			.expect("read timeout");
		send_command(&mut client, 14, "/bin/sleep", &["30"]);
		assert_eq!(receive_frame(&mut client).0.opcode, Opcode::Started);

		let fragment = vec![b'x'; 16 * 1024];
		let mut saturated = false;
		for action_id in 1..=32 {
			let payload = encode_action_request(action_id, &fragment).expect("stdin action");
			send_payload(&mut client, Opcode::Stdin, 14, &payload);
			let (header, payload) = receive_frame(&mut client);
			assert_eq!(header.opcode, Opcode::ActionResult);
			let result = WireActionResult::decode(&payload).expect("action result");
			assert_eq!(result.action_id, action_id);
			if result.errno == libc::EAGAIN {
				assert_eq!(result.accepted_bytes, 0);
				saturated = true;
				break;
			}
			assert_eq!(result.errno, 0);
			assert_eq!(
				result.accepted_bytes,
				u32::try_from(fragment.len()).expect("bounded fragment")
			);
		}
		assert!(
			saturated,
			"stdin queue did not saturate within its fixed bound"
		);
		drop(client);
		worker.join().expect("control worker");
	}

	fn send_command(stream: &mut TcpStream, request_id: u64, program: &str, arguments: &[&str]) {
		send_command_with_timeout(stream, request_id, program, arguments, 0);
	}

	fn send_command_with_timeout(
		stream: &mut TcpStream,
		request_id: u64,
		program: &str,
		arguments: &[&str],
		timeout_ms: u64,
	) {
		let payload = WireCommandSpec {
			program: program.as_bytes().to_vec(),
			arguments: arguments
				.iter()
				.map(|argument| argument.as_bytes().to_vec())
				.collect(),
			environment: Vec::new(),
			cwd: b"/".to_vec(),
			user: WireUser::Current,
			terminal: None,
			timeout_ms,
		}
		.encode()
		.expect("encode command");
		send_payload(stream, Opcode::Exec, request_id, &payload);
	}

	fn send_payload(stream: &mut TcpStream, opcode: Opcode, request_id: u64, payload: &[u8]) {
		let header = Header::new(opcode, request_id, payload.len(), 0).expect("request header");
		stream.write_all(&header.encode()).expect("write header");
		stream.write_all(payload).expect("write payload");
	}

	fn receive_frame(stream: &mut TcpStream) -> (Header, Vec<u8>) {
		let mut bytes = [0_u8; HEADER_SIZE];
		stream.read_exact(&mut bytes).expect("read response header");
		let header = Header::decode(&bytes).expect("decode response");
		let mut payload = vec![0; header.payload_len as usize];
		stream.read_exact(&mut payload).expect("read response body");
		(header, payload)
	}

	fn assert_action_result(
		stream: &mut TcpStream,
		action_id: u64,
		accepted_bytes: u32,
		errno: i32,
	) {
		let (header, payload) = receive_frame(stream);
		assert_eq!(header.opcode, Opcode::ActionResult);
		assert_eq!(
			WireActionResult::decode(&payload).expect("decode action result"),
			WireActionResult {
				action_id,
				accepted_bytes,
				errno,
			}
		);
	}

	fn control_pair() -> (TcpStream, thread::JoinHandle<()>) {
		let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
		let address = listener.local_addr().expect("address");
		let worker = thread::spawn(move || {
			let (stream, _) = listener.accept().expect("accept");
			handle_connection(stream).expect("handle control connection");
		});
		let client = TcpStream::connect(address).expect("connect");
		(client, worker)
	}
}
