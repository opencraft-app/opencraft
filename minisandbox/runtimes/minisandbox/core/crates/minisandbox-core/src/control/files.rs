//! Host-side bounded guest filesystem API.

use std::{
    ffi::OsString,
    net::TcpStream,
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub use minisandbox_control_protocol::FileKind;
use minisandbox_control_protocol::{
    Header, MAX_FILE_BYTES, MAX_FRAME_PAYLOAD, MAX_LIST_ENTRIES, Opcode, WireFileInfo,
    encode_path_pair, validate_path,
};

use super::{
    ControlError, SandboxControl, read_required_frame, remote_error, require_request, write_frame,
};

/// Cloneable filesystem client scoped to one restored guest.
#[derive(Clone)]
pub struct SandboxFiles {
    control: SandboxControl,
}

impl SandboxFiles {
    pub(super) fn new(control: SandboxControl) -> Self {
        Self { control }
    }

    /// Reads one regular guest file, up to 64 MiB.
    ///
    /// # Errors
    ///
    /// Returns a path, deadline, transport, protocol, remote, or size-limit error.
    pub fn read(&self, path: impl AsRef<Path>, timeout: Duration) -> Result<Vec<u8>, ControlError> {
        let mut connection = self.path_request(Opcode::FileRead, path.as_ref(), 0, timeout)?;
        let mut data = Vec::new();
        loop {
            let (header, payload) = connection.read()?;
            match header.opcode {
                Opcode::FileData => {
                    let length = data
                        .len()
                        .checked_add(payload.len())
                        .filter(|length| *length <= MAX_FILE_BYTES)
                        .ok_or(ControlError::FileLimit)?;
                    data.reserve(length - data.len());
                    data.extend_from_slice(&payload);
                }
                Opcode::Done => {
                    if usize::try_from(header.value).ok() != Some(data.len()) {
                        return Err(ControlError::CountMismatch);
                    }
                    return Ok(data);
                }
                Opcode::Failed => return Err(remote_error(header, payload)),
                opcode => return Err(ControlError::UnexpectedOpcode(opcode)),
            }
        }
    }

    /// Atomically replaces one guest file with at most 64 MiB of bytes.
    ///
    /// The agent writes a same-directory temporary file and renames it only
    /// after every chunk arrives. A disconnect leaves the old target intact.
    ///
    /// # Errors
    ///
    /// Returns a path, deadline, transport, protocol, remote, or size-limit error.
    pub fn write(
        &self,
        path: impl AsRef<Path>,
        data: &[u8],
        timeout: Duration,
    ) -> Result<(), ControlError> {
        if data.len() > MAX_FILE_BYTES {
            return Err(ControlError::FileLimit);
        }
        let mut connection = self.path_request(Opcode::FileWrite, path.as_ref(), 0, timeout)?;
        let (header, payload) = connection.read()?;
        match header.opcode {
            Opcode::Ready => {}
            Opcode::Failed => return Err(remote_error(header, payload)),
            opcode => return Err(ControlError::UnexpectedOpcode(opcode)),
        }
        for chunk in data.chunks(MAX_FRAME_PAYLOAD) {
            connection.write(Opcode::FileWriteChunk, chunk, 0)?;
        }
        connection.write(Opcode::FileWriteEnd, &[], 0)?;
        let (header, payload) = connection.read()?;
        match header.opcode {
            Opcode::Done if usize::try_from(header.value).ok() == Some(data.len()) => Ok(()),
            Opcode::Done => Err(ControlError::CountMismatch),
            Opcode::Failed => Err(remote_error(header, payload)),
            opcode => Err(ControlError::UnexpectedOpcode(opcode)),
        }
    }

    /// Returns `lstat`-style metadata without following the final symlink.
    ///
    /// # Errors
    ///
    /// Returns a path, deadline, transport, protocol, or remote error.
    pub fn stat(
        &self,
        path: impl AsRef<Path>,
        timeout: Duration,
    ) -> Result<FileInfo, ControlError> {
        let mut connection = self.path_request(Opcode::FileStat, path.as_ref(), 0, timeout)?;
        let (header, payload) = connection.read()?;
        let info = match header.opcode {
            Opcode::FileInfo => FileInfo::from_wire(WireFileInfo::decode(&payload)?),
            Opcode::Failed => return Err(remote_error(header, payload)),
            opcode => return Err(ControlError::UnexpectedOpcode(opcode)),
        };
        let (header, payload) = connection.read()?;
        match header.opcode {
            Opcode::Done if header.value == 1 => Ok(info),
            Opcode::Done => Err(ControlError::CountMismatch),
            Opcode::Failed => Err(remote_error(header, payload)),
            opcode => Err(ControlError::UnexpectedOpcode(opcode)),
        }
    }

    /// Lists at most 4096 direct children, sorted by raw Unix filename bytes.
    ///
    /// # Errors
    ///
    /// Returns a path, deadline, transport, protocol, remote, or entry-limit error.
    pub fn list(
        &self,
        path: impl AsRef<Path>,
        timeout: Duration,
    ) -> Result<Vec<FileInfo>, ControlError> {
        let mut connection = self.path_request(Opcode::FileList, path.as_ref(), 0, timeout)?;
        let mut entries = Vec::new();
        loop {
            let (header, payload) = connection.read()?;
            match header.opcode {
                Opcode::FileInfo => {
                    if entries.len() == MAX_LIST_ENTRIES {
                        return Err(ControlError::ListLimit);
                    }
                    entries.push(FileInfo::from_wire(WireFileInfo::decode(&payload)?));
                }
                Opcode::Done => {
                    if usize::try_from(header.value).ok() != Some(entries.len()) {
                        return Err(ControlError::CountMismatch);
                    }
                    return Ok(entries);
                }
                Opcode::Failed => return Err(remote_error(header, payload)),
                opcode => return Err(ControlError::UnexpectedOpcode(opcode)),
            }
        }
    }

    /// Creates a guest directory, optionally including missing parents.
    ///
    /// # Errors
    ///
    /// Returns a path, deadline, transport, protocol, or remote error.
    pub fn make_dir(
        &self,
        path: impl AsRef<Path>,
        recursive: bool,
        timeout: Duration,
    ) -> Result<(), ControlError> {
        self.simple_path(
            Opcode::FileMkdir,
            path.as_ref(),
            i32::from(recursive),
            timeout,
        )
    }

    /// Removes a file, symlink, or directory from the guest.
    ///
    /// Recursive mode is meaningful only for directories. Removing `/` is rejected.
    ///
    /// # Errors
    ///
    /// Returns a path, deadline, transport, protocol, or remote error.
    pub fn remove(
        &self,
        path: impl AsRef<Path>,
        recursive: bool,
        timeout: Duration,
    ) -> Result<(), ControlError> {
        self.simple_path(
            Opcode::FileRemove,
            path.as_ref(),
            i32::from(recursive),
            timeout,
        )
    }

    /// Atomically renames one guest path within the mounted filesystem rules.
    ///
    /// # Errors
    ///
    /// Returns a path, deadline, transport, protocol, or remote error.
    pub fn rename(
        &self,
        from: impl AsRef<Path>,
        to: impl AsRef<Path>,
        timeout: Duration,
    ) -> Result<(), ControlError> {
        let from = path_bytes(from.as_ref())?;
        let to = path_bytes(to.as_ref())?;
        let payload = encode_path_pair(from, to)?;
        let mut connection = self.request(Opcode::FileRename, &payload, 0, timeout)?;
        expect_empty_done(&mut connection)
    }

    fn simple_path(
        &self,
        opcode: Opcode,
        path: &Path,
        value: i32,
        timeout: Duration,
    ) -> Result<(), ControlError> {
        let mut connection = self.path_request(opcode, path, value, timeout)?;
        expect_empty_done(&mut connection)
    }

    fn path_request(
        &self,
        opcode: Opcode,
        path: &Path,
        value: i32,
        timeout: Duration,
    ) -> Result<FileConnection, ControlError> {
        let path = path_bytes(path)?;
        self.request(opcode, path, value, timeout)
    }

    fn request(
        &self,
        opcode: Opcode,
        payload: &[u8],
        value: i32,
        timeout: Duration,
    ) -> Result<FileConnection, ControlError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(ControlError::DeadlineExceeded)?;
        let request_id = self.control.request_id();
        let stream = self.control.open(timeout)?;
        let mut connection = FileConnection {
            stream,
            request_id,
            deadline,
        };
        connection.write(opcode, payload, value)?;
        Ok(connection)
    }
}

/// One guest filesystem metadata record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileInfo {
    /// Requested path for `stat`, or basename for `list`.
    pub name: OsString,
    /// File type without following symlinks.
    pub kind: FileKind,
    /// Linux `st_mode`, including type and permission bits.
    pub mode: u32,
    /// Logical byte size.
    pub size: u64,
    /// Whole seconds since the Unix epoch.
    pub modified_sec: i64,
    /// Fractional nanoseconds.
    pub modified_nsec: u32,
    /// Raw symlink target, when [`Self::kind`] is [`FileKind::Symlink`].
    pub symlink_target: Option<PathBuf>,
}

impl FileInfo {
    fn from_wire(info: WireFileInfo) -> Self {
        Self {
            name: OsString::from_vec(info.name),
            kind: info.kind,
            mode: info.mode,
            size: info.size,
            modified_sec: info.modified_sec,
            modified_nsec: info.modified_nsec,
            symlink_target: info
                .symlink_target
                .map(OsString::from_vec)
                .map(PathBuf::from),
        }
    }
}

struct FileConnection {
    stream: TcpStream,
    request_id: u64,
    deadline: Instant,
}

impl FileConnection {
    fn read(&mut self) -> Result<(Header, Vec<u8>), ControlError> {
        self.apply_deadline(false)?;
        let (header, payload) = read_required_frame(&mut self.stream)?;
        require_request(header, self.request_id)?;
        Ok((header, payload))
    }

    fn write(&mut self, opcode: Opcode, payload: &[u8], value: i32) -> Result<(), ControlError> {
        self.apply_deadline(true)?;
        let header = Header::new(opcode, self.request_id, payload.len(), value)?;
        write_frame(&mut self.stream, header, payload)?;
        Ok(())
    }

    fn apply_deadline(&self, writing: bool) -> Result<(), ControlError> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or(ControlError::DeadlineExceeded)?;
        if writing {
            self.stream.set_write_timeout(Some(remaining))?;
        } else {
            self.stream.set_read_timeout(Some(remaining))?;
        }
        Ok(())
    }
}

fn expect_empty_done(connection: &mut FileConnection) -> Result<(), ControlError> {
    let (header, payload) = connection.read()?;
    match header.opcode {
        Opcode::Done if header.value == 0 => Ok(()),
        Opcode::Done => Err(ControlError::CountMismatch),
        Opcode::Failed => Err(remote_error(header, payload)),
        opcode => Err(ControlError::UnexpectedOpcode(opcode)),
    }
}

fn path_bytes(path: &Path) -> Result<&[u8], ControlError> {
    let bytes = path.as_os_str().as_bytes();
    validate_path(bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener, TcpStream},
        thread,
        time::{Duration, Instant},
    };

    use minisandbox_control_protocol::{HEADER_SIZE, Header, Opcode};

    use super::{ControlError, FileConnection, expect_empty_done, path_bytes};

    #[test]
    fn relative_paths_never_reach_transport() {
        assert!(matches!(
            path_bytes(std::path::Path::new("relative")),
            Err(ControlError::Wire(_))
        ));
    }

    #[test]
    fn terminal_count_mismatch_is_detectable() {
        let (client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            let header = Header::new(Opcode::Done, 7, 0, 3).expect("done");
            server.write_all(&header.encode()).expect("write response");
        });
        let mut connection = FileConnection {
            stream: client,
            request_id: 7,
            deadline: Instant::now() + Duration::from_secs(1),
        };
        assert!(matches!(
            expect_empty_done(&mut connection),
            Err(ControlError::CountMismatch)
        ));
        worker.join().expect("worker");
    }

    #[test]
    fn hostile_payload_length_fails_before_body_read() {
        let (mut client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            let mut header = Header::new(Opcode::Done, 9, 0, 0).expect("header").encode();
            header[16..20].copy_from_slice(&(64_u32 * 1024 + 1).to_le_bytes());
            server.write_all(&header).expect("write malformed header");
        });
        let mut header = [0_u8; HEADER_SIZE];
        client
            .read_exact(&mut header)
            .expect("read malformed header");
        assert!(Header::decode(&header).is_err());
        worker.join().expect("worker");
    }

    #[test]
    fn expired_absolute_deadline_fails_before_io() {
        let (client, server) = tcp_pair();
        let mut connection = FileConnection {
            stream: client,
            request_id: 10,
            deadline: Instant::now(),
        };
        assert!(matches!(
            connection.read(),
            Err(ControlError::DeadlineExceeded)
        ));
        drop(server);
    }

    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let address = listener.local_addr().expect("address");
        let worker = thread::spawn(move || listener.accept().expect("accept").0);
        let client = TcpStream::connect_timeout(&address, Duration::from_secs(1)).expect("connect");
        (client, worker.join().expect("accept worker"))
    }
}
