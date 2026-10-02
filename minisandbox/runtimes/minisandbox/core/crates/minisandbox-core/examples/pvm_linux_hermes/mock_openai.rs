//! A bounded, deterministic `OpenAI` chat-completions peer for the Hermes PVM smoke test.

use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_REQUESTS_PER_CHAT: usize = 16;
const SERVER_TIMEOUT: Duration = Duration::from_mins(4);
const MODEL: &str = "minisandbox-e2e";
const PROMPT_MARKER: &[u8] = b"MINISANDBOX_HERMES_E2E_PROMPT";
pub const RESPONSE_MARKER: &[u8] = b"MINISANDBOX_HERMES_E2E_OK";

#[derive(Debug)]
pub struct MockReport {
    pub requests: usize,
    pub chat_requests: usize,
    pub first_chat_request: Option<Duration>,
}

pub struct MockOpenAiServer {
    port: u16,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<MockReport, String>>>,
}

impl MockOpenAiServer {
    pub fn start(expected_chats: usize) -> Result<Self, String> {
        if expected_chats == 0 {
            return Err("mock provider needs at least one expected chat".to_owned());
        }
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("cannot bind mock OpenAI provider: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("cannot inspect mock provider address: {error}"))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("cannot make mock provider nonblocking: {error}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = thread::spawn(move || serve(&listener, expected_chats, &worker_stop));
        Ok(Self {
            port,
            stop,
            worker: Some(worker),
        })
    }

    pub const fn port(&self) -> u16 {
        self.port
    }

    pub fn finish(mut self) -> Result<MockReport, String> {
        self.stop.store(true, Ordering::Release);
        self.worker
            .take()
            .expect("mock provider worker exists")
            .join()
            .map_err(|_| "mock OpenAI provider panicked".to_owned())?
    }
}

impl Drop for MockOpenAiServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn serve(
    listener: &TcpListener,
    expected_chats: usize,
    stop: &AtomicBool,
) -> Result<MockReport, String> {
    let started = Instant::now();
    let deadline = started + SERVER_TIMEOUT;
    let request_limit = expected_chats
        .checked_mul(MAX_REQUESTS_PER_CHAT)
        .and_then(|value| value.checked_add(MAX_REQUESTS_PER_CHAT))
        .ok_or_else(|| "mock provider request limit overflowed".to_owned())?;
    let mut report = MockReport {
        requests: 0,
        chat_requests: 0,
        first_chat_request: None,
    };
    while report.chat_requests < expected_chats {
        if stop.load(Ordering::Acquire) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "mock provider timed out after {} chats (expected {expected_chats})",
                report.chat_requests
            ));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                report.requests += 1;
                if report.requests > request_limit {
                    return Err(format!(
                        "mock provider exceeded its {request_limit}-request bound"
                    ));
                }
                let request = read_request(&mut stream)?;
                if request.method == "POST" && request.path == "/v1/chat/completions" {
                    if !contains(&request.body, PROMPT_MARKER)
                        || !contains(&request.body, MODEL.as_bytes())
                    {
                        respond_json(
                            &mut stream,
                            400,
                            br#"{"error":{"message":"missing deterministic prompt or model"}}"#,
                        )?;
                        return Err("Hermes sent an unexpected chat request".to_owned());
                    }
                    report
                        .first_chat_request
                        .get_or_insert_with(|| started.elapsed());
                    respond_chat_stream(&mut stream)?;
                    report.chat_requests += 1;
                } else if request.method == "GET"
                    && (request.path == "/v1/models"
                        || request.path == format!("/v1/models/{MODEL}"))
                {
                    respond_models(&mut stream, request.path.ends_with(MODEL))?;
                } else {
                    respond_json(&mut stream, 404, br#"{"error":{"message":"not found"}}"#)?;
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(format!("mock provider accept failed: {error}")),
        }
    }
    Ok(report)
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("cannot set mock provider read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| format!("cannot set mock provider write timeout: {error}"))?;
    let mut bytes = Vec::new();
    let mut scratch = [0_u8; 4096];
    let header_end = loop {
        let count = stream
            .read(&mut scratch)
            .map_err(|error| format!("cannot read mock provider request: {error}"))?;
        if count == 0 {
            return Err("mock provider request ended before its headers".to_owned());
        }
        bytes.extend_from_slice(&scratch[..count]);
        if let Some(offset) = find_bytes(&bytes, b"\r\n\r\n") {
            break offset + 4;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err("mock provider request headers exceeded 64 KiB".to_owned());
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| "mock provider request headers were not UTF-8".to_owned())?;
    let mut lines = header.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "mock provider request line was missing".to_owned())?;
    let mut request_parts = request_line.split_ascii_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "mock provider method was missing".to_owned())?
        .to_owned();
    let path = request_parts
        .next()
        .ok_or_else(|| "mock provider path was missing".to_owned())?
        .to_owned();
    if request_parts.next().is_none() || request_parts.next().is_some() {
        return Err("mock provider request line was malformed".to_owned());
    }
    let mut content_length = 0_usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value
                .trim()
                .parse::<usize>()
                .map_err(|_| "mock provider Content-Length was invalid".to_owned())?;
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err("mock provider request body exceeded 1 MiB".to_owned());
    }
    let total = header_end
        .checked_add(content_length)
        .ok_or_else(|| "mock provider request length overflowed".to_owned())?;
    while bytes.len() < total {
        let count = stream
            .read(&mut scratch)
            .map_err(|error| format!("cannot read mock provider body: {error}"))?;
        if count == 0 {
            return Err("mock provider request body was truncated".to_owned());
        }
        bytes.extend_from_slice(&scratch[..count]);
        if bytes.len() > total {
            return Err("mock provider request exceeded Content-Length".to_owned());
        }
    }
    Ok(Request {
        method,
        path: path.split('?').next().unwrap_or(&path).to_owned(),
        body: bytes[header_end..total].to_vec(),
    })
}

fn respond_models(stream: &mut TcpStream, single: bool) -> Result<(), String> {
    let body = if single {
        format!(
            r#"{{"id":"{MODEL}","object":"model","created":0,"owned_by":"minisandbox","context_length":131072}}"#
        )
    } else {
        format!(
            r#"{{"object":"list","data":[{{"id":"{MODEL}","object":"model","created":0,"owned_by":"minisandbox","context_length":131072}}]}}"#
        )
    };
    respond_json(stream, 200, body.as_bytes())
}

fn respond_chat_stream(stream: &mut TcpStream) -> Result<(), String> {
    let body = concat!(
        "data: {\"id\":\"chatcmpl-minisandbox\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"minisandbox-e2e\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"MINISANDBOX_HERMES_E2E_OK\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-minisandbox\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"minisandbox-e2e\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
    );
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    write_response(stream, header.as_bytes(), body.as_bytes())
}

fn respond_json(stream: &mut TcpStream, status: u16, body: &[u8]) -> Result<(), String> {
    let reason = if status == 200 {
        "OK"
    } else if status == 400 {
        "Bad Request"
    } else {
        "Not Found"
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    write_response(stream, header.as_bytes(), body)
}

fn write_response(stream: &mut TcpStream, header: &[u8], body: &[u8]) -> Result<(), String> {
    stream
        .write_all(header)
        .and_then(|()| stream.write_all(body))
        .and_then(|()| stream.flush())
        .map_err(|error| format!("cannot write mock provider response: {error}"))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find_bytes(haystack, needle).is_some()
}
