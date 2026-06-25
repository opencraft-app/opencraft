use async_trait::async_trait;
use serde_json::json;
use vela_core::{BackendModel, EventType, ReasoningEffortOption};

use crate::{VelaEngineConfig, runner::run_turn};

pub struct VelaEngineBackendAdapter {
    config: VelaEngineConfig,
}

impl VelaEngineBackendAdapter {
    pub fn new(config: VelaEngineConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &VelaEngineConfig {
        &self.config
    }
}

#[async_trait]
impl vela_backends::BackendAdapter for VelaEngineBackendAdapter {
    fn capabilities(&self) -> vela_backends::BackendCapabilities {
        vela_backends::BackendCapabilities {
            streaming: true,
            cancel: false,
            permission_requests: false,
            structured_diff: true,
            session_agent_config: true,
        }
    }

    async fn probe(&self) -> anyhow::Result<vela_backends::BackendProbe> {
        if !self.config.is_configured() {
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
        if !self.config.is_configured() {
            return Ok(Vec::new());
        }
        Ok(vec![BackendModel {
            id: self.config.model.clone(),
            label: self.config.model.clone(),
            description: Some("Configured Vela built-in engine model".to_string()),
            is_default: true,
            reasoning_efforts: common_reasoning_effort_options(),
            metadata: Default::default(),
        }])
    }

    async fn stream_user_message(
        &self,
        input: vela_backends::BackendSend,
        sink: vela_backends::BackendOutputSink,
    ) -> anyhow::Result<()> {
        self.config.validate()?;
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
                "model": self.config.model,
            }),
        ))
        .await?;

        match run_turn(&self.config, input).await {
            Ok(outputs) => {
                for output in outputs {
                    sink.send(output).await?;
                }
                sink.send(vela_backends::BackendOutput::event(
                    EventType::TURN_COMPLETED,
                    json!({
                        "turn_id": turn_id,
                        "last_agent_message": null,
                    }),
                ))
                .await?;
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
