//! Explicit destination policy; no guest request implicitly gains network access.

use std::{
    net::{Ipv4Addr, SocketAddr},
    ops::RangeInclusive,
};

/// Decides whether one already-decoded TCP destination may be opened.
pub trait ConnectPolicy: Send + Sync + 'static {
    /// Returns true only when this destination is authorized.
    fn authorize(&self, destination: SocketAddr) -> bool;
}

/// Decides whether one IPv4 resolver may receive bounded UDP DNS queries.
pub trait DnsPolicy: Send + Sync + 'static {
    /// Returns true only for an explicitly authorized resolver address.
    fn authorize_resolver(&self, resolver: Ipv4Addr) -> bool;
}

/// Explicit policy that rejects every connection.
#[derive(Clone, Copy, Debug, Default)]
pub struct DenyAll;

impl ConnectPolicy for DenyAll {
    fn authorize(&self, _destination: SocketAddr) -> bool {
        false
    }
}

impl DnsPolicy for DenyAll {
    fn authorize_resolver(&self, _resolver: Ipv4Addr) -> bool {
        false
    }
}

/// Explicit unrestricted egress policy.
///
/// The transport boundary still limits TCP to outbound streams and UDP to
/// structurally validated DNS queries on port 53. This policy only disables
/// destination filtering inside that boundary.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAll;

impl ConnectPolicy for AllowAll {
    fn authorize(&self, _destination: SocketAddr) -> bool {
        true
    }
}

impl DnsPolicy for AllowAll {
    fn authorize_resolver(&self, _resolver: Ipv4Addr) -> bool {
        true
    }
}

/// Small exact-address/port policy useful for explicit broker configuration.
#[derive(Clone, Debug, Default)]
pub struct AllowList {
    entries: Vec<(std::net::IpAddr, RangeInclusive<u16>)>,
}

impl AllowList {
    /// Adds one IP and inclusive port range.
    #[must_use]
    pub fn allow(mut self, ip: std::net::IpAddr, ports: RangeInclusive<u16>) -> Self {
        self.entries.push((ip, ports));
        self
    }
}

impl ConnectPolicy for AllowList {
    fn authorize(&self, destination: SocketAddr) -> bool {
        self.entries
            .iter()
            .any(|(ip, ports)| *ip == destination.ip() && ports.contains(&destination.port()))
    }
}

/// Exact IPv4 resolver allowlist. The broker independently fixes the port to 53.
#[derive(Clone, Debug, Default)]
pub struct DnsAllowList {
    resolvers: Vec<Ipv4Addr>,
}

impl DnsAllowList {
    /// Authorizes one resolver IP; no UDP port other than 53 becomes reachable.
    #[must_use]
    pub fn allow(mut self, resolver: Ipv4Addr) -> Self {
        if !self.resolvers.contains(&resolver) {
            self.resolvers.push(resolver);
        }
        self
    }
}

impl DnsPolicy for DnsAllowList {
    fn authorize_resolver(&self, resolver: Ipv4Addr) -> bool {
        self.resolvers.contains(&resolver)
    }
}
