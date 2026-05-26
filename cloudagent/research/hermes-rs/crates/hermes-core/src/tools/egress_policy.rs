//! Egress controls for model-visible HTTP tools.
//!
//! Sidecar tools run in the outer runtime process today. The policy in
//! this file intentionally treats web access as public-internet-only egress:
//! requests may reach normal public HTTP(S) endpoints, but must not reach local
//! loopback, link-local metadata, RFC1918 networks, or other special-use
//! addresses from the outer sandbox.

use std::fmt;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{Client, ClientBuilder, Url};
use tracing::warn;

#[derive(Debug, Clone)]
pub struct EgressPolicyError {
    reason: &'static str,
    detail: String,
}

impl EgressPolicyError {
    fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }

    pub fn reason(&self) -> &'static str {
        self.reason
    }
}

impl fmt::Display for EgressPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.reason, self.detail)
    }
}

impl std::error::Error for EgressPolicyError {}

#[derive(Debug, Clone, Copy, Default)]
pub struct PublicEgressPolicy;

impl PublicEgressPolicy {
    pub fn validate_url(&self, url: &Url) -> Result<(), EgressPolicyError> {
        match url.scheme() {
            "http" | "https" => {}
            _ => {
                return Err(EgressPolicyError::new(
                    "blocked_scheme",
                    "only HTTP and HTTPS URLs are supported",
                ))
            }
        }

        if !url.username().is_empty() || url.password().is_some() {
            return Err(EgressPolicyError::new(
                "blocked_userinfo",
                "URL userinfo is not allowed",
            ));
        }

        let host = url
            .host_str()
            .ok_or_else(|| EgressPolicyError::new("missing_host", "URL host is required"))?;
        self.validate_host(host)
    }

    pub fn validate_host(&self, host: &str) -> Result<(), EgressPolicyError> {
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() {
            return Err(EgressPolicyError::new("missing_host", "host is required"));
        }
        if host == "localhost" || host.ends_with(".localhost") {
            return Err(EgressPolicyError::new(
                "blocked_localhost",
                format!("host '{}' is local", host),
            ));
        }
        if is_metadata_host(&host) {
            return Err(EgressPolicyError::new(
                "blocked_metadata_host",
                format!("host '{}' is a cloud metadata endpoint", host),
            ));
        }
        let ip_literal = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(&host);
        if let Ok(ip) = ip_literal.parse::<IpAddr>() {
            self.validate_ip(ip)?;
        }
        Ok(())
    }

    pub fn validate_ip(&self, ip: IpAddr) -> Result<(), EgressPolicyError> {
        if is_blocked_ip(ip) {
            return Err(EgressPolicyError::new(
                "blocked_private_ip",
                format!("IP '{}' is not public internet egress", ip),
            ));
        }
        Ok(())
    }

    fn validate_all_resolved(
        &self,
        host: &str,
        addrs: &[SocketAddr],
    ) -> Result<(), EgressPolicyError> {
        if addrs.is_empty() {
            return Err(EgressPolicyError::new(
                "empty_dns_result",
                format!("host '{}' resolved to no addresses", host),
            ));
        }

        for addr in addrs {
            self.validate_ip(addr.ip()).map_err(|error| {
                warn!(
                    host = host,
                    ip = %addr.ip(),
                    reason = error.reason(),
                    "Blocked HTTP tool egress to non-public resolved address"
                );
                EgressPolicyError::new(
                    error.reason(),
                    format!(
                        "host '{}' resolved to blocked address '{}'",
                        host,
                        addr.ip()
                    ),
                )
            })?;
        }
        Ok(())
    }
}

pub fn guarded_http_client_builder() -> ClientBuilder {
    Client::builder()
        .dns_resolver(Arc::new(GuardedResolver::new(PublicEgressPolicy)))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
}

pub fn validate_http_tool_url(raw_url: &str) -> Result<Url, EgressPolicyError> {
    let url = Url::parse(raw_url)
        .map_err(|error| EgressPolicyError::new("invalid_url", error.to_string()))?;
    PublicEgressPolicy.validate_url(&url)?;
    Ok(url)
}

pub fn validate_response_remote_addr(
    tool_name: &str,
    remote_addr: Option<SocketAddr>,
) -> Result<Option<String>, EgressPolicyError> {
    if let Some(addr) = remote_addr {
        PublicEgressPolicy.validate_ip(addr.ip()).map_err(|error| {
            warn!(
                tool = tool_name,
                ip = %addr.ip(),
                reason = error.reason(),
                "Blocked HTTP tool response from non-public remote address"
            );
            EgressPolicyError::new(
                "blocked_remote_addr_after_connect",
                format!("response remote address '{}' is not allowed", addr.ip()),
            )
        })?;
        return Ok(Some(addr.to_string()));
    }
    Ok(None)
}

#[derive(Debug, Clone)]
struct GuardedResolver {
    policy: PublicEgressPolicy,
}

impl GuardedResolver {
    fn new(policy: PublicEgressPolicy) -> Self {
        Self { policy }
    }
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let policy = self.policy;
        Box::pin(async move {
            policy
                .validate_host(&host)
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;

            let addrs = lookup_host_without_port(&host)
                .await
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;
            policy
                .validate_all_resolved(&host, &addrs)
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;

            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

fn lookup_host_without_port(
    host: &str,
) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send>> {
    let host = host.to_string();
    Box::pin(async move {
        let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
        Ok(addrs.collect())
    })
}

fn is_metadata_host(host: &str) -> bool {
    matches!(
        host,
        "metadata.tencentyun.com"
            | "metadata.tencentcloudapi.com"
            | "metadata.google.internal"
            | "metadata.azure.internal"
            | "169.254.169.254"
    )
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_blocked_ipv4(ip),
        IpAddr::V6(_) => true,
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    is_rfc1918_ipv4(octets)
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || octets[0] == 0
        || (octets[0] == 100 && (octets[1] & 0b1100_0000) == 0b0100_0000)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && matches!(octets[1], 18 | 19))
        || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
        || octets[0] >= 224
}

fn is_rfc1918_ipv4(octets: [u8; 4]) -> bool {
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_localhost_and_metadata_hosts() {
        let policy = PublicEgressPolicy;

        assert!(policy.validate_host("localhost").is_err());
        assert!(policy.validate_host("api.localhost").is_err());
        assert!(policy.validate_host("metadata.tencentyun.com").is_err());
        assert!(policy.validate_host("metadata.google.internal").is_err());
    }

    #[test]
    fn rejects_private_and_special_ip_literals() {
        let policy = PublicEgressPolicy;

        for host in [
            "127.0.0.1",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "169.254.169.254",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(policy.validate_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn enforces_rfc1918_ipv4_boundaries_explicitly() {
        let policy = PublicEgressPolicy;

        for host in [
            "10.0.0.0",
            "10.255.255.255",
            "172.16.0.0",
            "172.31.255.255",
            "192.168.0.0",
            "192.168.255.255",
        ] {
            assert!(policy.validate_host(host).is_err(), "{host}");
        }

        for host in [
            "9.255.255.255",
            "11.0.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.167.255.255",
            "192.169.0.0",
        ] {
            assert!(policy.validate_host(host).is_ok(), "{host}");
        }
    }

    #[test]
    fn rejects_all_ipv4_mapped_ipv6_addresses() {
        let policy = PublicEgressPolicy;

        for host in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:172.16.0.1",
            "::ffff:192.168.0.1",
            "::ffff:169.254.169.254",
            "::ffff:93.184.216.34",
        ] {
            assert!(policy.validate_host(host).is_err(), "{host}");
        }
    }

    #[test]
    fn rejects_ipv6_literals_in_url_form() {
        assert!(validate_http_tool_url("http://[::1]/").is_err());
        assert!(validate_http_tool_url("http://[fc00::1]/").is_err());
        assert!(validate_http_tool_url("http://[fe80::1]/").is_err());
        assert!(validate_http_tool_url("https://[2606:2800:220:1:248:1893:25c8:1946]/").is_err());
    }

    #[test]
    fn rejects_metadata_hosts_case_and_trailing_dot() {
        let policy = PublicEgressPolicy;

        assert!(policy.validate_host("METADATA.TENCENTYUN.COM.").is_err());
        assert!(policy
            .validate_host("metadata.tencentcloudapi.com.")
            .is_err());
        assert!(policy.validate_host("api.LOCALHOST.").is_err());
    }

    #[test]
    fn accepts_public_hosts_and_ips() {
        let policy = PublicEgressPolicy;

        assert!(policy.validate_host("example.com").is_ok());
        assert!(policy.validate_host("93.184.216.34").is_ok());
    }

    #[test]
    fn rejects_public_ipv6_literals() {
        let policy = PublicEgressPolicy;

        assert!(policy
            .validate_host("2606:2800:220:1:248:1893:25c8:1946")
            .is_err());
    }

    #[test]
    fn rejects_userinfo_and_non_http_urls() {
        assert!(validate_http_tool_url("file:///etc/passwd").is_err());
        assert!(validate_http_tool_url("http://user:pass@example.com").is_err());
        assert!(validate_http_tool_url("https://example.com").is_ok());
    }

    #[test]
    fn rejects_mixed_dns_results() {
        let policy = PublicEgressPolicy;
        let addrs = vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)), 0),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 0),
        ];

        assert!(policy.validate_all_resolved("example.com", &addrs).is_err());
    }

    #[test]
    fn rejects_empty_dns_results() {
        let policy = PublicEgressPolicy;

        let error = policy
            .validate_all_resolved("example.com", &[])
            .expect_err("empty DNS response must fail closed");
        assert_eq!(error.reason(), "empty_dns_result");
    }

    #[test]
    fn validates_response_remote_addr_as_last_resort() {
        let public = validate_response_remote_addr(
            "web_fetch",
            Some(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)),
                443,
            )),
        )
        .expect("public response address should be allowed");
        assert_eq!(public.as_deref(), Some("93.184.216.34:443"));

        let error = validate_response_remote_addr(
            "web_fetch",
            Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 443)),
        )
        .expect_err("private response address must fail closed");
        assert_eq!(error.reason(), "blocked_remote_addr_after_connect");
    }
}
