use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::http::{
    json_response, plain_response, prompt_response_lines_body, read_http_request,
    write_http_response, write_json_line, write_prompt_response_line,
    write_streaming_prompt_headers,
};
use crate::protocol::{
    EnsureInnerRequest, HttpRequest, HttpResponse, PromptResponseLine, RuntimeAbortRequest,
    RuntimeInputRequest, RuntimeRunStatus, RuntimeRunSubmitRequest, SessionCreateRequest,
    StageFilesManifest, WorkspaceBindRequest, WorkspaceFileDownloadRequest,
    WorkspaceFileUploadRequest,
};
use crate::session_api::next_input_id;
use crate::DaemonState;

pub(crate) async fn handle_connection(
    state: Arc<DaemonState>,
    mut stream: TcpStream,
) -> Result<()> {
    let request = read_http_request(&mut stream).await?;
    let (path, query) = split_path_query(&request.path);
    if request.method == "POST" && path == "/session/input/stream" {
        handle_session_input_stream_request(state, request, &mut stream).await?;
        return Ok(());
    }
    if request.method == "GET" {
        if let Some(run_id) = run_id_with_suffix(&path, "/events") {
            if query_bool(&query, "stream") {
                handle_run_events_stream_request(state, run_id, query, &mut stream).await?;
                return Ok(());
            }
        }
    }
    let response = route_request(state.clone(), request).await;
    write_http_response(&mut stream, &response).await?;
    if response.shutdown_after_response {
        state.request_shutdown();
    }
    Ok(())
}

async fn route_request(state: Arc<DaemonState>, request: HttpRequest) -> HttpResponse {
    let (path, query) = split_path_query(&request.path);
    match (request.method.as_str(), path.as_str()) {
        ("GET", "/health") => plain_response(200, "hermes-sidecar ok"),
        ("GET", "/health-json") => json_response(
            200,
            serde_json::to_value(state.health_json().await)
                .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
        ),
        ("GET", "/session/status") => json_response(
            200,
            serde_json::to_value(state.session_status().await)
                .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
        ),
        ("GET", "/session/transcript") => json_response(
            200,
            serde_json::to_value(state.session_transcript().await)
                .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
        ),
        ("GET", "/session/run-ledger") => json_response(
            200,
            serde_json::to_value(state.session_run_ledger().await)
                .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
        ),
        ("GET", "/events/subscribe") => json_response(200, json!({ "events": [] })),
        ("POST", "/runs") => {
            match serde_json::from_slice::<RuntimeRunSubmitRequest>(&request.body) {
                Ok(body) => match state.submit_run(body).await {
                    Ok(response) => json_response(
                        200,
                        serde_json::to_value(response).unwrap_or_else(
                            |error| json!({ "ok": false, "error": error.to_string() }),
                        ),
                    ),
                    Err(error) => {
                        json_response(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("GET", path) if run_id_for_status(path).is_some() => {
            let run_id = run_id_for_status(path).unwrap();
            match state.run_status(run_id).await {
                Some(response) => json_response(
                    200,
                    serde_json::to_value(response)
                        .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
                ),
                None => json_response(404, json!({ "ok": false, "error": "run not found" })),
            }
        }
        ("GET", path) if run_id_with_suffix(path, "/events").is_some() => {
            let run_id = run_id_with_suffix(path, "/events").unwrap();
            let after_seq = query_u64(&query, "after_seq").unwrap_or(0);
            match state.run_events_since(run_id, after_seq).await {
                Ok(response) => json_response(
                    200,
                    serde_json::to_value(response)
                        .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
                ),
                Err(error) => {
                    json_response(404, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("GET", path) if run_id_with_suffix(path, "/result").is_some() => {
            let run_id = run_id_with_suffix(path, "/result").unwrap();
            match state.run_result(run_id).await {
                Some(response) => json_response(
                    200,
                    serde_json::to_value(response)
                        .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
                ),
                None => json_response(404, json!({ "ok": false, "error": "run not found" })),
            }
        }
        ("POST", path) if run_id_with_suffix(path, "/cancel").is_some() => {
            let run_id = run_id_with_suffix(path, "/cancel").unwrap();
            match state.cancel_run(run_id).await {
                Ok(response) => json_response(
                    200,
                    serde_json::to_value(response)
                        .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() })),
                ),
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/session/create") => {
            match serde_json::from_slice::<SessionCreateRequest>(&request.body) {
                Ok(body) => match state.session_create(body).await {
                    Ok(response) => json_response(200, response),
                    Err(error) => {
                        json_response(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/session/input") => {
            match serde_json::from_slice::<RuntimeInputRequest>(&request.body) {
                Ok(body) => match state.session_input(body).await {
                    Ok(response) => json_response(
                        200,
                        serde_json::to_value(response).unwrap_or_else(
                            |error| json!({ "ok": false, "error": error.to_string() }),
                        ),
                    ),
                    Err(error) => {
                        json_response(500, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/session/abort") => {
            match serde_json::from_slice::<RuntimeAbortRequest>(&request.body) {
                Ok(body) => match state.session_abort(body).await {
                    Ok(response) => json_response(
                        200,
                        serde_json::to_value(response).unwrap_or_else(
                            |error| json!({ "ok": false, "error": error.to_string() }),
                        ),
                    ),
                    Err(error) => {
                        json_response(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/stage-files") => {
            match serde_json::from_slice::<StageFilesManifest>(&request.body) {
                Ok(body) => match state.stage_files(body).await {
                    Ok(response) => json_response(200, response),
                    Err(error) => {
                        json_response(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/workspace/file-upload") => {
            match serde_json::from_slice::<WorkspaceFileUploadRequest>(&request.body) {
                Ok(body) => match state.workspace_file_upload(body).await {
                    Ok(response) => json_response(200, response),
                    Err(error) => {
                        json_response(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/workspace/file-download") => {
            match serde_json::from_slice::<WorkspaceFileDownloadRequest>(&request.body) {
                Ok(body) => match state.workspace_file_download(body).await {
                    Ok(response) => json_response(
                        200,
                        serde_json::to_value(response).unwrap_or_else(
                            |error| json!({ "ok": false, "error": error.to_string() }),
                        ),
                    ),
                    Err(error) => {
                        json_response(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/ensure-inner") => {
            match serde_json::from_slice::<EnsureInnerRequest>(&request.body) {
                Ok(body) => match state.ensure_inner(body.force).await {
                    Ok(response) => json_response(
                        200,
                        serde_json::to_value(response).unwrap_or_else(
                            |error| json!({ "ok": false, "error": error.to_string() }),
                        ),
                    ),
                    Err(error) => {
                        json_response(500, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/shutdown-inner") => {
            let lines = state.shutdown_inner_with_response_lines().await;
            let body = prompt_response_lines_body(&lines);
            HttpResponse {
                status: 200,
                content_type: "application/x-ndjson",
                body,
                shutdown_after_response: false,
            }
        }
        ("POST", "/workspace/bind") => {
            match serde_json::from_slice::<WorkspaceBindRequest>(&request.body) {
                Ok(body) => match state.bind_workspace(body).await {
                    Ok(response) => json_response(
                        200,
                        serde_json::to_value(response).unwrap_or_else(
                            |error| json!({ "ok": false, "error": error.to_string() }),
                        ),
                    ),
                    Err(error) => {
                        json_response(500, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => {
                    json_response(400, json!({ "ok": false, "error": error.to_string() }))
                }
            }
        }
        ("POST", "/shutdown") => {
            let lines = state.shutdown_agent_with_response_lines().await;
            let body = prompt_response_lines_body(&lines);
            HttpResponse {
                status: 200,
                content_type: "application/x-ndjson",
                body,
                shutdown_after_response: true,
            }
        }
        _ => plain_response(404, "not found"),
    }
}

async fn handle_session_input_stream_request(
    state: Arc<DaemonState>,
    request: HttpRequest,
    stream: &mut TcpStream,
) -> Result<()> {
    let mut body = match serde_json::from_slice::<RuntimeInputRequest>(&request.body) {
        Ok(body) => body,
        Err(error) => {
            let response = json_response(400, json!({ "error": error.to_string() }));
            write_http_response(stream, &response).await?;
            return Ok(());
        }
    };
    let run_id = body
        .input_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(next_input_id);
    body.input_id = Some(run_id.clone());
    let submit = RuntimeRunSubmitRequest {
        session_id: body.session_id,
        run_id: run_id.clone(),
        inbox_mode: body.inbox_mode,
        blocks: body.blocks,
        cwd: body.cwd,
        history: body.history,
    };
    if let Err(error) = state.clone().submit_run(submit).await {
        let response = json_response(500, json!({ "error": error.to_string() }));
        write_http_response(stream, &response).await?;
        return Ok(());
    }

    write_streaming_prompt_headers(stream).await?;
    stream_prompt_run_lines(state, &run_id, 0, stream).await
}

async fn handle_run_events_stream_request(
    state: Arc<DaemonState>,
    run_id: &str,
    query: HashMap<String, String>,
    stream: &mut TcpStream,
) -> Result<()> {
    let after_seq = query_u64(&query, "after_seq").unwrap_or(0);
    if state.run_status(run_id).await.is_none() {
        let response = json_response(404, json!({ "ok": false, "error": "run not found" }));
        write_http_response(stream, &response).await?;
        return Ok(());
    }
    write_streaming_prompt_headers(stream).await?;
    stream_run_event_records(state, run_id, after_seq, stream).await
}

async fn stream_run_event_records(
    state: Arc<DaemonState>,
    run_id: &str,
    after_seq: u64,
    stream: &mut TcpStream,
) -> Result<()> {
    let mut receiver = state.subscribe_run(run_id).await?;
    let replay = state.run_events_since(run_id, after_seq).await?;
    let mut seen_seq = after_seq;
    let mut terminal_seen = false;
    for event in replay.events {
        seen_seq = seen_seq.max(event.seq);
        terminal_seen |= is_terminal_event(&event.line);
        write_json_line(stream, &event).await?;
    }
    if terminal_seen || is_terminal_status(&replay.status) {
        return stream.flush().await.map_err(anyhow::Error::from);
    }
    loop {
        match receiver.recv().await {
            Ok(event) if event.seq <= seen_seq => {}
            Ok(event) => {
                seen_seq = event.seq;
                write_json_line(stream, &event).await?;
                if is_terminal_event(&event.line) {
                    break;
                }
                if replay_missing_terminal_after_status(&state, run_id, &mut seen_seq, stream)
                    .await?
                {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let replay = state.run_events_since(run_id, seen_seq).await?;
                for event in replay.events {
                    seen_seq = seen_seq.max(event.seq);
                    write_json_line(stream, &event).await?;
                }
                if is_terminal_status(&replay.status) {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
    stream.flush().await.map_err(anyhow::Error::from)
}

async fn stream_prompt_run_lines(
    state: Arc<DaemonState>,
    run_id: &str,
    after_seq: u64,
    stream: &mut TcpStream,
) -> Result<()> {
    let mut receiver = state.subscribe_run(run_id).await?;
    let replay = state.run_events_since(run_id, after_seq).await?;
    let mut seen_seq = after_seq;
    let mut terminal_seen = false;
    for event in replay.events {
        seen_seq = seen_seq.max(event.seq);
        terminal_seen |= is_terminal_event(&event.line);
        write_prompt_response_line(stream, &event.line).await?;
    }
    if terminal_seen || is_terminal_status(&replay.status) {
        return stream.flush().await.map_err(anyhow::Error::from);
    }
    loop {
        match receiver.recv().await {
            Ok(event) if event.seq <= seen_seq => {}
            Ok(event) => {
                seen_seq = event.seq;
                write_prompt_response_line(stream, &event.line).await?;
                if is_terminal_event(&event.line) {
                    break;
                }
                if replay_missing_prompt_terminal_after_status(
                    &state,
                    run_id,
                    &mut seen_seq,
                    stream,
                )
                .await?
                {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                let replay = state.run_events_since(run_id, seen_seq).await?;
                for event in replay.events {
                    seen_seq = seen_seq.max(event.seq);
                    write_prompt_response_line(stream, &event.line).await?;
                }
                if is_terminal_status(&replay.status) {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
    stream.flush().await.map_err(anyhow::Error::from)
}

async fn replay_missing_terminal_after_status(
    state: &DaemonState,
    run_id: &str,
    seen_seq: &mut u64,
    stream: &mut TcpStream,
) -> Result<bool> {
    if !state
        .run_status(run_id)
        .await
        .map(|status| is_terminal_status(&status.status))
        .unwrap_or(true)
    {
        return Ok(false);
    }
    let replay = state.run_events_since(run_id, *seen_seq).await?;
    let mut terminal_seen = is_terminal_status(&replay.status);
    for event in replay.events {
        *seen_seq = (*seen_seq).max(event.seq);
        terminal_seen |= is_terminal_event(&event.line);
        write_json_line(stream, &event).await?;
    }
    Ok(terminal_seen)
}

async fn replay_missing_prompt_terminal_after_status(
    state: &DaemonState,
    run_id: &str,
    seen_seq: &mut u64,
    stream: &mut TcpStream,
) -> Result<bool> {
    if !state
        .run_status(run_id)
        .await
        .map(|status| is_terminal_status(&status.status))
        .unwrap_or(true)
    {
        return Ok(false);
    }
    let replay = state.run_events_since(run_id, *seen_seq).await?;
    let mut terminal_seen = is_terminal_status(&replay.status);
    for event in replay.events {
        *seen_seq = (*seen_seq).max(event.seq);
        terminal_seen |= is_terminal_event(&event.line);
        write_prompt_response_line(stream, &event.line).await?;
    }
    Ok(terminal_seen)
}

fn is_terminal_status(status: &RuntimeRunStatus) -> bool {
    matches!(
        status,
        RuntimeRunStatus::Completed | RuntimeRunStatus::Failed | RuntimeRunStatus::Cancelled
    )
}

fn is_terminal_event(line: &PromptResponseLine) -> bool {
    matches!(
        line,
        PromptResponseLine::Result { .. } | PromptResponseLine::Error { .. }
    )
}

fn split_path_query(raw: &str) -> (String, HashMap<String, String>) {
    let Some((path, query)) = raw.split_once('?') else {
        return (raw.to_string(), HashMap::new());
    };
    let params = query
        .split('&')
        .filter_map(|part| {
            let (key, value) = part.split_once('=')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect();
    (path.to_string(), params)
}

fn query_bool(query: &HashMap<String, String>, key: &str) -> bool {
    query
        .get(key)
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn query_u64(query: &HashMap<String, String>, key: &str) -> Option<u64> {
    query.get(key).and_then(|value| value.parse().ok())
}

fn run_id_for_status(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/runs/")?;
    (!rest.is_empty() && !rest.contains('/')).then_some(rest)
}

fn run_id_with_suffix<'a>(path: &'a str, suffix: &str) -> Option<&'a str> {
    let rest = path.strip_prefix("/runs/")?;
    let run_id = rest.strip_suffix(suffix)?;
    let run_id = run_id.strip_suffix('/').unwrap_or(run_id);
    (!run_id.is_empty() && !run_id.contains('/')).then_some(run_id)
}
