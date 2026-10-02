//! Warm-checkpoint host-to-guest TCP injection smoke.

use std::{
    env, fs,
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    process::ExitCode,
    sync::{Arc, Barrier},
    thread,
    time::Duration,
};

use minisandbox_core::engine::{
    Engine, PvmLinuxTemplate, PvmReadOnlyImage, RunOptions, RunOutcome,
};
use minisandbox_core::pvm_linux::READ_ONLY_ROOTFS_GPA;

const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const GUEST_PORT: u16 = 18_080;
const GUEST_CANCEL_PORT: u16 = 18_081;
const REQUEST: &[u8] = b"host-ingress\0";
const RESPONSE: &[u8] = b"guest-ingress\0";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-socket-ingress-smoke: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let initramfs_path = arguments.next().ok_or_else(usage)?;
    if arguments.next().is_some() {
        return Err(usage());
    }
    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let initramfs = fs::read(&initramfs_path)
        .map_err(|error| format!("cannot read {}: {error}", initramfs_path.to_string_lossy()))?;
    // The checkpoint API retains one read-only GPA image. This initramfs-only
    // smoke deliberately leaves the page undescribed to Linux.
    let inert_image = PvmReadOnlyImage::from_bytes(&[0_u8; 4096])
        .map_err(|error| format!("cannot create inert read-only image: {error}"))?;
    let command_line = format!(
        "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 \
         nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable \
         rdinit=/init pvm_ingress_port={GUEST_PORT} \
         pvm_ingress_cancel_port={GUEST_CANCEL_PORT}"
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
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
        .map_err(|error| format!("cannot create ingress template: {error:?}"))?;
    verify_destroy_inject_isolation(&engine, &template)?;
    let mut instance = engine
        .clone_pvm_linux_template(&template)
        .map_err(|error| format!("cannot clone ingress template: {error:?}"))?;
    let ingress = instance.socket_ingress();
    let runner = thread::spawn(move || {
        instance.run_for(RunOptions {
            timeout: Duration::from_secs(3),
        })
    });

    let exchange = verify_cancellation_then_exchange(&ingress);
    let result = runner
        .join()
        .map_err(|_| "PVM ingress runner panicked".to_owned())?
        .map_err(|error| format!("PVM ingress run failed: {error:?}"))?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    print!("{}", String::from_utf8_lossy(&result.output));
    exchange?;
    if result.outcome != RunOutcome::TimedOut
        || !result
            .output
            .windows(b"MINISANDBOX_PVM_HOST_INGRESS_CANCEL_OK".len())
            .any(|window| window == b"MINISANDBOX_PVM_HOST_INGRESS_CANCEL_OK")
        || !result
            .output
            .windows(b"MINISANDBOX_PVM_HOST_INGRESS_OK".len())
            .any(|window| window == b"MINISANDBOX_PVM_HOST_INGRESS_OK")
    {
        return Err("guest did not publish host-ingress success marker".to_owned());
    }
    Ok(())
}

fn verify_destroy_inject_isolation(
    engine: &Engine,
    template: &PvmLinuxTemplate,
) -> Result<(), String> {
    const RACERS: usize = 64;

    let old_instance = engine
        .clone_pvm_linux_template(template)
        .map_err(|error| format!("cannot clone destroy-race instance: {error:?}"))?;
    let old_ingress = old_instance.socket_ingress();
    let barrier = Arc::new(Barrier::new(RACERS + 1));
    let mut racers = Vec::with_capacity(RACERS);
    for _ in 0..RACERS {
        let ingress = old_ingress.clone();
        let barrier = Arc::clone(&barrier);
        let (injected, peer) = connected_tcp_pair()?;
        racers.push(thread::spawn(move || {
            barrier.wait();
            let result = match ingress.begin_inject_tcp_with_timeout(
                injected,
                GUEST_PORT,
                Duration::from_secs(1),
            ) {
                Ok(operation) => operation.wait_timeout(Duration::from_millis(500)),
                Err(error) => Err(error),
            };
            drop(peer);
            result
        }));
    }
    barrier.wait();
    drop(old_instance);
    for racer in racers {
        let result = racer
            .join()
            .map_err(|_| "destroy/inject racer panicked".to_owned())?;
        if !matches!(
            result,
            Err(pvm_socket_service::SocketIngressError::BrokerStopped
                | pvm_socket_service::SocketIngressError::Capacity)
        ) {
            return Err(format!("destroy/inject racer escaped teardown: {result:?}"));
        }
    }

    let (stale_stream, stale_peer) = connected_tcp_pair()?;
    let stale_result = old_ingress.begin_inject_tcp(stale_stream, GUEST_PORT);
    drop(stale_peer);
    match stale_result {
        Err(pvm_socket_service::SocketIngressError::BrokerStopped) => {}
        Err(error) => {
            return Err(format!(
                "destroyed clone ingress handle returned wrong error: {error}"
            ));
        }
        Ok(operation) => {
            operation.cancel();
            return Err("destroyed clone ingress handle remained usable".to_owned());
        }
    }
    println!("MINISANDBOX_PVM_DESTROY_INJECT_ISOLATION_OK racers={RACERS}");
    Ok(())
}

fn verify_cancellation_then_exchange(
    ingress: &pvm_socket_service::SocketIngressHandle,
) -> Result<(), String> {
    let rejected = ingress
        .connect_tcp(GUEST_PORT + 2)
        .expect_err("unbound guest port must reject ingress");
    if rejected != pvm_socket_service::SocketIngressError::Rejected {
        return Err(format!("unbound guest port returned {rejected}"));
    }
    let (cancelled_stream, cancelled_peer) = connected_tcp_pair()?;
    let cancellation = ingress
        .begin_inject_tcp_with_timeout(cancelled_stream, GUEST_CANCEL_PORT, Duration::from_secs(2))
        .map_err(|error| format!("cannot submit cancellable ingress: {error}"))?;
    let cancellation_deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        match cancellation.try_result() {
            Some(Ok(())) => break,
            Some(Err(error)) => {
                return Err(format!(
                    "cancellable ingress failed before cancellation: {error}"
                ));
            }
            None if std::time::Instant::now() < cancellation_deadline => {
                thread::sleep(Duration::from_millis(1));
            }
            None => return Err("guest did not acknowledge cancellable ingress".to_owned()),
        }
    }
    cancellation.cancel();
    drop(cancelled_peer);

    let mut peer = ingress
        .connect_tcp(GUEST_PORT)
        .map_err(|error| format!("cannot connect to guest listener: {error}"))?;
    configure_peer(&peer)?;
    peer.write_all(REQUEST)
        .map_err(|error| format!("cannot send ingress request: {error}"))?;
    let mut response = [0_u8; RESPONSE.len()];
    peer.read_exact(&mut response)
        .map_err(|error| format!("cannot read ingress response: {error}"))?;
    if response != RESPONSE {
        return Err(format!("unexpected ingress response {response:02x?}"));
    }
    Ok(())
}

fn connected_tcp_pair() -> Result<(TcpStream, TcpStream), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("cannot bind private cancellation pair: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("cannot read private cancellation address: {error}"))?;
    let peer = TcpStream::connect(address)
        .map_err(|error| format!("cannot connect private cancellation pair: {error}"))?;
    let (injected, _) = listener
        .accept()
        .map_err(|error| format!("cannot accept private cancellation pair: {error}"))?;
    Ok((injected, peer))
}

fn configure_peer(peer: &TcpStream) -> Result<(), String> {
    peer.set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("cannot set ingress read timeout: {error}"))?;
    peer.set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("cannot set ingress write timeout: {error}"))?;
    Ok(())
}

fn usage() -> String {
    "usage: pvm_socket_ingress <bzImage> <initramfs.cpio>".to_owned()
}
