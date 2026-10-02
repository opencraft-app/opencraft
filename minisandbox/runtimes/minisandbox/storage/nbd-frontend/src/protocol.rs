use std::{
    error::Error,
    io::{self, Read, Write},
};

use thiserror::Error;

/// Logical sector size exposed by the validation NBD device.
pub const NBD_LOGICAL_BLOCK_SIZE: u64 = 512;
/// Maximum payload accepted in one NBD request.
pub const NBD_MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// Maximum discard range accepted as one NBD request.
///
/// Linux is configured with the same queue limit so larger filesystem trims
/// are split before transmission. Keeping the parser check is defense in depth
/// against a raw or incorrectly configured peer.
pub const NBD_MAX_TRIM_BYTES: usize = 512 * 1024;

const REQUEST_MAGIC: u32 = 0x2560_9513;
const REPLY_MAGIC: u32 = 0x6744_6698;
const REQUEST_HEADER_BYTES: usize = 28;
const REPLY_HEADER_BYTES: usize = 16;

const CMD_READ: u16 = 0;
const CMD_WRITE: u16 = 1;
const CMD_DISC: u16 = 2;
const CMD_FLUSH: u16 = 3;
const CMD_TRIM: u16 = 4;
const CMD_WRITE_ZEROES: u16 = 6;

const CMD_FLAG_FUA: u32 = 1 << 16;
const CMD_FLAG_NO_HOLE: u32 = 1 << 17;

/// Storage operations required by the NBD transmission parser.
pub trait BlockDevice {
    /// Backend failure type. Failures become `EIO` replies for the request.
    type Error: Error;

    /// Returns the fixed export size in bytes.
    fn size(&self) -> u64;
    /// Reads exactly `length` bytes.
    ///
    /// # Errors
    ///
    /// Returns a backend range, availability, or integrity failure.
    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, Self::Error>;
    /// Writes all bytes, optionally with FUA durability before reply.
    ///
    /// # Errors
    ///
    /// Returns a backend range, fencing, or durability failure.
    fn write_at(&mut self, offset: u64, bytes: &[u8], fua: bool) -> Result<(), Self::Error>;
    /// Persists the actor-ordered submitted write cut.
    ///
    /// # Errors
    ///
    /// Returns a backend fencing or durability failure.
    fn flush(&mut self) -> Result<(), Self::Error>;
    /// Processes an NBD discard hint, optionally with FUA ordering.
    ///
    /// # Errors
    ///
    /// Returns a backend range, fencing, or durability failure.
    fn trim(&mut self, offset: u64, length: usize, fua: bool) -> Result<(), Self::Error>;
}

/// Counts requests completed during one kernel NBD attachment.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SessionStats {
    /// Successful reads.
    pub reads: u64,
    /// Successful data writes.
    pub writes: u64,
    /// Successful explicit flushes.
    pub flushes: u64,
    /// Successful discard hints.
    pub trims: u64,
    /// Successful zero-write requests.
    pub write_zeroes: u64,
    /// Successful data-changing commands that carried the FUA flag.
    pub fua_commands: u64,
    /// Peer transport closures observed instead of a complete DISC command.
    pub transport_disconnects: u64,
    /// Requests completed with an errno.
    pub errors: u64,
    /// Bytes returned by successful reads.
    pub read_bytes: u64,
    /// Bytes accepted by successful writes and zero writes.
    pub written_bytes: u64,
}

/// Fatal framing or transport failure for one NBD session.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// Socket transport failed.
    #[error(transparent)]
    Io(#[from] io::Error),
    /// A request did not carry the Linux NBD request magic.
    #[error("invalid NBD request magic")]
    InvalidMagic,
    /// An unknown command would make payload framing ambiguous.
    #[error("unsupported NBD command {0}")]
    UnsupportedCommand(u16),
    /// A WRITE payload exceeds the frontend's fixed request bound.
    ///
    /// The session is closed instead of draining an attacker-controlled
    /// length, because retaining framing is not worth an unbounded read.
    #[error("NBD write request of {0} bytes exceeds the request limit")]
    RequestTooLarge(usize),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Request {
    command: u16,
    flags: u32,
    handle: [u8; 8],
    offset: u64,
    length: usize,
}

/// One completely drained request frame.
///
/// Keeping the write payload with its header lets the Linux attachment drain
/// the kernel socket independently from the intentionally single-writer
/// backend. This matters under deep queues: a blocked kernel socket can make
/// the in-kernel NBD client partially send and requeue a request.
pub(crate) struct QueuedRequest {
    request: Request,
    write_payload: Vec<u8>,
}

impl QueuedRequest {
    pub(crate) fn is_disconnect(&self) -> bool {
        self.request.command == CMD_DISC
    }
}

/// Serves Linux NBD transmission requests until `NBD_CMD_DISC` or EOF.
///
/// This function does not implement the network negotiation phase. The Linux
/// attachment wrapper connects it directly to `NBD_SET_SOCK`, which keeps this
/// parser out of the PVM product path and limits it to the 28-byte kernel
/// transmission header.
///
/// # Errors
///
/// Returns a fatal socket, magic, or ambiguous-command framing error. Backend
/// failures are request-local `EIO` replies and increment [`SessionStats::errors`].
pub fn serve_transmission<S: Read + Write, B: BlockDevice>(
    stream: &mut S,
    backend: &mut B,
) -> Result<SessionStats, ProtocolError> {
    let mut stats = SessionStats::default();
    loop {
        let request = match read_queued_request(stream) {
            Ok(Some(request)) => request,
            Ok(None) => break,
            Err(error) if is_peer_disconnect(&error) => {
                stats.transport_disconnects += 1;
                break;
            }
            Err(error) => return Err(error),
        };
        if request.is_disconnect() {
            break;
        }
        let result = process_queued_request(stream, backend, &request, &mut stats);
        if let Err(error) = result {
            if is_peer_disconnect(&error) {
                stats.transport_disconnects += 1;
                break;
            }
            return Err(error);
        }
    }
    Ok(stats)
}

pub(crate) fn is_peer_disconnect(error: &ProtocolError) -> bool {
    matches!(
        error,
        ProtocolError::Io(source)
            if matches!(
                source.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::UnexpectedEof
            )
    )
}

pub(crate) fn process_queued_request<S: Write, B: BlockDevice>(
    stream: &mut S,
    backend: &mut B,
    queued: &QueuedRequest,
    stats: &mut SessionStats,
) -> Result<(), ProtocolError> {
    let request = queued.request;
    match request.command {
        CMD_READ => handle_read(stream, backend, request, stats),
        CMD_WRITE => handle_write(stream, backend, request, &queued.write_payload, stats),
        CMD_FLUSH => handle_flush(stream, backend, request, stats),
        CMD_TRIM => handle_trim(stream, backend, request, stats),
        CMD_WRITE_ZEROES => handle_write_zeroes(stream, backend, request, stats),
        command => Err(ProtocolError::UnsupportedCommand(command)),
    }
}

fn handle_read<S: Write, B: BlockDevice>(
    stream: &mut S,
    backend: &mut B,
    request: Request,
    stats: &mut SessionStats,
) -> Result<(), ProtocolError> {
    if !valid_flags(request, 0) || !valid_data_range(backend.size(), request.offset, request.length)
    {
        return send_error(stream, request.handle, libc::EINVAL, stats);
    }
    match backend.read_at(request.offset, request.length) {
        Ok(bytes) if bytes.len() == request.length => {
            send_reply(stream, request.handle, 0)?;
            stream.write_all(&bytes)?;
            stream.flush()?;
            stats.reads += 1;
            stats.read_bytes = stats
                .read_bytes
                .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
            Ok(())
        }
        Ok(_) | Err(_) => send_error(stream, request.handle, libc::EIO, stats),
    }
}

fn handle_write<S: Write, B: BlockDevice>(
    stream: &mut S,
    backend: &mut B,
    request: Request,
    bytes: &[u8],
    stats: &mut SessionStats,
) -> Result<(), ProtocolError> {
    if !valid_flags(request, CMD_FLAG_FUA)
        || !valid_data_range(backend.size(), request.offset, request.length)
    {
        return send_error(stream, request.handle, libc::EINVAL, stats);
    }
    let fua = request.flags & CMD_FLAG_FUA != 0;
    match backend.write_at(request.offset, bytes, fua) {
        Ok(()) => {
            send_reply(stream, request.handle, 0)?;
            stats.writes += 1;
            stats.fua_commands += u64::from(fua);
            stats.written_bytes = stats
                .written_bytes
                .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
            Ok(())
        }
        Err(_) => send_error(stream, request.handle, libc::EIO, stats),
    }
}

fn handle_flush<S: Write, B: BlockDevice>(
    stream: &mut S,
    backend: &mut B,
    request: Request,
    stats: &mut SessionStats,
) -> Result<(), ProtocolError> {
    if request.offset != 0 || request.length != 0 || !valid_flags(request, 0) {
        return send_error(stream, request.handle, libc::EINVAL, stats);
    }
    match backend.flush() {
        Ok(()) => {
            send_reply(stream, request.handle, 0)?;
            stats.flushes += 1;
            Ok(())
        }
        Err(_) => send_error(stream, request.handle, libc::EIO, stats),
    }
}

fn handle_trim<S: Write, B: BlockDevice>(
    stream: &mut S,
    backend: &mut B,
    request: Request,
    stats: &mut SessionStats,
) -> Result<(), ProtocolError> {
    if !valid_flags(request, CMD_FLAG_FUA)
        || !valid_trim_range(backend.size(), request.offset, request.length)
    {
        return send_error(stream, request.handle, libc::EINVAL, stats);
    }
    match backend.trim(
        request.offset,
        request.length,
        request.flags & CMD_FLAG_FUA != 0,
    ) {
        Ok(()) => {
            send_reply(stream, request.handle, 0)?;
            stats.trims += 1;
            stats.fua_commands += u64::from(request.flags & CMD_FLAG_FUA != 0);
            Ok(())
        }
        Err(_) => send_error(stream, request.handle, libc::EIO, stats),
    }
}

fn handle_write_zeroes<S: Write, B: BlockDevice>(
    stream: &mut S,
    backend: &mut B,
    request: Request,
    stats: &mut SessionStats,
) -> Result<(), ProtocolError> {
    if !valid_flags(request, CMD_FLAG_FUA | CMD_FLAG_NO_HOLE)
        || !valid_data_range(backend.size(), request.offset, request.length)
    {
        return send_error(stream, request.handle, libc::EINVAL, stats);
    }
    let bytes = vec![0; request.length];
    match backend.write_at(request.offset, &bytes, request.flags & CMD_FLAG_FUA != 0) {
        Ok(()) => {
            send_reply(stream, request.handle, 0)?;
            stats.write_zeroes += 1;
            stats.fua_commands += u64::from(request.flags & CMD_FLAG_FUA != 0);
            stats.written_bytes = stats
                .written_bytes
                .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
            Ok(())
        }
        Err(_) => send_error(stream, request.handle, libc::EIO, stats),
    }
}

pub(crate) fn read_queued_request<S: Read>(
    stream: &mut S,
) -> Result<Option<QueuedRequest>, ProtocolError> {
    let mut bytes = [0_u8; REQUEST_HEADER_BYTES];
    let read = stream.read(&mut bytes[..1])?;
    if read == 0 {
        return Ok(None);
    }
    stream.read_exact(&mut bytes[1..])?;
    if u32::from_be_bytes(bytes[0..4].try_into().expect("fixed request magic")) != REQUEST_MAGIC {
        return Err(ProtocolError::InvalidMagic);
    }
    let type_word = u32::from_be_bytes(bytes[4..8].try_into().expect("fixed request type"));
    let mut handle = [0_u8; 8];
    handle.copy_from_slice(&bytes[8..16]);
    let request = Request {
        command: u16::try_from(type_word & 0xffff).expect("masked command"),
        flags: type_word & 0xffff_0000,
        handle,
        offset: u64::from_be_bytes(bytes[16..24].try_into().expect("fixed request offset")),
        length: usize::try_from(u32::from_be_bytes(
            bytes[24..28].try_into().expect("fixed request length"),
        ))
        .expect("u32 length fits usize"),
    };
    let write_payload = if request.command == CMD_WRITE {
        if request.length > NBD_MAX_REQUEST_BYTES {
            return Err(ProtocolError::RequestTooLarge(request.length));
        }
        let mut bytes = vec![0; request.length];
        stream.read_exact(&mut bytes)?;
        bytes
    } else {
        Vec::new()
    };
    Ok(Some(QueuedRequest {
        request,
        write_payload,
    }))
}

fn valid_flags(request: Request, allowed: u32) -> bool {
    request.flags & !allowed == 0
}

fn valid_data_range(size: u64, offset: u64, length: usize) -> bool {
    length > 0
        && length <= NBD_MAX_REQUEST_BYTES
        && offset.is_multiple_of(NBD_LOGICAL_BLOCK_SIZE)
        && length.is_multiple_of(usize::try_from(NBD_LOGICAL_BLOCK_SIZE).expect("sector fits"))
        && u64::try_from(length)
            .ok()
            .and_then(|length| offset.checked_add(length))
            .is_some_and(|end| end <= size)
}

fn valid_trim_range(size: u64, offset: u64, length: usize) -> bool {
    length > 0
        && length <= NBD_MAX_TRIM_BYTES
        && offset.is_multiple_of(NBD_LOGICAL_BLOCK_SIZE)
        && length.is_multiple_of(usize::try_from(NBD_LOGICAL_BLOCK_SIZE).expect("sector fits"))
        && u64::try_from(length)
            .ok()
            .and_then(|length| offset.checked_add(length))
            .is_some_and(|end| end <= size)
}

fn send_error<S: Write>(
    stream: &mut S,
    handle: [u8; 8],
    error: i32,
    stats: &mut SessionStats,
) -> Result<(), ProtocolError> {
    stats.errors += 1;
    Ok(send_reply(
        stream,
        handle,
        u32::try_from(error).expect("positive errno fits u32"),
    )?)
}

fn send_reply<S: Write>(stream: &mut S, handle: [u8; 8], error: u32) -> io::Result<()> {
    let mut reply = [0_u8; REPLY_HEADER_BYTES];
    reply[0..4].copy_from_slice(&REPLY_MAGIC.to_be_bytes());
    reply[4..8].copy_from_slice(&error.to_be_bytes());
    reply[8..16].copy_from_slice(&handle);
    stream.write_all(&reply)?;
    stream.flush()
}
