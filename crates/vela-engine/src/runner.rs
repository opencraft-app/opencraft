use crate::VelaEngineConfig;

pub async fn run_turn(
    config: &VelaEngineConfig,
    input: vela_backends::BackendSend,
) -> anyhow::Result<Vec<vela_backends::BackendOutput>> {
    #[cfg(feature = "codex-core-local")]
    {
        return embedded::run_turn(config, input).await;
    }

    #[cfg(not(feature = "codex-core-local"))]
    {
        let _ = (config, input);
        anyhow::bail!("vela_engine is not compiled with codex-core-local");
    }
}

#[cfg(feature = "codex-core-local")]
mod embedded {
    use std::{path::PathBuf, sync::Arc};

    use codex_core::config::ConfigBuilder;
    use codex_exec_server::{EnvironmentManager, ExecServerRuntimePaths};
    use codex_extension_api::empty_extension_registry;
    use codex_login::AuthManager;
    use codex_protocol::{
        protocol::{EventMsg, Op, SessionSource},
        user_input::UserInput,
    };
    use serde_json::json;
    use vela_core::EventType;

    use crate::{
        VelaEngineConfig,
        chat_completions_bridge::{ChatCompletionsBridge, ChatCompletionsBridgeConfig},
    };

    pub async fn run_turn(
        config: &VelaEngineConfig,
        input: vela_backends::BackendSend,
    ) -> anyhow::Result<Vec<vela_backends::BackendOutput>> {
        let bridge = ChatCompletionsBridge::start(ChatCompletionsBridgeConfig {
            endpoint: config.endpoint.clone(),
            api_key: config.api_key.clone(),
            model: input
                .resolved_agent_config
                .as_ref()
                .and_then(|config| config.config.model.clone())
                .unwrap_or_else(|| config.model.clone()),
        })?;
        let mut codex_config = ConfigBuilder::default()
            .codex_home(bridge.codex_home().to_path_buf())
            .fallback_cwd(Some(PathBuf::from(
                input
                    .working_directory
                    .clone()
                    .unwrap_or_else(|| config.cwd.clone()),
            )))
            .build()
            .await
            .map_err(|err| anyhow::anyhow!("load embedded Codex config: {err}"))?;
        codex_config.ephemeral = true;

        let auth_manager =
            AuthManager::shared_from_config(&codex_config, /*enable_codex_api_key_env*/ false)
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
        let thread_store = codex_core::thread_store_from_config(&codex_config, state_db.clone());
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
        let thread = Arc::clone(&new_thread.thread);
        let mut outputs = vec![vela_backends::BackendOutput::event(
            EventType::WARNING_RAISED,
            json!({
                "code": "vela_engine_trace",
                "message": "embedded Vela Engine thread started",
                "provider": bridge.provider_name(),
                "provider_id": bridge.provider_id(),
                "model": bridge.model(),
                "thread_id": new_thread.thread_id.to_string(),
            }),
        )];

        thread
            .submit(Op::from(vec![UserInput::Text {
                text: input.content,
                text_elements: Vec::new(),
            }]))
            .await
            .map_err(|err| anyhow::anyhow!("submit embedded Codex input: {err}"))?;

        loop {
            let event = thread
                .next_event()
                .await
                .map_err(|err| anyhow::anyhow!("read embedded Codex event: {err}"))?;
            let done = matches!(event.msg, EventMsg::TurnComplete(_));
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
            EventMsg::TurnComplete(_) => None,
            EventMsg::TurnStarted(_) => None,
            _ => None,
        };
        Ok(output)
    }
}
