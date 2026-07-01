use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use serde_json::json;
use vela_core::{BackendModel, EventType, ReasoningEffortOption};

use crate::{VelaEngineConfig, runner::VelaEngineRunner};

pub struct VelaEngineBackendAdapter {
    config: Arc<RwLock<VelaEngineConfig>>,
    runner: VelaEngineRunner,
}

impl VelaEngineBackendAdapter {
    pub fn new(config: VelaEngineConfig) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            runner: VelaEngineRunner::new(),
        }
    }

    pub fn config(&self) -> VelaEngineConfig {
        self.config
            .read()
            .map(|config| config.clone())
            .unwrap_or_else(|_| VelaEngineConfig::empty())
    }

    pub fn update_config(&self, config: VelaEngineConfig) {
        if let Ok(mut current) = self.config.write() {
            if *current != config {
                self.runner.clear();
            }
            *current = config;
        }
    }
}

#[async_trait]
impl vela_backends::BackendAdapter for VelaEngineBackendAdapter {
    fn capabilities(&self) -> vela_backends::BackendCapabilities {
        vela_backends::BackendCapabilities {
            streaming: true,
            cancel: cfg!(feature = "codex-core-local"),
            permission_requests: false,
            structured_diff: true,
            session_agent_config: true,
        }
    }

    async fn probe(&self) -> anyhow::Result<vela_backends::BackendProbe> {
        let config = self.config();
        if !config.is_configured() {
            return Ok(vela_backends::BackendProbe {
                status: vela_backends::BackendStatus::Unavailable,
                message: Some(
                    "Vela Engine endpoint, key, and model are not configured".to_string(),
                ),
            });
        }
        Ok(vela_backends::BackendProbe {
            status: if cfg!(feature = "codex-core-local") {
                vela_backends::BackendStatus::Available
            } else {
                vela_backends::BackendStatus::Unavailable
            },
            message: if cfg!(feature = "codex-core-local") {
                Some("Vela Engine is compiled with embedded Codex core".to_string())
            } else {
                Some("Vela Engine is not compiled into this velad build".to_string())
            },
        })
    }

    async fn list_models(
        &self,
        _backend: Option<vela_core::BackendKind>,
    ) -> anyhow::Result<Vec<BackendModel>> {
        let config = self.config();
        if !config.is_configured() {
            return Ok(Vec::new());
        }
        Ok(vec![BackendModel {
            id: config.model.clone(),
            label: config.model.clone(),
            description: Some("Configured Vela built-in engine model".to_string()),
            is_default: true,
            reasoning_efforts: common_reasoning_effort_options(),
            metadata: Default::default(),
        }])
    }

    async fn cancel(&self, input: vela_backends::BackendCancel) -> anyhow::Result<()> {
        self.runner.cancel_turn(&input.session_id).await
    }

    async fn stream_user_message(
        &self,
        input: vela_backends::BackendSend,
        sink: vela_backends::BackendOutputSink,
    ) -> anyhow::Result<()> {
        let config = self.config();
        config.validate()?;
        let turn_id = input
            .turn_id
            .as_ref()
            .map(|turn_id| turn_id.as_str().to_string())
            .unwrap_or_else(|| "vela_engine_turn".to_string());
        sink.send(vela_backends::BackendOutput::event(
            EventType::TURN_STARTED,
            json!({
                "turn_id": turn_id,
                "provider": "vela_engine",
                "model": config.model,
            }),
        ))
        .await?;

        match self.runner.run_turn(&config, input).await {
            Ok(outputs) => {
                let has_terminal_output = outputs.iter().any(is_terminal_turn_output);
                for output in outputs {
                    sink.send(output).await?;
                }
                if !has_terminal_output {
                    sink.send(vela_backends::BackendOutput::event(
                        EventType::TURN_COMPLETED,
                        json!({
                            "turn_id": turn_id,
                            "last_agent_message": null,
                        }),
                    ))
                    .await?;
                }
            }
            Err(error) => {
                sink.send(vela_backends::BackendOutput::event(
                    EventType::TURN_FAILED,
                    json!({
                        "turn_id": turn_id,
                        "status": "failed",
                        "error": error.to_string(),
                    }),
                ))
                .await?;
                return Err(error);
            }
        }
        Ok(())
    }
}

fn common_reasoning_effort_options() -> Vec<ReasoningEffortOption> {
    [
        ("off", "Off"),
        ("minimal", "Minimal"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "XHigh"),
    ]
    .into_iter()
    .map(|(id, label)| ReasoningEffortOption {
        id: id.to_string(),
        label: label.to_string(),
        description: None,
        is_default: id == "medium",
        metadata: Default::default(),
    })
    .collect()
}

fn is_terminal_turn_output(output: &vela_backends::BackendOutput) -> bool {
    matches!(
        output.event_type,
        EventType::TURN_COMPLETED | EventType::TURN_FAILED | EventType::TURN_CANCELLED
    )
}

#[cfg(test)]
mod tests {
    use vela_backends::BackendAdapter;

    use super::*;

    #[test]
    fn capabilities_expose_embedded_cancel_support() {
        let adapter = VelaEngineBackendAdapter::new(VelaEngineConfig::empty());

        assert_eq!(
            adapter.capabilities().cancel,
            cfg!(feature = "codex-core-local")
        );
    }

    #[tokio::test]
    async fn cancel_is_adapter_owned_and_idempotent() {
        let adapter = VelaEngineBackendAdapter::new(VelaEngineConfig::empty());

        adapter
            .cancel(vela_backends::BackendCancel {
                session_id: "missing-session".to_string(),
                backend: Some(vela_core::BackendKind::VelaEngine),
            })
            .await
            .expect("missing sessions should be an idempotent cancel");
    }

    #[test]
    fn terminal_turn_outputs_suppress_synthetic_completion() {
        assert!(is_terminal_turn_output(
            &vela_backends::BackendOutput::event(EventType::TURN_CANCELLED, json!({}))
        ));
        assert!(is_terminal_turn_output(
            &vela_backends::BackendOutput::event(EventType::TURN_FAILED, json!({}))
        ));
        assert!(is_terminal_turn_output(
            &vela_backends::BackendOutput::event(EventType::TURN_COMPLETED, json!({}))
        ));
        assert!(!is_terminal_turn_output(
            &vela_backends::BackendOutput::event(EventType::ASSISTANT_MESSAGE_DELTA, json!({}))
        ));
    }
}
