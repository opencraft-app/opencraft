use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine;
use hermes_core::{
    client::Role,
    runtime_host::{
        download_active_session_sandbox_file, sync_active_session_sandbox_files,
        upload_active_session_sandbox_file, SessionSandboxBinding,
    },
    AgentRuntime, BehaviorRegistry, BehaviorVersions, Message, RunTurnRequest, RuntimeStore,
    TranscriptBlock, TranscriptRole,
};
use serde_json::json;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::task::JoinHandle;

use crate::config_bootstrap::{build_agent, load_runtime_env, session_paths};
use crate::daemon_events::ActivePromptRegistry;
use crate::event_projection::runtime_host_line_from_agent_event;
use crate::protocol::*;
use crate::session_api::{
    build_session_prompt, ensure_session_id_matches, next_input_id, parse_inbox_mode,
    resolve_session_cwd, runtime_input_blocks_to_text, visible_output_text,
};
use crate::stage_files::{persist_stage_files_manifest, validate_stage_files_manifest};
use crate::telemetry::timeline;

#[derive(Debug)]
struct SessionState {
    prompt_count: usize,
    current_cwd: PathBuf,
    behavior_versions: BehaviorVersions,
    runtime_store_load: String,
}

pub(crate) struct DaemonState {
    pub(crate) session_id: String,
    pub(crate) workspace_root: PathBuf,
    agent: AgentRuntime,
    serial: Mutex<SessionState>,
    stage_files: Mutex<StageFilesState>,
    active_prompts: ActivePromptRegistry,
    event_task: Mutex<Option<JoinHandle<()>>>,
    pub(crate) shutdown: Notify,
    shutdown_requested: AtomicBool,
}

impl DaemonState {
    pub(crate) async fn new(
        session_id: &str,
        workspace: Option<PathBuf>,
        memory_dir: Option<PathBuf>,
    ) -> Result<Self> {
        let runtime = load_runtime_env()?;
        let mut paths = session_paths(session_id);
        if let Some(workspace) = workspace {
            paths.workspace_root = workspace;
        }
        if let Some(memory_dir) = memory_dir {
            paths.memory_root = memory_dir;
        }
        fs::create_dir_all(&paths.workspace_root).with_context(|| {
            format!(
                "failed to create session workspace '{}'",
                paths.workspace_root.display()
            )
        })?;
        fs::create_dir_all(&paths.memory_root).with_context(|| {
            format!(
                "failed to create session memory root '{}'",
                paths.memory_root.display()
            )
        })?;

        let (event_tx, event_rx) = mpsc::channel(128);
        let active_prompts = ActivePromptRegistry::new();
        let event_task = active_prompts.spawn_event_task(event_rx);

        let agent = build_agent(
            &runtime,
            paths.workspace_root.clone(),
            paths.memory_root.clone(),
            event_tx,
        )
        .await?
        .with_store(RuntimeStore::new(paths.memory_root.join("runtime-store")));
        let load = agent.restore_from_store().await?;

        Ok(Self {
            session_id: session_id.to_string(),
            workspace_root: paths.workspace_root.clone(),
            agent,
            serial: Mutex::new(SessionState {
                prompt_count: 0,
                current_cwd: paths.workspace_root,
                behavior_versions: BehaviorVersions::default(),
                runtime_store_load: format!("{:?}", load),
            }),
            stage_files: Mutex::new(StageFilesState::default()),
            active_prompts,
            event_task: Mutex::new(Some(event_task)),
            shutdown: Notify::new(),
            shutdown_requested: AtomicBool::new(false),
        })
    }

    pub(crate) async fn session_create(
        &self,
        request: SessionCreateRequest,
    ) -> Result<serde_json::Value> {
        ensure_session_id_matches(&self.session_id, &request.session_id)?;
        let default_versions = BehaviorVersions::default();
        let versions = BehaviorVersions {
            agent_version: request
                .agent_version
                .unwrap_or(default_versions.agent_version),
            workspace_version: request
                .workspace_version
                .unwrap_or(default_versions.workspace_version),
        };
        let resolved_behavior = BehaviorRegistry.resolve(&versions)?;
        {
            let mut state = self.serial.lock().await;
            self.apply_request_cwd(request.cwd.as_deref(), &mut state, true)?;
            state.behavior_versions = versions;
        }
        let load = self.agent.restore_from_store().await?;
        {
            let mut state = self.serial.lock().await;
            state.runtime_store_load = format!("{:?}", load);
        }
        timeline(
            "session_create_done",
            [
                ("session_id", self.session_id.clone()),
                ("load", format!("{:?}", load)),
                ("agent_version", resolved_behavior.agent_version.clone()),
                (
                    "workspace_version",
                    resolved_behavior.workspace_version.clone(),
                ),
            ],
        );
        Ok(json!({
            "ok": true,
            "session_id": self.session_id,
            "agent_version": resolved_behavior.agent_version,
            "workspace_version": resolved_behavior.workspace_version,
            "load": format!("{:?}", load),
        }))
    }

    pub(crate) async fn session_input(
        &self,
        mut request: RuntimeInputRequest,
    ) -> Result<RuntimeInputResponse> {
        let input_id = request
            .input_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(next_input_id);
        request.input_id = Some(input_id.clone());
        let outcome = self.session_input_internal(request, None).await?;
        timeline(
            "session_input_response",
            [
                ("session_id", self.session_id.clone()),
                ("input_id", input_id.clone()),
            ],
        );
        Ok(RuntimeInputResponse {
            input_id,
            status: "succeeded".to_string(),
            output_text: Some(outcome.output_text),
        })
    }

    pub(crate) async fn session_input_streaming(
        &self,
        request: RuntimeInputRequest,
        stream: mpsc::Sender<PromptResponseLine>,
    ) -> Result<PromptOutcome> {
        self.session_input_internal(request, Some(stream)).await
    }

    async fn session_input_internal(
        &self,
        request: RuntimeInputRequest,
        stream: Option<mpsc::Sender<PromptResponseLine>>,
    ) -> Result<PromptOutcome> {
        ensure_session_id_matches(&self.session_id, &request.session_id)?;
        let input_id = request
            .input_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(next_input_id);
        let history_seed = runtime_history_to_messages(&request.history);
        if !history_seed.is_empty() {
            let seeded = self.agent.seed_history_if_empty(history_seed).await?;
            timeline(
                "session_history_seed_done",
                [
                    ("session_id", self.session_id.clone()),
                    ("input_id", input_id.clone()),
                    ("seeded", seeded.to_string()),
                ],
            );
        }
        let inbox_mode = parse_inbox_mode(request.inbox_mode.as_deref())?;
        let prompt = runtime_input_blocks_to_text(&request.blocks)?;
        timeline(
            "session_input_start",
            [
                ("session_id", self.session_id.clone()),
                ("input_id", input_id.clone()),
                ("inbox_mode", inbox_mode.as_str().to_string()),
            ],
        );
        let (query, cwd, versions) = {
            let mut state = self.serial.lock().await;
            let had_inner_before = self.agent.session_sandbox_id().await.is_some();
            let runtime_note =
                self.apply_request_cwd(request.cwd.as_deref(), &mut state, !had_inner_before)?;
            (
                build_session_prompt(&prompt, runtime_note.as_deref()),
                state.current_cwd.clone(),
                state.behavior_versions.clone(),
            )
        };

        let (done_tx, done_rx) = oneshot::channel();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.active_prompts
            .insert(input_id.clone(), stream, done_tx, cancel_tx)
            .await;

        let run_result = tokio::select! {
            result = async {
                let completion = self
                    .agent
                    .enqueue_input(
                inbox_mode,
                RunTurnRequest {
                    run_id: Some(input_id.clone()),
                    session_id: self.session_id.clone(),
                    prompt: query,
                    cwd,
                    versions,
                },
            )
                    .await
                    .map_err(anyhow::Error::from)?;
                self.agent
                    .pump_until_idle()
                    .await
                    .map_err(anyhow::Error::from)?;
                completion
                    .await
                    .map_err(|_| anyhow::anyhow!("runtime dropped input completion"))?
                    .map_err(anyhow::Error::from)
            } => result,
            _ = cancel_rx => {
                self.agent.abort_active(false).await;
                self.active_prompts.remove(&input_id).await;
                timeline(
                    "session_input_cancelled",
                    [
                        ("session_id", self.session_id.clone()),
                        ("input_id", input_id),
                    ],
                );
                bail!("prompt cancelled");
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(1), done_rx).await;
        self.active_prompts.remove(&input_id).await;

        match run_result {
            Ok(result) => {
                self.serial.lock().await.prompt_count += 1;
                let output_text = visible_output_text(&result.final_message);
                let inner_sandbox_id = self.agent.session_sandbox_id().await;
                let inner_identity = if inner_sandbox_id.is_some() {
                    Some(
                        self.agent
                            .ensure_session_sandbox_envd_identity(false)
                            .await?,
                    )
                } else {
                    None
                };
                timeline(
                    "session_input_done",
                    [
                        ("session_id", self.session_id.clone()),
                        ("input_id", input_id.clone()),
                        (
                            "inner_sandbox_id",
                            inner_sandbox_id.clone().unwrap_or_default(),
                        ),
                    ],
                );
                Ok(PromptOutcome {
                    output_text,
                    inner_sandbox_id,
                    inner_sandbox_domain: inner_identity
                        .as_ref()
                        .map(|identity| identity.domain.clone()),
                    inner_envd_access_token: inner_identity
                        .as_ref()
                        .map(|identity| identity.envd_access_token.clone()),
                })
            }
            Err(error) => {
                timeline(
                    "session_input_failed",
                    [
                        ("session_id", self.session_id.clone()),
                        ("input_id", input_id.clone()),
                        ("error", error.to_string()),
                    ],
                );
                Err(error)
            }
        }
    }

    pub(crate) async fn session_abort(
        &self,
        request: RuntimeAbortRequest,
    ) -> Result<RuntimeAbortResponse> {
        ensure_session_id_matches(&self.session_id, &request.session_id)?;
        let target_run_id = request.run_id.clone();
        if target_run_id.is_some() && !self.cancel_prompt(target_run_id.as_deref()).await {
            timeline(
                "session_abort_target_not_active",
                [
                    ("session_id", self.session_id.clone()),
                    ("run_id", target_run_id.unwrap_or_default()),
                ],
            );
            return Ok(RuntimeAbortResponse {
                ok: true,
                dropped_pending: 0,
                status: self.agent.actor_status().await,
            });
        }
        let dropped_pending = self.agent.abort_active(request.clear_pending).await;
        if target_run_id.is_none() {
            let _ = self.cancel_prompt(None).await;
        }
        timeline(
            "session_abort_done",
            [
                ("session_id", self.session_id.clone()),
                ("dropped_pending", dropped_pending.to_string()),
                ("reason", request.reason.unwrap_or_default()),
            ],
        );
        Ok(RuntimeAbortResponse {
            ok: true,
            dropped_pending,
            status: self.agent.actor_status().await,
        })
    }

    pub(crate) async fn session_status(&self) -> RuntimeStatusResponse {
        let session = self.agent.session_snapshot().await;
        let transcript_count = session.transcript.len();
        let last_user_hash = last_transcript_text_hash(&session.transcript, TranscriptRole::User);
        let last_assistant_hash =
            last_transcript_text_hash(&session.transcript, TranscriptRole::Assistant);
        let run_ledger = self.agent.run_ledger_snapshot().await;
        let run_count = run_ledger.len();
        let run_ledger_tail = run_ledger.iter().rev().take(8).cloned().collect::<Vec<_>>();
        let last_run_status = run_ledger
            .last()
            .map(|record| format!("{:?}", record.status).to_ascii_lowercase());
        let (steer, prompt, follow_up) = self.agent.inbox_depths().await;
        let active_prompt = self.active_prompt_health().await;
        let runtime_store_load = self.serial.lock().await.runtime_store_load.clone();
        RuntimeStatusResponse {
            ok: true,
            session_id: self.session_id.clone(),
            status: self.agent.actor_status().await,
            runtime_store_load,
            active_run_id: self.agent.active_run_id().await,
            pending_run_count: steer + prompt + follow_up,
            pending_by_mode: PendingByMode {
                prompt,
                steer,
                follow_up,
            },
            run_count,
            transcript_count,
            last_user_hash,
            last_assistant_hash,
            last_run_status,
            run_ledger_tail,
            active_prompt,
        }
    }

    pub(crate) async fn session_transcript(&self) -> RuntimeTranscriptResponse {
        RuntimeTranscriptResponse {
            entries: self.agent.session_snapshot().await.transcript,
        }
    }

    pub(crate) async fn session_run_ledger(&self) -> RuntimeRunLedgerResponse {
        RuntimeRunLedgerResponse {
            runs: self.agent.run_ledger_snapshot().await,
        }
    }

    pub(crate) async fn stage_files(
        &self,
        manifest: StageFilesManifest,
    ) -> Result<serde_json::Value> {
        let current_generation = self.stage_files.lock().await.generation;
        let relative_paths = validate_stage_files_manifest(
            &manifest,
            &self.session_id,
            &self.workspace_root,
            current_generation,
        )?;
        let synced_inner =
            sync_active_session_sandbox_files(&self.workspace_root, &relative_paths).await?;
        persist_stage_files_manifest(&self.workspace_root, &manifest)?;
        let staged_files = manifest.files.len();
        let generation = manifest.generation.or(current_generation);
        *self.stage_files.lock().await = StageFilesState { generation };
        timeline(
            "stage_files_done",
            [
                ("session_id", self.session_id.clone()),
                ("files", staged_files.to_string()),
                ("inner_synced", synced_inner.to_string()),
                (
                    "generation",
                    generation
                        .map(|value| value.to_string())
                        .unwrap_or_default(),
                ),
            ],
        );
        Ok(json!({
            "ok": true,
            "files": staged_files,
            "inner_synced": synced_inner,
            "generation": generation,
        }))
    }

    pub(crate) async fn workspace_file_upload(
        &self,
        request: WorkspaceFileUploadRequest,
    ) -> Result<serde_json::Value> {
        let relative_path = self.workspace_relative_path(&request.path)?;
        let content = base64::engine::general_purpose::STANDARD
            .decode(request.content_b64.as_bytes())
            .context("failed to decode workspace file content")?;
        let local_path = self.workspace_root.join(&relative_path);
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create workspace directory '{}'",
                    parent.display()
                )
            })?;
        }
        let mut file = fs::File::create(&local_path).with_context(|| {
            format!("failed to create workspace file '{}'", local_path.display())
        })?;
        file.write_all(&content).with_context(|| {
            format!("failed to write workspace file '{}'", local_path.display())
        })?;
        let inner_synced =
            upload_active_session_sandbox_file(&self.workspace_root, &relative_path, content)
                .await?;
        Ok(json!({
            "ok": true,
            "path": request.path,
            "workspace_path": relative_path,
            "inner_synced": inner_synced,
        }))
    }

    pub(crate) async fn workspace_file_download(
        &self,
        request: WorkspaceFileDownloadRequest,
    ) -> Result<WorkspaceFileDownloadResponse> {
        let relative_path = self.workspace_relative_path(&request.path)?;
        let content =
            match download_active_session_sandbox_file(&self.workspace_root, &relative_path).await?
            {
                Some(content) => content,
                None => {
                    let local_path = self.workspace_root.join(&relative_path);
                    fs::read(&local_path).with_context(|| {
                        format!("failed to read workspace file '{}'", local_path.display())
                    })?
                }
            };
        Ok(WorkspaceFileDownloadResponse {
            ok: true,
            path: request.path,
            bytes: content.len() as u64,
            content_b64: base64::engine::general_purpose::STANDARD.encode(content),
        })
    }

    fn workspace_relative_path(&self, raw: &str) -> Result<String> {
        let raw = raw.trim();
        if raw.is_empty() {
            bail!("workspace file path must not be empty");
        }
        if raw.contains('\0') || raw.chars().any(|ch| ch.is_control()) {
            bail!("workspace file path contains control characters");
        }
        let path = Path::new(raw);
        let relative = if path.is_absolute() {
            path.strip_prefix(&self.workspace_root)
                .with_context(|| {
                    format!(
                        "workspace file path '{}' is outside workspace '{}'",
                        raw,
                        self.workspace_root.display()
                    )
                })?
                .to_path_buf()
        } else {
            path.to_path_buf()
        };
        let mut parts = Vec::new();
        for component in relative.components() {
            match component {
                std::path::Component::Normal(value) => {
                    parts.push(value.to_string_lossy().to_string())
                }
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    bail!("workspace file path must not contain '..'")
                }
                _ => bail!("workspace file path must be relative to workspace"),
            }
        }
        if parts.is_empty() {
            bail!("workspace file path must not point to workspace root");
        }
        Ok(parts.join("/"))
    }

    pub(crate) async fn ensure_inner(&self, force: bool) -> Result<EnsureInnerResponse> {
        let identity = self
            .agent
            .ensure_session_sandbox_envd_identity(force)
            .await?;
        timeline(
            "ensure_inner_done",
            [
                ("session_id", self.session_id.clone()),
                ("inner_sandbox_id", identity.sandbox_id.clone()),
                ("force", force.to_string()),
            ],
        );
        Ok(EnsureInnerResponse {
            inner_sandbox_id: identity.sandbox_id,
            inner_sandbox_domain: identity.domain,
            inner_envd_access_token: identity.envd_access_token,
        })
    }

    pub(crate) async fn bind_workspace(
        &self,
        request: WorkspaceBindRequest,
    ) -> Result<WorkspaceBindResponse> {
        let binding = SessionSandboxBinding {
            sandbox_id: request.sandbox_id.clone(),
            domain: request.domain.clone(),
            envd_access_token: request.envd_access_token.clone(),
            traffic_access_token: request.traffic_access_token.clone(),
            workspace_root: request.workspace_root.clone(),
            local_workspace_root: self.workspace_root.clone(),
            command_prefix: request.command_prefix.clone(),
            shutdown_command: request.shutdown_command.clone(),
        };
        let identity = self
            .agent
            .bind_session_sandbox(binding, request.replace_existing)
            .await?;
        timeline(
            "workspace_bind_done",
            [
                ("session_id", self.session_id.clone()),
                ("workspace_id", request.workspace_id.clone()),
                ("workspace_runtime_id", request.workspace_runtime_id.clone()),
                ("sandbox_id", identity.sandbox_id.clone()),
                ("workspace_root", request.workspace_root.clone()),
            ],
        );
        Ok(WorkspaceBindResponse {
            ok: true,
            workspace_id: request.workspace_id,
            workspace_runtime_id: request.workspace_runtime_id,
            sandbox_id: identity.sandbox_id,
            workspace_root: request.workspace_root,
        })
    }

    async fn active_prompt_health(&self) -> Option<ActivePromptHealth> {
        let active_run_id = self.agent.active_run_id().await;
        self.active_prompts.health(active_run_id).await
    }

    pub(crate) async fn health_json(&self) -> HealthJsonResponse {
        let generation = self.stage_files.lock().await.generation;
        let inner_sandbox_id = self.agent.session_sandbox_id().await;
        let active_prompt = self.active_prompt_health().await;

        HealthJsonResponse {
            ok: true,
            session_id: self.session_id.clone(),
            generation,
            workspace_root: self.workspace_root.display().to_string(),
            inner_sandbox_id,
            active_prompt,
        }
    }

    async fn cancel_prompt(&self, job_id: Option<&str>) -> bool {
        self.active_prompts.cancel(job_id, &self.session_id).await
    }

    fn apply_request_cwd(
        &self,
        cwd: Option<&str>,
        state: &mut SessionState,
        allow_change: bool,
    ) -> Result<Option<String>> {
        let Some(raw_cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };

        if allow_change {
            if let Some(target) = resolve_session_cwd(&self.workspace_root, raw_cwd) {
                fs::create_dir_all(&target).with_context(|| {
                    format!("failed to create daemon cwd '{}'", target.display())
                })?;
                std::env::set_current_dir(&target).with_context(|| {
                    format!("failed to enter daemon cwd '{}'", target.display())
                })?;
                state.current_cwd = target;
                return Ok(None);
            }
        }

        if state.current_cwd == Path::new(raw_cwd) {
            return Ok(None);
        }

        Ok(Some(format!(
            "ACP session cwd is '{}'. Active runtime cwd stays '{}' for this request.",
            raw_cwd,
            state.current_cwd.display()
        )))
    }

    pub(crate) async fn shutdown_agent(&self) {
        let _guard = self.serial.lock().await;
        self.agent.shutdown().await;
        if let Some(task) = self.event_task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
    }

    pub(crate) async fn shutdown_agent_with_response_lines(&self) -> Vec<PromptResponseLine> {
        let _guard = self.serial.lock().await;
        let sink = hermes_core::AgentEventSink::new();
        let events = self.agent.shutdown_with_event_sink(sink).await;
        if let Some(task) = self.event_task.lock().await.take() {
            task.abort();
            let _ = task.await;
        }
        events
            .into_iter()
            .filter_map(runtime_host_line_from_agent_event)
            .collect()
    }

    pub(crate) async fn shutdown_inner_with_response_lines(&self) -> Vec<PromptResponseLine> {
        let _guard = self.serial.lock().await;
        let sink = hermes_core::AgentEventSink::new();
        let events = self
            .agent
            .shutdown_inner_runtime_with_event_sink(sink)
            .await;
        events
            .into_iter()
            .filter_map(runtime_host_line_from_agent_event)
            .collect()
    }

    pub(crate) fn request_shutdown(&self) {
        if !self.shutdown_requested.swap(true, Ordering::Relaxed) {
            self.shutdown.notify_waiters();
        }
    }
}

fn runtime_history_to_messages(entries: &[RuntimeInputHistoryEntry]) -> Vec<Message> {
    entries
        .iter()
        .filter_map(|entry| {
            let text = entry.text.trim();
            if text.is_empty() {
                return None;
            }
            match entry.role.trim().to_ascii_lowercase().as_str() {
                "system" => Some(Message::new(Role::System, text.to_string())),
                "user" => Some(Message::user(text.to_string())),
                "assistant" => Some(Message::assistant(text.to_string())),
                _ => None,
            }
        })
        .collect()
}

fn last_transcript_text_hash(
    transcript: &[hermes_core::TranscriptEntry],
    role: TranscriptRole,
) -> Option<String> {
    transcript
        .iter()
        .rev()
        .find(|entry| entry.role == role)
        .and_then(|entry| {
            let text = transcript_entry_text(entry);
            (!text.trim().is_empty()).then(|| stable_debug_hash(&text))
        })
}

fn transcript_entry_text(entry: &hermes_core::TranscriptEntry) -> String {
    entry
        .blocks
        .iter()
        .filter_map(|block| match block {
            TranscriptBlock::Text { text } | TranscriptBlock::Reasoning { text } => {
                Some(text.as_str())
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn stable_debug_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
