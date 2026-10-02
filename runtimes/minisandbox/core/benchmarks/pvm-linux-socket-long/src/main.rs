//! Long-lived protocol and EPOLLET/backpressure verification for one PVM clone.

use std::{env, fs, process::ExitCode, sync::Arc, thread, time::Duration};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Empty};
use hyper::{Request, StatusCode, client::conn::http1};
use hyper_util::rt::TokioIo;
use minisandbox_core::{
    engine::{Engine, PvmReadOnlyImage, RunOptions},
    pvm_linux::READ_ONLY_ROOTFS_GPA,
};
use pvm_socket_service::SocketIngressHandle;
use tokio::{
    net::TcpStream,
    sync::{Barrier, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use tokio_tungstenite::{client_async, tungstenite::Message};

const COMMON_COMMAND_LINE: &str = "console=ttyS0,115200n8 earlycon=uart,io,0x3f8,115200n8 panic=-1 nokaslr acpi=off pci=off noapic clocksource=tsc tsc=reliable";
const MEMORY_SIZE: usize = 256 * 1024 * 1024;
const GUEST_PORT: u16 = 18_090;
const KEEPALIVE_CONNECTIONS: usize = 16;
const SSE_CONNECTIONS: usize = 16;
const WEBSOCKET_CONNECTIONS: usize = 16;
const KEEPALIVE_REQUESTS: usize = 64;
const SSE_EVENTS: usize = 512;
const WEBSOCKET_MESSAGES: usize = 64;
const WEBSOCKET_PAYLOAD: usize = 256;
const TOTAL_CONNECTIONS: usize = KEEPALIVE_CONNECTIONS + SSE_CONNECTIONS + WEBSOCKET_CONNECTIONS;
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pvm-linux-socket-long: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let kernel_path = arguments.next().ok_or_else(usage)?;
    let rootfs_path = arguments.next().ok_or_else(usage)?;
    if arguments.next().is_some() {
        return Err(usage());
    }
    let kernel = fs::read(&kernel_path)
        .map_err(|error| format!("cannot read {}: {error}", kernel_path.to_string_lossy()))?;
    let rootfs = fs::File::open(&rootfs_path)
        .map_err(|error| format!("cannot open {}: {error}", rootfs_path.to_string_lossy()))?;
    let rootfs = PvmReadOnlyImage::from_file(rootfs)
        .map_err(|error| format!("cannot map long-lived EROFS: {error}"))?;
    let command_line = format!(
        "{COMMON_COMMAND_LINE} loglevel=3 memmap={:#x}!{READ_ONLY_ROOTFS_GPA:#x} \
         root=/dev/pmem0 rootfstype=erofs rootflags=dax=always ro \
         init=/sbin/minisandbox-init mslong.port={GUEST_PORT} \
         mslong.connections={TOTAL_CONNECTIONS} mslong.keepalive={KEEPALIVE_REQUESTS} \
         mslong.sse={SSE_EVENTS} mslong.websocket={WEBSOCKET_MESSAGES}",
        rootfs.len()
    );
    let engine = Engine::open().map_err(|error| format!("cannot open PVM engine: {error:?}"))?;
    let template = engine
        .warm_pvm_linux_template(
            &kernel,
            &[],
            command_line.as_bytes(),
            MEMORY_SIZE,
            &rootfs,
            READ_ONLY_ROOTFS_GPA,
            RunOptions {
                timeout: RUN_TIMEOUT,
            },
        )
        .map_err(|error| format!("cannot warm long-lived template: {error:?}"))?;
    let mut instance = engine
        .clone_pvm_linux_template(&template)
        .map_err(|error| format!("cannot clone long-lived template: {error:?}"))?;
    let resumed = instance
        .run_until_markers(
            b"MSLONG_RESUMED",
            b"MSLONG_RESUMED",
            RunOptions {
                timeout: RUN_TIMEOUT,
            },
        )
        .map_err(|error| format!("cannot resume long-lived clone: {error:?}"))?;
    let ingress = instance.socket_ingress();
    let canceller = instance.run_canceller();
    let runner = thread::spawn(move || {
        instance.run_until_markers(
            b"MSLONG_RESULT",
            b"MSLONG_DONE",
            RunOptions {
                timeout: RUN_TIMEOUT,
            },
        )
    });
    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| format!("cannot create protocol runtime: {error}"))?;
    let clients = runtime.block_on(run_clients(ingress));
    if clients.is_err() {
        canceller
            .cancel()
            .map_err(|error| format!("cannot cancel failed protocol run: {error}"))?;
    }
    let result = runner
        .join()
        .map_err(|_| "long-lived PVM runner panicked".to_owned())?
        .map_err(|error| {
            clients
                .as_ref()
                .map_or_else(std::clone::Clone::clone, |()| {
                    format!("long-lived PVM run failed: {error:?}")
                })
        })?;
    print!("{}", String::from_utf8_lossy(template.warm_output()));
    print!("{}", String::from_utf8_lossy(&resumed.output));
    print!("{}", String::from_utf8_lossy(&result.output));
    clients?;
    verify_guest_result(&result.output)?;
    if result.socket_stats.rx_bytes == 0
        || result.socket_stats.tx_bytes == 0
        || result.socket_stats.reactor_turns == 0
    {
        return Err("socket broker did not attribute long-lived traffic".to_owned());
    }
    Ok(())
}

async fn run_clients(ingress: SocketIngressHandle) -> Result<(), String> {
    let admission = Arc::new(Semaphore::new(8));
    let slow_sse_connections = SSE_CONNECTIONS / 2;
    let slow_ready = Arc::new(Barrier::new(slow_sse_connections + 1));
    let slow_release = Arc::new(Barrier::new(slow_sse_connections + 1));
    let mut fast_clients: Vec<JoinHandle<Result<(), String>>> =
        Vec::with_capacity(TOTAL_CONNECTIONS - slow_sse_connections);
    let mut slow_clients: Vec<JoinHandle<Result<(), String>>> =
        Vec::with_capacity(slow_sse_connections);
    for client in 0..KEEPALIVE_CONNECTIONS {
        fast_clients.push(tokio::spawn(run_keepalive(
            ingress.clone(),
            Arc::clone(&admission),
            client,
        )));
    }
    for client in 0..SSE_CONNECTIONS {
        let slow = client % 2 == 0;
        let task = tokio::spawn(run_sse(
            ingress.clone(),
            Arc::clone(&admission),
            client,
            slow.then(|| Arc::clone(&slow_ready)),
            slow.then(|| Arc::clone(&slow_release)),
        ));
        if slow {
            slow_clients.push(task);
        } else {
            fast_clients.push(task);
        }
    }
    for client in 0..WEBSOCKET_CONNECTIONS {
        fast_clients.push(tokio::spawn(run_websocket(
            ingress.clone(),
            Arc::clone(&admission),
            client,
        )));
    }
    slow_ready.wait().await;
    for client in fast_clients {
        client
            .await
            .map_err(|error| format!("protocol client task failed: {error}"))??;
    }
    slow_release.wait().await;
    for client in slow_clients {
        client
            .await
            .map_err(|error| format!("slow SSE client task failed: {error}"))??;
    }
    Ok(())
}

async fn connect_guest(
    ingress: SocketIngressHandle,
    admission: Arc<Semaphore>,
) -> Result<(TcpStream, OwnedSemaphorePermit), String> {
    let permit = admission
        .acquire_owned()
        .await
        .map_err(|_| "ingress admission semaphore closed".to_owned())?;
    let stream = ingress
        .connect_tcp_async(GUEST_PORT)
        .await
        .map_err(|error| format!("cannot inject long-lived connection: {error}"))?;
    stream
        .set_nonblocking(true)
        .map_err(|error| format!("cannot make injected stream nonblocking: {error}"))?;
    let stream = TcpStream::from_std(stream)
        .map_err(|error| format!("cannot attach injected stream to Tokio: {error}"))?;
    Ok((stream, permit))
}

async fn run_keepalive(
    ingress: SocketIngressHandle,
    admission: Arc<Semaphore>,
    client: usize,
) -> Result<(), String> {
    let (stream, admission) = connect_guest(ingress, admission).await?;
    let mut admission = Some(admission);
    let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|error| format!("keep-alive {client} handshake: {error}"))?;
    let driver = tokio::spawn(connection);
    for request_index in 0..KEEPALIVE_REQUESTS {
        let request = Request::builder()
            .method("GET")
            .uri("/keepalive")
            .header("host", "minisandbox")
            .body(Empty::<Bytes>::new())
            .map_err(|error| format!("keep-alive request build: {error}"))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|error| format!("keep-alive {client}/{request_index}: {error}"))?;
        if response.status() != StatusCode::OK {
            return Err(format!("keep-alive returned {}", response.status()));
        }
        let body = response
            .into_body()
            .collect()
            .await
            .map_err(|error| format!("keep-alive body: {error}"))?
            .to_bytes();
        if body.as_ref() != b"ok" {
            return Err("keep-alive response body mismatch".to_owned());
        }
        if request_index == 0 {
            drop(admission.take());
        }
    }
    drop(sender);
    driver.abort();
    let _ = driver.await;
    Ok(())
}

async fn run_sse(
    ingress: SocketIngressHandle,
    admission: Arc<Semaphore>,
    client: usize,
    slow_ready: Option<Arc<Barrier>>,
    slow_release: Option<Arc<Barrier>>,
) -> Result<(), String> {
    let (stream, admission) = connect_guest(ingress, admission).await?;
    let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|error| format!("SSE {client} handshake: {error}"))?;
    let driver = tokio::spawn(connection);
    let request = Request::builder()
        .method("GET")
        .uri("/sse")
        .header("host", "minisandbox")
        .body(Empty::<Bytes>::new())
        .map_err(|error| format!("SSE request build: {error}"))?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|error| format!("SSE {client} request: {error}"))?;
    if response.status() != StatusCode::OK
        || response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            != Some("text/event-stream")
    {
        return Err("invalid SSE response headers".to_owned());
    }
    drop(admission);
    match (slow_ready, slow_release) {
        (Some(ready), Some(release)) => {
            ready.wait().await;
            release.wait().await;
        }
        (None, None) => {}
        _ => return Err("inconsistent slow SSE barriers".to_owned()),
    }
    let mut body = response.into_body();
    let mut buffered = Vec::with_capacity(1024);
    let mut event_index = 0_usize;
    while event_index < SSE_EVENTS {
        let frame = body
            .frame()
            .await
            .ok_or_else(|| format!("SSE {client} ended after {event_index} events"))?
            .map_err(|error| format!("SSE {client} frame: {error}"))?;
        if let Ok(data) = frame.into_data() {
            buffered.extend_from_slice(&data);
        }
        while let Some(end) = find_double_newline(&buffered) {
            let event: Vec<_> = buffered.drain(..end + 2).collect();
            let expected = format!("data: {event_index:06} ");
            if event.len() != 512 || !event.starts_with(expected.as_bytes()) {
                return Err(format!("SSE {client} event {event_index} was malformed"));
            }
            event_index += 1;
            if event_index == SSE_EVENTS {
                break;
            }
        }
        if buffered.len() > 1024 {
            return Err("SSE parser carry exceeded two bounded events".to_owned());
        }
    }
    drop(body);
    drop(sender);
    driver.abort();
    let _ = driver.await;
    Ok(())
}

async fn run_websocket(
    ingress: SocketIngressHandle,
    admission: Arc<Semaphore>,
    client: usize,
) -> Result<(), String> {
    let (stream, admission) = connect_guest(ingress, admission).await?;
    let (mut websocket, response) = client_async("ws://minisandbox/ws", stream)
        .await
        .map_err(|error| format!("WebSocket {client} handshake: {error}"))?;
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Err(format!(
            "WebSocket handshake returned {}",
            response.status()
        ));
    }
    drop(admission);
    for message_index in 0..WEBSOCKET_MESSAGES {
        let mut payload = vec![0_u8; WEBSOCKET_PAYLOAD];
        for (offset, byte) in payload.iter_mut().enumerate() {
            *byte = u8::try_from((client * 17 + message_index * 31 + offset) % 251)
                .expect("bounded payload byte");
        }
        websocket
            .send(Message::Binary(payload.clone().into()))
            .await
            .map_err(|error| format!("WebSocket {client} send: {error}"))?;
        let echoed = websocket
            .next()
            .await
            .ok_or_else(|| format!("WebSocket {client} ended before echo"))?
            .map_err(|error| format!("WebSocket {client} receive: {error}"))?;
        if echoed.into_data().as_ref() != payload {
            return Err(format!("WebSocket {client}/{message_index} echo mismatch"));
        }
    }
    websocket
        .close(None)
        .await
        .map_err(|error| format!("WebSocket {client} close: {error}"))
}

fn find_double_newline(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|window| window == b"\n\n")
}

fn verify_guest_result(output: &[u8]) -> Result<(), String> {
    let text = String::from_utf8_lossy(output);
    let line = text
        .lines()
        .find(|line| line.starts_with("MSLONG_RESULT "))
        .ok_or_else(|| "guest did not publish MSLONG_RESULT".to_owned())?;
    let accepted = result_field(line, "accepted")?;
    let completed = result_field(line, "completed")?;
    let send_eagain = result_field(line, "send_eagain")?;
    let recv_eagain = result_field(line, "recv_eagain")?;
    if accepted != TOTAL_CONNECTIONS as u64
        || completed != TOTAL_CONNECTIONS as u64
        || send_eagain == 0
        || recv_eagain == 0
    {
        return Err(format!(
            "guest EPOLLET/backpressure result was incomplete: {line}"
        ));
    }
    Ok(())
}

fn result_field(line: &str, name: &str) -> Result<u64, String> {
    let prefix = format!("{name}=");
    line.split_ascii_whitespace()
        .find_map(|field| field.strip_prefix(&prefix))
        .ok_or_else(|| format!("missing {name} in long-lived result"))?
        .parse()
        .map_err(|error| format!("invalid {name} in long-lived result: {error}"))
}

fn usage() -> String {
    "usage: pvm-linux-socket-long <bzImage> <debian-socket-long.erofs>".to_owned()
}
