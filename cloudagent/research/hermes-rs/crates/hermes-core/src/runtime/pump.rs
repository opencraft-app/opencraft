use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::sync::oneshot;

use crate::error::{Error, Result};
use crate::events::{AgentEvent, AgentEventSink};
use crate::runtime::ids::{next_run_id, next_turn_id};
use crate::runtime::transcript::append_events_to_transcript;
use crate::runtime::{
    ActiveRunCancel, AgentRuntime, InboxMode, QueuedRun, RunTurnRequest, RunTurnResult,
};
use crate::turn::{TurnContext, TurnState, TurnStatus};

impl AgentRuntime {
    pub async fn run_turn(&self, request: RunTurnRequest) -> Result<RunTurnResult> {
        let completion = self.enqueue_input(InboxMode::Prompt, request).await?;
        self.pump_until_idle().await?;
        completion
            .await
            .map_err(|_| Error::Agent("runtime dropped run completion".to_string()))?
    }

    pub async fn enqueue_input(
        &self,
        mode: InboxMode,
        request: RunTurnRequest,
    ) -> Result<oneshot::Receiver<Result<RunTurnResult>>> {
        let resolved_behavior = self.behavior_registry.resolve(&request.versions)?;
        let (completion_tx, completion_rx) = oneshot::channel();
        let run_id = request.run_id.clone().unwrap_or_else(next_run_id);
        let run = QueuedRun {
            run_id,
            turn_id: next_turn_id(),
            mode,
            request,
            resolved_behavior,
            completion: Some(completion_tx),
        };
        {
            let mut actor = self.actor.lock().await;
            actor.enqueue_run(run);
        }
        if matches!(mode, InboxMode::Steer) {
            self.signal_active_cancel().await;
        }
        self.persist_state().await?;
        Ok(completion_rx)
    }

    pub async fn abort_active(&self, clear_pending: bool) -> usize {
        let dropped = self.actor.lock().await.abort_active(clear_pending);
        self.signal_active_cancel().await;
        let dropped_count = dropped.len();
        for mut run in dropped {
            if let Some(completion) = run.completion.take() {
                let _ = completion.send(Err(Error::Agent("run canceled by abort".to_string())));
            }
        }
        let _ = self.persist_state().await;
        dropped_count
    }

    pub async fn pump_until_idle(&self) -> Result<()> {
        let _pump_guard = self.pump_lock.lock().await;
        loop {
            let queued = {
                let mut actor = self.actor.lock().await;
                actor.begin_next_run()
            };

            let Some(mut queued) = queued else {
                return Ok(());
            };
            let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
            {
                let mut active = self.active_cancel.lock().await;
                *active = Some(ActiveRunCancel {
                    run_id: queued.run_id.clone(),
                    flag: cancel_flag.clone(),
                });
            }

            let turn = TurnState::queued(TurnContext {
                turn_id: queued.turn_id.clone(),
                run_id: queued.run_id.clone(),
                source: queued.mode.as_str().to_string(),
                prompt: queued.request.prompt.clone(),
                cwd: queued.request.cwd.clone(),
                versions: queued.request.versions.clone(),
            });
            let turn_context = turn.context.clone();
            {
                let mut session = self.session.lock().await;
                session.session_id = queued.request.session_id.clone();
                session.cwd = queued.request.cwd.clone();
                session.begin_turn(TurnState {
                    status: TurnStatus::Running,
                    ..turn
                });
            }
            self.persist_state().await?;

            let forward = self.agent.event_forwarder().await;
            let sink = if let Some(forward) = forward {
                let (run_tx, mut run_rx) = tokio::sync::mpsc::channel(128);
                let run_id = queued.run_id.clone();
                tokio::spawn(async move {
                    while let Some(event) = run_rx.recv().await {
                        let _ = forward
                            .send(AgentEvent::RunScoped {
                                run_id: run_id.clone(),
                                event: Box::new(event),
                            })
                            .await;
                    }
                });
                AgentEventSink::with_forward(Some(run_tx))
            } else {
                AgentEventSink::new()
            };
            let result = self
                .agent
                .run_with_event_sink(
                    queued.request.prompt,
                    sink.clone(),
                    Some(cancel_flag),
                    Some(turn_context),
                )
                .await;
            let events = sink.events().await;
            match result {
                Ok(message) => {
                    {
                        let mut session = self.session.lock().await;
                        append_events_to_transcript(
                            &mut session,
                            &queued.turn_id,
                            &queued.run_id,
                            &events,
                        );
                        session.append_assistant_message(
                            queued.turn_id.clone(),
                            queued.run_id.clone(),
                            message.content.clone(),
                        );
                        session.finish_turn(TurnStatus::Completed);
                    }
                    self.actor.lock().await.complete_run(&queued.run_id);
                    self.clear_active_cancel(&queued.run_id).await;
                    self.persist_state().await?;
                    if let Some(completion) = queued.completion.take() {
                        let _ = completion.send(Ok(RunTurnResult {
                            final_message: message,
                            events,
                            resolved_behavior: queued.resolved_behavior,
                        }));
                    }
                }
                Err(error) => {
                    {
                        let mut session = self.session.lock().await;
                        append_events_to_transcript(
                            &mut session,
                            &queued.turn_id,
                            &queued.run_id,
                            &events,
                        );
                        if error.to_string().contains("canceled by abort") {
                            session.finish_turn(TurnStatus::Cancelled);
                        } else {
                            session.finish_turn(TurnStatus::Failed);
                        }
                    }
                    self.actor.lock().await.fail_run(&queued.run_id, &error);
                    self.clear_active_cancel(&queued.run_id).await;
                    self.persist_state().await?;
                    if let Some(completion) = queued.completion.take() {
                        let _ = completion.send(Err(error));
                    }
                    return Ok(());
                }
            }
        }
    }

    pub(crate) async fn signal_active_cancel(&self) {
        if let Some(active) = self.active_cancel.lock().await.as_ref() {
            active.flag.store(true, Ordering::SeqCst);
        }
    }

    pub(crate) async fn clear_active_cancel(&self, run_id: &str) {
        let mut active = self.active_cancel.lock().await;
        if active
            .as_ref()
            .is_some_and(|current| current.run_id == run_id)
        {
            *active = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use crate::behavior::BehaviorVersions;
    use crate::client::{ClientConfig, OpenAIClient, Role};
    use crate::error::Error;
    use crate::runtime::agent::{AgentConfig, AgentExecutor};
    use crate::runtime::ids::tests::test_runtime;
    use crate::runtime::store::RuntimeStore;
    use crate::runtime::{AgentStatus, InboxMode, RunRecordStatus, RunTurnRequest};
    use crate::tools::ToolRegistry;
    use crate::turn::TurnStatus;

    fn chat_response(content: &str) -> String {
        serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-test",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2
            }
        })
        .to_string()
    }

    #[tokio::test]
    async fn run_turn_is_enqueue_then_pump() {
        let runtime = test_runtime(0);

        let err = runtime
            .run_turn(RunTurnRequest {
                run_id: None,
                session_id: "session_1".to_string(),
                prompt: "hello".to_string(),
                cwd: PathBuf::from("."),
                versions: BehaviorVersions::default(),
            })
            .await
            .unwrap_err();

        assert!(matches!(err, Error::MaxIterationsExceeded { .. }));
        let session = runtime.session_snapshot().await;
        assert!(session.active_turn.is_none());
        assert_eq!(
            session.last_turn.as_ref().map(|turn| &turn.status),
            Some(&TurnStatus::Failed)
        );
        let ledger = runtime.run_ledger_snapshot().await;
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].status, RunRecordStatus::Failed);
    }

    #[tokio::test]
    async fn prompt_turns_send_restored_conversation_history() {
        let mut server = mockito::Server::new_async().await;
        let first = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(chat_response("你好，我记住了。"))
            .create_async()
            .await;
        let store = RuntimeStore::new(std::env::temp_dir().join(format!(
            "hermes-runtime-history-test-{}",
            std::process::id()
        )));
        let _ = std::fs::remove_dir_all(store.root());
        let runtime = crate::runtime::AgentRuntime::from_agent(AgentExecutor::new(
            AgentConfig {
                model: "gpt-test".to_string(),
                max_iterations: 1,
                stream: false,
                ..AgentConfig::default()
            },
            OpenAIClient::new(ClientConfig {
                base_url: server.url(),
                api_key: None,
                timeout: Duration::from_secs(5),
                max_context_length: 128_000,
            }),
            ToolRegistry::new(Duration::from_secs(1)),
        ))
        .with_store(store.clone());

        runtime
            .run_turn(RunTurnRequest {
                run_id: None,
                session_id: "session_1".to_string(),
                prompt: "你好".to_string(),
                cwd: PathBuf::from("."),
                versions: BehaviorVersions::default(),
            })
            .await
            .expect("first turn succeeds");
        first.assert_async().await;

        let second = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::Regex(r#""content":"你好""#.to_string()),
                mockito::Matcher::Regex(r#""content":"你好，我记住了。""#.to_string()),
                mockito::Matcher::Regex(r#""content":"我刚刚和你打过招呼吗""#.to_string()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(chat_response("打过，你刚刚说了你好。"))
            .create_async()
            .await;

        runtime
            .run_turn(RunTurnRequest {
                run_id: None,
                session_id: "session_1".to_string(),
                prompt: "我刚刚和你打过招呼吗".to_string(),
                cwd: PathBuf::from("."),
                versions: BehaviorVersions::default(),
            })
            .await
            .expect("second turn succeeds");
        second.assert_async().await;

        let conversation = runtime.conversation().await;
        let visible_history: Vec<_> = conversation
            .iter()
            .map(|message| (&message.role, message.content.as_str()))
            .collect();
        assert_eq!(
            visible_history,
            vec![
                (&Role::User, "你好"),
                (&Role::Assistant, "你好，我记住了。"),
                (&Role::User, "我刚刚和你打过招呼吗"),
                (&Role::Assistant, "打过，你刚刚说了你好。"),
            ]
        );

        let restored = crate::runtime::AgentRuntime::from_agent(AgentExecutor::new(
            AgentConfig {
                model: "gpt-test".to_string(),
                max_iterations: 1,
                stream: false,
                ..AgentConfig::default()
            },
            OpenAIClient::new(ClientConfig {
                base_url: server.url(),
                api_key: None,
                timeout: Duration::from_secs(5),
                max_context_length: 128_000,
            }),
            ToolRegistry::new(Duration::from_secs(1)),
        ))
        .with_store(store);
        restored.restore_from_store().await.expect("store restored");
        let restored_history = restored.conversation().await;
        assert_eq!(restored_history.len(), 4);
        assert_eq!(restored_history[0].content, "你好");
        assert_eq!(restored_history[1].content, "你好，我记住了。");
        assert_eq!(restored_history[2].content, "我刚刚和你打过招呼吗");
        assert_eq!(restored_history[3].content, "打过，你刚刚说了你好。");
    }

    #[tokio::test]
    async fn steer_preempts_prompt_and_follow_up() {
        let runtime = test_runtime(0);
        let _prompt = runtime
            .enqueue_input(
                InboxMode::Prompt,
                RunTurnRequest {
                    run_id: None,
                    session_id: "session_1".to_string(),
                    prompt: "normal".to_string(),
                    cwd: PathBuf::from("."),
                    versions: BehaviorVersions::default(),
                },
            )
            .await
            .expect("prompt enqueued");
        let _follow = runtime
            .enqueue_input(
                InboxMode::FollowUp,
                RunTurnRequest {
                    run_id: None,
                    session_id: "session_1".to_string(),
                    prompt: "later".to_string(),
                    cwd: PathBuf::from("."),
                    versions: BehaviorVersions::default(),
                },
            )
            .await
            .expect("follow-up enqueued");
        let _steer = runtime
            .enqueue_input(
                InboxMode::Steer,
                RunTurnRequest {
                    run_id: None,
                    session_id: "session_1".to_string(),
                    prompt: "now".to_string(),
                    cwd: PathBuf::from("."),
                    versions: BehaviorVersions::default(),
                },
            )
            .await
            .expect("steer enqueued");

        assert_eq!(runtime.actor_status().await, AgentStatus::Queued);
        assert_eq!(runtime.inbox_depths().await, (1, 1, 1));
        let err = runtime.pump_until_idle().await;
        assert!(err.is_ok());
        let ledger = runtime.run_ledger_snapshot().await;
        assert_eq!(ledger[0].status, RunRecordStatus::Queued);
        assert_eq!(ledger[2].inbox_mode, InboxMode::Steer);
    }
}
