//! Stable, explicitly decoded little-endian command ABI.
//!
//! No Rust reference is ever created into adversarial shared memory.  The ring
//! adapter must first copy exactly [`DESCRIPTOR_SIZE`] bytes into a private
//! array and only then call [`Command::decode`].

use crate::protocol::Capability;

pub const ABI_VERSION: u16 = 6;
pub const DESCRIPTOR_SIZE: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum Opcode {
    Tx = 1,
    RxRelease = 2,
    Close = 3,
    Connect = 4,
    Shutdown = 5,
    /// Sends one bounded UDP DNS query. The fixed TX slot begins with the
    /// socket-service endpoint record followed by `length` DNS bytes.
    DnsQuery = 6,
    /// Confirms that one host ingress offer was queued on a guest listener.
    IngressAck = 7,
    /// Rejects one host ingress offer without allocating a stream capability.
    IngressReject = 8,
    /// Attaches a queued host ingress stream to a fresh guest capability.
    IngressAccept = 9,
}

impl TryFrom<u16> for Opcode {
    type Error = WireError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Tx),
            2 => Ok(Self::RxRelease),
            3 => Ok(Self::Close),
            4 => Ok(Self::Connect),
            5 => Ok(Self::Shutdown),
            6 => Ok(Self::DnsQuery),
            7 => Ok(Self::IngressAck),
            8 => Ok(Self::IngressReject),
            9 => Ok(Self::IngressAccept),
            _ => Err(WireError::UnknownOpcode),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandKind {
    /// Opens the capability and connects to the canonical endpoint record in a TX slot.
    Connect {
        slot: u16,
        length: u32,
    },
    Tx {
        slot: u16,
        offset: u32,
        length: u32,
    },
    RxRelease {
        slot: u16,
    },
    /// Applies Linux `SHUT_RD`, `SHUT_WR`, or `SHUT_RDWR` (`how` 0..=2).
    Shutdown {
        how: u32,
    },
    /// Sends one DNS datagram stored after the eight-byte endpoint prefix.
    DnsQuery {
        slot: u16,
        length: u32,
    },
    /// `capability.index/generation` identify the bounded pending offer.
    IngressAck,
    /// `capability.index/generation` identify the bounded pending offer.
    IngressReject,
    /// The ordinary command capability is the new accepted child. The pending
    /// offer identity is carried separately and is generation checked.
    IngressAccept {
        pending_index: u16,
        pending_generation: u64,
    },
    Close,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Command {
    pub sequence: u32,
    pub capability: Capability,
    pub kind: CommandKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WireError {
    WrongVersion,
    UnknownOpcode,
    UnknownFlags,
    NonCanonical,
}

impl Command {
    /// Decodes a private snapshot of one untrusted descriptor.
    ///
    /// # Errors
    ///
    /// Returns a [`WireError`] for unknown or noncanonical input.
    pub fn decode(bytes: &[u8; DESCRIPTOR_SIZE], session: u64) -> Result<Self, WireError> {
        if session == 0 {
            return Err(WireError::NonCanonical);
        }
        let version = read_u16(bytes, 0);
        if version != ABI_VERSION {
            return Err(WireError::WrongVersion);
        }
        let opcode = Opcode::try_from(read_u16(bytes, 2))?;
        let generation = read_u64(bytes, 8);
        if generation == 0 {
            return Err(WireError::NonCanonical);
        }
        let capability = Capability {
            index: read_u32(bytes, 4),
            generation,
            session,
        };
        let slot = read_u16(bytes, 16);
        let flags = read_u16(bytes, 18);
        if flags != 0 {
            return Err(WireError::UnknownFlags);
        }
        let offset = read_u32(bytes, 20);
        let length = read_u32(bytes, 24);
        let sequence = read_u32(bytes, 28);
        let kind = match opcode {
            Opcode::Connect => {
                if offset != 0 || length == 0 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::Connect { slot, length }
            }
            Opcode::Tx => CommandKind::Tx {
                slot,
                offset,
                length,
            },
            Opcode::RxRelease => {
                if offset != 0 || length != 0 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::RxRelease { slot }
            }
            Opcode::Close => {
                if slot != 0 || offset != 0 || length != 0 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::Close
            }
            Opcode::Shutdown => {
                if slot != 0 || offset != 0 || length > 2 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::Shutdown { how: length }
            }
            Opcode::DnsQuery => {
                if offset != 8 || length == 0 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::DnsQuery { slot, length }
            }
            Opcode::IngressAck => {
                if slot != 0 || offset != 0 || length != 0 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::IngressAck
            }
            Opcode::IngressReject => {
                if slot != 0 || offset != 0 || length != 0 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::IngressReject
            }
            Opcode::IngressAccept => {
                let pending_generation = u64::from(offset) | (u64::from(length) << 32);
                if pending_generation == 0 {
                    return Err(WireError::NonCanonical);
                }
                CommandKind::IngressAccept {
                    pending_index: slot,
                    pending_generation,
                }
            }
        };
        Ok(Self {
            sequence,
            capability,
            kind,
        })
    }

    /// Produces the canonical descriptor representation used by tests/drivers.
    #[must_use]
    pub fn encode(self) -> [u8; DESCRIPTOR_SIZE] {
        let mut bytes = [0_u8; DESCRIPTOR_SIZE];
        write_u16(&mut bytes, 0, ABI_VERSION);
        let (opcode, slot, offset, length) = match self.kind {
            CommandKind::Connect { slot, length } => (Opcode::Connect, slot, 0, length),
            CommandKind::Tx {
                slot,
                offset,
                length,
            } => (Opcode::Tx, slot, offset, length),
            CommandKind::RxRelease { slot } => (Opcode::RxRelease, slot, 0, 0),
            CommandKind::Close => (Opcode::Close, 0, 0, 0),
            CommandKind::Shutdown { how } => (Opcode::Shutdown, 0, 0, how),
            CommandKind::DnsQuery { slot, length } => (Opcode::DnsQuery, slot, 8, length),
            CommandKind::IngressAck => (Opcode::IngressAck, 0, 0, 0),
            CommandKind::IngressReject => (Opcode::IngressReject, 0, 0, 0),
            CommandKind::IngressAccept {
                pending_index,
                pending_generation,
            } => {
                let generation = pending_generation.to_le_bytes();
                (
                    Opcode::IngressAccept,
                    pending_index,
                    u32::from_le_bytes([
                        generation[0],
                        generation[1],
                        generation[2],
                        generation[3],
                    ]),
                    u32::from_le_bytes([
                        generation[4],
                        generation[5],
                        generation[6],
                        generation[7],
                    ]),
                )
            }
        };
        write_u16(&mut bytes, 2, opcode as u16);
        write_u32(&mut bytes, 4, self.capability.index);
        write_u64(&mut bytes, 8, self.capability.generation);
        write_u16(&mut bytes, 16, slot);
        write_u16(&mut bytes, 18, 0);
        write_u32(&mut bytes, 20, offset);
        write_u32(&mut bytes, 24, length);
        write_u32(&mut bytes, 28, self.sequence);
        bytes
    }
}

fn read_u16(bytes: &[u8; DESCRIPTOR_SIZE], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8; DESCRIPTOR_SIZE], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn read_u64(bytes: &[u8; DESCRIPTOR_SIZE], offset: usize) -> u64 {
    u64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}

fn write_u16(bytes: &mut [u8; DESCRIPTOR_SIZE], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(bytes: &mut [u8; DESCRIPTOR_SIZE], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(bytes: &mut [u8; DESCRIPTOR_SIZE], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
