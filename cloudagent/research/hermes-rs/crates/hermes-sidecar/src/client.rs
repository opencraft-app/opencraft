use std::io::{self, Write};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::protocol::{
    EnsureInnerRequest, PromptResponseLine, RuntimeAbortRequest, RuntimeInputBlock,
    RuntimeInputRequest, RuntimeRunEventRecord, RuntimeRunEventsResponse, RuntimeRunResultResponse,
    RuntimeRunSubmitRequest, SessionCreateRequest, StageFilesManifest, WorkspaceBindRequest,
    WorkspaceFileDownloadRequest, WorkspaceFileUploadRequest,
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
        history_b64: Option<String>,
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
    RunSubmit {
        session_id: String,
        run_id: String,
        inbox_mode: String,
        text_b64: String,
        cwd_b64: Option<String>,
        history_b64: Option<String>,
    },
    RunEvents {
        run_id: String,
        after_seq: u64,
        stream: bool,
    },
    RunStatus {
        run_id: String,
    },
    RunResult {
        run_id: String,
    },
    RunCancel {
        session_id: String,
        run_id: String,
    },
    StageFiles {
        manifest_b64: String,
    },
    WorkspaceFileUpload {
        path_b64: String,
        content: WorkspaceFileUploadContent,
    },
    WorkspaceFileDownload {
        path_b64: String,
    },
    WorkspaceBind {
        request_b64: String,
    },
    EnsureInner {
        force: bool,
    },
    ShutdownInner,
    Shutdown,
}

#[derive(Debug)]
pub(crate) enum WorkspaceFileUploadContent {
    InlineB64(String),
    FileB64(String),
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
            history_b64,
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
                history: history_b64
                    .as_deref()
                    .map(decode_json_b64)
                    .transpose()
                    .context("failed to decode client session input history")?
                    .unwrap_or_default(),
            };
            stream_runtime_input_response_lines(&args.addr, &request, request.input_id.as_deref())
                .await?;
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
        ClientCommand::RunSubmit {
            session_id,
            run_id,
            inbox_mode,
            text_b64,
            cwd_b64,
            history_b64,
        } => {
            let request = RuntimeRunSubmitRequest {
                session_id,
                run_id,
                inbox_mode: Some(inbox_mode),
                blocks: vec![RuntimeInputBlock::Text {
                    text: decode_required_b64(&text_b64)
                        .context("failed to decode client run submit text")?,
                }],
                cwd: cwd_b64.as_deref().and_then(decode_inline_b64),
                history: history_b64
                    .as_deref()
                    .map(decode_json_b64)
                    .transpose()
                    .context("failed to decode client run submit history")?
                    .unwrap_or_default(),
            };
            let response = http_request_json(&args.addr, "POST", "/runs", &request).await?;
            ensure_http_ok(&response, "/runs")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::RunEvents {
            run_id,
            after_seq,
            stream,
        } => {
            stream_runtime_run_events(&args.addr, &run_id, after_seq, stream).await?;
        }
        ClientCommand::RunStatus { run_id } => {
            let path = format!("/runs/{}", run_id);
            let response = http_request(&args.addr, "GET", &path, None).await?;
            ensure_http_ok(&response, &path)?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::RunResult { run_id } => {
            let path = format!("/runs/{}/result", run_id);
            let response = http_request(&args.addr, "GET", &path, None).await?;
            ensure_http_ok(&response, &path)?;
            let result: RuntimeRunResultResponse = serde_json::from_str(&response.body)
                .context("failed to decode run result response")?;
            print_run_result_response(result)?;
        }
        ClientCommand::RunCancel { session_id, run_id } => {
            let request = RuntimeAbortRequest {
                session_id,
                run_id: Some(run_id.clone()),
                clear_pending: false,
                reason: Some("run cancel".to_string()),
            };
            let response = http_request_json(
                &args.addr,
                "POST",
                &format!("/runs/{}/cancel", run_id),
                &request,
            )
            .await?;
            ensure_http_ok(&response, "/runs/{run_id}/cancel")?;
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
        ClientCommand::WorkspaceFileUpload { path_b64, content } => {
            let content_b64 = match content {
                WorkspaceFileUploadContent::InlineB64(value) => value,
                WorkspaceFileUploadContent::FileB64(path_b64) => {
                    let path = decode_required_b64(&path_b64)
                        .context("failed to decode workspace file upload content path")?;
                    let bytes = tokio::fs::read(&path).await.with_context(|| {
                        format!("failed to read workspace upload content file {}", path)
                    })?;
                    STANDARD.encode(bytes)
                }
            };
            let request = WorkspaceFileUploadRequest {
                path: decode_required_b64(&path_b64)
                    .context("failed to decode workspace file path")?,
                content_b64,
            };
            let response =
                http_request_json(&args.addr, "POST", "/workspace/file-upload", &request).await?;
            ensure_http_ok(&response, "/workspace/file-upload")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::WorkspaceFileDownload { path_b64 } => {
            let request = WorkspaceFileDownloadRequest {
                path: decode_required_b64(&path_b64)
                    .context("failed to decode workspace file path")?,
            };
            let response =
                http_request_json(&args.addr, "POST", "/workspace/file-download", &request).await?;
            ensure_http_ok(&response, "/workspace/file-download")?;
            if !response.body.trim().is_empty() {
                println!("{}", response.body.trim());
            }
        }
        ClientCommand::WorkspaceBind { request_b64 } => {
            let request: WorkspaceBindRequest = decode_json_b64(&request_b64)
                .context("failed to decode client workspace-bind request")?;
            let response =
                http_request_json(&args.addr, "POST", "/workspace/bind", &request).await?;
            ensure_http_ok(&response, "/workspace/bind")?;
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
        ClientCommand::ShutdownInner => {
            let response = http_request(
                &args.addr,
                "POST",
                "/shutdown-inner",
                Some("{}".to_string()),
            )
            .await?;
            ensure_http_ok(&response, "/shutdown-inner")?;
            if !response.body.trim().is_empty() {
                let mut saw_result = false;
                for line in response.body.lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        print_prompt_response_line(line, &mut saw_result, None)?;
                    }
                }
                if !saw_result {
                    println!("{}", response.body.trim());
                }
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
                        print_prompt_response_line(line, &mut saw_result, None)?;
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
            "health"
            | "health-json"
            | "session-create"
            | "session-input"
            | "session-abort"
            | "session-status"
            | "session-transcript"
            | "session-run-ledger"
            | "run-submit"
            | "run-events"
            | "run-status"
            | "run-result"
            | "run-cancel"
            | "stage-files"
            | "workspace-file-upload"
            | "workspace-file-download"
            | "workspace-bind"
            | "ensure-inner"
            | "shutdown-inner"
            | "shutdown" => {
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
        "shutdown-inner" => ClientCommand::ShutdownInner,
        "session-create" => parse_client_session_create_args(&args[start..])?,
        "session-input" => parse_client_session_input_args(&args[start..])?,
        "session-abort" => parse_client_session_abort_args(&args[start..])?,
        "session-status" => ClientCommand::SessionStatus,
        "session-transcript" => ClientCommand::SessionTranscript,
        "session-run-ledger" => ClientCommand::SessionRunLedger,
        "run-submit" => parse_client_run_submit_args(&args[start..])?,
        "run-events" => parse_client_run_events_args(&args[start..])?,
        "run-status" => parse_client_run_status_args(&args[start..])?,
        "run-result" => parse_client_run_result_args(&args[start..])?,
        "run-cancel" => parse_client_run_cancel_args(&args[start..])?,
        "workspace-bind" => parse_client_workspace_bind_args(&args[start..])?,
        "workspace-file-upload" => parse_client_workspace_file_upload_args(&args[start..])?,
        "workspace-file-download" => parse_client_workspace_file_download_args(&args[start..])?,
        "ensure-inner" => parse_client_ensure_inner_args(&args[start..])?,
        "stage-files" => parse_client_stage_files_args(&args[start..])?,
        _ => unreachable!(),
    };

    Ok(ClientArgs { addr, command })
}

fn parse_client_workspace_file_upload_args(args: &[String]) -> Result<ClientCommand> {
    let mut path_b64 = None;
    let mut content_b64 = None;
    let mut content_file_b64 = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--path-b64" => {
                path_b64 = Some(take_flag_value(args, &mut index, "--path-b64")?);
            }
            "--content-b64" => {
                content_b64 = Some(take_flag_value(args, &mut index, "--content-b64")?);
            }
            "--content-file-b64" => {
                content_file_b64 = Some(take_flag_value(args, &mut index, "--content-file-b64")?);
            }
            other => bail!("unexpected workspace-file-upload argument '{}'", other),
        }
        index += 1;
    }
    if content_b64.is_some() && content_file_b64.is_some() {
        bail!(
            "client workspace-file-upload accepts only one of --content-b64 or --content-file-b64"
        );
    }
    let content = match (content_b64, content_file_b64) {
        (Some(value), None) => WorkspaceFileUploadContent::InlineB64(value),
        (None, Some(value)) => WorkspaceFileUploadContent::FileB64(value),
        (None, None) => bail!(
            "one of --content-b64 or --content-file-b64 is required for client workspace-file-upload"
        ),
        (Some(_), Some(_)) => unreachable!(),
    };
    Ok(ClientCommand::WorkspaceFileUpload {
        path_b64: path_b64.context("--path-b64 is required for client workspace-file-upload")?,
        content,
    })
}

fn parse_client_workspace_file_download_args(args: &[String]) -> Result<ClientCommand> {
    let mut path_b64 = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--path-b64" => {
                path_b64 = Some(take_flag_value(args, &mut index, "--path-b64")?);
            }
            other => bail!("unexpected workspace-file-download argument '{}'", other),
        }
        index += 1;
    }
    Ok(ClientCommand::WorkspaceFileDownload {
        path_b64: path_b64.context("--path-b64 is required for client workspace-file-download")?,
    })
}

fn parse_client_workspace_bind_args(args: &[String]) -> Result<ClientCommand> {
    let mut request_b64 = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--request-b64" => {
                request_b64 = Some(take_flag_value(args, &mut index, "--request-b64")?);
            }
            other => bail!("unexpected workspace-bind argument '{}'", other),
        }
        index += 1;
    }
    Ok(ClientCommand::WorkspaceBind {
        request_b64: request_b64.context("--request-b64 is required")?,
    })
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
    input_id: Option<&str>,
) -> Result<()> {
    stream_response_lines(addr, "/session/input/stream", request, input_id).await
}

async fn stream_runtime_run_events(
    addr: &str,
    run_id: &str,
    after_seq: u64,
    stream_events: bool,
) -> Result<()> {
    let mut path = format!("/runs/{}/events?after_seq={}", run_id, after_seq);
    if stream_events {
        path.push_str("&stream=true");
    } else {
        let response = http_request(addr, "GET", &path, None).await?;
        ensure_http_ok(&response, &path)?;
        let events: RuntimeRunEventsResponse =
            serde_json::from_str(&response.body).context("failed to decode run events response")?;
        let mut saw_terminal = false;
        for event in events.events {
            print_prompt_response_line_with_seq(
                &event.line,
                Some(event.seq),
                None,
                &mut saw_terminal,
            )?;
        }
        return Ok(());
    }
    let authority = parse_http_authority(addr)?;
    let mut stream = TcpStream::connect(&authority)
        .await
        .with_context(|| format!("failed to connect to daemon '{}'", authority))?;
    write_daemon_request(&mut stream, &authority, "GET", &path, "").await?;

    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(position) = find_bytes(&buffer, b"\r\n\r\n") {
            break position;
        }
        let count = stream
            .read(&mut chunk)
            .await
            .context("failed to read daemon run events response headers")?;
        if count == 0 {
            bail!("unexpected EOF while reading daemon run events response headers");
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
            .context("failed to read daemon run events error body")?;
        bail!(
            "daemon {} failed: HTTP {}: {}",
            path,
            status,
            String::from_utf8_lossy(&pending).trim()
        );
    }

    let mut saw_terminal = false;
    process_run_event_record_bytes(&mut pending, &mut saw_terminal)?;
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .context("failed to read daemon run events body")?;
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..count]);
        process_run_event_record_bytes(&mut pending, &mut saw_terminal)?;
    }
    if !pending.iter().all(|byte| byte.is_ascii_whitespace()) {
        let line = String::from_utf8(std::mem::take(&mut pending))
            .context("daemon run event line is not UTF-8")?;
        print_run_event_record(line.trim_end(), &mut saw_terminal)?;
    }
    if stream_events && !saw_terminal {
        bail!("daemon run event stream ended before a terminal event")
    }
    Ok(())
}

async fn stream_response_lines<T: Serialize>(
    addr: &str,
    path: &str,
    request: &T,
    input_id: Option<&str>,
) -> Result<()> {
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
    process_prompt_response_bytes(&mut pending, &mut saw_result, input_id)?;
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .context("failed to read daemon prompt response body")?;
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..count]);
        process_prompt_response_bytes(&mut pending, &mut saw_result, input_id)?;
    }
    if !pending.iter().all(|byte| byte.is_ascii_whitespace()) {
        let line = String::from_utf8(std::mem::take(&mut pending))
            .context("daemon prompt response line is not UTF-8")?;
        print_prompt_response_line(line.trim_end(), &mut saw_result, input_id)?;
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

fn process_prompt_response_bytes(
    pending: &mut Vec<u8>,
    saw_result: &mut bool,
    input_id: Option<&str>,
) -> Result<()> {
    while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
        let line_bytes: Vec<u8> = pending.drain(..=position).collect();
        let line = String::from_utf8(line_bytes).context("daemon prompt response is not UTF-8")?;
        let line = line.trim_end();
        if !line.trim().is_empty() {
            print_prompt_response_line(line, saw_result, input_id)?;
        }
    }
    Ok(())
}

fn process_run_event_record_bytes(pending: &mut Vec<u8>, saw_terminal: &mut bool) -> Result<()> {
    while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
        let line_bytes: Vec<u8> = pending.drain(..=position).collect();
        let line = String::from_utf8(line_bytes).context("daemon run event line is not UTF-8")?;
        let line = line.trim_end();
        if !line.trim().is_empty() {
            print_run_event_record(line, saw_terminal)?;
        }
    }
    Ok(())
}

fn print_run_event_record(line: &str, saw_terminal: &mut bool) -> Result<()> {
    let record: RuntimeRunEventRecord = serde_json::from_str(line)
        .with_context(|| format!("failed to parse daemon run event '{}'", line))?;
    print_prompt_response_line_with_seq(&record.line, Some(record.seq), None, saw_terminal)
}

fn print_prompt_response_line(
    line: &str,
    saw_result: &mut bool,
    input_id: Option<&str>,
) -> Result<()> {
    let parsed = serde_json::from_str::<PromptResponseLine>(line)
        .with_context(|| format!("failed to parse daemon line '{}'", line))?;
    print_prompt_response_line_with_seq(&parsed, None, input_id, saw_result)
}

fn print_prompt_response_line_with_seq(
    line: &PromptResponseLine,
    run_seq: Option<u64>,
    input_id: Option<&str>,
    saw_result: &mut bool,
) -> Result<()> {
    match line {
        PromptResponseLine::OutputTextDelta { delta } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                wrapper_json_with_seq(
                    json!({
                    "type": "output_text_delta",
                    "input_id": input_id,
                    "delta": delta,
                    }),
                    run_seq,
                )
            )?;
            stdout.flush()?;
        }
        PromptResponseLine::ReasoningDelta { delta } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                wrapper_json_with_seq(
                    json!({
                    "type": "reasoning_delta",
                    "input_id": input_id,
                    "delta": delta,
                    }),
                    run_seq,
                )
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
                wrapper_json_with_seq(
                    json!({
                    "type": "tool_call",
                    "input_id": input_id,
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "status": status,
                    "raw_input": raw_input,
                    }),
                    run_seq,
                )
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
                wrapper_json_with_seq(
                    json!({
                    "type": "tool_call_update",
                    "input_id": input_id,
                    "tool_call_id": tool_call_id,
                    "name": name,
                    "status": status,
                    "error": error,
                    "raw_output": raw_output,
                    "content": content,
                    }),
                    run_seq,
                )
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
            exit_code,
            stdout_bytes,
            stderr_bytes,
            stdout_tail,
            stderr_tail,
        } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_EVENT_JSON={}",
                wrapper_json_with_seq(
                    json!({
                    "type": "runtime_host",
                    "input_id": input_id,
                    "event": event,
                    "session_id": session_id,
                    "sandbox_id": sandbox_id,
                    "workspace_root": workspace_root,
                    "template": template,
                    "error": error,
                    "exit_code": exit_code,
                    "stdout_bytes": stdout_bytes,
                    "stderr_bytes": stderr_bytes,
                    "stdout_tail": stdout_tail,
                    "stderr_tail": stderr_tail,
                    }),
                    run_seq,
                )
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
                wrapper_json_with_seq(
                    json!({
                    "input_id": input_id,
                    "output_text": output_text,
                    "inner_sandbox_id": inner_sandbox_id,
                    "inner_sandbox_domain": inner_sandbox_domain,
                    "inner_envd_access_token": inner_envd_access_token,
                    }),
                    run_seq,
                )
            )?;
            stdout.flush()?;
            *saw_result = true;
        }
        PromptResponseLine::Error { code, error } => {
            let mut stdout = io::stdout().lock();
            writeln!(
                stdout,
                "WRAPPER_ERROR_JSON={}",
                wrapper_json_with_seq(
                    json!({
                    "input_id": input_id,
                    "code": code
                        .clone()
                        .unwrap_or_else(|| classify_error_code(error).to_string()),
                    "message": error,
                    }),
                    run_seq,
                )
            )?;
            stdout.flush()?;
            *saw_result = true;
        }
    }
    Ok(())
}

fn print_run_result_response(result: RuntimeRunResultResponse) -> Result<()> {
    let mut stdout = io::stdout().lock();
    if let Some(error) = result.error {
        writeln!(
            stdout,
            "WRAPPER_ERROR_JSON={}",
            json!({
                "code": classify_error_code(&error),
                "message": error,
            })
        )?;
    } else {
        writeln!(
            stdout,
            "WRAPPER_RESULT_JSON={}",
            json!({
                "output_text": result.output_text.unwrap_or_default(),
                "inner_sandbox_id": result.inner_sandbox_id,
                "inner_sandbox_domain": result.inner_sandbox_domain,
                "inner_envd_access_token": null,
            })
        )?;
    }
    stdout.flush()?;
    Ok(())
}

fn wrapper_json_with_seq(mut value: serde_json::Value, run_seq: Option<u64>) -> serde_json::Value {
    if let Some(seq) = run_seq {
        if let Some(object) = value.as_object_mut() {
            object.insert("run_seq".to_string(), json!(seq));
        }
    }
    value
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
    let mut history_b64 = None;
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
            "--history-b64" => {
                history_b64 = Some(take_flag_value(args, &mut index, "--history-b64")?);
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
        history_b64,
    })
}

fn parse_client_run_submit_args(args: &[String]) -> Result<ClientCommand> {
    let mut session_id = None;
    let mut run_id = None;
    let mut inbox_mode = Some("prompt".to_string());
    let mut text_b64 = None;
    let mut cwd_b64 = None;
    let mut history_b64 = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--session-id" => {
                session_id = Some(take_flag_value(args, &mut index, "--session-id")?);
            }
            "--run-id" => {
                run_id = Some(take_flag_value(args, &mut index, "--run-id")?);
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
            "--history-b64" => {
                history_b64 = Some(take_flag_value(args, &mut index, "--history-b64")?);
            }
            other => bail!("unexpected run-submit argument '{}'", other),
        }
        index += 1;
    }

    Ok(ClientCommand::RunSubmit {
        session_id: session_id.context("--session-id is required for client run-submit")?,
        run_id: run_id.context("--run-id is required for client run-submit")?,
        inbox_mode: inbox_mode.unwrap_or_else(|| "prompt".to_string()),
        text_b64: text_b64.context("--text-b64 is required for client run-submit")?,
        cwd_b64,
        history_b64,
    })
}

fn parse_client_run_events_args(args: &[String]) -> Result<ClientCommand> {
    let mut run_id = None;
    let mut after_seq = 0u64;
    let mut stream = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--run-id" => {
                run_id = Some(take_flag_value(args, &mut index, "--run-id")?);
            }
            "--after-seq" => {
                after_seq = take_flag_value(args, &mut index, "--after-seq")?
                    .parse()
                    .context("--after-seq must be an unsigned integer")?;
            }
            "--stream" => {
                stream = true;
            }
            other => bail!("unexpected run-events argument '{}'", other),
        }
        index += 1;
    }
    Ok(ClientCommand::RunEvents {
        run_id: run_id.context("--run-id is required for client run-events")?,
        after_seq,
        stream,
    })
}

fn parse_client_run_status_args(args: &[String]) -> Result<ClientCommand> {
    let mut run_id = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--run-id" => {
                run_id = Some(take_flag_value(args, &mut index, "--run-id")?);
            }
            other => bail!("unexpected run-status argument '{}'", other),
        }
        index += 1;
    }
    Ok(ClientCommand::RunStatus {
        run_id: run_id.context("--run-id is required for client run-status")?,
    })
}

fn parse_client_run_result_args(args: &[String]) -> Result<ClientCommand> {
    let mut run_id = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--run-id" => {
                run_id = Some(take_flag_value(args, &mut index, "--run-id")?);
            }
            other => bail!("unexpected run-result argument '{}'", other),
        }
        index += 1;
    }
    Ok(ClientCommand::RunResult {
        run_id: run_id.context("--run-id is required for client run-result")?,
    })
}

fn parse_client_run_cancel_args(args: &[String]) -> Result<ClientCommand> {
    let mut session_id = None;
    let mut run_id = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--session-id" => {
                session_id = Some(take_flag_value(args, &mut index, "--session-id")?);
            }
            "--run-id" => {
                run_id = Some(take_flag_value(args, &mut index, "--run-id")?);
            }
            other => bail!("unexpected run-cancel argument '{}'", other),
        }
        index += 1;
    }
    Ok(ClientCommand::RunCancel {
        session_id: session_id.context("--session-id is required for client run-cancel")?,
        run_id: run_id.context("--run-id is required for client run-cancel")?,
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
