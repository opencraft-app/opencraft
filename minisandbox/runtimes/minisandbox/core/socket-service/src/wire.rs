//! Host-to-guest event and endpoint wire formats.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use pvm_stream_mailbox::protocol::Capability;

use crate::layout::DESCRIPTOR_SIZE;
use crate::quota::MAX_PENDING_INGRESS_OFFERS;

/// Socket service ABI version.
pub const ABI_VERSION: u16 = pvm_stream_mailbox::wire::ABI_VERSION;
/// Canonical IPv4 endpoint record length.
pub const ENDPOINT_SIZE: usize = 8;
/// Fixed host-private ingress slots per clone.
pub const INGRESS_SLOTS: usize = MAX_PENDING_INGRESS_OFFERS;
const INGRESS_SLOTS_U32: u32 = 32;
const AF_INET_WIRE: u16 = 2;

/// Session-scoped identity for one bounded, not-yet-accepted host stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PendingIngressId {
    pub(crate) index: u32,
    pub(crate) generation: u64,
}

/// A policy-checkable connection destination copied from guest memory.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Endpoint(SocketAddrV4);

impl Endpoint {
    /// Decodes `{ AF_INET:le16, port:be16, address:be32 }`.
    ///
    /// # Errors
    ///
    /// Returns `EINVAL` for a noncanonical length, family, or zero port.
    pub fn decode(bytes: &[u8]) -> Result<Self, i32> {
        let bytes: [u8; ENDPOINT_SIZE] = bytes.try_into().map_err(|_| libc::EINVAL)?;
        if u16::from_le_bytes([bytes[0], bytes[1]]) != AF_INET_WIRE {
            return Err(libc::EAFNOSUPPORT);
        }
        let port = u16::from_be_bytes([bytes[2], bytes[3]]);
        if port == 0 {
            return Err(libc::EINVAL);
        }
        Ok(Self(SocketAddrV4::new(
            Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7]),
            port,
        )))
    }

    /// Returns the host socket address after canonical decoding.
    #[must_use]
    pub const fn socket_addr(self) -> SocketAddrV4 {
        self.0
    }
}

impl From<Endpoint> for SocketAddr {
    fn from(endpoint: Endpoint) -> Self {
        Self::V4(endpoint.0)
    }
}

/// Host-authenticated event type published into the read-only mapping.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum EventKind {
    /// Nonblocking TCP connect completed successfully.
    Connected = 1,
    /// One guest TX slot returned to guest ownership.
    TxComplete = 2,
    /// One host RX slot now contains `length` immutable bytes.
    RxReady = 3,
    /// A requested half/full shutdown completed.
    Shutdown = 4,
    /// The stream closed locally or remotely.
    Closed = 5,
    /// A request failed without opening/closing a stream.
    Error = 6,
    /// One UDP DNS query was atomically accepted and its TX slot is reusable.
    DnsTxComplete = 7,
    /// One validated UDP DNS response occupies an RX slot after its endpoint prefix.
    DnsRxReady = 8,
    /// A host stream is available for one explicitly addressed guest listener.
    IngressOffer = 9,
    /// A previously offered host stream expired before guest `accept(2)`.
    IngressCancel = 10,
    /// The accepted child capability now owns the injected host stream.
    IngressAccepted = 11,
}

/// One fixed-size host-to-guest completion.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Event {
    /// Event discriminator.
    pub kind: EventKind,
    /// Clone-session and generation-bound stream capability.
    pub capability: Capability,
    /// Associated TX/RX slot, or zero for events without a slot.
    pub slot: u16,
    /// Zero on success or a negative Linux errno.
    pub status: i32,
    /// RX byte count, shutdown selector, or failed request opcode.
    pub length: u32,
    /// Request sequence for correlated completions; zero for unsolicited RX/EOF.
    pub sequence: u32,
}

impl Event {
    pub(crate) fn ingress_offer(
        session: u64,
        id: PendingIngressId,
        target: SocketAddrV4,
        peer: SocketAddrV4,
    ) -> Self {
        Self {
            kind: EventKind::IngressOffer,
            capability: Capability {
                index: id.index,
                generation: id.generation,
                session,
            },
            slot: target.port(),
            status: u32::from_be_bytes(target.ip().octets()).cast_signed(),
            length: u32::from_be_bytes(peer.ip().octets()),
            sequence: u32::from(peer.port()),
        }
    }

    pub(crate) fn ingress_cancel(session: u64, id: PendingIngressId) -> Self {
        Self {
            kind: EventKind::IngressCancel,
            capability: Capability {
                index: id.index,
                generation: id.generation,
                session,
            },
            slot: 0,
            status: 0,
            length: 0,
            sequence: 0,
        }
    }

    pub(crate) fn ingress_offer_parts(
        self,
    ) -> Option<(PendingIngressId, SocketAddrV4, SocketAddrV4)> {
        if self.kind != EventKind::IngressOffer {
            return None;
        }
        let peer_port = u16::try_from(self.sequence).ok()?;
        Some((
            PendingIngressId {
                index: self.capability.index,
                generation: self.capability.generation,
            },
            SocketAddrV4::new(
                Ipv4Addr::from(self.status.cast_unsigned().to_be_bytes()),
                self.slot,
            ),
            SocketAddrV4::new(Ipv4Addr::from(self.length.to_be_bytes()), peer_port),
        ))
    }

    /// Produces the canonical fixed descriptor used by the guest decoder.
    #[must_use]
    pub fn encode(self) -> [u8; DESCRIPTOR_SIZE] {
        let mut bytes = [0_u8; DESCRIPTOR_SIZE];
        bytes[0..2].copy_from_slice(&ABI_VERSION.to_le_bytes());
        bytes[2..4].copy_from_slice(&(self.kind as u16).to_le_bytes());
        bytes[4..8].copy_from_slice(&self.capability.index.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.capability.generation.to_le_bytes());
        bytes[16..18].copy_from_slice(&self.slot.to_le_bytes());
        bytes[20..24].copy_from_slice(&self.status.to_le_bytes());
        bytes[24..28].copy_from_slice(&self.length.to_le_bytes());
        bytes[28..32].copy_from_slice(&self.sequence.to_le_bytes());
        bytes
    }

    /// Decodes one host-authenticated response snapshot.
    ///
    /// Guest drivers use the equivalent C decoder. This Rust decoder exists
    /// for end-to-end broker tests and diagnostic tools.
    ///
    /// # Errors
    ///
    /// Returns `EPROTO` for a wrong ABI, event kind, generation, or session.
    pub fn decode(bytes: &[u8; DESCRIPTOR_SIZE], session: u64) -> Result<Self, i32> {
        if session == 0 || read_u16(bytes, 0) != ABI_VERSION {
            return Err(libc::EPROTO);
        }
        let kind = match read_u16(bytes, 2) {
            1 => EventKind::Connected,
            2 => EventKind::TxComplete,
            3 => EventKind::RxReady,
            4 => EventKind::Shutdown,
            5 => EventKind::Closed,
            6 => EventKind::Error,
            7 => EventKind::DnsTxComplete,
            8 => EventKind::DnsRxReady,
            9 => EventKind::IngressOffer,
            10 => EventKind::IngressCancel,
            11 => EventKind::IngressAccepted,
            _ => return Err(libc::EPROTO),
        };
        let generation = read_u64(bytes, 8);
        if generation == 0 {
            return Err(libc::EPROTO);
        }
        let event = Self {
            kind,
            capability: Capability {
                index: read_u32(bytes, 4),
                generation,
                session,
            },
            slot: read_u16(bytes, 16),
            status: read_i32(bytes, 20),
            length: read_u32(bytes, 24),
            sequence: read_u32(bytes, 28),
        };
        match kind {
            EventKind::IngressOffer => {
                let Some((id, target, peer)) = event.ingress_offer_parts() else {
                    return Err(libc::EPROTO);
                };
                if id.index >= INGRESS_SLOTS_U32
                    || target.ip() != &Ipv4Addr::LOCALHOST
                    || target.port() == 0
                    || peer.port() == 0
                    || event.sequence > u32::from(u16::MAX)
                {
                    return Err(libc::EPROTO);
                }
            }
            EventKind::IngressCancel
                if event.capability.index >= INGRESS_SLOTS_U32
                    || event.slot != 0
                    || event.status != 0
                    || event.length != 0
                    || event.sequence != 0 =>
            {
                return Err(libc::EPROTO);
            }
            _ => {}
        }
        Ok(event)
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

fn read_i32(bytes: &[u8; DESCRIPTOR_SIZE], offset: usize) -> i32 {
    i32::from_le_bytes([
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingress_offer_round_trips_in_one_fixed_descriptor() {
        let event = Event::ingress_offer(
            7,
            PendingIngressId {
                index: 3,
                generation: 9,
            },
            SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8080),
            SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 4), 49152),
        );
        let decoded = Event::decode(&event.encode(), 7).expect("canonical ingress offer");
        assert_eq!(decoded, event);
        assert_eq!(decoded.ingress_offer_parts(), event.ingress_offer_parts());
    }

    #[test]
    fn ingress_cancel_rejects_noncanonical_payload() {
        let event = Event::ingress_cancel(
            7,
            PendingIngressId {
                index: 3,
                generation: 9,
            },
        );
        let mut bytes = event.encode();
        bytes[24] = 1;
        assert_eq!(Event::decode(&bytes, 7), Err(libc::EPROTO));
    }
}
