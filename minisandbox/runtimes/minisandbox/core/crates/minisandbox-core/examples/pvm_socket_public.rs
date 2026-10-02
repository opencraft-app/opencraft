//! Live guest UDP DNS plus explicitly allowlisted public HTTPS TCP probe.

use std::{
    env, fs,
    net::{IpAddr, Ipv4Addr, ToSocketAddrs},
    process::ExitCode,
    sync::Arc,
    time::Duration,
};

use minisandbox_core::engine::{DnsAllowList, Engine, RunOptions, TcpAllowList};

const MEMORY_SIZE: usize = 256 * 1024 * 1024;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-socket-public: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let initramfs_path = arguments.next().ok_or_else(usage)?;
    let resolver: Ipv4Addr = arguments
        .next()
        .ok_or_else(usage)?
        .to_string_lossy()
        .parse()
        .map_err(|error| format!("invalid resolver IPv4 address: {error}"))?;
    let hostname = arguments.next().map_or_else(
        || "example.com".to_owned(),
        |value| value.to_string_lossy().into_owned(),
    );
    if arguments.next().is_some() || hostname.contains([' ', '\0']) {
        return Err(usage());
    }

    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let initramfs = fs::read(&initramfs_path)
        .map_err(|error| format!("cannot read {}: {error}", initramfs_path.to_string_lossy()))?;
    let mut tcp_policy = TcpAllowList::default();
    let mut addresses = (hostname.as_str(), 443)
        .to_socket_addrs()
        .map_err(|error| format!("cannot resolve {hostname} for host policy: {error}"))?
        .filter_map(|address| match address.ip() {
            IpAddr::V4(ip) => Some(ip),
            IpAddr::V6(_) => None,
        })
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(format!("{hostname} has no IPv4 address for PF_INET"));
    }
    for address in &addresses {
        tcp_policy = tcp_policy.allow(IpAddr::V4(*address), 443..=443);
    }
    let dns_policy = DnsAllowList::default().allow(resolver);
    let command_line = format!(
        "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable rdinit=/init pvm_dns_server={resolver} pvm_https_host={hostname}"
    );
    eprintln!(
        "guest resolver allowlist: {resolver}:53; TCP allowlist: {}",
        addresses
            .iter()
            .map(|address| format!("{address}:443"))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let result = engine
        .run_pvm_linux_with_socket_policies(
            &kernel,
            &initramfs,
            command_line.as_bytes(),
            MEMORY_SIZE,
            Arc::new(tcp_policy),
            Arc::new(dns_policy),
            RunOptions {
                timeout: Duration::from_secs(20),
            },
        )
        .map_err(|error| format!("PVM public socket run failed: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(&result.output));
    for marker in [
        b"MINISANDBOX_PVM_DNS_OK".as_slice(),
        b"MINISANDBOX_PVM_HTTPS_TCP_OK".as_slice(),
        b"MINISANDBOX_PVM_LINUX_OK".as_slice(),
    ] {
        if !result
            .output
            .windows(marker.len())
            .any(|window| window == marker)
        {
            return Err(format!(
                "guest did not publish {}",
                String::from_utf8_lossy(marker)
            ));
        }
    }
    Ok(())
}

fn usage() -> String {
    "usage: pvm_socket_public <bzImage> <initramfs.cpio> <dns-resolver-ipv4> [hostname]".to_owned()
}
