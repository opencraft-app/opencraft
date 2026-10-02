#![forbid(unsafe_code)]

//! Bounded wire records for the host-to-guest sandbox control connection.
//!
//! The transport is an explicitly injected IPv4 TCP stream. This crate owns
//! only its fixed header decoder; it does not know about PVM, host descriptors,
//! Linux processes, or an async runtime.

use std::fmt;

mod commands;
mod files;

pub use commands::{
    WireActionResult, WireCommandSpec, WirePtySize, WireUser, decode_action_request,
    encode_action_request,
};
pub use files::{FileKind, WireFileInfo, decode_path_pair, encode_path_pair, validate_path};

/// Guest loopback port reserved for the minisandbox control agent.
pub const CONTROL_PORT: u16 = 49_983;
/// Fixed control-frame header size.
pub const HEADER_SIZE: usize = 32;
/// Maximum payload carried by one frame.
pub const MAX_FRAME_PAYLOAD: usize = 64 * 1024;
/// Maximum simultaneous command or file connections admitted by one guest agent.
pub const MAX_CONTROL_CONNECTIONS: usize = 32;
/// Maximum stdout plus stderr retained by a convenience host call.
pub const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;
/// Maximum byte length of one guest path.
pub const MAX_PATH_BYTES: usize = 4096;
/// Maximum bytes read or written by one convenience file operation.
pub const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum directory entries returned by one list operation.
pub const MAX_LIST_ENTRIES: usize = 4096;
/// Maximum argument count in one structured exec request.
pub const MAX_COMMAND_ARGUMENTS: usize = 256;
/// Maximum environment entry count in one structured exec request.
pub const MAX_COMMAND_ENVIRONMENT: usize = 256;

const MAGIC: u32 = u32::from_le_bytes(*b"MSCP");
const VERSION: u16 = 4;

/// Canonical request and response operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum Opcode {
    /// Verifies that the restored agent accepts a control connection.
    Ping = 1,
    /// Starts one strictly encoded direct-exec command.
    Exec = 2,
    /// Supplies bytes to a running command's standard input; empty means EOF.
    Stdin = 3,
    /// Sends the positive signal number in [`Header::value`] to the process group.
    Signal = 4,
    /// Reads one bounded regular file named by the path payload.
    FileRead = 5,
    /// Begins an atomic bounded write to the path payload.
    FileWrite = 6,
    /// Supplies a nonempty fragment to an active file write.
    FileWriteChunk = 7,
    /// Commits an active file write.
    FileWriteEnd = 8,
    /// Returns metadata for the path payload without following symlinks.
    FileStat = 9,
    /// Lists one directory named by the path payload.
    FileList = 10,
    /// Creates the path payload; value 1 requests recursive creation.
    FileMkdir = 11,
    /// Removes the path payload; value 1 requests recursive removal.
    FileRemove = 12,
    /// Renames the two strictly encoded path payloads.
    FileRename = 13,
    /// Resizes the PTY attached to an active command.
    PtyResize = 14,
    /// Successful response to [`Opcode::Ping`].
    Pong = 0x8001,
    /// Announces the positive guest PID in [`Header::value`].
    Started = 0x8002,
    /// One bounded stdout fragment.
    Stdout = 0x8003,
    /// One bounded stderr fragment.
    Stderr = 0x8004,
    /// Announces the normalized 0..=255 status in [`Header::value`].
    Exit = 0x8005,
    /// Announces readiness for streamed file-write chunks.
    Ready = 0x8006,
    /// One nonempty bounded file-content fragment.
    FileData = 0x8007,
    /// One strictly encoded file metadata record.
    FileInfo = 0x8008,
    /// Completes a file operation; value carries a bounded byte/entry count.
    Done = 0x8009,
    /// One nonempty fragment read from an attached PTY.
    PtyData = 0x800a,
    /// Fixed acknowledgement or rejection of one command action.
    ActionResult = 0x800b,
    /// Bounded diagnostic text with a negative errno in [`Header::value`].
    Failed = 0x80ff,
}

impl TryFrom<u16> for Opcode {
    type Error = WireError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Ping),
            2 => Ok(Self::Exec),
            3 => Ok(Self::Stdin),
            4 => Ok(Self::Signal),
            5 => Ok(Self::FileRead),
            6 => Ok(Self::FileWrite),
            7 => Ok(Self::FileWriteChunk),
            8 => Ok(Self::FileWriteEnd),
            9 => Ok(Self::FileStat),
            10 => Ok(Self::FileList),
            11 => Ok(Self::FileMkdir),
            12 => Ok(Self::FileRemove),
            13 => Ok(Self::FileRename),
            14 => Ok(Self::PtyResize),
            0x8001 => Ok(Self::Pong),
            0x8002 => Ok(Self::Started),
            0x8003 => Ok(Self::Stdout),
            0x8004 => Ok(Self::Stderr),
            0x8005 => Ok(Self::Exit),
            0x8006 => Ok(Self::Ready),
            0x8007 => Ok(Self::FileData),
            0x8008 => Ok(Self::FileInfo),
            0x8009 => Ok(Self::Done),
            0x800a => Ok(Self::PtyData),
            0x800b => Ok(Self::ActionResult),
            0x80ff => Ok(Self::Failed),
            _ => Err(WireError::UnknownOpcode),
        }
    }
}

/// One validated fixed header. Payload bytes immediately follow it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Header {
    /// Frame operation.
    pub opcode: Opcode,
    /// Nonzero caller-selected correlation ID.
    pub request_id: u64,
    /// Number of following payload bytes.
    pub payload_len: u32,
    /// Operation-specific scalar value.
    pub value: i32,
}

impl Header {
    /// Creates a header and checks its complete canonical shape.
    ///
    /// # Errors
    ///
    /// Returns [`WireError::NonCanonical`] for invalid IDs, lengths, or values.
    pub fn new(
        opcode: Opcode,
        request_id: u64,
        payload_len: usize,
        value: i32,
    ) -> Result<Self, WireError> {
        let payload_len = u32::try_from(payload_len).map_err(|_| WireError::PayloadTooLarge)?;
        let header = Self {
            opcode,
            request_id,
            payload_len,
            value,
        };
        header.validate()?;
        Ok(header)
    }

    /// Decodes a private snapshot of one untrusted fixed header.
    ///
    /// # Errors
    ///
    /// Rejects wrong magic/version, unknown flags/opcodes, oversized payloads,
    /// nonzero reserved words, and operation-specific noncanonical fields.
    pub fn decode(bytes: &[u8; HEADER_SIZE]) -> Result<Self, WireError> {
        if read_u32(bytes, 0) != MAGIC {
            return Err(WireError::WrongMagic);
        }
        if read_u16(bytes, 4) != VERSION {
            return Err(WireError::WrongVersion);
        }
        let opcode = Opcode::try_from(read_u16(bytes, 6))?;
        if read_u32(bytes, 24) != 0 {
            return Err(WireError::UnknownFlags);
        }
        if read_u32(bytes, 28) != 0 {
            return Err(WireError::NonCanonical);
        }
        let header = Self {
            opcode,
            request_id: read_u64(bytes, 8),
            payload_len: read_u32(bytes, 16),
            value: read_i32(bytes, 20),
        };
        header.validate()?;
        Ok(header)
    }

    /// Encodes the canonical fixed representation.
    #[must_use]
    pub fn encode(self) -> [u8; HEADER_SIZE] {
        let mut bytes = [0_u8; HEADER_SIZE];
        write_u32(&mut bytes, 0, MAGIC);
        write_u16(&mut bytes, 4, VERSION);
        write_u16(&mut bytes, 6, self.opcode as u16);
        write_u64(&mut bytes, 8, self.request_id);
        write_u32(&mut bytes, 16, self.payload_len);
        bytes[20..24].copy_from_slice(&self.value.to_le_bytes());
        bytes
    }

    fn validate(self) -> Result<(), WireError> {
        if self.request_id == 0 {
            return Err(WireError::NonCanonical);
        }
        let payload_len =
            usize::try_from(self.payload_len).map_err(|_| WireError::PayloadTooLarge)?;
        if payload_len > MAX_FRAME_PAYLOAD {
            return Err(WireError::PayloadTooLarge);
        }
        let canonical = match self.opcode {
            Opcode::Ping | Opcode::Pong | Opcode::Ready | Opcode::FileWriteEnd => {
                payload_len == 0 && self.value == 0
            }
            Opcode::Exec
            | Opcode::Stdout
            | Opcode::Stderr
            | Opcode::FileWriteChunk
            | Opcode::FileData
            | Opcode::FileInfo
            | Opcode::PtyData => payload_len != 0 && self.value == 0,
            Opcode::Stdin => (8..=MAX_FRAME_PAYLOAD).contains(&payload_len) && self.value == 0,
            Opcode::FileRead | Opcode::FileWrite | Opcode::FileStat | Opcode::FileList => {
                (1..=MAX_PATH_BYTES).contains(&payload_len) && self.value == 0
            }
            Opcode::FileMkdir | Opcode::FileRemove => {
                (1..=MAX_PATH_BYTES).contains(&payload_len) && (0..=1).contains(&self.value)
            }
            Opcode::FileRename => {
                (6..=(MAX_PATH_BYTES * 2 + 4)).contains(&payload_len) && self.value == 0
            }
            Opcode::PtyResize | Opcode::ActionResult => payload_len == 16 && self.value == 0,
            Opcode::Signal => payload_len == 8 && (1..=64).contains(&self.value),
            Opcode::Started => payload_len == 0 && self.value > 0,
            Opcode::Exit => payload_len == 0 && (0..=255).contains(&self.value),
            Opcode::Done => {
                payload_len == 0
                    && (0..=i32::try_from(MAX_FILE_BYTES).expect("file limit fits i32"))
                        .contains(&self.value)
            }
            Opcode::Failed => payload_len <= 4096 && (-4095..=-1).contains(&self.value),
        };
        if canonical {
            Ok(())
        } else {
            Err(WireError::NonCanonical)
        }
    }
}

/// Fixed decoder failure classes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WireError {
    /// Header does not carry the control-protocol magic.
    WrongMagic,
    /// Header version is not exactly supported.
    WrongVersion,
    /// Opcode is not defined by this hard-cutover version.
    UnknownOpcode,
    /// A future flag was supplied.
    UnknownFlags,
    /// Payload exceeds the fixed one-frame maximum.
    PayloadTooLarge,
    /// Reserved or operation-specific fields are not canonical.
    NonCanonical,
}

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for WireError {}

fn read_u16(bytes: &[u8; HEADER_SIZE], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8; HEADER_SIZE], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed u32 range"),
    )
}

fn read_i32(bytes: &[u8; HEADER_SIZE], offset: usize) -> i32 {
    i32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed i32 range"),
    )
}

fn read_u64(bytes: &[u8; HEADER_SIZE], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("fixed u64 range"),
    )
}

fn write_u16(bytes: &mut [u8; HEADER_SIZE], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(bytes: &mut [u8; HEADER_SIZE], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(bytes: &mut [u8; HEADER_SIZE], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::{HEADER_SIZE, Header, MAX_FRAME_PAYLOAD, Opcode, WireError};

    #[test]
    fn canonical_operations_round_trip() {
        for header in [
            Header::new(Opcode::Ping, 1, 0, 0).expect("ping"),
            Header::new(Opcode::Exec, 2, 7, 0).expect("exec"),
            Header::new(Opcode::Stdin, 2, 8, 0).expect("stdin EOF"),
            Header::new(Opcode::Signal, 2, 8, 15).expect("signal"),
            Header::new(Opcode::FileRead, 2, 4, 0).expect("read"),
            Header::new(Opcode::FileWrite, 2, 4, 0).expect("write"),
            Header::new(Opcode::FileWriteChunk, 2, 4, 0).expect("write data"),
            Header::new(Opcode::FileWriteEnd, 2, 0, 0).expect("write end"),
            Header::new(Opcode::FileStat, 2, 4, 0).expect("stat"),
            Header::new(Opcode::FileList, 2, 4, 0).expect("list"),
            Header::new(Opcode::FileMkdir, 2, 4, 1).expect("mkdir"),
            Header::new(Opcode::FileRemove, 2, 4, 0).expect("remove"),
            Header::new(Opcode::FileRename, 2, 6, 0).expect("rename"),
            Header::new(Opcode::PtyResize, 2, 16, 0).expect("pty resize"),
            Header::new(Opcode::Started, 2, 0, 123).expect("started"),
            Header::new(Opcode::Stdout, 2, 3, 0).expect("stdout"),
            Header::new(Opcode::Stderr, 2, 3, 0).expect("stderr"),
            Header::new(Opcode::Exit, 2, 0, 137).expect("exit"),
            Header::new(Opcode::Ready, 2, 0, 0).expect("ready"),
            Header::new(Opcode::FileData, 2, 3, 0).expect("file data"),
            Header::new(Opcode::FileInfo, 2, 32, 0).expect("file info"),
            Header::new(Opcode::Done, 2, 0, 42).expect("done"),
            Header::new(Opcode::PtyData, 2, 3, 0).expect("pty data"),
            Header::new(Opcode::ActionResult, 2, 16, 0).expect("action result"),
            Header::new(Opcode::Failed, 2, 4, -22).expect("error"),
        ] {
            assert_eq!(Header::decode(&header.encode()), Ok(header));
        }
    }

    #[test]
    fn hostile_headers_fail_before_payload_allocation() {
        let valid = Header::new(Opcode::Ping, 1, 0, 0).expect("ping").encode();
        let mut cases = Vec::new();
        let mut wrong_magic = valid;
        wrong_magic[0] ^= 1;
        cases.push((wrong_magic, WireError::WrongMagic));
        let mut future_version = valid;
        future_version[4..6].copy_from_slice(&5_u16.to_le_bytes());
        cases.push((future_version, WireError::WrongVersion));
        let mut unknown_flags = valid;
        unknown_flags[24..28].copy_from_slice(&1_u32.to_le_bytes());
        cases.push((unknown_flags, WireError::UnknownFlags));
        let mut oversized = valid;
        oversized[16..20].copy_from_slice(
            &u32::try_from(MAX_FRAME_PAYLOAD + 1)
                .expect("bounded test size")
                .to_le_bytes(),
        );
        cases.push((oversized, WireError::PayloadTooLarge));
        let mut zero_id = valid;
        zero_id[8..16].fill(0);
        cases.push((zero_id, WireError::NonCanonical));
        let mut reserved = valid;
        reserved[28] = 1;
        cases.push((reserved, WireError::NonCanonical));
        let mut overflowing_errno = Header::new(Opcode::Failed, 1, 0, -1)
            .expect("error")
            .encode();
        overflowing_errno[20..24].copy_from_slice(&i32::MIN.to_le_bytes());
        cases.push((overflowing_errno, WireError::NonCanonical));

        for (bytes, expected) in cases {
            assert_eq!(Header::decode(&bytes), Err(expected));
        }
        assert_eq!(valid.len(), HEADER_SIZE);
    }
}
