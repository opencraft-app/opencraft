//! Bounded filesystem requests for the clone-local control agent.

use std::{
	ffi::OsString,
	fs::{self, File, OpenOptions},
	io::{self, Read, Write},
	os::unix::{
		ffi::{OsStrExt, OsStringExt},
		fs::{MetadataExt, OpenOptionsExt},
	},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use minisandbox_control_protocol::{
	FileKind, Header, MAX_FILE_BYTES, MAX_FRAME_PAYLOAD, MAX_LIST_ENTRIES, Opcode, WireFileInfo,
	decode_path_pair, validate_path,
};

use super::{read_frame, wire_io_error, write_failure, write_frame};

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(1);

pub(super) fn handle(
	stream: &mut std::net::TcpStream,
	header: Header,
	payload: &[u8],
) -> io::Result<()> {
	let request_id = header.request_id;
	let result = match header.opcode {
		Opcode::FileRead => read_file(stream, request_id, payload),
		Opcode::FileWrite => write_file(stream, request_id, payload),
		Opcode::FileStat => stat(stream, request_id, payload),
		Opcode::FileList => list(stream, request_id, payload),
		Opcode::FileMkdir => mkdir(payload, header.value != 0),
		Opcode::FileRemove => remove(payload, header.value != 0),
		Opcode::FileRename => rename(payload),
		_ => unreachable!("caller filters initial file opcodes"),
	};
	match result {
		Ok(OperationResult::AlreadyReplied) => Ok(()),
		Ok(OperationResult::Count(count)) => write_done(stream, request_id, count),
		Err(error) => write_failure(
			stream,
			request_id,
			errno(&error),
			b"filesystem operation failed",
		),
	}
}

fn errno(error: &io::Error) -> i32 {
	error.raw_os_error().unwrap_or(match error.kind() {
		io::ErrorKind::InvalidData => libc::EPROTO,
		io::ErrorKind::UnexpectedEof => libc::ECONNRESET,
		_ => libc::EIO,
	})
}

enum OperationResult {
	AlreadyReplied,
	Count(usize),
}

fn read_file(
	stream: &mut std::net::TcpStream,
	request_id: u64,
	requested: &[u8],
) -> io::Result<OperationResult> {
	let path = path(requested)?;
	let mut file = File::open(path)?;
	let metadata = file.metadata()?;
	if !metadata.is_file() {
		return Err(io::Error::from_raw_os_error(libc::EINVAL));
	}
	if metadata.len() > MAX_FILE_BYTES as u64 {
		return Err(io::Error::from_raw_os_error(libc::EFBIG));
	}
	let mut total = 0_usize;
	let mut buffer = vec![0_u8; MAX_FRAME_PAYLOAD];
	loop {
		let length = file.read(&mut buffer)?;
		if length == 0 {
			break;
		}
		total = total
			.checked_add(length)
			.filter(|total| *total <= MAX_FILE_BYTES)
			.ok_or_else(|| io::Error::from_raw_os_error(libc::EFBIG))?;
		write_frame(
			stream,
			Header::new(Opcode::FileData, request_id, length, 0).map_err(wire_io_error)?,
			&buffer[..length],
		)?;
	}
	write_done(stream, request_id, total)?;
	Ok(OperationResult::AlreadyReplied)
}

fn write_file(
	stream: &mut std::net::TcpStream,
	request_id: u64,
	target: &[u8],
) -> io::Result<OperationResult> {
	let target = path(target)?;
	if target == Path::new("/") {
		return Err(io::Error::from_raw_os_error(libc::EISDIR));
	}
	let parent = target
		.parent()
		.ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
	let (temporary, mut file) = create_temporary(parent)?;
	let guard = TemporaryFile::new(temporary);
	if let Ok(metadata) = fs::metadata(&target) {
		file.set_permissions(metadata.permissions())?;
	}
	write_frame(
		stream,
		Header::new(Opcode::Ready, request_id, 0, 0).map_err(wire_io_error)?,
		&[],
	)?;

	let mut total = 0_usize;
	loop {
		let Some((header, payload)) = read_frame(stream)? else {
			return Err(io::Error::new(
				io::ErrorKind::UnexpectedEof,
				"file write disconnected before commit",
			));
		};
		if header.request_id != request_id {
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				"file write request ID mismatch",
			));
		}
		match header.opcode {
			Opcode::FileWriteChunk => {
				total = total
					.checked_add(payload.len())
					.filter(|total| *total <= MAX_FILE_BYTES)
					.ok_or_else(|| io::Error::from_raw_os_error(libc::EFBIG))?;
				file.write_all(&payload)?;
			}
			Opcode::FileWriteEnd => break,
			_ => {
				return Err(io::Error::new(
					io::ErrorKind::InvalidData,
					"unexpected file write frame",
				));
			}
		}
	}
	file.flush()?;
	drop(file);
	fs::rename(guard.path(), &target)?;
	guard.commit();
	Ok(OperationResult::Count(total))
}

fn stat(
	stream: &mut std::net::TcpStream,
	request_id: u64,
	requested: &[u8],
) -> io::Result<OperationResult> {
	let requested_path = path(requested)?;
	let info = metadata_info(&requested_path, requested.to_vec())?;
	write_info(stream, request_id, &info)?;
	write_done(stream, request_id, 1)?;
	Ok(OperationResult::AlreadyReplied)
}

fn list(
	stream: &mut std::net::TcpStream,
	request_id: u64,
	requested: &[u8],
) -> io::Result<OperationResult> {
	let requested = path(requested)?;
	let mut entries = Vec::new();
	for entry in fs::read_dir(requested)? {
		if entries.len() == MAX_LIST_ENTRIES {
			return Err(io::Error::from_raw_os_error(libc::EOVERFLOW));
		}
		let entry = entry?;
		entries.push(metadata_info(&entry.path(), entry.file_name().into_vec())?);
	}
	entries.sort_unstable_by(|left, right| left.name.cmp(&right.name));
	for entry in &entries {
		write_info(stream, request_id, entry)?;
	}
	write_done(stream, request_id, entries.len())?;
	Ok(OperationResult::AlreadyReplied)
}

fn mkdir(requested: &[u8], recursive: bool) -> io::Result<OperationResult> {
	let requested = path(requested)?;
	if recursive {
		fs::create_dir_all(requested)?;
	} else {
		fs::create_dir(requested)?;
	}
	Ok(OperationResult::Count(0))
}

fn remove(requested: &[u8], recursive: bool) -> io::Result<OperationResult> {
	let requested = path(requested)?;
	if requested == Path::new("/") {
		return Err(io::Error::from_raw_os_error(libc::EBUSY));
	}
	let metadata = fs::symlink_metadata(&requested)?;
	if metadata.is_dir() {
		if recursive {
			fs::remove_dir_all(requested)?;
		} else {
			fs::remove_dir(requested)?;
		}
	} else {
		fs::remove_file(requested)?;
	}
	Ok(OperationResult::Count(0))
}

fn rename(payload: &[u8]) -> io::Result<OperationResult> {
	let (from, to) = decode_path_pair(payload).map_err(wire_io_error)?;
	let from = PathBuf::from(OsString::from_vec(from.to_vec()));
	let to = PathBuf::from(OsString::from_vec(to.to_vec()));
	if from == Path::new("/") || to == Path::new("/") {
		return Err(io::Error::from_raw_os_error(libc::EBUSY));
	}
	fs::rename(from, to)?;
	Ok(OperationResult::Count(0))
}

fn metadata_info(path: &Path, name: Vec<u8>) -> io::Result<WireFileInfo> {
	let metadata = fs::symlink_metadata(path)?;
	let file_type = metadata.file_type();
	let kind = if file_type.is_file() {
		FileKind::File
	} else if file_type.is_dir() {
		FileKind::Directory
	} else if file_type.is_symlink() {
		FileKind::Symlink
	} else {
		FileKind::Other
	};
	let symlink_target = if kind == FileKind::Symlink {
		Some(fs::read_link(path)?.as_os_str().as_bytes().to_vec())
	} else {
		None
	};
	Ok(WireFileInfo {
		kind,
		mode: metadata.mode(),
		size: metadata.size(),
		modified_sec: metadata.mtime(),
		modified_nsec: u32::try_from(metadata.mtime_nsec())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid mtime nanoseconds"))?,
		name,
		symlink_target,
	})
}

fn write_info(
	stream: &mut std::net::TcpStream,
	request_id: u64,
	info: &WireFileInfo,
) -> io::Result<()> {
	let payload = info.encode().map_err(wire_io_error)?;
	write_frame(
		stream,
		Header::new(Opcode::FileInfo, request_id, payload.len(), 0).map_err(wire_io_error)?,
		&payload,
	)
}

fn write_done(stream: &mut std::net::TcpStream, request_id: u64, count: usize) -> io::Result<()> {
	let count = i32::try_from(count)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file count exceeds i32"))?;
	write_frame(
		stream,
		Header::new(Opcode::Done, request_id, 0, count).map_err(wire_io_error)?,
		&[],
	)
}

fn path(bytes: &[u8]) -> io::Result<PathBuf> {
	validate_path(bytes).map_err(wire_io_error)?;
	Ok(PathBuf::from(OsString::from_vec(bytes.to_vec())))
}

fn create_temporary(parent: &Path) -> io::Result<(PathBuf, File)> {
	for _ in 0..16 {
		let number = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
		let name = OsString::from(format!(
			".minisandbox-upload-{}-{number}",
			std::process::id()
		));
		let path = parent.join(name);
		match OpenOptions::new()
			.write(true)
			.create_new(true)
			.mode(0o644)
			.open(&path)
		{
			Ok(file) => return Ok((path, file)),
			Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
			Err(error) => return Err(error),
		}
	}
	Err(io::Error::from_raw_os_error(libc::EEXIST))
}

struct TemporaryFile {
	path: PathBuf,
	committed: bool,
}

impl TemporaryFile {
	fn new(path: PathBuf) -> Self {
		Self {
			path,
			committed: false,
		}
	}

	fn path(&self) -> &Path {
		&self.path
	}

	fn commit(mut self) {
		self.committed = true;
	}
}

impl Drop for TemporaryFile {
	fn drop(&mut self) {
		if !self.committed {
			let _ = fs::remove_file(&self.path);
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		io::{Read, Write},
		net::{Ipv4Addr, TcpListener, TcpStream},
		os::unix::ffi::OsStrExt,
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
		thread,
	};

	use minisandbox_control_protocol::{HEADER_SIZE, Header, Opcode};

	use super::handle;

	static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

	#[test]
	fn streamed_write_commits_atomically() {
		let directory = test_directory();
		let target = directory.join("target");
		fs::write(&target, b"old").expect("seed target");
		let path = target.as_os_str().as_bytes().to_vec();
		let (mut client, mut server) = tcp_pair();
		let worker = thread::spawn(move || {
			let header = Header::new(Opcode::FileWrite, 41, path.len(), 0).expect("write header");
			handle(&mut server, header, &path).expect("handle write");
		});

		assert_eq!(read_frame(&mut client).0.opcode, Opcode::Ready);
		send_frame(&mut client, Opcode::FileWriteChunk, 41, b"new-");
		send_frame(&mut client, Opcode::FileWriteChunk, 41, b"content");
		send_frame(&mut client, Opcode::FileWriteEnd, 41, &[]);
		let (done, payload) = read_frame(&mut client);
		assert_eq!(done.opcode, Opcode::Done);
		assert_eq!(done.value, 11);
		assert!(payload.is_empty());
		worker.join().expect("worker");
		assert_eq!(fs::read(&target).expect("read target"), b"new-content");
		assert_no_uploads(&directory);
		fs::remove_dir_all(directory).expect("clean test directory");
	}

	#[test]
	fn disconnected_write_keeps_target_and_removes_temporary() {
		let directory = test_directory();
		let target = directory.join("target");
		fs::write(&target, b"original").expect("seed target");
		let path = target.as_os_str().as_bytes().to_vec();
		let (mut client, mut server) = tcp_pair();
		let worker = thread::spawn(move || {
			let header = Header::new(Opcode::FileWrite, 42, path.len(), 0).expect("write header");
			let _ = handle(&mut server, header, &path);
		});

		assert_eq!(read_frame(&mut client).0.opcode, Opcode::Ready);
		send_frame(&mut client, Opcode::FileWriteChunk, 42, b"partial");
		drop(client);
		worker.join().expect("worker");
		assert_eq!(fs::read(&target).expect("read target"), b"original");
		assert_no_uploads(&directory);
		fs::remove_dir_all(directory).expect("clean test directory");
	}

	fn send_frame(stream: &mut TcpStream, opcode: Opcode, request_id: u64, payload: &[u8]) {
		let header = Header::new(opcode, request_id, payload.len(), 0).expect("frame header");
		stream.write_all(&header.encode()).expect("write header");
		stream.write_all(payload).expect("write payload");
	}

	fn read_frame(stream: &mut TcpStream) -> (Header, Vec<u8>) {
		let mut bytes = [0_u8; HEADER_SIZE];
		stream.read_exact(&mut bytes).expect("read header");
		let header = Header::decode(&bytes).expect("decode header");
		let mut payload = vec![0_u8; header.payload_len as usize];
		stream.read_exact(&mut payload).expect("read payload");
		(header, payload)
	}

	fn assert_no_uploads(directory: &PathBuf) {
		let names: Vec<_> = fs::read_dir(directory)
			.expect("read test directory")
			.map(|entry| entry.expect("directory entry").file_name())
			.collect();
		assert!(
			names.iter().all(|name| !name
				.as_os_str()
				.as_bytes()
				.starts_with(b".minisandbox-upload-")),
			"temporary upload leaked: {names:?}"
		);
	}

	fn test_directory() -> PathBuf {
		let number = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
		let directory = std::env::temp_dir().join(format!(
			"minisandbox-file-agent-test-{}-{number}",
			std::process::id()
		));
		fs::create_dir(&directory).expect("create test directory");
		directory
	}

	fn tcp_pair() -> (TcpStream, TcpStream) {
		let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
		let address = listener.local_addr().expect("address");
		let worker = thread::spawn(move || listener.accept().expect("accept").0);
		let client = TcpStream::connect(address).expect("connect");
		(client, worker.join().expect("accept worker"))
	}
}
