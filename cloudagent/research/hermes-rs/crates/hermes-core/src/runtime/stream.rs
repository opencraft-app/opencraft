use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use futures::StreamExt;
use tracing::{debug, error};

use crate::client::{ChatResponse, ChatStreamEvent, ChatStreamResponse, ToolCall};
use crate::error::{Error, Result};
use crate::events::AgentEvent;
use crate::parser::{ToolCallParser, ToolCallStreamParser};
use crate::runtime::agent::AgentExecutor;
use crate::runtime::reasoning::{strip_reasoning_tags, ThinkBlockRouter};
use crate::runtime::tool_calls::{
    extract_tool_calls_from_choice, merge_stream_tool_call, normalize_tool_calls,
    strip_tool_call_markup, StreamingToolCallAccumulator, ToolCallContentRouter,
};
use crate::runtime::tool_loop::check_cancelled;

impl AgentExecutor {
    pub(crate) async fn process_stream(
        &self,
        mut stream: ChatStreamResponse,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<(String, String, Vec<ToolCall>)> {
        let mut parser = ToolCallStreamParser::new().on_tool_call(|tc| {
            let tc_id = tc.id.clone();
            debug!(tool_call_id = %tc_id, name = %tc.function.name, "Early tool call detected");
        });
        let mut content_router = ThinkBlockRouter::default();
        let mut tool_call_router = ToolCallContentRouter::default();
        let mut accumulated_text = String::new();
        let mut accumulated_reasoning = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut native_tool_calls = StreamingToolCallAccumulator::default();
        let mut has_error = false;

        while let Some(event_result) = stream.next().await {
            check_cancelled(cancel.as_ref())?;
            match event_result {
                Ok(event) => {
                    if let Some(reasoning) = extract_reasoning_from_event(&event) {
                        let reasoning = strip_reasoning_tags(&reasoning);
                        if !reasoning.is_empty() {
                            accumulated_reasoning.push_str(&reasoning);
                            self.emit(AgentEvent::Reasoning { text: reasoning }).await;
                        }
                    }

                    if let Some(text) = extract_text_from_event(&event) {
                        let (content_delta, reasoning_delta) = content_router.feed(&text);

                        if !content_delta.is_empty() {
                            let chunk_tool_calls = parser.process_chunk(&content_delta);
                            for tc in chunk_tool_calls {
                                if !tool_calls.iter().any(|existing| existing.id == tc.id) {
                                    tool_calls.push(tc);
                                }
                            }

                            let visible_text = tool_call_router.feed(&content_delta);
                            if !visible_text.is_empty() {
                                accumulated_text.push_str(&visible_text);
                                self.emit(AgentEvent::Content { text: visible_text }).await;
                            }
                        }

                        if !reasoning_delta.is_empty() {
                            accumulated_reasoning.push_str(&reasoning_delta);
                            self.emit(AgentEvent::Reasoning {
                                text: reasoning_delta,
                            })
                            .await;
                        }
                    }

                    native_tool_calls.feed_event(&event);
                }
                Err(e) => {
                    error!(error = %e, "Stream error");
                    has_error = true;
                    break;
                }
            }
        }

        if has_error {
            return Err(Error::Agent("Stream processing failed".to_string()));
        }

        let (remaining_content, remaining_reasoning) = content_router.finish();
        let mut final_visible_text = String::new();
        if !remaining_content.is_empty() {
            let remaining_calls = parser.process_chunk(&remaining_content);
            for tc in remaining_calls {
                merge_stream_tool_call(&mut tool_calls, tc);
            }
            let visible_text = tool_call_router.feed(&remaining_content);
            accumulated_text.push_str(&visible_text);
            final_visible_text.push_str(&visible_text);
        }
        let trailing_visible_text = tool_call_router.finish();
        accumulated_text.push_str(&trailing_visible_text);
        final_visible_text.push_str(&trailing_visible_text);
        accumulated_reasoning.push_str(&remaining_reasoning);
        if !final_visible_text.is_empty() {
            self.emit(AgentEvent::Content {
                text: final_visible_text,
            })
            .await;
        }
        if !remaining_reasoning.is_empty() {
            self.emit(AgentEvent::Reasoning {
                text: remaining_reasoning,
            })
            .await;
        }

        for tc in native_tool_calls.finish() {
            merge_stream_tool_call(&mut tool_calls, tc);
        }

        let mut remaining_parser = ToolCallParser::new();
        let remaining_calls = remaining_parser.parse(&accumulated_text)?;

        for tc in remaining_calls {
            merge_stream_tool_call(&mut tool_calls, tc);
        }

        let tool_calls = normalize_tool_calls(tool_calls)?;
        Ok((accumulated_text, accumulated_reasoning, tool_calls))
    }

    pub(crate) async fn process_response(
        &self,
        response: ChatResponse,
    ) -> Result<(String, String, Vec<ToolCall>)> {
        let choice = response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| Error::ParseResponse("response had no choices".to_string()))?;

        let message = choice.message;
        let raw_content = message.content.unwrap_or_default();
        let content = strip_tool_call_markup(&raw_content);
        let reasoning = message
            .reasoning_content
            .map(|value| strip_reasoning_tags(&value))
            .unwrap_or_default();
        let mut tool_calls = extract_tool_calls_from_choice(message.tool_calls);
        let mut xml_parser = ToolCallParser::new();
        if let Ok(xml_tool_calls) = xml_parser.parse(&raw_content) {
            for tool_call in xml_tool_calls {
                merge_stream_tool_call(&mut tool_calls, tool_call);
            }
        }

        if !content.is_empty() {
            self.emit(AgentEvent::Content {
                text: content.clone(),
            })
            .await;
        }
        if !reasoning.is_empty() {
            self.emit(AgentEvent::Reasoning {
                text: reasoning.clone(),
            })
            .await;
        }

        let tool_calls = normalize_tool_calls(tool_calls)?;
        Ok((content, reasoning, tool_calls))
    }
}

fn extract_text_from_event(event: &ChatStreamEvent) -> Option<String> {
    let mut text = String::new();

    for choice in &event.choices {
        if let Some(content) = &choice.delta.content {
            text.push_str(content);
        }
    }

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn extract_reasoning_from_event(event: &ChatStreamEvent) -> Option<String> {
    let mut reasoning = String::new();

    for choice in &event.choices {
        if let Some(content) = &choice.delta.reasoning_content {
            reasoning.push_str(content);
        }
    }

    if reasoning.is_empty() {
        None
    } else {
        Some(reasoning)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::client::{ChatResponse, Choice, MessageDelta, OpenAIClient, Role, Usage};
    use crate::runtime::agent::{AgentConfig, AgentExecutor};
    use crate::tools::ToolRegistry;

    use super::*;

    #[test]
    fn stream_tool_call_events_preserve_tool_name() {
        let event = crate::client::ChatStreamEvent {
            id: "test".to_string(),
            object: "chat.completion.chunk".to_string(),
            created: 0,
            model: "test".to_string(),
            choices: vec![crate::client::StreamChoice {
                index: 0,
                delta: crate::client::StreamingMessageDelta {
                    role: None,
                    content: Some("Hello ".to_string()),
                    reasoning_content: None,
                    tool_calls: None,
                },
                finish_reason: None,
            }],
        };

        let text = extract_text_from_event(&event);
        assert_eq!(text, Some("Hello ".to_string()));
    }

    #[tokio::test]
    async fn process_response_parses_xml_tool_calls_in_non_stream_mode() {
        let agent = AgentExecutor::new(
            AgentConfig::default(),
            OpenAIClient::new(crate::client::ClientConfig::default()),
            ToolRegistry::new(Duration::from_secs(1)),
        );

        let response = ChatResponse {
            id: "resp_1".to_string(),
            object: "chat.completion".to_string(),
            created: 0,
            model: "demo".to_string(),
            choices: vec![Choice {
                index: 0,
                message: MessageDelta {
                    role: Some(Role::Assistant),
                    content: Some(
                        "<tool_call>{\"name\":\"terminal\",\"arguments\":\"{}\"}</tool_call>"
                            .to_string(),
                    ),
                    reasoning_content: Some("need tool".to_string()),
                    tool_calls: None,
                },
                finish_reason: Some("stop".to_string()),
            }],
            usage: Usage {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
            },
        };

        let (content, reasoning, tool_calls) = agent
            .process_response(response)
            .await
            .expect("response parsed");

        assert_eq!(content, "");
        assert_eq!(reasoning, "need tool");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].function.name, "terminal");
    }
}
