use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::client::classify_error_code;
use crate::http::{
    json_response, plain_response, prompt_response_lines_body, read_http_request,
    write_http_response, write_prompt_response_line, write_streaming_prompt_headers,
};
use crate::protocol::{
    EnsureInnerRequest, HttpRequest, HttpResponse, PromptOutcome, PromptResponseLine,
    RuntimeAbortRequest, RuntimeInputRequest, SessionCreateRequest, StageFilesManifest,
    WorkspaceBindRequest,
};
use crate::DaemonState;

pub(crate) async fn handle_connection(
    state: Arc<DaemonState>,
    mut stream: TcpStream,
) -> Result<()> {
    let request = read_http_request(&mut stream).await?;
    if request.method == "POST" && request.path == "/session/input/stream" {
        handle_session_input_stream_request(state, request, &mut stream).await?;
        return Ok(());
    }
    let response = route_request(state.clone(), request).await;
    write_http_response(&mut stream, &response).await?;
    if response.shutdown_after_response {
        state.request_shutdown();
    }
    Ok(())
}

async fn route_request(state: Arc<DaemonState>, request: HttpRequest) -> HttpResponse {
    match (request.method.as_str(), request.path.as_str()) {
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
    let body = match serde_json::from_slice::<RuntimeInputRequest>(&request.body) {
        Ok(body) => body,
        Err(error) => {
            let response = json_response(400, json!({ "error": error.to_string() }));
            write_http_response(stream, &response).await?;
            return Ok(());
        }
    };

    write_streaming_prompt_headers(stream).await?;
    let (line_tx, mut line_rx) = mpsc::channel(128);
    let input_task =
        tokio::spawn(async move { state.session_input_streaming(body, line_tx).await });
    write_prompt_stream_task(stream, &mut line_rx, input_task).await
}

async fn write_prompt_stream_task(
    stream: &mut TcpStream,
    line_rx: &mut mpsc::Receiver<PromptResponseLine>,
    prompt_task: tokio::task::JoinHandle<Result<PromptOutcome>>,
) -> Result<()> {
    tokio::pin!(prompt_task);

    loop {
        tokio::select! {
            maybe_line = line_rx.recv() => {
                if let Some(line) = maybe_line {
                    write_prompt_response_line(stream, &line).await?;
                }
            }
            outcome = &mut prompt_task => {
                while let Ok(line) = line_rx.try_recv() {
                    write_prompt_response_line(stream, &line).await?;
                }
                match outcome {
                    Ok(Ok(outcome)) => {
                        write_prompt_response_line(
                            stream,
                            &PromptResponseLine::Result {
                                output_text: outcome.output_text,
                                inner_sandbox_id: outcome.inner_sandbox_id,
                                inner_sandbox_domain: outcome.inner_sandbox_domain,
                                inner_envd_access_token: outcome.inner_envd_access_token,
                            },
                        ).await?;
                    }
                    Ok(Err(error)) => {
                        let message = error.to_string();
                        write_prompt_response_line(
                            stream,
                            &PromptResponseLine::Error {
                                code: Some(classify_error_code(&message).to_string()),
                                error: message,
                            },
                        ).await?;
                    }
                    Err(error) => {
                        let message = error.to_string();
                        write_prompt_response_line(
                            stream,
                            &PromptResponseLine::Error {
                                code: Some(classify_error_code(&message).to_string()),
                                error: message,
                            },
                        ).await?;
                    }
                }
                break;
            }
        }
    }

    stream
        .flush()
        .await
        .context("failed to flush streaming prompt response")?;
    Ok(())
}
