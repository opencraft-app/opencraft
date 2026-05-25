use std::io::{self, Write};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::protocol::{
    EnsureInnerRequest, PromptResponseLine, RuntimeAbortRequest, RuntimeInputBlock,
    RuntimeInputRequest, SessionCreateRequest, StageFilesManifest,
};
use crate::timeline;

const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub(crate) struct ClientArgs {
    pub(crate) addr: String,
    pub(crate) command: ClientCommand,
}

#[derive(Debug)]
pub(crate) enum ClientCommand {
    Health,
    HealthJson,
    SessionCreate {
        session_id: String,
        cwd_b64: Option<String>,
        agent_version: Option<String>,
        workspace_version: Option<String>,
    },
    SessionInput {
        session_id: String,
        input_id: Option<String>,
        inbox_mode: String,
        text_b64: String,
        cwd_b64: Option<String>,
    },
    SessionAbort {
        session_id: String,
        run_id: Option<String>,
        clear_pending: bool,
        reason: Option<String>,
    },
    SessionStatus,
    SessionTranscript,
    SessionRunLedger,
    StageFiles {
        manifest_b64: String,
    },
    EnsureInner {
        force: bool,
    },
    Shutdown,
}

pub(crate) async fn run_client(args: ClientArgs) -> Result<()> {
    timeline(
        "process_start",
        [("mode", "client".to_string()), ("addr", args.addr.clone())],
    );
    match args.command {
        ClientCommand::Health => {
            let response = http_request(&args.addr, "GET", "/health", None).await?;
            ensure_http_ok(&response, "/health")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::HealthJson => {
            let response = http_request(&args.addr, "GET", "/health-json", None).await?;
            ensure_http_ok(&response, "/health-json")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::SessionCreate {
            session_id,
            cwd_b64,
            agent_version,
            workspace_version,
        } => {
            let request = SessionCreateRequest {
                session_id,
                cwd: cwd_b64.as_deref().and_then(decode_inline_b64),
                agent_version,
                workspace_version,
            };
            let response =
                http_request_json(&args.addr, "POST", "/session/create", &request).await?;
            ensure_http_ok(&response, "/session/create")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::SessionInput {
            session_id,
            input_id,
            inbox_mode,
            text_b64,
            cwd_b64,
        } => {
            let request = RuntimeInputRequest {
                session_id,
                input_id,
                inbox_mode: Some(inbox_mode),
                blocks: vec![RuntimeInputBlock::Text {
                    text: decode_required_b64(&text_b64)
                        .context("failed to decode client session input text")?,
                }],
                cwd: cwd_b64.as_deref().and_then(decode_inline_b64),
            };
            stream_runtime_input_response_lines(&args.addr, &request).await?;
        }
        ClientCommand::SessionAbort {
            session_id,
            run_id,
            clear_pending,
            reason,
        } => {
            let request = RuntimeAbortRequest {
                session_id,
                run_id,
                clear_pending,
                reason,
            };
            let response =
                http_request_json(&args.addr, "POST", "/session/abort", &request).await?;
            ensure_http_ok(&response, "/session/abort")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::SessionStatus => {
            let response = http_request(&args.addr, "GET", "/session/status", None).await?;
            ensure_http_ok(&response, "/session/status")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::SessionTranscript => {
            let response = http_request(&args.addr, "GET", "/session/transcript", None).await?;
            ensure_http_ok(&response, "/session/transcript")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::SessionRunLedger => {
            let response = http_request(&args.addr, "GET", "/session/run-ledger", None).await?;
            ensure_http_ok(&response, "/session/run-ledger")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::StageFiles { manifest_b64 } => {
            let request: StageFilesManifest = decode_json_b64(&manifest_b64)
                .context("failed to decode client stage-files manifest")?;
            let response = http_request_json(&args.addr, "POST", "/stage-files", &request).await?;
            ensure_http_ok(&response, "/stage-files")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::EnsureInner { force } => {
            let response = http_request_json(
                &args.addr,
                "POST",
                "/ensure-inner",
                &EnsureInnerRequest { force },
            )
            .await?;
            ensure_http_ok(&response, "/ensure-inner")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::Shutdown => {
            let response =
                http_request(&args.addr, "POST", "/shutdown", Some("{}".to_string())).await?;
            ensure_http_ok(&response, "/shutdown")?;
            if !response.body.trim().is_empty() {
                let mut saw_result = false;
                for line in response.body.lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        print_prompt_response_line(line, &mut saw_result)?;
                    }
                }
            }
        }
    }
    timeline("process_done", [("mode", "client".to_string())]);
    Ok(())
}

pub(crate) fn parse_client_args(args: &[String]) -> Result<ClientArgs> {
    let mut addr = None;
    let mut subcommand = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--addr" => {
                addr = Some(take_flag_value(args, &mut index, "--addr")?);
            }
            "health" | "health-json" | "session-create" | "session-input" | "session-abort"
            | "session-status" | "session-transcript" | "session-run-ledger" | "stage-files"
            | "ensure-inner" | "shutdown" => {
                subcommand = Some((args[index].clone(), index + 1));
                break;
            }
            other => bail!("unexpected client argument '{}'", other),
        }
        index += 1;
    }

    let addr = addr.context("--addr is required for client")?;
    let (name, start) = subcommand.context("client subcommand is required")?;
    let command = match name.as_str() {
        "health" => ClientCommand::Health,
        "health-json" => ClientCommand::HealthJson,
        "shutdown" => ClientCommand::Shutdown,
        "session-create" => parse_client_session_create_args(&args[start..])?,
        "session-input" => parse_client_session_input_args(&args[start..])?,
        "session-abort" => parse_client_session_abort_args(&args[start..])?,
        "session-status" => ClientCommand::SessionStatus,
        "session-transcript" => ClientCommand::SessionTranscript,
        "session-run-ledger" => ClientCommand::SessionRunLedger,
        "ensure-inner" => parse_client_ensure_inner_args(&args[start..])?,
        "stage-files" => parse_client_stage_files_args(&args[start..])?,
        _ => unreachable!(),
    };

    Ok(ClientArgs { addr, command })
}

pub(crate) fn classify_error_code(message: &str) -> &'static str {
    let lowered = message.to_ascii_lowercase();
    if lowered.contains("max iterations exceeded") {
        return "max_iterations_exceeded";
    }
    if lowered.contains("prompt cancelled") {
        return "prompt_cancelled";
    }
    "agent_runtime_error"
}

async fn http_request(
    addr: &str,
    method: &str,
    path: &str,
    body: Option<String>,
) -> Result<ClientHttpResponse> {
    let authority = parse_http_authority(addr)?;
    let mut stream = TcpStream::connect(&authority)
        .await
        .with_context(|| format!("failed to connect to daemon '{}'", authority))?;
    let body = body.unwrap_or_default();
    let mut request = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
        method, path, authority
    );
    if !body.is_empty() {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    request.push_str(&body);

    stream
        .write_all(request.as_bytes())
        .await
        .context("failed to write daemon request")?;
    stream
        .flush()
        .await
        .context("failed to flush daemon request")?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .context("failed to read daemon response")?;
    parse_client_http_response(&raw)
}

async fn stream_runtime_input_response_lines(
    addr: &str,
    request: &RuntimeInputRequest,
) -> Result<()> {
    stream_response_lines(addr, "/session/input/stream", request).await
}

async fn stream_response_lines<T: Serialize>(addr: &str, path: &str, request: &T) -> Result<()> {
    let authority = parse_http_authority(addr)?;
    let mut stream = TcpStream::connect(&authority)
        .await
        .with_context(|| format!("failed to connect to daemon '{}'", authority))?;
    let body =
        serde_json::to_string(request).context("failed to serialize daemon streaming body")?;
    write_daemon_request(&mut stream, &authority, "POST", path, &body).await?;

    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(position) = find_bytes(&buffer, b"\r\n\r\n") {
            break position;
        }
        let count = stream
            .read(&mut chunk)
            .await
            .context("failed to read daemon prompt response headers")?;
        if count == 0 {
            bail!("unexpected EOF while reading daemon prompt response headers");
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_HTTP_HEADER_BYTES {
            bail!(
                "HTTP response headers exceed {} bytes",
                MAX_HTTP_HEADER_BYTES
            );
        }
    };

    let header_text = std::str::from_utf8(&buffer[..header_end])
        .context("HTTP response headers are not UTF-8")?;
    let status = parse_response_status(header_text)?;
    let body_offset = header_end + 4;
    let mut pending = buffer[body_offset..].to_vec();
    if status != 200 {
        stream
            .read_to_end(&mut pending)
            .await
            .context("failed to read daemon streaming error body")?;
        bail!(
            "daemon {} failed: HTTP {}: {}",
            path,
            status,
            String::from_utf8_lossy(&pending).trim()
        );
    }

    let mut saw_result = false;
    process_prompt_response_bytes(&mut pending, &mut saw_result)?;
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .context("failed to read daemon prompt response body")?;
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..count]);
        process_prompt_response_bytes(&mut pending, &mut saw_result)?;
    }
    if !pending.iter().all(|byte| byte.is_ascii_whitespace()) {
        let line = String::from_utf8(std::mem::take(&mut pending))
            .context("daemon prompt response line is not UTF-8")?;
        print_prompt_response_line(line.trim_end(), &mut saw_result)?;
    }
    if !saw_result {
        bail!("daemon streaming response did not include a result line");
    }
    Ok(())
}

async fn write_daemon_request(
    stream: &mut TcpStream,
    authority: &str,
    method: &str,
    path: &str,
    body: &str,
) -> Result<()> {
    let mut request = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
        method, path, authority
    );
    if !body.is_empty() {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    request.push_str(body);

    stream
        .write_all(request.as_bytes())
        .await
        .context("failed to write daemon request")?;
    stream
        .flush()
        .await
        .context("failed to flush daemon request")?;
    Ok(())
}

async fn http_request_json<T: Serialize>(
    addr: &str,
    method: &str,
    path: &str,
    body: &T,
) -> Result<ClientHttpResponse> {
    let serialized =
        serde_json::to_string(body).context("failed to serialize daemon request body")?;
    http_request(addr, method, path, Some(serialized)).await
}

#[derive(Debug)]
struct ClientHttpResponse {
    status: u16,
    body: String,
}

fn parse_client_http_response(raw: &[u8]) -> Result<ClientHttpResponse> {
    let header_end = find_bytes(raw, b"\r\n\r\n").context("invalid HTTP response")?;
    let header_text =
        std::str::from_utf8(&raw[..header_end]).context("HTTP response headers are not UTF-8")?;
    let status = parse_response_status(header_text)?;
    let body = String::from_utf8_lossy(&raw[header_end + 4..]).into_owned();
    Ok(ClientHttpResponse { status, body })
}

fn parse_response_status(header_text: &str) -> Result<u16> {
    let status_line = header_text
        .lines()
        .next()
        .context("missing HTTP response status line")?;
    let mut status_parts = status_line.split_whitespace();
    let _http_version = status_parts.next().context("missing HTTP version")?;
    status_parts
        .next()
        .context("missing HTTP status")?
        .parse::<u16>()
        .context("invalid HTTP status code")
}

fn ensure_http_ok(response: &ClientHttpResponse, path: &str) -> Result<()> {
    if response.status == 200 {
        return Ok(());
    }
    bail!(
        "daemon {} failed: HTTP {}: {}",
        path,
        response.status,
        response.body.trim()
    )
}

fn process_prompt_response_bytes(pending: &mut Vec<u8>, saw_result: &mut bool) -> Result<()> {
    while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
        let line_bytes: Vec<u8> = pending.drain(..=position).collect();
        let line = String::from_utf8(line_bytes).context("daemon prompt response is not UTF-8")?;
        let line = line.trim_end();
        if !line.trim().is_empty() {
            print_prompt_response_line(line, saw_result)?;
        }
    }
    Ok(())
}

fn print_prompt_response_line(line: &str, saw_result: &mut bool) -> Result<()> {
    match serde_json::from_str::<PromptResponseLine>(line)
        .with_context(|| format!("failed to parse daemon line '{}'", line))?
    {
        PromptResponseLine::OutputTextDelta { delta } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                json!({
                    "type": "output_text_delta",
                    "delta": delta,
                })
            )?;
            stdout.flush()?;
        }
        PromptResponseLine::ReasoningDelta { delta } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                json!({
                    "type": "reasoning_delta",
                    "delta": delta,
                })
            )?;
            stdout.flush()?;
        }
        PromptResponseLine::ToolCall {
            tool_call_id,
            name,
            status,
            raw_input,
        } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                json!({
                    "type": "tool_call",
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "status": status,
                    "raw_input": raw_input,
                })
            )?;
            stdout.flush()?;
        }
        PromptResponseLine::ToolCallUpdate {
            tool_call_id,
            name,
            status,
            error,
            raw_output,
            content,
        } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                json!({
                    "type": "tool_call_update",
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "status": status,
                    "error": error,
                    "raw_output": raw_output,
                    "content": content,
                })
            )?;
            stdout.flush()?;
        }
        PromptResponseLine::RuntimeHost {
            event,
            session_id,
            sandbox_id,
            workspace_root,
            template,
            error,
        } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                json!({
                    "type": "runtime_host",
                    "event": event,
                    "session_id": session_id,
                    "sandbox_id": sandbox_id,
                    "workspace_root": workspace_root,
                    "template": template,
                    "error": error,
                })
            )?;
            stdout.flush()?;
        }
        PromptResponseLine::Result {
            output_text,
            inner_sandbox_id,
            inner_sandbox_domain,
            inner_envd_access_token,
        } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_RESULT_JSON={}",
                json!({
                    "output_text": output_text,
                    "inner_sandbox_id": inner_sandbox_id,
                    "inner_sandbox_domain": inner_sandbox_domain,
                    "inner_envd_access_token": inner_envd_access_token,
                })
            )?;
            stdout.flush()?;
            *saw_result = true;
        }
        PromptResponseLine::Error { code, error } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_ERROR_JSON={}",
                json!({
                    "code": code.unwrap_or_else(|| classify_error_code(&error).to_string()),
                    "message": error,
                })
            )?;
            stdout.flush()?;
            *saw_result = true;
        }
    }
    Ok(())
}

fn parse_client_session_create_args(args: &[String]) -> Result<ClientCommand> {
    let mut session_id = None;
    let mut cwd_b64 = None;
    let mut agent_version = None;
    let mut workspace_version = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--session-id" => {
                session_id = Some(take_flag_value(args, &mut index, "--session-id")?);
            }
            "--cwd-b64" => {
                cwd_b64 = Some(take_flag_value(args, &mut index, "--cwd-b64")?);
            }
            "--agent-version" => {
                agent_version = Some(take_flag_value(args, &mut index, "--agent-version")?);
            }
            "--workspace-version" => {
                workspace_version = Some(take_flag_value(args, &mut index, "--workspace-version")?);
            }
            other => bail!("unexpected session-create argument '{}'", other),
        }
        index += 1;
    }

    Ok(ClientCommand::SessionCreate {
        session_id: session_id.context("--session-id is required for client session-create")?,
        cwd_b64,
        agent_version,
        workspace_version,
    })
}

fn parse_client_session_input_args(args: &[String]) -> Result<ClientCommand> {
    let mut session_id = None;
    let mut input_id = None;
    let mut inbox_mode = Some("prompt".to_string());
    let mut text_b64 = None;
    let mut cwd_b64 = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--session-id" => {
                session_id = Some(take_flag_value(args, &mut index, "--session-id")?);
            }
            "--input-id" => {
                input_id = Some(take_flag_value(args, &mut index, "--input-id")?);
            }
            "--inbox-mode" => {
                inbox_mode = Some(take_flag_value(args, &mut index, "--inbox-mode")?);
            }
            "--text-b64" => {
                text_b64 = Some(take_flag_value(args, &mut index, "--text-b64")?);
            }
            "--cwd-b64" => {
                cwd_b64 = Some(take_flag_value(args, &mut index, "--cwd-b64")?);
            }
            other => bail!("unexpected session-input argument '{}'", other),
        }
        index += 1;
    }

    Ok(ClientCommand::SessionInput {
        session_id: session_id.context("--session-id is required for client session-input")?,
        input_id,
        inbox_mode: inbox_mode.unwrap_or_else(|| "prompt".to_string()),
        text_b64: text_b64.context("--text-b64 is required for client session-input")?,
        cwd_b64,
    })
}

fn parse_client_session_abort_args(args: &[String]) -> Result<ClientCommand> {
    let mut session_id = None;
    let mut run_id = None;
    let mut clear_pending = false;
    let mut reason = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--session-id" => {
                session_id = Some(take_flag_value(args, &mut index, "--session-id")?);
            }
            "--run-id" => {
                run_id = Some(take_flag_value(args, &mut index, "--run-id")?);
            }
            "--clear-pending" => {
                clear_pending = true;
            }
            "--reason" => {
                reason = Some(take_flag_value(args, &mut index, "--reason")?);
            }
            other => bail!("unexpected session-abort argument '{}'", other),
        }
        index += 1;
    }

    Ok(ClientCommand::SessionAbort {
        session_id: session_id.context("--session-id is required for client session-abort")?,
        run_id,
        clear_pending,
        reason,
    })
}

fn parse_client_stage_files_args(args: &[String]) -> Result<ClientCommand> {
    let mut manifest_b64 = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--manifest-b64" => {
                manifest_b64 = Some(take_flag_value(args, &mut index, "--manifest-b64")?);
            }
            other => bail!("unexpected stage-files argument '{}'", other),
        }
        index += 1;
    }

    Ok(ClientCommand::StageFiles {
        manifest_b64: manifest_b64.context("--manifest-b64 is required for client stage-files")?,
    })
}

fn parse_client_ensure_inner_args(args: &[String]) -> Result<ClientCommand> {
    let mut force = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--force" => {
                force = true;
            }
            other => bail!("unexpected ensure-inner argument '{}'", other),
        }
        index += 1;
    }

    Ok(ClientCommand::EnsureInner { force })
}

fn take_flag_value(args: &[String], index: &mut usize, flag: &str) -> Result<String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .with_context(|| format!("missing value for {}", flag))
}

fn parse_http_authority(addr: &str) -> Result<String> {
    if let Some(rest) = addr.strip_prefix("http://") {
        if rest.contains('/') {
            bail!("client --addr must not include a path");
        }
        return Ok(rest.to_string());
    }
    if addr.starts_with("https://") {
        bail!("https:// is not supported for localhost daemon client");
    }
    Ok(addr.to_string())
}

fn decode_required_b64(raw: &str) -> Result<String> {
    let bytes = STANDARD
        .decode(raw)
        .context("failed to decode base64 input")?;
    String::from_utf8(bytes).context("base64 input was not valid UTF-8")
}

fn decode_inline_b64(raw: &str) -> Option<String> {
    decode_required_b64(raw)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn decode_json_b64<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T> {
    let decoded = decode_required_b64(raw)?;
    serde_json::from_str(&decoded).context("failed to parse decoded JSON")
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
