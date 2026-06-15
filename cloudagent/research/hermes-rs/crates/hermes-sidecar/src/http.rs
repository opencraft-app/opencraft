use anyhow::{bail, Context, Result};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use serde::Serialize;

use crate::protocol::{HttpRequest, HttpResponse, PromptResponseLine};

const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;

pub(crate) async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(position) = find_bytes(&buffer, b"\r\n\r\n") {
            break position;
        }
        let count = stream
            .read(&mut chunk)
            .await
            .context("failed to read HTTP request")?;
        if count == 0 {
            bail!("connection closed before HTTP headers");
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_HTTP_HEADER_BYTES {
            bail!(
                "HTTP request headers exceed {} bytes",
                MAX_HTTP_HEADER_BYTES
            );
        }
    };

    let header_text =
        std::str::from_utf8(&buffer[..header_end]).context("HTTP headers are not UTF-8")?;
    let mut lines = header_text.lines();
    let request_line = lines.next().context("missing HTTP request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().context("missing HTTP method")?.to_string();
    let path = parts.next().context("missing HTTP path")?.to_string();
    let mut content_length = 0usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().context("invalid Content-Length")?;
            }
        }
    }

    let body_start = header_end + 4;
    let mut body = buffer[body_start..].to_vec();
    while body.len() < content_length {
        let count = stream
            .read(&mut chunk)
            .await
            .context("failed to read HTTP request body")?;
        if count == 0 {
            bail!("connection closed before HTTP body completed");
        }
        body.extend_from_slice(&chunk[..count]);
    }
    body.truncate(content_length);

    Ok(HttpRequest { method, path, body })
}

pub(crate) async fn write_http_response(
    stream: &mut TcpStream,
    response: &HttpResponse,
) -> Result<()> {
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        status_text(response.status),
        response.content_type,
        response.body.len()
    );
    stream
        .write_all(header.as_bytes())
        .await
        .context("failed to write HTTP response headers")?;
    stream
        .write_all(&response.body)
        .await
        .context("failed to write HTTP response body")?;
    stream
        .flush()
        .await
        .context("failed to flush HTTP response")?;
    Ok(())
}

pub(crate) async fn write_streaming_prompt_headers(stream: &mut TcpStream) -> Result<()> {
    let header =
        "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n";
    stream
        .write_all(header.as_bytes())
        .await
        .context("failed to write prompt response headers")
}

pub(crate) async fn write_prompt_response_line(
    stream: &mut TcpStream,
    line: &PromptResponseLine,
) -> Result<()> {
    let serialized = serde_json::to_string(line).context("failed to serialize prompt response")?;
    stream
        .write_all(serialized.as_bytes())
        .await
        .context("failed to write prompt response line")?;
    stream
        .write_all(b"\n")
        .await
        .context("failed to write prompt response newline")?;
    stream
        .flush()
        .await
        .context("failed to flush prompt response line")
}

pub(crate) async fn write_json_line<T: Serialize>(stream: &mut TcpStream, line: &T) -> Result<()> {
    let serialized = serde_json::to_string(line).context("failed to serialize response line")?;
    stream
        .write_all(serialized.as_bytes())
        .await
        .context("failed to write response line")?;
    stream
        .write_all(b"\n")
        .await
        .context("failed to write response newline")?;
    stream
        .flush()
        .await
        .context("failed to flush response line")
}

pub(crate) fn prompt_response_lines_body(lines: &[PromptResponseLine]) -> Vec<u8> {
    let mut body = Vec::new();
    for line in lines {
        if let Ok(serialized) = serde_json::to_string(line) {
            body.extend_from_slice(serialized.as_bytes());
            body.push(b'\n');
        }
    }
    body
}

pub(crate) fn plain_response(status: u16, body: &str) -> HttpResponse {
    HttpResponse {
        status,
        content_type: "text/plain; charset=utf-8",
        body: body.as_bytes().to_vec(),
        shutdown_after_response: false,
    }
}

pub(crate) fn json_response(status: u16, body: Value) -> HttpResponse {
    HttpResponse {
        status,
        content_type: "application/json",
        body: body.to_string().into_bytes(),
        shutdown_after_response: false,
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}
