use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Arc};
use tokio::sync::Mutex;
use vela_backends::{BackendAdapter, BackendSend};
use vela_core::{BackendKind, CommandAck, EventSource, EventType, SessionId};
use vela_store::SqliteEventStore;

#[derive(Clone)]
pub struct Runtime<B> {
    store: Arc<SqliteEventStore>,
    backend: Arc<B>,
    running: Arc<Mutex<HashSet<SessionId>>>,
}

#[derive(Clone, Debug)]
pub struct SendUserMessage {
    pub session_id: SessionId,
    pub idempotency_key: String,
    pub content: String,
    pub command_id: Option<vela_core::CommandId>,
}

impl<B> Runtime<B>
where
    B: BackendAdapter + 'static,
{
    pub fn new(store: Arc<SqliteEventStore>, backend: Arc<B>) -> Self {
        Self {
            store,
            backend,
            running: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub async fn create_session(
        &self,
        session_id: SessionId,
        backend: BackendKind,
        working_directory: &str,
    ) -> anyhow::Result<()> {
        self.store
            .create_session(&session_id, backend, working_directory)
            .await?;
        self.store
            .append_event(
                &session_id,
                EventType::SESSION_CREATED,
                EventSource::runtime("vela-runtime"),
                json!({ "backend": backend.as_str(), "working_directory": working_directory }),
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn send_user_message(&self, input: SendUserMessage) -> anyhow::Result<CommandAck> {
        if !self.store.session_exists(&input.session_id).await? {
            return Ok(CommandAck::Rejected(vela_core::RejectedCommandAck {
                code: "session_not_found".to_string(),
                message: "session does not exist".to_string(),
                cursor: None,
                command_id: input.command_id,
                session_id: Some(input.session_id),
            }));
        }

        let command_hash = hash_command(&input);
        if self.running.lock().await.contains(&input.session_id) {
            return Ok(CommandAck::Rejected(vela_core::RejectedCommandAck {
                code: "turn_running".to_string(),
                message: "session already has a running turn".to_string(),
                cursor: None,
                command_id: input.command_id,
                session_id: Some(input.session_id),
            }));
        }
        let acceptance = self
            .store
            .record_idempotency_acceptance(
                &input.session_id,
                &input.idempotency_key,
                &command_hash,
                input.command_id.clone(),
                EventType::USER_MESSAGE_ACCEPTED,
                EventSource::runtime("vela-runtime"),
                json!({ "content": input.content, "command_id": input.command_id }),
            )
            .await?;
        if acceptance.is_hash_mismatch() {
            return Ok(acceptance.ack());
        }
        if acceptance.is_replay() {
            return Ok(acceptance.ack());
        }

        self.running.lock().await.insert(input.session_id.clone());
        self.store
            .append_event(
                &input.session_id,
                EventType::TURN_STARTED,
                EventSource::runtime("vela-runtime"),
                json!({}),
                None,
            )
            .await?;
        let backend_result = self
            .backend
            .send_user_message(BackendSend {
                content: input.content.clone(),
            })
            .await;
        match backend_result {
            Ok(outputs) => {
                for output in outputs {
                    self.store
                        .append_event(
                            &input.session_id,
                            output.event_type,
                            EventSource::backend("pi"),
                            output.payload,
                            output.raw,
                        )
                        .await?;
                }
            }
            Err(error) => {
                self.store
                    .append_event(
                        &input.session_id,
                        EventType::TURN_FAILED,
                        EventSource::runtime("vela-runtime"),
                        json!({ "error": error.to_string() }),
                        None,
                    )
                    .await?;
            }
        }
        self.running.lock().await.remove(&input.session_id);

        Ok(acceptance.ack())
    }
}

fn hash_command(input: &SendUserMessage) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.session_id.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(input.content.as_bytes());
    format!("{:x}", hasher.finalize())
}
