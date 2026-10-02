#![deny(unsafe_op_in_unsafe_fn)]

//! Independently auditable `PF_INET` stream service for a PVM Linux guest.
//!
//! The PVM core only maps two fresh memory regions and registers one IRQ.
//! This crate owns every socket-specific parser, cursor, capability, quota,
//! host TCP descriptor, and worker thread.

mod broker;
mod dns;
mod layout;
mod policy;
mod quota;
mod ring;
mod wire;

pub use broker::{
    BrokerHandle, BrokerStats, HOST_LOOPBACK_ALIAS, IngressOperation, SocketBroker,
    SocketIngressError, SocketIngressHandle, TcpBroker,
};
pub use layout::{
    G2H_GPA, G2H_SLOT, H2G_GPA, H2G_SLOT, IRQ_GSI, RING_ENTRIES, SLOT_COUNT, SLOT_SIZE,
    ServiceMemory,
};
pub use policy::{AllowAll, AllowList, ConnectPolicy, DenyAll, DnsAllowList, DnsPolicy};
pub use quota::{
    BandwidthQuota, CLONE_MAILBOX_BUFFER_BYTES_PER_DIRECTION, MAX_ACTIVE_SOCKET_FDS,
    MAX_PENDING_INGRESS_OFFERS, STREAM_BUFFER_BYTES_PER_DIRECTION, SocketQuotas,
};
pub use ring::{HostRing, RingError};
pub use wire::{Endpoint, Event, EventKind};
