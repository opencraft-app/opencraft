//! Destination decoding and explicit policy tests.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use pvm_socket_service::{
    AllowAll, AllowList, ConnectPolicy, DenyAll, DnsAllowList, DnsPolicy, Endpoint,
};

#[test]
fn endpoint_decode_and_default_deny_are_canonical() {
    let bytes = [2, 0, 0x01, 0xbb, 127, 0, 0, 1];
    let endpoint = Endpoint::decode(&bytes).expect("canonical endpoint");
    let address = SocketAddr::from(endpoint);
    assert_eq!(address, "127.0.0.1:443".parse().unwrap());
    assert!(!DenyAll.authorize(address));
    assert!(
        AllowList::default()
            .allow(IpAddr::V4(Ipv4Addr::LOCALHOST), 443..=443)
            .authorize(address)
    );
    assert!(Endpoint::decode(&bytes[..7]).is_err());
}

#[test]
fn dns_resolvers_are_exact_and_default_deny() {
    let resolver = Ipv4Addr::new(9, 9, 9, 9);
    assert!(!DnsPolicy::authorize_resolver(&DenyAll, resolver));
    assert!(
        DnsAllowList::default()
            .allow(resolver)
            .authorize_resolver(resolver)
    );
    assert!(
        !DnsAllowList::default()
            .allow(resolver)
            .authorize_resolver(Ipv4Addr::new(1, 1, 1, 1))
    );
}

#[test]
fn unrestricted_policy_allows_tcp_and_dns_within_the_transport_boundary() {
    assert!(AllowAll.authorize("127.0.0.1:1".parse().unwrap()));
    assert!(AllowAll.authorize("203.0.113.9:65535".parse().unwrap()));
    assert!(DnsPolicy::authorize_resolver(
        &AllowAll,
        Ipv4Addr::UNSPECIFIED
    ));
    assert!(DnsPolicy::authorize_resolver(
        &AllowAll,
        Ipv4Addr::BROADCAST
    ));
}
