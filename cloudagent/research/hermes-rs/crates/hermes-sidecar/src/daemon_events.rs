use std::collections::HashMap;
use std::sync::Arc;

use hermes_core::AgentEvent;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::event_projection::runtime_host_prompt_line;
use crate::protocol::{ActivePromptHealth, PromptResponseLine};
use crate::session_api::parse_tool_json;
use crate::telemetry::timeline;

#[derive(Clone, Default)]
pub(crate) struct ActivePromptRegistry {
    sinks: Arc<Mutex<HashMap<String, ActivePrompt>>>,
}

#[derive(Debug)]
struct ActivePrompt {
    job_id: String,
    stream: Option<mpsc::Sender<PromptResponseLine>>,
    done: Option<oneshot::Sender<()>>,
    cancel: Option<oneshot::Sender<()>>,
}

impl ActivePromptRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn insert(
        &self,
        job_id: String,
        stream: Option<mpsc::Sender<PromptResponseLine>>,
        done: oneshot::Sender<()>,
        cancel: oneshot::Sender<()>,
    ) {
        self.sinks.lock().await.insert(
            job_id.clone(),
            ActivePrompt {
                job_id,
                stream,
                done: Some(done),
                cancel: Some(cancel),
            },
        );
    }

    pub(crate) async fn remove(&self, job_id: &str) {
        self.sinks.lock().await.remove(job_id);
    }

    pub(crate) async fn cancel(&self, job_id: Option<&str>, session_id: &str) -> bool {
        let cancel = {
            let mut active = self.sinks.lock().await;
            if let Some(job_id) = job_id {
                active
                    .get_mut(job_id)
                    .and_then(|prompt| prompt.cancel.take())
            } else {
                active
                    .values_mut()
                    .next()
                    .and_then(|prompt| prompt.cancel.take())
            }
        };
        if let Some(cancel) = cancel {
            let _ = cancel.send(());
            timeline(
                "prompt_cancel_requested",
                [("session_id", session_id.to_string())],
            );
            true
        } else {
            false
        }
    }

    pub(crate) async fn health(&self, active_run_id: Option<String>) -> Option<ActivePromptHealth> {
        let guard = self.sinks.lock().await;
        active_run_id
            .as_deref()
            .and_then(|run_id| guard.get(run_id))
            .or_else(|| guard.values().next())
            .map(|prompt| ActivePromptHealth {
                job_id: prompt.job_id.clone(),
            })
    }

    pub(crate) fn spawn_event_task(
        &self,
        mut event_rx: mpsc::Receiver<AgentEvent>,
    ) -> JoinHandle<()> {
        let active_prompts = self.clone();
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                active_prompts.dispatch_agent_event(event).await;
            }
        })
    }

    async fn dispatch_agent_event(&self, event: AgentEvent) {
        let (run_id, event) = match event {
            AgentEvent::RunScoped { run_id, event } => (Some(run_id), *event),
            event => (None, event),
        };
        match event {
            AgentEvent::ToolStart {
                tool_call_id,
                name,
                arguments,
            } => {
                timeline("tool_exec_start", [("tool", name.clone())]);
                if let Some(stream) = self.stream_for(run_id.as_deref()).await {
                    let _ = stream
                        .send(PromptResponseLine::ToolCall {
                            tool_call_id,
                            name,
                            status: "running".to_string(),
                            raw_input: Some(parse_tool_json(&arguments)),
                        })
                        .await;
                }
            }
            AgentEvent::ToolComplete {
                tool_call_id,
                name,
                result,
            } => {
                let raw_output = parse_tool_json(&result.content);
                timeline(
                    "tool_exec_done",
                    [
                        ("tool_call_id", tool_call_id.clone()),
                        ("tool", name.clone()),
                        ("success", result.success.to_string()),
                    ],
                );
                if let Some(stream) = self.stream_for(run_id.as_deref()).await {
                    let _ = stream
                        .send(PromptResponseLine::ToolCallUpdate {
                            tool_call_id: tool_call_id.clone(),
                            name,
                            status: "done".to_string(),
                            error: None,
                            raw_output: Some(raw_output),
                            content: Some(result.content),
                        })
                        .await;
                }
            }
            AgentEvent::ToolError {
                tool_call_id,
                name,
                error,
            } => {
                timeline(
                    "tool_exec_failed",
                    [("tool", name.clone()), ("error", error.clone())],
                );
                if let Some(stream) = self.stream_for(run_id.as_deref()).await {
                    let _ = stream
                        .send(PromptResponseLine::ToolCallUpdate {
                            tool_call_id: tool_call_id.clone(),
                            name,
                            status: "error".to_string(),
                            error: Some(error.clone()),
                            raw_output: None,
                            content: Some(error),
                        })
                        .await;
                }
            }
            AgentEvent::Reasoning { text } => {
                if text.is_empty() {
                    return;
                }
                if let Some(stream) = self.stream_for(run_id.as_deref()).await {
                    let _ = stream
                        .send(PromptResponseLine::ReasoningDelta { delta: text })
                        .await;
                }
            }
            AgentEvent::Content { text } => {
                if text.is_empty() {
                    return;
                }
                if let Some(stream) = self.stream_for(run_id.as_deref()).await {
                    let _ = stream
                        .send(PromptResponseLine::OutputTextDelta { delta: text })
                        .await;
                }
            }
            AgentEvent::RuntimeHost(event) => {
                timeline(
                    "runtime_host_event",
                    [
                        ("event", event.event.clone()),
                        ("sandbox_id", event.sandbox_id.clone().unwrap_or_default()),
                    ],
                );
                if let Some(stream) = self.stream_for(run_id.as_deref()).await {
                    let _ = stream.send(runtime_host_prompt_line(event)).await;
                }
            }
            AgentEvent::Done { .. } => {
                self.complete(run_id.as_deref()).await;
                timeline("response_done", []);
            }
            AgentEvent::Error { .. } => {
                self.complete(run_id.as_deref()).await;
            }
            _ => {}
        }
    }

    async fn stream_for(&self, run_id: Option<&str>) -> Option<mpsc::Sender<PromptResponseLine>> {
        let guard = self.sinks.lock().await;
        if let Some(run_id) = run_id {
            return guard.get(run_id).and_then(|active| active.stream.clone());
        }
        if guard.len() == 1 {
            guard
                .values()
                .next()
                .and_then(|active| active.stream.clone())
        } else {
            None
        }
    }

    async fn complete(&self, run_id: Option<&str>) {
        let done = {
            let mut guard = self.sinks.lock().await;
            if let Some(run_id) = run_id {
                guard.get_mut(run_id).and_then(|active| active.done.take())
            } else if guard.len() == 1 {
                guard
                    .values_mut()
                    .next()
                    .and_then(|active| active.done.take())
            } else {
                None
            }
        };
        if let Some(done) = done {
            let _ = done.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stream_uses_run_id_when_multiple_prompts_are_active() {
        let registry = ActivePromptRegistry::new();
        let (stream_a, _rx_a) = mpsc::channel(1);
        let (stream_b, _rx_b) = mpsc::channel(1);
        let (done_a, _done_rx_a) = oneshot::channel();
        let (done_b, _done_rx_b) = oneshot::channel();
        let (cancel_a, _cancel_rx_a) = oneshot::channel();
        let (cancel_b, _cancel_rx_b) = oneshot::channel();

        registry
            .insert("run_a".to_string(), Some(stream_a), done_a, cancel_a)
            .await;
        registry
            .insert(
                "run_b".to_string(),
                Some(stream_b.clone()),
                done_b,
                cancel_b,
            )
            .await;

        assert!(registry.stream_for(None).await.is_none());
        assert!(registry.stream_for(Some("run_b")).await.is_some());
    }
}
