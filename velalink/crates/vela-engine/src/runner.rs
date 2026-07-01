use crate::VelaEngineConfig;

pub struct VelaEngineRunner {
    #[cfg(feature = "codex-core-local")]
    embedded: std::sync::Arc<embedded::EmbeddedRunner>,
}

impl VelaEngineRunner {
    pub fn new() -> Self {
        #[cfg(feature = "codex-core-local")]
        {
            return Self {
                embedded: std::sync::Arc::new(embedded::EmbeddedRunner::new()),
            };
        }

        #[cfg(not(feature = "codex-core-local"))]
        {
            Self {}
        }
    }

    pub fn clear(&self) {
        #[cfg(feature = "codex-core-local")]
        self.embedded.clear();
    }

    pub async fn cancel_turn(&self, session_id: &str) -> anyhow::Result<()> {
        #[cfg(feature = "codex-core-local")]
        {
            return self.embedded.cancel_turn(session_id).await;
        }

        #[cfg(not(feature = "codex-core-local"))]
        {
            let _ = session_id;
            Ok(())
        }
    }

    pub async fn run_turn(
        &self,
        config: &VelaEngineConfig,
        input: vela_backends::BackendSend,
    ) -> anyhow::Result<Vec<vela_backends::BackendOutput>> {
        #[cfg(feature = "codex-core-local")]
        {
            return self.embedded.run_turn(config, input).await;
        }

        #[cfg(not(feature = "codex-core-local"))]
        {
            let _ = (config, input);
            anyhow::bail!("vela_engine is not compiled with codex-core-local");
        }
    }
}

impl Default for VelaEngineRunner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "codex-core-local")]
mod embedded {
    use std::{
        collections::HashMap,
        path::PathBuf,
        sync::{Arc, Mutex, MutexGuard},
    };

    use codex_core::{CodexThread, config::ConfigBuilder};
    use codex_exec_server::{EnvironmentManager, ExecServerRuntimePaths};
    use codex_extension_api::empty_extension_registry;
    use codex_login::AuthManager;
    use codex_protocol::{
        protocol::{EventMsg, Op, SessionSource, TurnAbortReason},
        user_input::UserInput,
    };
    use serde_json::json;
    use vela_core::{EventType, SessionId};

    use crate::{
        VelaEngineConfig,
        chat_completions_bridge::{ChatCompletionsBridge, ChatCompletionsBridgeConfig},
    };

    pub struct EmbeddedRunner {
        sessions: Mutex<HashMap<EmbeddedSessionKey, Arc<EmbeddedSession>>>,
    }

    impl EmbeddedRunner {
        pub fn new() -> Self {
            Self {
                sessions: Mutex::new(HashMap::new()),
            }
        }

        pub fn clear(&self) {
            let sessions = match self.sessions.lock() {
                Ok(mut sessions) => sessions.drain().map(|(_, session)| session).collect(),
                Err(_) => return,
            };
            shutdown_sessions(sessions);
        }

        pub async fn cancel_turn(&self, session_id: &str) -> anyhow::Result<()> {
            let sessions = self.sessions_by_session_id(session_id)?;
            for session in sessions {
                session.cancel_turn().await?;
            }
            Ok(())
        }

        pub async fn run_turn(
            &self,
            config: &VelaEngineConfig,
            input: vela_backends::BackendSend,
        ) -> anyhow::Result<Vec<vela_backends::BackendOutput>> {
            let effective_config = EffectiveTurnConfig::from_input(config, &input);
            let content = input.content;
            let Some(session_id) = input.session_id.as_ref() else {
                let session = Arc::new(EmbeddedSession::start(&effective_config).await?);
                return session.run_turn(content, true).await;
            };
            let key = effective_config.session_key(session_id);
            let (session, was_created) = self
                .get_or_start_session(key.clone(), &effective_config)
                .await?;
            let result = session.run_turn(content, was_created).await;
            if result.is_err() {
                self.remove_session(&key, &session);
                shutdown_sessions(vec![Arc::clone(&session)]);
            }
            result
        }

        async fn get_or_start_session(
            &self,
            key: EmbeddedSessionKey,
            config: &EffectiveTurnConfig,
        ) -> anyhow::Result<(Arc<EmbeddedSession>, bool)> {
            if let Some(session) = self.session(&key)? {
                return Ok((session, false));
            }

            let session = Arc::new(EmbeddedSession::start(config).await?);
            let mut sessions = self.lock_sessions()?;
            if let Some(existing) = sessions.get(&key).cloned() {
                shutdown_sessions(vec![session]);
                return Ok((existing, false));
            }
            sessions.insert(key, Arc::clone(&session));
            Ok((session, true))
        }

        fn session(
            &self,
            key: &EmbeddedSessionKey,
        ) -> anyhow::Result<Option<Arc<EmbeddedSession>>> {
            Ok(self.lock_sessions()?.get(key).cloned())
        }

        fn sessions_by_session_id(
            &self,
            session_id: &str,
        ) -> anyhow::Result<Vec<Arc<EmbeddedSession>>> {
            Ok(self
                .lock_sessions()?
                .iter()
                .filter(|(key, _)| key.session_id == session_id)
                .map(|(_, session)| Arc::clone(session))
                .collect())
        }

        fn remove_session(&self, key: &EmbeddedSessionKey, session: &Arc<EmbeddedSession>) {
            let Ok(mut sessions) = self.sessions.lock() else {
                return;
            };
            if sessions
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.remove(key);
            }
        }

        fn lock_sessions(
            &self,
        ) -> anyhow::Result<MutexGuard<'_, HashMap<EmbeddedSessionKey, Arc<EmbeddedSession>>>>
        {
            self.sessions
                .lock()
                .map_err(|_| anyhow::anyhow!("embedded Vela Engine session cache is poisoned"))
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq, Hash)]
    struct EmbeddedSessionKey {
        session_id: String,
        endpoint: String,
        model: String,
        cwd: String,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct EffectiveTurnConfig {
        endpoint: String,
        api_key: String,
        model: String,
        cwd: String,
    }

    impl EffectiveTurnConfig {
        fn from_input(config: &VelaEngineConfig, input: &vela_backends::BackendSend) -> Self {
            let model = input
                .resolved_agent_config
                .as_ref()
                .and_then(|config| config.config.model.as_ref())
                .filter(|model| !model.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| config.model.clone());
            let cwd = input
                .working_directory
                .as_ref()
                .filter(|cwd| !cwd.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| config.cwd.clone());
            Self {
                endpoint: config.endpoint.clone(),
                api_key: config.api_key.clone(),
                model,
                cwd,
            }
        }

        fn session_key(&self, session_id: &SessionId) -> EmbeddedSessionKey {
            EmbeddedSessionKey {
                session_id: session_id.as_str().to_string(),
                endpoint: self.endpoint.clone(),
                model: self.model.clone(),
                cwd: self.cwd.clone(),
            }
        }
    }

    struct EmbeddedSession {
        _bridge: ChatCompletionsBridge,
        thread: Arc<CodexThread>,
        thread_id: String,
        provider_id: String,
        provider_name: String,
        model: String,
        turn_lock: tokio::sync::Mutex<()>,
    }

    impl EmbeddedSession {
        async fn start(config: &EffectiveTurnConfig) -> anyhow::Result<Self> {
            let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
                endpoint: config.endpoint.clone(),
                api_key: config.api_key.clone(),
                model: config.model.clone(),
            })?;
            let provider_id = bridge.provider_id().to_string();
            let provider_name = bridge.provider_name().to_string();
            let model = bridge.model().to_string();
            let mut codex_config = ConfigBuilder::default()
                .codex_home(bridge.codex_home().to_path_buf())
                .fallback_cwd(Some(PathBuf::from(config.cwd.clone())))
                .build()
                .await
                .map_err(|err| anyhow::anyhow!("load embedded Codex config: {err}"))?;
            codex_config.ephemeral = true;

            let auth_manager = AuthManager::shared_from_config(
                &codex_config,
                /*enable_codex_api_key_env*/ false,
            )
            .await;
            let runtime_paths = if codex_config.codex_self_exe.is_some()
                || codex_config.codex_linux_sandbox_exe.is_some()
            {
                Some(
                    ExecServerRuntimePaths::from_optional_paths(
                        codex_config.codex_self_exe.clone(),
                        codex_config.codex_linux_sandbox_exe.clone(),
                    )
                    .map_err(|err| anyhow::anyhow!("resolve exec runtime paths: {err}"))?,
                )
            } else {
                None
            };
            let environment_manager = Arc::new(if let Some(runtime_paths) = runtime_paths {
                EnvironmentManager::from_codex_home(
                    codex_config.codex_home.clone(),
                    Some(runtime_paths),
                )
                .await
                .map_err(|err| anyhow::anyhow!("create environment manager: {err}"))?
            } else {
                EnvironmentManager::without_environments()
            });
            let state_db = codex_core::init_state_db(&codex_config).await;
            let thread_store =
                codex_core::thread_store_from_config(&codex_config, state_db.clone());
            let installation_id = codex_core::resolve_installation_id(&codex_config.codex_home)
                .await
                .map_err(|err| anyhow::anyhow!("resolve installation id: {err}"))?;
            let manager = codex_core::ThreadManager::new(
                &codex_config,
                Arc::clone(&auth_manager),
                SessionSource::Exec,
                environment_manager,
                empty_extension_registry(),
                None,
                thread_store,
                state_db,
                installation_id,
                None,
            );
            let new_thread = manager
                .start_thread(codex_config)
                .await
                .map_err(|err| anyhow::anyhow!("start embedded Codex thread: {err}"))?;
            Ok(Self {
                _bridge: bridge,
                thread: Arc::clone(&new_thread.thread),
                thread_id: new_thread.thread_id.to_string(),
                provider_id,
                provider_name,
                model,
                turn_lock: tokio::sync::Mutex::new(()),
            })
        }

        async fn run_turn(
            &self,
            content: String,
            was_created: bool,
        ) -> anyhow::Result<Vec<vela_backends::BackendOutput>> {
            let _turn_guard = self.turn_lock.lock().await;
            let mut outputs = vec![self.trace_output(was_created)];

            self.thread
                .submit(Op::from(vec![UserInput::Text {
                    text: content,
                    text_elements: Vec::new(),
                }]))
                .await
                .map_err(|err| anyhow::anyhow!("submit embedded Codex input: {err}"))?;

            loop {
                let event = self
                    .thread
                    .next_event()
                    .await
                    .map_err(|err| anyhow::anyhow!("read embedded Codex event: {err}"))?;
                let done = matches!(
                    event.msg,
                    EventMsg::TurnComplete(_) | EventMsg::TurnAborted(_)
                );
                match embedded_event_to_outputs(event.msg)? {
                    Some(mut event_outputs) => outputs.append(&mut event_outputs),
                    None => {}
                }
                if done {
                    break;
                }
            }
            Ok(outputs)
        }

        async fn cancel_turn(&self) -> anyhow::Result<()> {
            self.thread
                .submit(Op::Interrupt)
                .await
                .map_err(|err| anyhow::anyhow!("interrupt embedded Codex turn: {err}"))?;
            Ok(())
        }

        async fn shutdown(self: Arc<Self>) {
            let _ = self.thread.submit(Op::Shutdown {}).await;
            self.thread.wait_until_terminated().await;
        }

        fn trace_output(&self, was_created: bool) -> vela_backends::BackendOutput {
            vela_backends::BackendOutput::event(
                EventType::WARNING_RAISED,
                json!({
                    "code": "vela_engine_trace",
                    "message": if was_created {
                        "embedded Vela Engine thread started"
                    } else {
                        "embedded Vela Engine thread reused"
                    },
                    "provider": self.provider_name,
                    "provider_id": self.provider_id,
                    "model": self.model,
                    "thread_id": self.thread_id,
                    "thread_reused": !was_created,
                }),
            )
        }
    }

    fn shutdown_sessions(sessions: Vec<Arc<EmbeddedSession>>) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        for session in sessions {
            handle.spawn(session.shutdown());
        }
    }

    fn embedded_event_to_outputs(
        event: EventMsg,
    ) -> anyhow::Result<Option<Vec<vela_backends::BackendOutput>>> {
        let output = match event {
            EventMsg::AgentMessage(event) => Some(vec![vela_backends::BackendOutput::event(
                EventType::ASSISTANT_MESSAGE_DELTA,
                json!({
                    "message_id": "vela_engine_message",
                    "delta": event.message,
                }),
            )]),
            EventMsg::AgentReasoning(event) => Some(vec![vela_backends::BackendOutput::event(
                EventType::ASSISTANT_REASONING_DELTA,
                json!({
                    "reasoning_id": "vela_engine_reasoning",
                    "delta": event.text,
                }),
            )]),
            EventMsg::AgentReasoningRawContent(event) => {
                Some(vec![vela_backends::BackendOutput::event(
                    EventType::ASSISTANT_REASONING_DELTA,
                    json!({
                        "reasoning_id": "vela_engine_reasoning_raw",
                        "delta": event.text,
                    }),
                )])
            }
            EventMsg::StreamError(event) => Some(vec![vela_backends::BackendOutput::event(
                EventType::WARNING_RAISED,
                json!({
                    "code": "vela_engine_stream_error",
                    "message": event.message,
                    "details": event.additional_details,
                }),
            )]),
            EventMsg::Warning(event) | EventMsg::GuardianWarning(event) => {
                Some(vec![vela_backends::BackendOutput::event(
                    EventType::WARNING_RAISED,
                    json!({
                        "code": "vela_engine_warning",
                        "message": event.message,
                    }),
                )])
            }
            EventMsg::Error(event) => anyhow::bail!(event.message),
            EventMsg::TurnAborted(event) => Some(vec![vela_backends::BackendOutput::event(
                EventType::TURN_CANCELLED,
                json!({
                    "reason": turn_abort_reason(&event.reason),
                    "turn_id": event.turn_id,
                    "completed_at": event.completed_at,
                    "duration_ms": event.duration_ms,
                }),
            )]),
            EventMsg::TurnComplete(_) => None,
            EventMsg::TurnStarted(_) => None,
            _ => None,
        };
        Ok(output)
    }

    fn turn_abort_reason(reason: &TurnAbortReason) -> &'static str {
        match reason {
            TurnAbortReason::Interrupted => "user_cancelled",
            TurnAbortReason::Replaced => "replaced",
            TurnAbortReason::ReviewEnded => "review_ended",
            TurnAbortReason::BudgetLimited => "budget_limited",
        }
    }

    #[cfg(test)]
    mod tests {
        use vela_core::{AgentConfig, BackendKind, ResolvedAgentConfig, SessionId};

        use super::*;

        #[test]
        fn session_key_keeps_session_model_and_cwd_boundaries() {
            let config = VelaEngineConfig::new("http://provider", "secret", "default-model", "/a");
            let mut input = vela_backends::BackendSend::new("hello");
            input.session_id = Some(SessionId::from("ses_1"));
            input.working_directory = Some("/b".to_string());
            input.resolved_agent_config = Some(ResolvedAgentConfig {
                backend: BackendKind::VelaEngine,
                config: AgentConfig::with_model(Some("selected-model")),
            });

            let effective = EffectiveTurnConfig::from_input(&config, &input);
            let key = effective.session_key(input.session_id.as_ref().unwrap());

            assert_eq!(key.session_id, "ses_1");
            assert_eq!(key.endpoint, "http://provider");
            assert_eq!(key.model, "selected-model");
            assert_eq!(key.cwd, "/b");
        }
    }
}
