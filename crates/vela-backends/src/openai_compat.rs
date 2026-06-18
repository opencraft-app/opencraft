use crate::{BackendAdapter, BackendOutput, BackendSend};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vela_core::EventType;

#[derive(Clone, Debug)]
pub struct OpenAiChatBackendAdapter {
    client: Client,
    base_url: String,
    model: String,
    api_key: String,
}

impl OpenAiChatBackendAdapter {
    pub fn new(
        base_url: impl Into<String>,
        model: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            model: model.into(),
            api_key: api_key.into(),
        }
    }
}

#[async_trait]
impl BackendAdapter for OpenAiChatBackendAdapter {
    async fn send_user_message(&self, input: BackendSend) -> anyhow::Result<Vec<BackendOutput>> {
        let request = ChatCompletionRequest {
            model: self.model.clone(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: input.content,
            }],
            stream: false,
        };
        let response = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&request)
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await?;
        if !status.is_success() || body.get("error").is_some() {
            anyhow::bail!("{}", extract_error_message(&body, status.as_u16()));
        }

        let content = body
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        Ok(vec![
            BackendOutput {
                event_type: EventType::ASSISTANT_MESSAGE_DELTA,
                payload: json!({ "delta": content }),
                raw: Some(body.clone()),
            },
            BackendOutput {
                event_type: EventType::TURN_COMPLETED,
                payload: json!({}),
                raw: Some(body),
            },
        ])
    }
}

#[derive(Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorBody>,
}

#[derive(Deserialize)]
struct ErrorBody {
    message: Option<String>,
}

fn extract_error_message(body: &Value, status: u16) -> String {
    serde_json::from_value::<ErrorEnvelope>(body.clone())
        .ok()
        .and_then(|envelope| envelope.error)
        .and_then(|error| error.message)
        .unwrap_or_else(|| format!("OpenAI-compatible backend returned HTTP {status}"))
}
