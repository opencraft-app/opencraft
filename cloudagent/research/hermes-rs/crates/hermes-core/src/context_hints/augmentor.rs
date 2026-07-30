use serde_json::{json, Value};

use crate::tools::ToolResult;

use super::scanner::ContextHintBatch;

pub struct ToolResultAugmentor;

impl ToolResultAugmentor {
    pub fn append_context_hints(result: &mut ToolResult, hints: &ContextHintBatch) {
        if hints.is_empty() {
            return;
        }

        let hint_value = hints.to_json_value();
        let content = result.content.trim();
        if content.is_empty() {
            result.content = json!({ "_hermes_context_hints": hint_value }).to_string();
            return;
        }

        match serde_json::from_str::<Value>(content) {
            Ok(Value::Object(mut object)) => {
                object.insert("_hermes_context_hints".to_string(), hint_value);
                result.content = Value::Object(object).to_string();
            }
            Ok(value) => {
                result.content = json!({
                    "result": value,
                    "_hermes_context_hints": hint_value,
                })
                .to_string();
            }
            Err(_) => {
                result.content.push_str("\n\n");
                result.content.push_str(&hints.to_model_observation());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_hints::{ContextHintBatch, HintFile};

    fn sample_hints() -> ContextHintBatch {
        ContextHintBatch {
            target_dir: "/workspace/pkg".into(),
            files: vec![HintFile {
                relative_path: "pkg/AGENTS.md".into(),
                content: "pkg rules".to_string(),
            }],
        }
    }

    #[test]
    fn augmentor_preserves_json_object_results() {
        let mut result = ToolResult::success("call_1", json!({ "content": "file body" }));

        ToolResultAugmentor::append_context_hints(&mut result, &sample_hints());

        let value: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(value["content"], "file body");
        assert_eq!(
            value["_hermes_context_hints"]["files"][0]["path"],
            "pkg/AGENTS.md"
        );
    }

    #[test]
    fn augmentor_wraps_json_non_object_results() {
        let mut result = ToolResult::success("call_1", vec!["a", "b"]);

        ToolResultAugmentor::append_context_hints(&mut result, &sample_hints());

        let value: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(value["result"][0], "a");
        assert_eq!(
            value["_hermes_context_hints"]["files"][0]["content"],
            "pkg rules"
        );
    }

    #[test]
    fn augmentor_falls_back_to_text_for_non_json_results() {
        let mut result = ToolResult {
            tool_call_id: "call_1".to_string(),
            success: true,
            content: "plain text".to_string(),
            error: None,
        };

        ToolResultAugmentor::append_context_hints(&mut result, &sample_hints());

        assert!(result.content.contains("plain text"));
        assert!(result.content.contains("<subdirectory_context_hints>"));
    }
}
