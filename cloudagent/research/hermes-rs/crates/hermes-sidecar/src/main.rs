#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
#[cfg(test)]
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(test)]
use hermes_core::{InboxMode, Message};
#[cfg(test)]
use serde_json::json;
use tokio::net::TcpListener;

mod cli;
mod client;
mod config_bootstrap;
mod daemon_events;
mod daemon_http;
mod daemon_state;
mod event_projection;
mod http;
mod protocol;
mod session_api;
mod stage_files;
mod telemetry;

use cli::{parse_command_mode, CommandMode, DaemonArgs};
use client::run_client;
#[cfg(test)]
use client::{classify_error_code, ClientCommand};
#[cfg(test)]
use config_bootstrap::build_runtime_config;
use daemon_http::handle_connection;
use daemon_state::DaemonState;
#[cfg(test)]
use protocol::*;
#[cfg(test)]
use session_api::{
    parse_inbox_mode, resolve_session_cwd, runtime_input_blocks_to_text, visible_output_text,
};
#[cfg(test)]
use stage_files::validate_stage_files_manifest;
#[cfg(test)]
use telemetry::elapsed_secs;
use telemetry::{init_tracing, timeline};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        timeline("failed", [("error", error.to_string())]);
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    init_tracing();
    let mode = parse_command_mode(&std::env::args().collect::<Vec<_>>())?;
    match mode {
        CommandMode::Daemon(args) => run_daemon(args).await,
        CommandMode::Client(args) => run_client(args).await,
    }
}

async fn run_daemon(args: DaemonArgs) -> Result<()> {
    timeline(
        "process_start",
        [
            ("mode", "daemon".to_string()),
            ("session_id", args.session_id.clone()),
            ("addr", args.addr.clone()),
        ],
    );
    let state = Arc::new(
        DaemonState::new(
            &args.session_id,
            args.workspace.clone(),
            args.memory_dir.clone(),
        )
        .await?,
    );
    let listener = TcpListener::bind(&args.addr)
        .await
        .with_context(|| format!("failed to bind daemon listener on '{}'", args.addr))?;
    timeline(
        "daemon_ready",
        [
            ("session_id", state.session_id.clone()),
            ("addr", args.addr.clone()),
            ("workspace_root", state.workspace_root.display().to_string()),
        ],
    );

    loop {
        tokio::select! {
            _ = state.shutdown.notified() => {
                break;
            }
            accept = listener.accept() => {
                let (stream, peer) = accept.context("daemon accept failed")?;
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(state, stream).await {
                        timeline(
                            "http_request_failed",
                            [
                                ("peer", peer.to_string()),
                                ("error", error.to_string()),
                            ],
                        );
                    }
                });
            }
        }
    }

    state.shutdown_agent().await;
    timeline(
        "process_done",
        [
            ("mode", "daemon".to_string()),
            ("session_id", args.session_id),
        ],
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_no_subcommand_is_rejected() {
        let args = vec!["hermes-sidecar".to_string()];
        let err = parse_command_mode(&args).unwrap_err();
        assert!(err.to_string().contains("subcommand is required"));
    }

    #[test]
    fn parse_daemon_subcommand() {
        let args = vec![
            "hermes-sidecar".to_string(),
            "daemon".to_string(),
            "--addr".to_string(),
            "127.0.0.1:49999".to_string(),
            "--session-id".to_string(),
            "session_123".to_string(),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Daemon(daemon) => {
                assert_eq!(daemon.addr, "127.0.0.1:49999");
                assert_eq!(daemon.session_id, "session_123");
            }
            other => panic!("expected daemon mode, got {:?}", other),
        }
    }

    #[test]
    fn parse_client_session_input_subcommand() {
        let args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "session-input".to_string(),
            "--session-id".to_string(),
            "session_123".to_string(),
            "--input-id".to_string(),
            "job_1".to_string(),
            "--inbox-mode".to_string(),
            "steer".to_string(),
            "--text-b64".to_string(),
            STANDARD.encode("hello"),
            "--cwd-b64".to_string(),
            STANDARD.encode("/workspace"),
            "--history-b64".to_string(),
            STANDARD.encode(r#"[{"role":"user","text":"previous"}]"#),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Client(client) => match client.command {
                ClientCommand::SessionInput {
                    session_id,
                    input_id,
                    inbox_mode,
                    text_b64,
                    cwd_b64,
                    history_b64,
                } => {
                    assert_eq!(session_id, "session_123");
                    assert_eq!(input_id.as_deref(), Some("job_1"));
                    assert_eq!(inbox_mode, "steer");
                    assert_eq!(text_b64, STANDARD.encode("hello"));
                    assert_eq!(cwd_b64, Some(STANDARD.encode("/workspace")));
                    assert_eq!(
                        history_b64,
                        Some(STANDARD.encode(r#"[{"role":"user","text":"previous"}]"#))
                    );
                }
                other => panic!("expected client session-input command, got {:?}", other),
            },
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn parse_client_session_abort_subcommand() {
        let args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "session-abort".to_string(),
            "--session-id".to_string(),
            "session_123".to_string(),
            "--run-id".to_string(),
            "run_1".to_string(),
            "--clear-pending".to_string(),
            "--reason".to_string(),
            "cancelled".to_string(),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Client(client) => match client.command {
                ClientCommand::SessionAbort {
                    session_id,
                    run_id,
                    clear_pending,
                    reason,
                } => {
                    assert_eq!(session_id, "session_123");
                    assert_eq!(run_id.as_deref(), Some("run_1"));
                    assert!(clear_pending);
                    assert_eq!(reason.as_deref(), Some("cancelled"));
                }
                other => panic!("expected client session-abort command, got {:?}", other),
            },
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn runtime_api_parses_inbox_modes() {
        assert!(matches!(parse_inbox_mode(None).unwrap(), InboxMode::Prompt));
        assert!(matches!(
            parse_inbox_mode(Some("followUp")).unwrap(),
            InboxMode::FollowUp
        ));
        assert!(matches!(
            parse_inbox_mode(Some("steer")).unwrap(),
            InboxMode::Steer
        ));
        assert!(parse_inbox_mode(Some("bad")).is_err());
    }

    #[test]
    fn runtime_api_requires_text_blocks() {
        let text = runtime_input_blocks_to_text(&[
            RuntimeInputBlock::Text {
                text: " hello ".to_string(),
            },
            RuntimeInputBlock::Text {
                text: "world".to_string(),
            },
        ])
        .unwrap();

        assert_eq!(text, "hello\n\nworld");
        assert!(runtime_input_blocks_to_text(&[]).is_err());
        assert!(runtime_input_blocks_to_text(&[RuntimeInputBlock::Text {
            text: " ".to_string(),
        }])
        .is_err());
    }

    #[test]
    fn runtime_api_status_response_serializes_runtime_status() {
        let value = serde_json::to_value(RuntimeStatusResponse {
            ok: true,
            session_id: "session_1".to_string(),
            status: hermes_core::AgentStatus::Queued,
            runtime_store_load: "Restored".to_string(),
            active_run_id: Some("run_1".to_string()),
            pending_run_count: 1,
            pending_by_mode: PendingByMode {
                prompt: 1,
                steer: 0,
                follow_up: 0,
            },
            run_count: 1,
            transcript_count: 2,
            last_user_hash: Some("userhash".to_string()),
            last_assistant_hash: Some("assisthash".to_string()),
            last_run_status: Some("queued".to_string()),
            run_ledger_tail: Vec::new(),
            active_prompt: None,
        })
        .unwrap();

        assert_eq!(value["status"], "queued");
        assert_eq!(value["run_count"], 1);
        assert_eq!(value["transcript_count"], 2);
        assert_eq!(value["runtime_store_load"], "Restored");
        assert_eq!(value["last_user_hash"], "userhash");
        assert_eq!(value["last_assistant_hash"], "assisthash");
        assert_eq!(value["active_run_id"], "run_1");
        assert_eq!(value["pending_by_mode"]["prompt"], 1);
    }

    #[test]
    fn parse_client_health_json_subcommand() {
        let args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "health-json".to_string(),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Client(client) => {
                assert!(matches!(client.command, ClientCommand::HealthJson));
            }
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn parse_client_ensure_inner_subcommand() {
        let args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "ensure-inner".to_string(),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Client(client) => {
                assert!(matches!(
                    client.command,
                    ClientCommand::EnsureInner { force: false }
                ));
            }
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn parse_client_ensure_inner_force_subcommand() {
        let args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "ensure-inner".to_string(),
            "--force".to_string(),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Client(client) => {
                assert!(matches!(
                    client.command,
                    ClientCommand::EnsureInner { force: true }
                ));
            }
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn parse_client_stage_files_subcommand() {
        let manifest = json!({
            "session_id": "session_123",
            "generation": 1,
            "workspace_root": "/workspace",
            "files": []
        })
        .to_string();
        let args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "stage-files".to_string(),
            "--manifest-b64".to_string(),
            STANDARD.encode(&manifest),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Client(client) => match client.command {
                ClientCommand::StageFiles { manifest_b64 } => {
                    assert_eq!(manifest_b64, STANDARD.encode(manifest));
                }
                other => panic!("expected client stage-files command, got {:?}", other),
            },
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn parse_client_workspace_bind_subcommand() {
        let request = json!({
            "workspace_id": "workspace_1",
            "workspace_runtime_id": "runtime_1",
            "sandbox_id": "sandbox_1",
            "domain": "example.com",
            "envd_access_token": "token",
            "workspace_root": "/workspace",
            "replace_existing": true
        })
        .to_string();
        let args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "workspace-bind".to_string(),
            "--request-b64".to_string(),
            STANDARD.encode(&request),
        ];
        match parse_command_mode(&args).unwrap() {
            CommandMode::Client(client) => match client.command {
                ClientCommand::WorkspaceBind { request_b64 } => {
                    assert_eq!(request_b64, STANDARD.encode(request));
                }
                other => panic!("expected client workspace-bind command, got {:?}", other),
            },
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn parse_client_workspace_file_transfer_subcommands() {
        let upload_args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "workspace-file-upload".to_string(),
            "--path-b64".to_string(),
            STANDARD.encode("/workspace/a.txt"),
            "--content-b64".to_string(),
            STANDARD.encode("hello"),
        ];
        match parse_command_mode(&upload_args).unwrap() {
            CommandMode::Client(client) => match client.command {
                ClientCommand::WorkspaceFileUpload {
                    path_b64,
                    content_b64,
                } => {
                    assert_eq!(path_b64, STANDARD.encode("/workspace/a.txt"));
                    assert_eq!(content_b64, STANDARD.encode("hello"));
                }
                other => panic!(
                    "expected client workspace-file-upload command, got {:?}",
                    other
                ),
            },
            other => panic!("expected client mode, got {:?}", other),
        }

        let download_args = vec![
            "hermes-sidecar".to_string(),
            "client".to_string(),
            "--addr".to_string(),
            "http://127.0.0.1:49999".to_string(),
            "workspace-file-download".to_string(),
            "--path-b64".to_string(),
            STANDARD.encode("/workspace/a.txt"),
        ];
        match parse_command_mode(&download_args).unwrap() {
            CommandMode::Client(client) => match client.command {
                ClientCommand::WorkspaceFileDownload { path_b64 } => {
                    assert_eq!(path_b64, STANDARD.encode("/workspace/a.txt"));
                }
                other => panic!(
                    "expected client workspace-file-download command, got {:?}",
                    other
                ),
            },
            other => panic!("expected client mode, got {:?}", other),
        }
    }

    #[test]
    fn validate_stage_files_manifest_accepts_staged_workspace_file() {
        let workspace = unique_test_dir("stage-ok");
        let inputs = workspace.join("inputs");
        fs::create_dir_all(&inputs).unwrap();
        fs::write(inputs.join("TODO.md"), b"hello").unwrap();

        let manifest = StageFilesManifest {
            session_id: Some("session_123".to_string()),
            generation: Some(2),
            workspace_root: Some(workspace.display().to_string()),
            files: vec![StagedFile {
                file_id: "file_1".to_string(),
                name: "TODO.md".to_string(),
                mime_type: "text/markdown".to_string(),
                bytes: Some(5),
                sha256: String::new(),
                outer_path: workspace.join("inputs/TODO.md").display().to_string(),
                workspace_path: "./inputs/TODO.md".to_string(),
            }],
        };

        let paths =
            validate_stage_files_manifest(&manifest, "session_123", &workspace, Some(1)).unwrap();
        assert_eq!(paths, vec!["inputs/TODO.md".to_string()]);

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn validate_stage_files_manifest_rejects_workspace_escape() {
        let workspace = unique_test_dir("stage-escape");
        fs::create_dir_all(&workspace).unwrap();
        let manifest = StageFilesManifest {
            session_id: Some("session_123".to_string()),
            generation: Some(1),
            workspace_root: Some(workspace.display().to_string()),
            files: vec![StagedFile {
                file_id: "file_1".to_string(),
                name: "secret".to_string(),
                mime_type: "text/plain".to_string(),
                bytes: None,
                sha256: String::new(),
                outer_path: String::new(),
                workspace_path: "../secret".to_string(),
            }],
        };

        let error =
            validate_stage_files_manifest(&manifest, "session_123", &workspace, None).unwrap_err();
        assert!(error.to_string().contains("must not contain '..'"));

        let _ = fs::remove_dir_all(workspace);
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "hermes-sidecar-{}-{}-{}",
            name,
            std::process::id(),
            elapsed_secs()
        ))
    }

    #[test]
    fn render_and_parse_prompt_response_lines() {
        let body = [
            PromptResponseLine::OutputTextDelta {
                delta: "he".to_string(),
            },
            PromptResponseLine::ReasoningDelta {
                delta: "thinking".to_string(),
            },
            PromptResponseLine::ToolCall {
                tool_call_id: "call_1".to_string(),
                name: "terminal".to_string(),
                status: "running".to_string(),
                raw_input: Some(json!({"command": "pwd"})),
            },
            PromptResponseLine::ToolCallUpdate {
                tool_call_id: "call_1".to_string(),
                name: "terminal".to_string(),
                status: "done".to_string(),
                error: None,
                raw_output: Some(json!({"stdout": "/workspace\n"})),
                content: Some(r#"{"stdout":"/workspace\n"}"#.to_string()),
            },
            PromptResponseLine::RuntimeHost {
                event: "inner_shutdown_done".to_string(),
                session_id: Some("session_1".to_string()),
                sandbox_id: Some("inner_1".to_string()),
                workspace_root: Some("/workspace/session_1".to_string()),
                template: None,
                error: None,
            },
            PromptResponseLine::OutputTextDelta {
                delta: "llo".to_string(),
            },
            PromptResponseLine::Result {
                output_text: "hello".to_string(),
                inner_sandbox_id: Some("inner_1".to_string()),
                inner_sandbox_domain: Some("inner.example.com".to_string()),
                inner_envd_access_token: Some("token_1".to_string()),
            },
            PromptResponseLine::Error {
                code: Some("max_iterations_exceeded".to_string()),
                error: "Max iterations exceeded: 12".to_string(),
            },
        ]
        .into_iter()
        .map(|line| serde_json::to_string(&line).unwrap())
        .collect::<Vec<_>>()
        .join("\n");

        let mut parsed = Vec::new();
        for line in body.lines() {
            parsed.push(serde_json::from_str::<PromptResponseLine>(line).unwrap());
        }

        assert_eq!(
            parsed,
            vec![
                PromptResponseLine::OutputTextDelta {
                    delta: "he".to_string()
                },
                PromptResponseLine::ReasoningDelta {
                    delta: "thinking".to_string()
                },
                PromptResponseLine::ToolCall {
                    tool_call_id: "call_1".to_string(),
                    name: "terminal".to_string(),
                    status: "running".to_string(),
                    raw_input: Some(json!({"command": "pwd"})),
                },
                PromptResponseLine::ToolCallUpdate {
                    tool_call_id: "call_1".to_string(),
                    name: "terminal".to_string(),
                    status: "done".to_string(),
                    error: None,
                    raw_output: Some(json!({"stdout": "/workspace\n"})),
                    content: Some(r#"{"stdout":"/workspace\n"}"#.to_string()),
                },
                PromptResponseLine::RuntimeHost {
                    event: "inner_shutdown_done".to_string(),
                    session_id: Some("session_1".to_string()),
                    sandbox_id: Some("inner_1".to_string()),
                    workspace_root: Some("/workspace/session_1".to_string()),
                    template: None,
                    error: None,
                },
                PromptResponseLine::OutputTextDelta {
                    delta: "llo".to_string()
                },
                PromptResponseLine::Result {
                    output_text: "hello".to_string(),
                    inner_sandbox_id: Some("inner_1".to_string()),
                    inner_sandbox_domain: Some("inner.example.com".to_string()),
                    inner_envd_access_token: Some("token_1".to_string()),
                },
                PromptResponseLine::Error {
                    code: Some("max_iterations_exceeded".to_string()),
                    error: "Max iterations exceeded: 12".to_string(),
                },
            ]
        );
    }

    #[test]
    fn visible_output_text_prefers_content() {
        let message = Message::assistant(" final answer ")
            .with_reasoning("internal planning should not leak");

        assert_eq!(visible_output_text(&message), "final answer");
    }

    #[test]
    fn visible_output_text_uses_safe_fallback_for_reasoning_only() {
        let message = Message::assistant("").with_reasoning("ask the user for a filename");

        assert_eq!(
            visible_output_text(&message),
            "The model produced reasoning but no final response."
        );
    }

    #[test]
    fn visible_output_text_never_returns_empty() {
        let message = Message::assistant("");

        assert_eq!(
            visible_output_text(&message),
            "No response content was produced."
        );
    }

    #[test]
    fn classify_max_iterations_error() {
        assert_eq!(
            classify_error_code("Max iterations exceeded: 12"),
            "max_iterations_exceeded"
        );
        assert_eq!(classify_error_code("boom"), "agent_runtime_error");
    }

    #[test]
    fn runtime_config_uses_cloudagent_identity_prompt() {
        std::env::remove_var("HERMES_SYSTEM_PROMPT");
        let config = build_runtime_config("token", "model", "ags", "domain", "url", "template");
        let prompt = config
            .agent
            .system_prompt
            .as_deref()
            .expect("system prompt");
        assert!(prompt.contains("You are CloudAgent"));
        assert!(prompt.contains("Do not call yourself \"MCP Agent\""));
    }

    #[test]
    fn resolve_session_cwd_rejects_escape() {
        let workspace = PathBuf::from("/tmp/gateway/sessions/s/workspace");
        assert_eq!(
            resolve_session_cwd(&workspace, "src/lib"),
            Some(workspace.join("src/lib"))
        );
        assert!(resolve_session_cwd(&workspace, "../escape").is_none());
        assert!(resolve_session_cwd(&workspace, "/tmp/outside").is_none());
    }
}
