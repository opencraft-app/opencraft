use std::collections::BTreeMap;

use crate::client::{ChatStreamEvent, ToolCall};
use crate::error::{Error, Result};
use serde_json::Value;

#[derive(Debug, Default)]
pub(crate) struct StreamingToolCallAccumulator {
    tool_calls: BTreeMap<usize, StreamingToolCallState>,
}

#[derive(Debug, Default)]
struct StreamingToolCallState {
    id: Option<String>,
    name: String,
    arguments: String,
}

impl StreamingToolCallAccumulator {
    pub(crate) fn feed_event(&mut self, event: &ChatStreamEvent) {
        for choice in &event.choices {
            if let Some(delta_tool_calls) = &choice.delta.tool_calls {
                for delta in delta_tool_calls {
                    let state = self.tool_calls.entry(delta.index).or_default();
                    if let Some(id) = delta.id.as_ref().filter(|id| !id.is_empty()) {
                        state.id = Some(id.clone());
                    }
                    if let Some(function) = &delta.function {
                        if !function.name.is_empty() {
                            if state.name.is_empty() || function.name.starts_with(&state.name) {
                                state.name = function.name.clone();
                            } else if !state.name.ends_with(&function.name) {
                                state.name.push_str(&function.name);
                            }
                        }
                        if !function.arguments.is_empty() {
                            state.arguments.push_str(&function.arguments);
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn finish(self) -> Vec<ToolCall> {
        self.tool_calls
            .into_iter()
            .map(|(index, state)| ToolCall {
                id: state.id.unwrap_or_else(|| {
                    if state.name.is_empty() {
                        format!("call_stream_{}", index)
                    } else {
                        format!("call_stream_{}_{}", index, state.name)
                    }
                }),
                function: crate::client::ToolCallFunction {
                    name: state.name,
                    arguments: state.arguments,
                },
            })
            .collect()
    }
}

pub(crate) fn extract_tool_calls_from_choice(
    deltas: Option<Vec<crate::client::ToolCallDelta>>,
) -> Vec<ToolCall> {
    deltas
        .unwrap_or_default()
        .into_iter()
        .filter_map(|delta| {
            let function = delta.function?;
            Some(ToolCall {
                id: delta
                    .id
                    .unwrap_or_else(|| format!("call_choice_{}_{}", delta.index, function.name)),
                function,
            })
        })
        .collect()
}

pub(crate) fn merge_stream_tool_call(tool_calls: &mut Vec<ToolCall>, tool_call: ToolCall) {
    if let Some(existing) = tool_calls
        .iter_mut()
        .find(|existing| existing.id == tool_call.id)
    {
        if existing.function.name.is_empty() {
            existing.function.name = tool_call.function.name;
        }
        if !tool_call.function.arguments.is_empty() {
            existing
                .function
                .arguments
                .push_str(&tool_call.function.arguments);
        }
    } else {
        tool_calls.push(tool_call);
    }
}

pub(crate) fn normalize_tool_calls(tool_calls: Vec<ToolCall>) -> Result<Vec<ToolCall>> {
    tool_calls
        .into_iter()
        .map(normalize_tool_call)
        .collect::<Result<Vec<_>>>()
}

fn normalize_tool_call(mut tool_call: ToolCall) -> Result<ToolCall> {
    let tool_name = tool_call.function.name.trim();
    if tool_name.is_empty() {
        return Err(Error::InvalidToolArgs {
            name: "<unknown>".to_string(),
            details: "tool call function name is empty".to_string(),
        });
    }

    tool_call.function.name = tool_name.to_string();
    tool_call.function.arguments =
        normalize_tool_arguments(&tool_call.function.name, &tool_call.function.arguments)?;
    Ok(tool_call)
}

fn normalize_tool_arguments(tool_name: &str, arguments: &str) -> Result<String> {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return Ok("{}".to_string());
    }

    let value = serde_json::from_str::<Value>(trimmed).map_err(|error| Error::InvalidToolArgs {
        name: tool_name.to_string(),
        details: format!("function.arguments must be a valid JSON object string: {error}"),
    })?;
    if !value.is_object() {
        return Err(Error::InvalidToolArgs {
            name: tool_name.to_string(),
            details: "function.arguments must decode to a JSON object".to_string(),
        });
    }

    serde_json::to_string(&value).map_err(Error::JsonDecode)
}

#[derive(Default)]
pub(crate) struct ToolCallContentRouter {
    pending: String,
    inside_tool_call: bool,
}

impl ToolCallContentRouter {
    pub(crate) fn feed(&mut self, chunk: &str) -> String {
        self.pending.push_str(chunk);
        self.drain_ready(false)
    }

    pub(crate) fn finish(&mut self) -> String {
        self.drain_ready(true)
    }

    fn drain_ready(&mut self, flush_all: bool) -> String {
        const OPEN: &str = "<tool_call";
        const CLOSE: &str = "</tool_call";
        let mut content = String::new();

        loop {
            if self.inside_tool_call {
                if let Some(index) = find_ascii_case_insensitive(&self.pending, CLOSE) {
                    let close_end = self.pending[index..]
                        .find('>')
                        .map(|offset| index + offset + 1);
                    if let Some(close_end) = close_end {
                        self.pending.drain(..close_end);
                        self.inside_tool_call = false;
                        continue;
                    }
                }

                if flush_all {
                    self.pending.clear();
                }
                break;
            }

            if let Some(index) = find_ascii_case_insensitive(&self.pending, OPEN) {
                content.push_str(&self.pending[..index]);
                if let Some(open_end) = self.pending[index..]
                    .find('>')
                    .map(|offset| index + offset + 1)
                {
                    self.pending.drain(..open_end);
                    self.inside_tool_call = true;
                    continue;
                }

                self.pending.drain(..index);
                break;
            }

            let keep = if flush_all {
                0
            } else {
                longest_suffix_prefix_match_case_insensitive(&self.pending, OPEN)
            };
            let flush_len = self.pending.len().saturating_sub(keep);
            if flush_len == 0 {
                break;
            }

            content.push_str(&self.pending[..flush_len]);
            self.pending.drain(..flush_len);
            break;
        }

        content
    }
}

fn longest_suffix_prefix_match(value: &str, marker: &str) -> usize {
    let max = value.len().min(marker.len().saturating_sub(1));
    for len in (1..=max).rev() {
        if value.ends_with(&marker[..len]) {
            return len;
        }
    }
    0
}

fn longest_suffix_prefix_match_case_insensitive(value: &str, marker: &str) -> usize {
    let lowered = value.to_ascii_lowercase();
    longest_suffix_prefix_match(&lowered, marker)
}

fn find_ascii_case_insensitive(value: &str, marker: &str) -> Option<usize> {
    value.to_ascii_lowercase().find(marker)
}

pub(crate) fn strip_tool_call_markup(content: &str) -> String {
    let mut router = ToolCallContentRouter::default();
    let mut visible = router.feed(content);
    visible.push_str(&router.finish());
    visible
}

#[cfg(test)]
mod tests {
    use crate::client::{ToolCall, ToolCallFunction};

    use super::*;

    #[test]
    fn merge_stream_tool_call_preserves_name_and_arguments() {
        let mut tool_calls = vec![ToolCall {
            id: "call_0_datetime".to_string(),
            function: ToolCallFunction {
                name: "datetime".to_string(),
                arguments: "{\"format\":".to_string(),
            },
        }];

        merge_stream_tool_call(
            &mut tool_calls,
            ToolCall {
                id: "call_0_datetime".to_string(),
                function: ToolCallFunction {
                    name: "datetime".to_string(),
                    arguments: "\"%Y-%m-%d\"}".to_string(),
                },
            },
        );

        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].function.name, "datetime");
        assert_eq!(
            tool_calls[0].function.arguments,
            "{\"format\":\"%Y-%m-%d\"}"
        );
    }

    #[test]
    fn extract_tool_calls_from_choice_handles_non_streaming_calls() {
        let tool_calls = extract_tool_calls_from_choice(Some(vec![crate::client::ToolCallDelta {
            index: 0,
            id: Some("call_1".to_string()),
            call_type: Some("function".to_string()),
            function: Some(ToolCallFunction {
                name: "datetime".to_string(),
                arguments: "{\"timezone\":\"UTC\"}".to_string(),
            }),
        }]));

        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_1");
        assert_eq!(tool_calls[0].function.name, "datetime");
    }

    #[test]
    fn extract_tool_calls_from_choice_ignores_empty_entries() {
        let tool_calls = extract_tool_calls_from_choice(Some(vec![crate::client::ToolCallDelta {
            index: 0,
            id: None,
            call_type: None,
            function: None,
        }]));

        assert!(tool_calls.is_empty());
    }

    #[test]
    fn normalize_tool_calls_compacts_valid_json_arguments() {
        let normalized = normalize_tool_calls(vec![ToolCall {
            id: "call_1".to_string(),
            function: ToolCallFunction {
                name: " terminal ".to_string(),
                arguments: " { \"command\" : \"pwd\" } ".to_string(),
            },
        }])
        .expect("valid tool call should normalize");

        assert_eq!(normalized[0].function.name, "terminal");
        assert_eq!(normalized[0].function.arguments, "{\"command\":\"pwd\"}");
    }

    #[test]
    fn normalize_tool_calls_turns_empty_arguments_into_object() {
        let normalized = normalize_tool_calls(vec![ToolCall {
            id: "call_1".to_string(),
            function: ToolCallFunction {
                name: "datetime".to_string(),
                arguments: "".to_string(),
            },
        }])
        .expect("empty arguments represent no-arg function calls");

        assert_eq!(normalized[0].function.arguments, "{}");
    }

    #[test]
    fn normalize_tool_calls_rejects_malformed_arguments() {
        let error = normalize_tool_calls(vec![ToolCall {
            id: "call_bad".to_string(),
            function: ToolCallFunction {
                name: "terminal".to_string(),
                arguments: "{\"command\":".to_string(),
            },
        }])
        .expect_err("malformed arguments must not enter history");

        assert!(error.to_string().contains("Invalid tool arguments"));
    }

    #[test]
    fn normalize_tool_calls_rejects_non_object_arguments() {
        let error = normalize_tool_calls(vec![ToolCall {
            id: "call_bad".to_string(),
            function: ToolCallFunction {
                name: "terminal".to_string(),
                arguments: "\"pwd\"".to_string(),
            },
        }])
        .expect_err("arguments must be JSON objects");

        assert!(error.to_string().contains("JSON object"));
    }

    #[test]
    fn streaming_tool_call_accumulator_merges_split_native_deltas() {
        let mut accumulator = StreamingToolCallAccumulator::default();

        accumulator.feed_event(&crate::client::ChatStreamEvent {
            id: "evt_1".to_string(),
            object: "chat.completion.chunk".to_string(),
            created: 0,
            model: "test-model".to_string(),
            choices: vec![crate::client::StreamChoice {
                index: 0,
                delta: crate::client::StreamingMessageDelta {
                    role: Some(crate::client::Role::Assistant),
                    content: None,
                    reasoning_content: None,
                    tool_calls: Some(vec![crate::client::StreamingToolCallDelta {
                        index: 0,
                        id: Some("call_function_terminal_1".to_string()),
                        call_type: Some("function".to_string()),
                        function: Some(ToolCallFunction {
                            name: "terminal".to_string(),
                            arguments: r#"{"command":"pwd"#.to_string(),
                        }),
                    }]),
                },
                finish_reason: None,
            }],
        });

        accumulator.feed_event(&crate::client::ChatStreamEvent {
            id: "evt_2".to_string(),
            object: "chat.completion.chunk".to_string(),
            created: 0,
            model: "test-model".to_string(),
            choices: vec![crate::client::StreamChoice {
                index: 0,
                delta: crate::client::StreamingMessageDelta {
                    role: Some(crate::client::Role::Assistant),
                    content: None,
                    reasoning_content: None,
                    tool_calls: Some(vec![crate::client::StreamingToolCallDelta {
                        index: 0,
                        id: None,
                        call_type: Some("function".to_string()),
                        function: Some(ToolCallFunction {
                            name: String::new(),
                            arguments: r#" && cat hello.txt"}"#.to_string(),
                        }),
                    }]),
                },
                finish_reason: Some("tool_calls".to_string()),
            }],
        });

        let tool_calls = accumulator.finish();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0].id, "call_function_terminal_1");
        assert_eq!(tool_calls[0].function.name, "terminal");
        assert_eq!(
            tool_calls[0].function.arguments,
            r#"{"command":"pwd && cat hello.txt"}"#
        );
    }

    #[test]
    fn tool_call_router_hides_xml_from_visible_content() {
        let mut router = ToolCallContentRouter::default();

        let first = router.feed("Before <tool_call>{\"name\":\"datetime\"}");
        let second = router.feed("{\"arguments\":{}}</tool_call> after");
        let rest = router.finish();

        assert_eq!(first, "Before ");
        assert_eq!(second, " after");
        assert_eq!(rest, "");
    }

    #[test]
    fn tool_call_router_keeps_plain_text_streaming() {
        let mut router = ToolCallContentRouter::default();

        let first = router.feed("Halo ");
        let second = router.feed("hermes!");
        let rest = router.finish();

        assert_eq!(first, "Halo ");
        assert_eq!(second, "hermes!");
        assert_eq!(rest, "");
    }

    #[test]
    fn tool_call_router_hides_split_tool_call_open_tag() {
        let mut router = ToolCallContentRouter::default();

        let first = router.feed("Before <tool_ca");
        let second = router.feed("ll>{\"name\":\"datetime\"}</tool_call> after");
        let rest = router.finish();

        assert_eq!(first, "Before ");
        assert_eq!(second, " after");
        assert_eq!(rest, "");
    }
}
