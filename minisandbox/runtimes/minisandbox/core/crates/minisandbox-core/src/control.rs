//! Host-side client for the clone-local sandbox control agent.

mod commands;
mod files;

pub use commands::{CommandSpec, CommandUser, PtySize};
pub use files::{FileInfo, FileKind, SandboxFiles};

use std::{
    collections::VecDeque,
    fmt,
    io::{self, Read, Write},
    net::TcpStream,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use minisandbox_control_protocol::{
    CONTROL_PORT, HEADER_SIZE, Header, MAX_CAPTURE_BYTES, Opcode, WireActionResult, WireError,
    encode_action_request,
};
pub use pvm_socket_service::SocketIngressError;
use pvm_socket_service::SocketIngressHandle;

const LINUX_ETIMEDOUT: i32 = 110;

/// Cloneable entrance to one restored guest's command agent.
#[derive(Clone)]
pub struct SandboxControl {
    ingress: SocketIngressHandle,
    next_request: Arc<AtomicU64>,
}

impl SandboxControl {
    pub(crate) fn new(ingress: SocketIngressHandle) -> Self {
        Self {
            ingress,
            next_request: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Verifies that the clone-local agent is accepting commands.
    ///
    /// # Errors
    ///
    /// Returns an ingress, timeout, I/O, protocol, or remote-agent error.
    pub fn ping(&self, timeout: Duration) -> Result<(), ControlError> {
        let request_id = self.request_id();
        let mut stream = self.open(timeout)?;
        write_frame(
            &mut stream,
            Header::new(Opcode::Ping, request_id, 0, 0)?,
            &[],
        )?;
        let (header, payload) = read_required_frame(&mut stream)?;
        require_request(header, request_id)?;
        match header.opcode {
            Opcode::Pong => Ok(()),
            Opcode::Failed => Err(remote_error(header, payload)),
            opcode => Err(ControlError::UnexpectedOpcode(opcode)),
        }
    }

    /// Starts one structured command directly, without a shell or PATH lookup.
    ///
    /// The returned session owns the stream. Dropping it before [`CommandEvent::Exit`]
    /// disconnects the agent, which kills and reaps the command process group.
    ///
    /// # Errors
    ///
    /// Returns an ingress, timeout, I/O, protocol, or remote-agent error.
    pub fn start(
        &self,
        command: &CommandSpec,
        request_timeout: Duration,
    ) -> Result<CommandSession, ControlError> {
        self.start_inner(command, request_timeout, None)
    }

    /// Starts a command with separate request and total execution deadlines.
    ///
    /// The request timeout bounds ingress, startup, and each acknowledged
    /// control action. The command timeout starts after the guest announces
    /// the child PID and is also enforced independently inside the guest.
    ///
    /// # Errors
    ///
    /// Returns an ingress, deadline, I/O, protocol, or remote-agent error.
    pub fn start_with_timeout(
        &self,
        command: &CommandSpec,
        request_timeout: Duration,
        command_timeout: Duration,
    ) -> Result<CommandSession, ControlError> {
        self.start_inner(command, request_timeout, Some(command_timeout))
    }

    fn start_inner(
        &self,
        command: &CommandSpec,
        request_timeout: Duration,
        command_timeout: Option<Duration>,
    ) -> Result<CommandSession, ControlError> {
        let request_id = self.request_id();
        let mut stream = self.open(request_timeout)?;
        let terminal = command.has_terminal();
        let command = command.encode(command_timeout)?;
        write_frame(
            &mut stream,
            Header::new(Opcode::Exec, request_id, command.len(), 0)?,
            &command,
        )?;
        let (header, payload) = read_required_frame(&mut stream)?;
        require_request(header, request_id)?;
        match header.opcode {
            Opcode::Started => CommandSession::new(
                stream,
                request_id,
                header.value,
                terminal,
                request_timeout,
                command_timeout,
            ),
            Opcode::Failed => Err(remote_error(header, payload)),
            opcode => Err(ControlError::UnexpectedOpcode(opcode)),
        }
    }

    /// Runs one command and captures bounded stdout and stderr.
    ///
    /// For streaming, stdin, or signals, use [`Self::start`] instead.
    ///
    /// # Errors
    ///
    /// Returns an ingress, timeout, I/O, protocol, remote-agent, or capture
    /// capacity error.
    pub fn execute(
        &self,
        command: &CommandSpec,
        timeout: Duration,
    ) -> Result<CommandOutput, ControlError> {
        self.execute_with_timeouts(command, timeout, timeout)
    }

    /// Runs one command with distinct request and total execution deadlines.
    ///
    /// # Errors
    ///
    /// Returns the same bounded failures as [`Self::execute`].
    pub fn execute_with_timeouts(
        &self,
        command: &CommandSpec,
        request_timeout: Duration,
        command_timeout: Duration,
    ) -> Result<CommandOutput, ControlError> {
        self.start_with_timeout(command, request_timeout, command_timeout)?
            .collect()
    }

    /// Returns a cloneable bounded filesystem client for this guest.
    #[must_use]
    pub fn files(&self) -> SandboxFiles {
        SandboxFiles::new(self.clone())
    }

    pub(super) fn open(&self, timeout: Duration) -> Result<TcpStream, ControlError> {
        let stream = self
            .ingress
            .connect_tcp_with_timeout(CONTROL_PORT, timeout)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        Ok(stream)
    }

    pub(super) fn request_id(&self) -> u64 {
        let request_id = self.next_request.fetch_add(1, Ordering::Relaxed);
        if request_id == 0 {
            // A request ID is scoped to its private connection. Skipping zero
            // is sufficient even if this practically unreachable wrap races.
            self.next_request.fetch_add(1, Ordering::Relaxed)
        } else {
            request_id
        }
    }
}

/// One running guest command and its full-duplex control stream.
pub struct CommandSession {
    stream: TcpStream,
    request_id: u64,
    guest_pid: i32,
    terminal: bool,
    exited: bool,
    request_timeout: Duration,
    command_deadline: Option<Instant>,
    next_action_id: u64,
    pending_events: VecDeque<CommandEvent>,
    pending_bytes: usize,
}

impl CommandSession {
    fn new(
        stream: TcpStream,
        request_id: u64,
        guest_pid: i32,
        terminal: bool,
        request_timeout: Duration,
        command_timeout: Option<Duration>,
    ) -> Result<Self, ControlError> {
        let command_deadline = command_timeout
            .map(|timeout| {
                Instant::now()
                    .checked_add(timeout)
                    .ok_or(ControlError::DeadlineExceeded)
            })
            .transpose()?;
        stream.set_read_timeout(None)?;
        stream.set_write_timeout(Some(request_timeout))?;
        Ok(Self {
            stream,
            request_id,
            guest_pid,
            terminal,
            exited: false,
            request_timeout,
            command_deadline,
            next_action_id: 1,
            pending_events: VecDeque::new(),
            pending_bytes: 0,
        })
    }

    /// Guest PID announced after a successful exec.
    #[must_use]
    pub const fn guest_pid(&self) -> i32 {
        self.guest_pid
    }

    /// Sends one bounded standard-input fragment. An empty fragment closes stdin.
    ///
    /// # Errors
    ///
    /// Returns only after the guest acknowledges every accepted byte. Queue
    /// saturation is reported as an action error with `EAGAIN`; no fragment is
    /// silently discarded.
    pub fn write_stdin(&mut self, bytes: &[u8]) -> Result<(), ControlError> {
        self.perform_action(Opcode::Stdin, bytes, 0, bytes.len())
    }

    /// Closes the command's standard input.
    ///
    /// # Errors
    ///
    /// Returns a stream I/O error.
    pub fn close_stdin(&mut self) -> Result<(), ControlError> {
        self.write_stdin(&[])
    }

    /// Sends a Linux signal number to the command process group.
    ///
    /// # Errors
    ///
    /// Rejects values outside 1..=64 and returns stream I/O errors.
    pub fn signal(&mut self, signal: i32) -> Result<(), ControlError> {
        self.perform_action(Opcode::Signal, &[], signal, 0)
    }

    /// Changes the attached PTY dimensions and delivers `SIGWINCH` in the guest.
    ///
    /// # Errors
    ///
    /// Returns [`ControlError::NotTerminal`] for a pipe-backed command, or a
    /// wire/I/O error when the resize cannot be sent.
    pub fn resize(&mut self, size: PtySize) -> Result<(), ControlError> {
        if !self.terminal {
            return Err(ControlError::NotTerminal);
        }
        let payload = size.to_wire().encode()?;
        self.perform_action(Opcode::PtyResize, &payload, 0, 0)
    }

    /// Reads the next stdout, stderr, remote failure, or exit event.
    ///
    /// # Errors
    /// Returns an I/O or strict protocol error. EOF before exit is rejected.
    pub fn next_event(&mut self) -> Result<CommandEvent, ControlError> {
        if let Some(event) = self.pending_events.pop_front() {
            self.pending_bytes = self.pending_bytes.saturating_sub(event.payload_len());
            return Ok(event);
        }
        if self.exited {
            return Err(ControlError::AlreadyExited);
        }
        match self.read_session_frame(self.command_deadline)? {
            SessionFrame::Event(event) => Ok(event),
            SessionFrame::Action(_) => Err(ControlError::UnexpectedOpcode(Opcode::ActionResult)),
        }
    }

    /// Collects stdout and stderr up to the protocol-wide host capture limit.
    ///
    /// # Errors
    ///
    /// Returns a remote failure, I/O/protocol error, or [`ControlError::CaptureLimit`].
    pub fn collect(self) -> Result<CommandOutput, ControlError> {
        self.collect_with_limit(MAX_CAPTURE_BYTES)
    }

    /// Collects stdout and stderr up to an explicit combined byte limit.
    ///
    /// # Errors
    ///
    /// Returns a remote failure, I/O/protocol error, or [`ControlError::CaptureLimit`].
    pub fn collect_with_limit(mut self, limit: usize) -> Result<CommandOutput, ControlError> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            match self.next_event()? {
                CommandEvent::Stdout(bytes) | CommandEvent::Pty(bytes) => {
                    append_bounded(&mut stdout, &stderr, &bytes, limit)?;
                }
                CommandEvent::Stderr(bytes) => {
                    append_bounded(&mut stderr, &stdout, &bytes, limit)?;
                }
                CommandEvent::Failed { errno, message } => {
                    if errno == LINUX_ETIMEDOUT {
                        return Err(ControlError::DeadlineExceeded);
                    }
                    return Err(ControlError::Remote { errno, message });
                }
                CommandEvent::Exit(exit_code) => {
                    return Ok(CommandOutput {
                        guest_pid: self.guest_pid,
                        stdout,
                        stderr,
                        exit_code,
                    });
                }
            }
        }
    }

    fn perform_action(
        &mut self,
        opcode: Opcode,
        body: &[u8],
        value: i32,
        expected_bytes: usize,
    ) -> Result<(), ControlError> {
        if self.exited {
            return Err(ControlError::AlreadyExited);
        }
        let action_id = self.action_id();
        let payload = encode_action_request(action_id, body)?;
        let action_deadline = Instant::now()
            .checked_add(self.request_timeout)
            .ok_or(ControlError::DeadlineExceeded)?;
        let deadline = earlier_deadline(Some(action_deadline), self.command_deadline);
        self.apply_write_deadline(deadline)?;
        let header = Header::new(opcode, self.request_id, payload.len(), value)?;
        if let Err(error) = write_frame(&mut self.stream, header, &payload) {
            return Err(self.io_or_deadline(error, deadline));
        }
        loop {
            match self.read_session_frame(deadline)? {
                SessionFrame::Action(result) => {
                    if result.action_id != action_id {
                        self.expire();
                        return Err(ControlError::WrongActionId);
                    }
                    if result.errno != 0 {
                        return Err(ControlError::ActionFailed {
                            errno: result.errno,
                        });
                    }
                    if usize::try_from(result.accepted_bytes).ok() != Some(expected_bytes) {
                        self.expire();
                        return Err(ControlError::CountMismatch);
                    }
                    return Ok(());
                }
                SessionFrame::Event(event) => {
                    let terminal =
                        matches!(event, CommandEvent::Exit(_) | CommandEvent::Failed { .. });
                    self.queue_event(event)?;
                    if terminal {
                        return Err(ControlError::ActionInterrupted);
                    }
                }
            }
        }
    }

    fn read_session_frame(
        &mut self,
        deadline: Option<Instant>,
    ) -> Result<SessionFrame, ControlError> {
        self.apply_read_deadline(deadline)?;
        let (header, payload) = match read_required_frame(&mut self.stream) {
            Ok(frame) => frame,
            Err(ControlError::Io(error)) => return Err(self.io_or_deadline(error, deadline)),
            Err(error) => return Err(error),
        };
        require_request(header, self.request_id)?;
        let frame = match header.opcode {
            Opcode::Stdout if !self.terminal => SessionFrame::Event(CommandEvent::Stdout(payload)),
            Opcode::Stderr if !self.terminal => SessionFrame::Event(CommandEvent::Stderr(payload)),
            Opcode::PtyData if self.terminal => SessionFrame::Event(CommandEvent::Pty(payload)),
            Opcode::Failed => {
                self.exited = true;
                SessionFrame::Event(CommandEvent::Failed {
                    errno: -header.value,
                    message: payload,
                })
            }
            Opcode::Exit => {
                self.exited = true;
                let status = u8::try_from(header.value)
                    .map_err(|_| ControlError::Wire(WireError::NonCanonical))?;
                SessionFrame::Event(CommandEvent::Exit(status))
            }
            Opcode::ActionResult => SessionFrame::Action(WireActionResult::decode(&payload)?),
            opcode => return Err(ControlError::UnexpectedOpcode(opcode)),
        };
        Ok(frame)
    }

    fn queue_event(&mut self, event: CommandEvent) -> Result<(), ControlError> {
        let Some(pending_bytes) = self
            .pending_bytes
            .checked_add(event.payload_len())
            .filter(|bytes| *bytes <= MAX_CAPTURE_BYTES)
        else {
            self.expire();
            return Err(ControlError::CaptureLimit);
        };
        self.pending_bytes = pending_bytes;
        self.pending_events.push_back(event);
        Ok(())
    }

    fn action_id(&mut self) -> u64 {
        let id = self.next_action_id;
        self.next_action_id = self.next_action_id.wrapping_add(1);
        if self.next_action_id == 0 {
            self.next_action_id = 1;
        }
        id
    }

    fn apply_read_deadline(&mut self, deadline: Option<Instant>) -> Result<(), ControlError> {
        let timeout = self.remaining(deadline)?;
        self.stream.set_read_timeout(timeout)?;
        Ok(())
    }

    fn apply_write_deadline(&mut self, deadline: Option<Instant>) -> Result<(), ControlError> {
        let timeout = self.remaining(deadline)?.or(Some(self.request_timeout));
        self.stream.set_write_timeout(timeout)?;
        Ok(())
    }

    fn remaining(&mut self, deadline: Option<Instant>) -> Result<Option<Duration>, ControlError> {
        let Some(deadline) = deadline else {
            return Ok(None);
        };
        match deadline.checked_duration_since(Instant::now()) {
            Some(remaining) if !remaining.is_zero() => Ok(Some(remaining)),
            _ => {
                self.expire();
                Err(ControlError::DeadlineExceeded)
            }
        }
    }

    fn io_or_deadline(&mut self, error: io::Error, deadline: Option<Instant>) -> ControlError {
        if deadline.is_some()
            && matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            )
        {
            self.expire();
            ControlError::DeadlineExceeded
        } else {
            ControlError::Io(error)
        }
    }

    fn expire(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
        self.exited = true;
    }
}

enum SessionFrame {
    Event(CommandEvent),
    Action(WireActionResult),
}

fn earlier_deadline(first: Option<Instant>, second: Option<Instant>) -> Option<Instant> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
        (None, None) => None,
    }
}

/// One streaming command event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandEvent {
    /// Bounded stdout fragment.
    Stdout(Vec<u8>),
    /// Bounded stderr fragment.
    Stderr(Vec<u8>),
    /// Bounded merged output from an attached pseudo-terminal.
    Pty(Vec<u8>),
    /// Recoverable agent-side request failure.
    Failed {
        /// Positive Linux errno.
        errno: i32,
        /// Bounded diagnostic bytes.
        message: Vec<u8>,
    },
    /// Normalized command status in 0..=255.
    Exit(u8),
}

impl CommandEvent {
    fn payload_len(&self) -> usize {
        match self {
            Self::Stdout(bytes) | Self::Stderr(bytes) | Self::Pty(bytes) => bytes.len(),
            Self::Failed { message, .. } => message.len(),
            Self::Exit(_) => 0,
        }
    }
}

/// Complete bounded command result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandOutput {
    /// Guest PID allocated to the command leader.
    pub guest_pid: i32,
    /// Captured standard output.
    pub stdout: Vec<u8>,
    /// Captured standard error.
    pub stderr: Vec<u8>,
    /// Normalized command status in 0..=255.
    pub exit_code: u8,
}

/// Bounded host control failure classes.
#[derive(Debug)]
pub enum ControlError {
    /// The clone-local ingress queue or listener rejected the connection.
    Ingress(SocketIngressError),
    /// Host-local stream I/O failed or timed out.
    Io(io::Error),
    /// A fixed wire record was invalid.
    Wire(WireError),
    /// A frame carried another request's identifier.
    WrongRequestId,
    /// An action acknowledgement did not match the outstanding action.
    WrongActionId,
    /// A valid opcode appeared in the wrong protocol state.
    UnexpectedOpcode(Opcode),
    /// The agent closed the stream without a terminal status.
    Truncated,
    /// A completed session was used again.
    AlreadyExited,
    /// Combined captured stdout and stderr exceeded the caller's bound.
    CaptureLimit,
    /// One convenience file read or write exceeded the protocol byte limit.
    FileLimit,
    /// A directory returned more entries than the protocol limit.
    ListLimit,
    /// A terminal byte or entry count did not match the received data.
    CountMismatch,
    /// A stdin, signal, or resize action was rejected by the guest.
    ActionFailed {
        /// Positive Linux errno reported for this action only.
        errno: i32,
    },
    /// The process exited or failed before acknowledging an action.
    ActionInterrupted,
    /// The complete operation or command lifetime exceeded its deadline.
    DeadlineExceeded,
    /// A PTY-only operation was requested for a pipe-backed command.
    NotTerminal,
    /// The agent rejected an operation.
    Remote {
        /// Positive Linux errno.
        errno: i32,
        /// Bounded diagnostic bytes.
        message: Vec<u8>,
    },
}

impl fmt::Display for ControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ingress(error) => write!(formatter, "sandbox ingress failed: {error}"),
            Self::Io(error) => write!(formatter, "sandbox control I/O failed: {error}"),
            Self::Wire(error) => write!(formatter, "invalid sandbox control frame: {error}"),
            Self::WrongRequestId => formatter.write_str("sandbox control request ID mismatch"),
            Self::WrongActionId => formatter.write_str("sandbox control action ID mismatch"),
            Self::UnexpectedOpcode(opcode) => {
                write!(formatter, "unexpected sandbox control opcode {opcode:?}")
            }
            Self::Truncated => formatter.write_str("sandbox control stream ended before exit"),
            Self::AlreadyExited => formatter.write_str("sandbox command has already exited"),
            Self::CaptureLimit => {
                formatter.write_str("sandbox command output exceeded capture limit")
            }
            Self::FileLimit => formatter.write_str("sandbox file exceeded transfer limit"),
            Self::ListLimit => formatter.write_str("sandbox directory exceeded entry limit"),
            Self::CountMismatch => {
                formatter.write_str("sandbox response count did not match payload")
            }
            Self::ActionFailed { errno } => {
                write!(
                    formatter,
                    "sandbox command action failed with errno {errno}"
                )
            }
            Self::ActionInterrupted => {
                formatter.write_str("sandbox command ended before acknowledging action")
            }
            Self::DeadlineExceeded => {
                formatter.write_str("sandbox operation exceeded its deadline")
            }
            Self::NotTerminal => formatter.write_str("sandbox command has no attached terminal"),
            Self::Remote { errno, message } => write!(
                formatter,
                "sandbox agent failed with errno {errno}: {}",
                String::from_utf8_lossy(message)
            ),
        }
    }
}

impl std::error::Error for ControlError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ingress(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Wire(error) => Some(error),
            _ => None,
        }
    }
}

impl From<SocketIngressError> for ControlError {
    fn from(error: SocketIngressError) -> Self {
        Self::Ingress(error)
    }
}

impl From<io::Error> for ControlError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<WireError> for ControlError {
    fn from(error: WireError) -> Self {
        Self::Wire(error)
    }
}

fn append_bounded(
    destination: &mut Vec<u8>,
    other: &[u8],
    bytes: &[u8],
    limit: usize,
) -> Result<(), ControlError> {
    let total = destination
        .len()
        .checked_add(other.len())
        .and_then(|used| used.checked_add(bytes.len()))
        .ok_or(ControlError::CaptureLimit)?;
    if total > limit {
        return Err(ControlError::CaptureLimit);
    }
    destination.extend_from_slice(bytes);
    Ok(())
}

pub(super) fn require_request(header: Header, request_id: u64) -> Result<(), ControlError> {
    if header.request_id == request_id {
        Ok(())
    } else {
        Err(ControlError::WrongRequestId)
    }
}

pub(super) fn remote_error(header: Header, payload: Vec<u8>) -> ControlError {
    ControlError::Remote {
        errno: -header.value,
        message: payload,
    }
}

pub(super) fn read_required_frame(
    stream: &mut TcpStream,
) -> Result<(Header, Vec<u8>), ControlError> {
    let mut bytes = [0_u8; HEADER_SIZE];
    match stream.read_exact(&mut bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(ControlError::Truncated);
        }
        Err(error) => return Err(ControlError::Io(error)),
    }
    let header = Header::decode(&bytes)?;
    let mut payload = vec![0_u8; header.payload_len as usize];
    stream.read_exact(&mut payload)?;
    Ok((header, payload))
}

pub(super) fn write_frame(
    stream: &mut TcpStream,
    header: Header,
    payload: &[u8],
) -> io::Result<()> {
    if header.payload_len as usize != payload.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "control payload length mismatch",
        ));
    }
    stream.write_all(&header.encode())?;
    stream.write_all(payload)
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
        HEADER_SIZE, Header, Opcode, WireActionResult, decode_action_request,
    };

    use super::{CommandSession, ControlError};

    #[test]
    fn session_streams_and_collects_separate_output() {
        let (mut client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            let mut request = [0_u8; HEADER_SIZE];
            server.read_exact(&mut request).expect("request header");
            let request = Header::decode(&request).expect("valid request");
            let mut command = vec![0; request.payload_len as usize];
            server.read_exact(&mut command).expect("command body");
            assert_eq!(command, b"echo test");
            for (opcode, payload, value) in [
                (Opcode::Started, &b""[..], 71),
                (Opcode::Stdout, &b"out"[..], 0),
                (Opcode::Stderr, &b"err"[..], 0),
                (Opcode::Exit, &b""[..], 9),
            ] {
                let header = Header::new(opcode, request.request_id, payload.len(), value)
                    .expect("response header");
                server.write_all(&header.encode()).expect("write header");
                server.write_all(payload).expect("write payload");
            }
        });
        let request_id = 17;
        let command = b"echo test";
        let request = Header::new(Opcode::Exec, request_id, command.len(), 0).expect("header");
        client.write_all(&request.encode()).expect("write header");
        client.write_all(command).expect("write body");
        let mut started = [0_u8; HEADER_SIZE];
        client.read_exact(&mut started).expect("started header");
        let started = Header::decode(&started).expect("decode started");
        let session = session(client, request_id, started.value, false, None);
        let result = session.collect().expect("collect command");
        assert_eq!(result.guest_pid, 71);
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        assert_eq!(result.exit_code, 9);
        worker.join().expect("server worker");
    }

    #[test]
    fn capture_limit_is_combined() {
        let (client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            for opcode in [Opcode::Stdout, Opcode::Stderr] {
                let header = Header::new(opcode, 4, 2, 0).expect("header");
                server.write_all(&header.encode()).expect("write header");
                server.write_all(b"xx").expect("write payload");
            }
        });
        let session = session(client, 4, 1, false, None);
        assert!(matches!(
            session.collect_with_limit(3),
            Err(ControlError::CaptureLimit)
        ));
        worker.join().expect("server worker");
    }

    #[test]
    fn resize_emits_one_strict_terminal_frame() {
        let (client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            let mut bytes = [0_u8; HEADER_SIZE];
            server.read_exact(&mut bytes).expect("resize header");
            let header = Header::decode(&bytes).expect("decode resize");
            assert_eq!(header.opcode, Opcode::PtyResize);
            let mut payload = vec![0_u8; header.payload_len as usize];
            server.read_exact(&mut payload).expect("resize payload");
            let (action_id, resize) = decode_action_request(&payload).expect("resize action");
            assert_eq!(&resize[..4], &[33, 0, 101, 0]);
            send_action_result(&mut server, header.request_id, action_id, 0, 0);
        });
        let mut session = session(client, 5, 1, true, None);
        session
            .resize(super::PtySize::new(33, 101))
            .expect("resize");
        worker.join().expect("server worker");
    }

    #[test]
    fn stdin_backpressure_is_reported_to_the_caller() {
        let (client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            let mut bytes = [0_u8; HEADER_SIZE];
            server.read_exact(&mut bytes).expect("stdin header");
            let header = Header::decode(&bytes).expect("decode stdin");
            assert_eq!(header.opcode, Opcode::Stdin);
            let mut payload = vec![0_u8; header.payload_len as usize];
            server.read_exact(&mut payload).expect("stdin payload");
            let (action_id, body) = decode_action_request(&payload).expect("stdin action");
            assert_eq!(body, b"fragment");
            let output =
                Header::new(Opcode::Stdout, header.request_id, 6, 0).expect("output header");
            server
                .write_all(&output.encode())
                .expect("write output header");
            server.write_all(b"queued").expect("write output");
            send_action_result(&mut server, header.request_id, action_id, 0, 11);
        });
        let mut session = session(client, 6, 1, false, None);
        assert!(matches!(
            session.write_stdin(b"fragment"),
            Err(ControlError::ActionFailed { errno: 11 })
        ));
        assert_eq!(
            session.next_event().expect("queued output"),
            super::CommandEvent::Stdout(b"queued".to_vec())
        );
        worker.join().expect("server worker");
    }

    #[test]
    fn unacknowledged_action_has_a_fixed_request_deadline() {
        let (client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            let mut bytes = [0_u8; HEADER_SIZE];
            server.read_exact(&mut bytes).expect("stdin header");
            let header = Header::decode(&bytes).expect("decode stdin");
            let mut payload = vec![0_u8; header.payload_len as usize];
            server.read_exact(&mut payload).expect("stdin payload");
            thread::sleep(Duration::from_millis(150));
        });
        let mut session = CommandSession::new(client, 8, 1, false, Duration::from_millis(40), None)
            .expect("command session");
        let started = Instant::now();
        assert!(matches!(
            session.write_stdin(b"fragment"),
            Err(ControlError::DeadlineExceeded)
        ));
        assert!(started.elapsed() < Duration::from_millis(140));
        worker.join().expect("server worker");
    }

    #[test]
    fn command_deadline_expires_despite_continuous_output() {
        let (client, mut server) = tcp_pair();
        let worker = thread::spawn(move || {
            for _ in 0..20 {
                thread::sleep(Duration::from_millis(15));
                let Ok(header) = Header::new(Opcode::Stdout, 7, 1, 0) else {
                    return;
                };
                if server.write_all(&header.encode()).is_err() || server.write_all(b"x").is_err() {
                    return;
                }
            }
        });
        let started = Instant::now();
        let mut session = session(client, 7, 1, false, Some(Duration::from_millis(70)));
        let mut output_events = 0;
        loop {
            match session.next_event() {
                Ok(super::CommandEvent::Stdout(bytes)) => {
                    assert_eq!(bytes, b"x");
                    output_events += 1;
                }
                Err(ControlError::DeadlineExceeded) => break,
                event => panic!("unexpected deadline event: {event:?}"),
            }
        }
        assert!(output_events > 0);
        assert!(started.elapsed() < Duration::from_millis(250));
        worker.join().expect("server worker");
    }

    fn session(
        stream: TcpStream,
        request_id: u64,
        guest_pid: i32,
        terminal: bool,
        command_timeout: Option<Duration>,
    ) -> CommandSession {
        CommandSession::new(
            stream,
            request_id,
            guest_pid,
            terminal,
            Duration::from_secs(1),
            command_timeout,
        )
        .expect("command session")
    }

    fn send_action_result(
        stream: &mut TcpStream,
        request_id: u64,
        action_id: u64,
        accepted_bytes: u32,
        errno: i32,
    ) {
        let payload = WireActionResult {
            action_id,
            accepted_bytes,
            errno,
        }
        .encode()
        .expect("action result");
        let header = Header::new(Opcode::ActionResult, request_id, payload.len(), 0)
            .expect("action result header");
        stream.write_all(&header.encode()).expect("write header");
        stream.write_all(&payload).expect("write payload");
    }

    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("listener");
        let address = listener.local_addr().expect("address");
        let worker = thread::spawn(move || listener.accept().expect("accept").0);
        let client = TcpStream::connect_timeout(&address, Duration::from_secs(1)).expect("connect");
        (client, worker.join().expect("accept worker"))
    }
}
