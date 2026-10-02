//! Real loopback HTTP tests for data/control separation and scripted faults.

use std::{
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

use minisandbox_cos_emulator::{HistoryEvent, http::EmulatorServer, verify_history};
use serde_json::json;
use tempfile::TempDir;

const TOKEN: &str = "local-control-token-1234";
const BUCKET: &str = "test-1250000000";

#[test]
fn http_data_control_range_faults_and_history() {
    let directory = TempDir::new().expect("temporary directory");
    let server = EmulatorServer::start(
        directory.path(),
        "127.0.0.1:0".parse().expect("data address"),
        "127.0.0.1:0".parse().expect("control address"),
        TOKEN,
        2,
    )
    .expect("start emulator");
    let key_path = format!("/{BUCKET}/extent%2Fsha256%2Fabc");

    let put = send(
        server.data_addr(),
        "PUT",
        &key_path,
        &[("x-cos-emulator-access-path", "access-a")],
        b"abcdef",
    );
    assert_eq!(put.status, 200);
    assert!(put.headers.contains("x-cos-emulator-sha256"));

    let hidden = send(
        server.data_addr(),
        "HEAD",
        &key_path,
        &[("x-cos-emulator-access-path", "access-b")],
        b"",
    );
    assert_eq!(hidden.status, 404);

    let unauthorized = send(server.control_addr(), "GET", "/v1/history", &[], b"");
    assert_eq!(unauthorized.status, 401);

    let visibility = json!({
        "access_path": "access-b",
        "bucket": BUCKET,
        "key": "extent/sha256/abc",
        "visibility": "visible"
    });
    assert_eq!(
        control(server.control_addr(), "PUT", "/v1/visibility", &visibility).status,
        200
    );
    let range = send(
        server.data_addr(),
        "GET",
        &key_path,
        &[
            ("x-cos-emulator-access-path", "access-b"),
            ("range", "bytes=2-4"),
        ],
        b"",
    );
    assert_eq!(range.status, 206);
    assert_eq!(range.body, b"cde");
    assert!(range.headers.contains("content-range: bytes 2-4/6"));

    assert_scripted_gets(&server, &key_path);

    let history_response = control(
        server.control_addr(),
        "GET",
        "/v1/history",
        &serde_json::Value::Null,
    );
    assert_eq!(history_response.status, 200);
    let history: Vec<HistoryEvent> =
        serde_json::from_slice(&history_response.body).expect("history JSON");
    assert_eq!(history.len(), 6);
    verify_history(&history).expect("history invariants");
}

fn assert_scripted_gets(server: &EmulatorServer, key_path: &str) {
    let script = json!({
        "access_path": "access-b",
        "operation": "get",
        "bucket": BUCKET,
        "key": "extent/sha256/abc",
        "actions": [
            {"kind": "not_found"},
            {"kind": "corrupt"},
            {"kind": "normal"}
        ]
    });
    assert_eq!(
        control(server.control_addr(), "POST", "/v1/scripts", &script).status,
        200
    );
    assert_eq!(
        send(
            server.data_addr(),
            "GET",
            key_path,
            &[("x-cos-emulator-access-path", "access-b")],
            b""
        )
        .status,
        404
    );
    let corrupt = send(
        server.data_addr(),
        "GET",
        key_path,
        &[("x-cos-emulator-access-path", "access-b")],
        b"",
    );
    assert_eq!(corrupt.status, 200);
    assert_ne!(corrupt.body, b"abcdef");
    assert_eq!(
        send(
            server.data_addr(),
            "GET",
            key_path,
            &[("x-cos-emulator-access-path", "access-b")],
            b""
        )
        .body,
        b"abcdef"
    );
}

#[test]
fn timeout_after_apply_is_observable_over_http() {
    let directory = TempDir::new().expect("temporary directory");
    let server = EmulatorServer::start(
        directory.path(),
        "127.0.0.1:0".parse().expect("data address"),
        "127.0.0.1:0".parse().expect("control address"),
        TOKEN,
        2,
    )
    .expect("start emulator");
    let key_path = format!("/{BUCKET}/unknown-put");
    let script = json!({
        "access_path": "access-a",
        "operation": "put",
        "bucket": BUCKET,
        "key": "unknown-put",
        "actions": [{"kind": "timeout_after_apply", "delay_ms": 40}]
    });
    assert_eq!(
        control(server.control_addr(), "POST", "/v1/scripts", &script).status,
        200
    );
    let started = Instant::now();
    let timeout = send(
        server.data_addr(),
        "PUT",
        &key_path,
        &[("x-cos-emulator-access-path", "access-a")],
        b"committed",
    );
    assert_eq!(timeout.status, 504);
    assert!(started.elapsed() >= Duration::from_millis(25));
    assert_eq!(
        send(
            server.data_addr(),
            "GET",
            &key_path,
            &[("x-cos-emulator-access-path", "access-a")],
            b""
        )
        .body,
        b"committed"
    );
}

fn control(address: SocketAddr, method: &str, path: &str, body: &serde_json::Value) -> RawResponse {
    let bytes = if body.is_null() {
        Vec::new()
    } else {
        serde_json::to_vec(body).expect("control JSON")
    };
    send(
        address,
        method,
        path,
        &[
            ("x-cos-emulator-token", TOKEN),
            ("content-type", "application/json"),
        ],
        &bytes,
    )
}

#[derive(Debug)]
struct RawResponse {
    status: u16,
    headers: String,
    body: Vec<u8>,
}

fn send(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> RawResponse {
    let mut stream = TcpStream::connect(address).expect("connect HTTP");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("read timeout");
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    )
    .expect("request line");
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n").expect("request header");
    }
    stream.write_all(b"\r\n").expect("header end");
    stream.write_all(body).expect("request body");
    stream.shutdown(Shutdown::Write).expect("finish request");

    let mut response = Vec::new();
    stream.read_to_end(&mut response).expect("read response");
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("HTTP header terminator");
    let headers = String::from_utf8(response[..split].to_vec()).expect("ASCII headers");
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
        .expect("HTTP status");
    RawResponse {
        status,
        headers: headers.to_ascii_lowercase(),
        body: response[split + 4..].to_vec(),
    }
}
