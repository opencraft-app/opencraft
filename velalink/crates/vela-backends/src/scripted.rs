use crate::{
    BackendAdapter, BackendCancel, BackendOutput, BackendOutputSink, BackendProbe, BackendSend,
    BackendStatus, backend_output_channel, emit_backend_outputs,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::Arc};
use tokio::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScriptedAgentCassette {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redaction: Option<String>,
    pub turns: Vec<ScriptedAgentTurn>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScriptedAgentTurn {
    pub prompt: String,
    pub outputs: Vec<BackendOutput>,
}

#[derive(Clone, Debug)]
pub struct ScriptedAgentClient {
    state: Arc<Mutex<ScriptedAgentState>>,
}

#[derive(Debug)]
struct ScriptedAgentState {
    repeated_outputs: Vec<BackendOutput>,
    turn_outputs: VecDeque<Vec<BackendOutput>>,
    prompts: Vec<String>,
    cancels: Vec<String>,
    probes: usize,
}

impl ScriptedAgentClient {
    pub fn repeat(outputs: Vec<BackendOutput>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ScriptedAgentState {
                repeated_outputs: outputs,
                turn_outputs: VecDeque::new(),
                prompts: Vec::new(),
                cancels: Vec::new(),
                probes: 0,
            })),
        }
    }

    pub fn from_turns(outputs: Vec<Vec<BackendOutput>>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ScriptedAgentState {
                repeated_outputs: Vec::new(),
                turn_outputs: VecDeque::from(outputs),
                prompts: Vec::new(),
                cancels: Vec::new(),
                probes: 0,
            })),
        }
    }

    pub fn from_cassette(cassette: ScriptedAgentCassette) -> Self {
        Self::from_turns(
            cassette
                .turns
                .into_iter()
                .map(|turn| turn.outputs)
                .collect(),
        )
    }

    pub async fn prompt_count(&self) -> usize {
        self.state.lock().await.prompts.len()
    }

    pub async fn recorded_prompts(&self) -> Vec<String> {
        self.state.lock().await.prompts.clone()
    }

    pub async fn remaining_turns(&self) -> usize {
        self.state.lock().await.turn_outputs.len()
    }

    pub async fn cancel_count(&self) -> usize {
        self.state.lock().await.cancels.len()
    }

    pub async fn probe_count(&self) -> usize {
        self.state.lock().await.probes
    }
}

#[derive(Clone, Debug)]
pub struct RecordingAgentClient<B> {
    inner: Arc<B>,
    provider: String,
    model: Option<String>,
    turns: Arc<Mutex<Vec<ScriptedAgentTurn>>>,
}

impl<B> RecordingAgentClient<B> {
    pub fn new(inner: Arc<B>, provider: impl Into<String>, model: Option<&str>) -> Self {
        Self {
            inner,
            provider: provider.into(),
            model: model.map(str::to_string),
            turns: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn to_cassette(&self) -> ScriptedAgentCassette {
        ScriptedAgentCassette {
            provider: self.provider.clone(),
            model: self.model.clone(),
            recorded_at: None,
            redaction: Some("recorded canonical backend outputs only".to_string()),
            turns: self.turns.lock().await.clone(),
        }
    }
}

#[async_trait]
impl BackendAdapter for ScriptedAgentClient {
    async fn probe(&self) -> anyhow::Result<BackendProbe> {
        self.state.lock().await.probes += 1;
        Ok(BackendProbe {
            status: BackendStatus::Available,
            message: Some("scripted agent available".to_string()),
        })
    }

    async fn cancel(&self, input: BackendCancel) -> anyhow::Result<()> {
        self.state.lock().await.cancels.push(input.session_id);
        Ok(())
    }

    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        let mut state = self.state.lock().await;
        state.prompts.push(input.content);
        let outputs = if let Some(outputs) = state.turn_outputs.pop_front() {
            outputs
        } else {
            state.repeated_outputs.clone()
        };
        drop(state);
        emit_backend_outputs(sink, outputs).await
    }
}

#[async_trait]
impl<B> BackendAdapter for RecordingAgentClient<B>
where
    B: BackendAdapter + 'static,
{
    async fn probe(&self) -> anyhow::Result<BackendProbe> {
        self.inner.probe().await
    }

    async fn cancel(&self, input: BackendCancel) -> anyhow::Result<()> {
        self.inner.cancel(input).await
    }

    async fn stream_user_message(
        &self,
        input: BackendSend,
        sink: BackendOutputSink,
    ) -> anyhow::Result<()> {
        let prompt = input.content.clone();
        let (recording_sink, mut receiver) = backend_output_channel(32);
        let stream = self.inner.stream_user_message(input, recording_sink);
        tokio::pin!(stream);
        let mut outputs = Vec::new();

        loop {
            tokio::select! {
                result = &mut stream => {
                    result?;
                    while let Some(output) = receiver.recv().await {
                        let output = output?;
                        sink.send(output.clone()).await?;
                        outputs.push(output);
                    }
                    break;
                }
                output = receiver.recv() => {
                    match output {
                        Some(output) => {
                            let output = output?;
                            sink.send(output.clone()).await?;
                            outputs.push(output);
                        }
                        None => {
                            stream.await?;
                            break;
                        }
                    }
                }
            }
        }

        self.turns
            .lock()
            .await
            .push(ScriptedAgentTurn { prompt, outputs });
        Ok(())
    }
}
