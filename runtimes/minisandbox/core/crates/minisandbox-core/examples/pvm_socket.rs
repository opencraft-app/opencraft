//! Live guest `PF_INET` to host TCP broker round-trip.

use std::{
    env, fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, TcpListener, TcpStream},
    num::NonZeroU64,
    os::fd::AsRawFd,
    process::ExitCode,
    sync::Arc,
    thread,
    time::Duration,
};

use minisandbox_core::{
    engine::{
        BandwidthQuota, BrokerStats, Engine, HOST_LOOPBACK_ALIAS, NetworkAllowAll,
        PvmLinuxCloneResult, PvmReadOnlyImage, RunOptions, SocketQuotas, TcpAllowList,
    },
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};

const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const STREAM_FIFO_BYTES: usize = 6 * 4096 + 733;
const CLOSE_DRAIN_BYTES: usize = 4 * 4096 - 19;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-socket-smoke: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments
        .next()
        .ok_or_else(|| "usage: pvm_socket <bzImage> <initramfs.cpio>".to_owned())?;
    let initramfs_path = arguments
        .next()
        .ok_or_else(|| "usage: pvm_socket <bzImage> <initramfs.cpio>".to_owned())?;
    if arguments.next().is_some() {
        return Err("usage: pvm_socket <bzImage> <initramfs.cpio>".to_owned());
    }
    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let initramfs = fs::read(&initramfs_path)
        .map_err(|error| format!("cannot read {}: {error}", initramfs_path.to_string_lossy()))?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("cannot bind loopback server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("cannot read loopback address: {error}"))?
        .port();
    let refused_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("cannot reserve refused loopback port: {error}"))?;
    let refused_port = refused_listener
        .local_addr()
        .map_err(|error| format!("cannot read refused loopback address: {error}"))?
        .port();
    drop(refused_listener);
    let lifecycle_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("cannot bind lifecycle loopback server: {error}"))?;
    let lifecycle_port = lifecycle_listener
        .local_addr()
        .map_err(|error| format!("cannot read lifecycle loopback address: {error}"))?
        .port();
    let server = thread::spawn(move || serve_socket_smoke(&listener));
    let lifecycle_server = thread::spawn(move || serve_socket_lifecycle(&lifecycle_listener));
    let command_line = format!(
        "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable rdinit=/init pvm_socket_after_resume=1 pvm_socket_port={port} pvm_socket_refused_port={refused_port} pvm_socket_lifecycle_port={lifecycle_port}"
    );
    let policy = TcpAllowList::default()
        .allow(IpAddr::V4(HOST_LOOPBACK_ALIAS), port..=port)
        .allow(IpAddr::V4(HOST_LOOPBACK_ALIAS), refused_port..=refused_port)
        .allow(
            IpAddr::V4(HOST_LOOPBACK_ALIAS),
            lifecycle_port..=lifecycle_port,
        );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let inert_image = PvmReadOnlyImage::from_bytes(&[0_u8; 4096])
        .map_err(|error| format!("cannot create inert read-only image: {error}"))?;
    let template = engine
        .warm_pvm_linux_template(
            &kernel,
            &initramfs,
            command_line.as_bytes(),
            MEMORY_SIZE,
            &inert_image,
            READ_ONLY_ROOTFS_GPA,
            RunOptions {
                timeout: Duration::from_secs(10),
            },
        )
        .map_err(|error| format!("cannot warm PVM socket template: {error:?}"))?;
    let bandwidth = BandwidthQuota {
        bytes_per_second: NonZeroU64::new(64 * 1024).expect("nonzero fixed rate"),
        burst_bytes: NonZeroU64::new(4096).expect("nonzero fixed burst"),
    };
    let mut instance = engine
        .clone_pvm_linux_template_with_socket_policies_and_quotas(
            &template,
            Arc::new(policy),
            Arc::new(NetworkAllowAll),
            SocketQuotas {
                egress_bandwidth: Some(bandwidth),
                ingress_bandwidth: Some(bandwidth),
                ..SocketQuotas::default()
            },
        )
        .map_err(|error| format!("cannot clone PVM socket template: {error:?}"))?;
    let result = instance
        .run_until_markers(
            b"MINISANDBOX_PVM_LINUX_RESUMED",
            b"MINISANDBOX_PVM_SOCKET_RST_OK",
            RunOptions {
                timeout: Duration::from_secs(10),
            },
        )
        .map_err(|error| format!("PVM socket clone failed: {error:?}"))?;
    server
        .join()
        .map_err(|_| "loopback server panicked".to_owned())??;
    lifecycle_server
        .join()
        .map_err(|_| "lifecycle loopback server panicked".to_owned())??;
    let final_socket_stats = instance.socket_stats();
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    print!("{}", String::from_utf8_lossy(&result.output));
    verify_result(&result, final_socket_stats)
}

fn verify_result(result: &PvmLinuxCloneResult, stats: BrokerStats) -> Result<(), String> {
    let required_markers: [&[u8]; 6] = [
        b"MINISANDBOX_PVM_SOCKET_OK",
        b"MINISANDBOX_PVM_SOCKET_SO_ERROR_OK",
        b"MINISANDBOX_PVM_SOCKET_STREAM_FIFO_OK",
        b"MINISANDBOX_PVM_SOCKET_CLOSE_DRAIN_OK",
        b"MINISANDBOX_PVM_SOCKET_HALF_CLOSE_OK",
        b"MINISANDBOX_PVM_SOCKET_RST_OK",
    ];
    if required_markers.iter().all(|marker| {
        result
            .output
            .windows(marker.len())
            .any(|window| window == *marker)
    }) && result.completion_latency >= Duration::from_millis(250)
        && stats.rx_bytes >= u64::try_from(STREAM_FIFO_BYTES).expect("fixed stream bytes fit u64")
        && stats.tx_bytes >= u64::try_from(CLOSE_DRAIN_BYTES).expect("fixed close bytes fit u64")
    {
        Ok(())
    } else {
        Err(format!(
            "guest socket/quota verification failed: completion {:?}, tx {}, rx {}",
            result.completion_latency, stats.tx_bytes, stats.rx_bytes
        ))
    }
}

fn serve_socket_lifecycle(listener: &TcpListener) -> Result<(), String> {
    let (mut half_close, _) = listener
        .accept()
        .map_err(|error| format!("cannot accept half-close stream: {error}"))?;
    half_close
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("cannot set half-close read timeout: {error}"))?;
    half_close
        .write_all(b"before-fin\0")
        .map_err(|error| format!("cannot write pre-FIN payload: {error}"))?;
    half_close
        .shutdown(std::net::Shutdown::Write)
        .map_err(|error| format!("cannot publish host FIN: {error}"))?;
    let mut response = [0_u8; 10];
    half_close
        .read_exact(&mut response)
        .map_err(|error| format!("cannot read guest response after FIN: {error}"))?;
    if &response != b"after-fin\0" {
        return Err(format!(
            "unexpected post-FIN guest response {response:02x?}"
        ));
    }
    let mut eof = [0_u8; 1];
    if half_close
        .read(&mut eof)
        .map_err(|error| format!("cannot observe guest SHUT_WR: {error}"))?
        != 0
    {
        return Err("guest sent bytes after SHUT_WR".to_owned());
    }

    let (mut reset, _) = listener
        .accept()
        .map_err(|error| format!("cannot accept reset stream: {error}"))?;
    reset
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("cannot set reset read timeout: {error}"))?;
    let mut ready = [0_u8; 1];
    reset
        .read_exact(&mut ready)
        .map_err(|error| format!("cannot read reset readiness: {error}"))?;
    if ready[0] != b'R' {
        return Err("guest sent invalid reset readiness".to_owned());
    }
    set_abortive_close(&reset)?;
    drop(reset);
    Ok(())
}

fn set_abortive_close(stream: &TcpStream) -> Result<(), String> {
    let linger = libc::linger {
        l_onoff: 1,
        l_linger: 0,
    };
    let linger_length = libc::socklen_t::try_from(std::mem::size_of_val(&linger))
        .map_err(|_| "SO_LINGER length does not fit socklen_t".to_owned())?;
    // SAFETY: `stream` owns a live TCP fd and `linger` matches `SO_LINGER`.
    let result = unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_LINGER,
            std::ptr::from_ref(&linger).cast(),
            linger_length,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "cannot configure abortive TCP close: {}",
            std::io::Error::last_os_error()
        ))
    }
}

fn serve_socket_smoke(listener: &TcpListener) -> Result<(), String> {
    let (mut stream, _) = listener
        .accept()
        .map_err(|error| format!("cannot accept broker stream: {error}"))?;
    let mut request = [0_u8; 11];
    stream
        .read_exact(&mut request)
        .map_err(|error| format!("cannot read guest request: {error}"))?;
    if &request != b"guest-ping\0" {
        return Err(format!("unexpected guest request {request:02x?}"));
    }
    stream
        .write_all(b"host-pong\0")
        .map_err(|error| format!("cannot write guest response: {error}"))?;
    let mut payload = vec![0_u8; STREAM_FIFO_BYTES];
    for (position, byte) in payload.iter_mut().enumerate() {
        *byte = u8::try_from((position * 131 + 17) % 251)
            .map_err(|_| "stream test byte exceeds u8".to_owned())?;
    }
    stream
        .write_all(&payload)
        .map_err(|error| format!("cannot write FIFO test payload: {error}"))?;
    let mut close_tail = vec![0_u8; CLOSE_DRAIN_BYTES];
    stream
        .read_exact(&mut close_tail)
        .map_err(|error| format!("cannot read guest close-drain tail: {error}"))?;
    for (position, byte) in close_tail.iter().copied().enumerate() {
        let expected = u8::try_from((position * 73 + 41) % 251)
            .map_err(|_| "close-drain test byte exceeds u8".to_owned())?;
        if byte != expected {
            return Err(format!(
                "guest close-drain byte {position} was {byte}, expected {expected}"
            ));
        }
    }
    let mut after_close = [0_u8; 1];
    if stream
        .read(&mut after_close)
        .map_err(|error| format!("cannot observe guest TCP FIN: {error}"))?
        != 0
    {
        return Err("guest sent bytes after the close-drain tail".to_owned());
    }
    Ok(())
}
