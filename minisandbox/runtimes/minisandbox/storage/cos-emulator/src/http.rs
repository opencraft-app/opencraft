//! Loopback-only HTTP data and control planes for the emulator core.

use std::{
    io::{self, Read},
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::Serialize;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::{
    ByteRange, CosEmulator, DataOperation, DataRequest, DataResponse, EmulatorError, ScriptRequest,
    VisibilityRequest, core::MAX_OBJECT_BYTES,
};

const ACCESS_PATH_HEADER: &str = "x-cos-emulator-access-path";
const CONTROL_TOKEN_HEADER: &str = "x-cos-emulator-token";
const MAX_CONTROL_BODY_BYTES: usize = 1024 * 1024;
const WORKER_POLL: Duration = Duration::from_millis(50);

/// Running loopback data/control HTTP service.
pub struct EmulatorServer {
    data_addr: SocketAddr,
    control_addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    data_server: Arc<Server>,
    control_server: Arc<Server>,
    workers: Vec<JoinHandle<()>>,
}

impl EmulatorServer {
    /// Starts separate loopback data and authenticated control listeners.
    ///
    /// Port zero selects an ephemeral port. The data plane uses path-style
    /// `/{bucket}/{key}` URLs. The control plane exposes `/v1/scripts`,
    /// `/v1/visibility`, `/v1/history`, and `/healthz`.
    ///
    /// # Errors
    ///
    /// Returns an error for non-loopback binds, invalid worker count, storage
    /// failure, or listener creation failure.
    pub fn start(
        root: impl Into<std::path::PathBuf>,
        data_bind: SocketAddr,
        control_bind: SocketAddr,
        control_token: impl Into<String>,
        data_workers: usize,
    ) -> Result<Self, EmulatorError> {
        validate_bind(data_bind)?;
        validate_bind(control_bind)?;
        if data_workers == 0 || data_workers > 64 {
            return Err(EmulatorError::InvalidArgument("invalid data worker count"));
        }
        let control_token = control_token.into();
        if control_token.len() < 16 || control_token.len() > 256 || !control_token.is_ascii() {
            return Err(EmulatorError::InvalidArgument("invalid control token"));
        }
        let core = Arc::new(Mutex::new(CosEmulator::open(root)?));
        let data_server = Arc::new(http_server(data_bind)?);
        let control_server = Arc::new(http_server(control_bind)?);
        let data_addr = data_server
            .server_addr()
            .to_ip()
            .ok_or(EmulatorError::InvalidArgument("data listener is not IP"))?;
        let control_addr = control_server
            .server_addr()
            .to_ip()
            .ok_or(EmulatorError::InvalidArgument("control listener is not IP"))?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let mut workers = Vec::with_capacity(data_workers + 1);
        for index in 0..data_workers {
            let worker_server = Arc::clone(&data_server);
            let worker_core = Arc::clone(&core);
            let worker_shutdown = Arc::clone(&shutdown);
            workers.push(
                thread::Builder::new()
                    .name(format!("cos-emulator-data-{index}"))
                    .spawn(move || data_worker(&worker_server, &worker_core, &worker_shutdown))
                    .map_err(EmulatorError::Io)?,
            );
        }
        let worker_server = Arc::clone(&control_server);
        let worker_core = core;
        let worker_shutdown = Arc::clone(&shutdown);
        workers.push(
            thread::Builder::new()
                .name("cos-emulator-control".to_owned())
                .spawn(move || {
                    control_worker(
                        &worker_server,
                        &worker_core,
                        &worker_shutdown,
                        &control_token,
                    );
                })
                .map_err(EmulatorError::Io)?,
        );
        Ok(Self {
            data_addr,
            control_addr,
            shutdown,
            data_server,
            control_server,
            workers,
        })
    }

    /// Actual data-plane address, including an assigned ephemeral port.
    #[must_use]
    pub const fn data_addr(&self) -> SocketAddr {
        self.data_addr
    }

    /// Actual control-plane address, including an assigned ephemeral port.
    #[must_use]
    pub const fn control_addr(&self) -> SocketAddr {
        self.control_addr
    }
}

impl Drop for EmulatorServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        for _ in 0..self.workers.len() {
            self.data_server.unblock();
            self.control_server.unblock();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn validate_bind(address: SocketAddr) -> Result<(), EmulatorError> {
    if !address.ip().is_loopback() {
        return Err(EmulatorError::InvalidArgument("listener must be loopback"));
    }
    Ok(())
}

fn http_server(address: SocketAddr) -> Result<Server, EmulatorError> {
    Server::http(address).map_err(|error| EmulatorError::Io(io::Error::other(error.to_string())))
}

fn data_worker(server: &Server, core: &Mutex<CosEmulator>, shutdown: &AtomicBool) {
    while !shutdown.load(Ordering::Acquire) {
        match server.recv_timeout(WORKER_POLL) {
            Ok(Some(request)) => handle_data(request, core),
            Err(_) if shutdown.load(Ordering::Acquire) => break,
            Ok(None) | Err(_) => {}
        }
    }
}

fn control_worker(server: &Server, core: &Mutex<CosEmulator>, shutdown: &AtomicBool, token: &str) {
    while !shutdown.load(Ordering::Acquire) {
        match server.recv_timeout(WORKER_POLL) {
            Ok(Some(request)) => handle_control(request, core, token),
            Err(_) if shutdown.load(Ordering::Acquire) => break,
            Ok(None) | Err(_) => {}
        }
    }
}

fn handle_data(mut request: Request, core: &Mutex<CosEmulator>) {
    let prepared = (|| -> Result<DataResponse, HttpInputError> {
        let operation = method_to_operation(request.method())?;
        let (bucket, key) = parse_object_path(request.url())?;
        let access_path = header_value(&request, ACCESS_PATH_HEADER)
            .unwrap_or("default")
            .to_owned();
        let range = header_value(&request, "range")
            .map(parse_range)
            .transpose()?;
        let body = if operation == DataOperation::Put {
            read_bounded(request.as_reader(), MAX_OBJECT_BYTES)?
        } else {
            Vec::new()
        };
        core.lock()
            .map_err(|_| HttpInputError::Internal)?
            .execute(DataRequest {
                operation,
                bucket,
                key,
                access_path,
                body,
                range,
            })
            .map_err(HttpInputError::Core)
    })();
    match prepared {
        Ok(response) => {
            if response.delay_ms > 0 {
                thread::sleep(Duration::from_millis(response.delay_ms));
            }
            respond_data(request, response);
        }
        Err(error) => respond_error(request, error.status(), error.message()),
    }
}

fn handle_control(mut request: Request, core: &Mutex<CosEmulator>, token: &str) {
    if header_value(&request, CONTROL_TOKEN_HEADER) != Some(token) {
        respond_error(request, 401, "unauthorized");
        return;
    }
    let method = request.method().clone();
    let path = request
        .url()
        .split('?')
        .next()
        .unwrap_or(request.url())
        .to_owned();
    let response = match (method, path.as_str()) {
        (Method::Get, "/healthz") => Ok(json_response(200, &serde_json::json!({"ok": true}))),
        (Method::Post, "/v1/scripts") => {
            control_json::<ScriptRequest>(&mut request).and_then(|body| {
                core.lock()
                    .map_err(|_| HttpInputError::Internal)?
                    .enqueue_script(body)
                    .map_err(HttpInputError::Core)?;
                Ok(json_response(200, &serde_json::json!({"ok": true})))
            })
        }
        (Method::Put, "/v1/visibility") => control_json::<VisibilityRequest>(&mut request)
            .and_then(|body| {
                core.lock()
                    .map_err(|_| HttpInputError::Internal)?
                    .set_visibility(body)
                    .map_err(HttpInputError::Core)?;
                Ok(json_response(200, &serde_json::json!({"ok": true})))
            }),
        (Method::Get, "/v1/history") => core
            .lock()
            .map(|core| json_response(200, core.history()))
            .map_err(|_| HttpInputError::Internal),
        _ => Err(HttpInputError::NotFound),
    };
    match response {
        Ok(response) => {
            let _ = request.respond(response);
        }
        Err(error) => respond_error(request, error.status(), error.message()),
    }
}

fn method_to_operation(method: &Method) -> Result<DataOperation, HttpInputError> {
    match method {
        Method::Put => Ok(DataOperation::Put),
        Method::Head => Ok(DataOperation::Head),
        Method::Get => Ok(DataOperation::Get),
        Method::Delete => Ok(DataOperation::Delete),
        _ => Err(HttpInputError::MethodNotAllowed),
    }
}

fn parse_object_path(url: &str) -> Result<(String, String), HttpInputError> {
    let path = url.split('?').next().unwrap_or(url);
    let stripped = path.strip_prefix('/').ok_or(HttpInputError::BadRequest)?;
    let (bucket, key) = stripped.split_once('/').ok_or(HttpInputError::BadRequest)?;
    let bucket = percent_decode(bucket)?;
    let key = percent_decode(key)?;
    if bucket.is_empty() || key.is_empty() {
        return Err(HttpInputError::BadRequest);
    }
    Ok((bucket, key))
}

fn percent_decode(value: &str) -> Result<String, HttpInputError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(HttpInputError::BadRequest);
            }
            let high = decode_hex(bytes[index + 1]).ok_or(HttpInputError::BadRequest)?;
            let low = decode_hex(bytes[index + 2]).ok_or(HttpInputError::BadRequest)?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| HttpInputError::BadRequest)
}

const fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn parse_range(value: &str) -> Result<ByteRange, HttpInputError> {
    let value = value
        .strip_prefix("bytes=")
        .ok_or(HttpInputError::BadRange)?;
    if value.contains(',') {
        return Err(HttpInputError::BadRange);
    }
    let (start, end) = value.split_once('-').ok_or(HttpInputError::BadRange)?;
    match (start.is_empty(), end.is_empty()) {
        (false, false) => Ok(ByteRange::Inclusive {
            start: start.parse().map_err(|_| HttpInputError::BadRange)?,
            end: end.parse().map_err(|_| HttpInputError::BadRange)?,
        }),
        (false, true) => Ok(ByteRange::From {
            start: start.parse().map_err(|_| HttpInputError::BadRange)?,
        }),
        (true, false) => Ok(ByteRange::Suffix {
            length: end.parse().map_err(|_| HttpInputError::BadRange)?,
        }),
        (true, true) => Err(HttpInputError::BadRange),
    }
}

fn header_value<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

fn read_bounded(reader: &mut dyn Read, limit: usize) -> Result<Vec<u8>, HttpInputError> {
    let bounded = u64::try_from(limit).map_err(|_| HttpInputError::Internal)? + 1;
    let mut body = Vec::new();
    reader
        .take(bounded)
        .read_to_end(&mut body)
        .map_err(|_| HttpInputError::BadRequest)?;
    if body.len() > limit {
        return Err(HttpInputError::PayloadTooLarge);
    }
    Ok(body)
}

fn control_json<T: serde::de::DeserializeOwned>(
    request: &mut Request,
) -> Result<T, HttpInputError> {
    let bytes = read_bounded(request.as_reader(), MAX_CONTROL_BODY_BYTES)?;
    serde_json::from_slice(&bytes).map_err(|_| HttpInputError::BadRequest)
}

fn respond_data(request: Request, response: DataResponse) {
    let mut http_response = Response::from_data(response.body).with_status_code(response.status);
    for (name, value) in response.headers {
        if let Ok(header) = Header::from_bytes(name, value) {
            http_response.add_header(header);
        }
    }
    let _ = request.respond(http_response);
}

fn json_response<T: Serialize + ?Sized>(
    status: u16,
    value: &T,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(value)
        .unwrap_or_else(|_| b"{\"error\":\"serialization failed\"}".to_vec());
    Response::from_data(bytes)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("content-type", "application/json").expect("static header"))
}

fn respond_error(request: Request, status: u16, message: &str) {
    let response = json_response(status, &serde_json::json!({"error": message}));
    let _ = request.respond(response);
}

#[derive(Debug)]
enum HttpInputError {
    BadRequest,
    BadRange,
    PayloadTooLarge,
    MethodNotAllowed,
    NotFound,
    Internal,
    Core(EmulatorError),
}

impl HttpInputError {
    const fn status(&self) -> u16 {
        match self {
            Self::BadRequest | Self::Core(EmulatorError::InvalidArgument(_)) => 400,
            Self::BadRange => 416,
            Self::PayloadTooLarge => 413,
            Self::MethodNotAllowed => 405,
            Self::NotFound => 404,
            Self::Internal => 500,
            Self::Core(EmulatorError::ImmutableConflict) => 409,
            Self::Core(
                EmulatorError::Io(_) | EmulatorError::CorruptState | EmulatorError::AlreadyOpen,
            ) => 503,
        }
    }

    const fn message(&self) -> &'static str {
        match self {
            Self::BadRequest => "bad request",
            Self::BadRange => "invalid range",
            Self::PayloadTooLarge => "payload too large",
            Self::MethodNotAllowed => "method not allowed",
            Self::NotFound => "not found",
            Self::Internal => "internal emulator error",
            Self::Core(error) => match error {
                EmulatorError::InvalidArgument(_) => "invalid emulator request",
                EmulatorError::ImmutableConflict => "immutable key conflict",
                EmulatorError::Io(_) | EmulatorError::CorruptState | EmulatorError::AlreadyOpen => {
                    "emulator unavailable"
                }
            },
        }
    }
}
