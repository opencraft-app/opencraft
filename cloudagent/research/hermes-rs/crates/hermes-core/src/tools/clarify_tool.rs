//! Clarify tool
//!
//! A tool for the agent to ask the user clarifying questions.
//! Matches Python's clarify_tool.py. Returns a structured question
//! for the frontend/CLI layer to present to the user.

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};

/// Maximum number of choices allowed
const MAX_CHOICES: usize = 4;

/// Arguments for the clarify tool
#[derive(JsonSchema, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClarifyArgs {
    /// The clarifying question to ask the user
    question: String,
    /// Optional list of choices (max 4) for the user to pick from
    choices: Option<Vec<String>>,
}

/// Tool for asking the user clarifying questions
pub struct ClarifyTool;

#[async_trait]
impl ToolHandler for ClarifyTool {
    fn name(&self) -> &str {
        "clarify"
    }

    fn description(&self) -> &str {
        "Ask the user a clarifying question when you need more information to proceed. \
        Optionally provide up to 4 choices for the user to select from."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<ClarifyArgs>("clarify", "Ask the user a clarifying question")
    }

    async fn execute(&self, args: Value, _context: ToolContext) -> ToolResult {
        let args: ClarifyArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return ToolResult::error("clarify", format!("Invalid arguments: {}", e)),
        };

        if args.question.trim().is_empty() {
            return ToolResult::error("clarify", "Question must not be empty");
        }

        let (choices, original_choice_count) = normalize_choices(args.choices);

        let mut response = serde_json::json!({
            "type": "clarification",
            "question": args.question,
        });

        if let Some(ref choices) = choices {
            response["choices"] = serde_json::json!(choices);
            response["choiceCount"] = serde_json::json!(choices.len());
        }
        if let Some(count) = original_choice_count {
            response["choicesTruncated"] = serde_json::json!(true);
            response["originalChoiceCount"] = serde_json::json!(count);
        }

        ToolResult::success("clarify", response)
    }
}

fn normalize_choices(choices: Option<Vec<String>>) -> (Option<Vec<String>>, Option<usize>) {
    let Some(choices) = choices else {
        return (None, None);
    };
    if choices.len() <= MAX_CHOICES {
        return (Some(choices), None);
    }

    let original_len = choices.len();
    let other_choice = choices
        .iter()
        .rev()
        .find(|choice| is_other_choice(choice))
        .cloned();
    let mut normalized: Vec<String> = choices
        .into_iter()
        .filter(|choice| !is_other_choice(choice))
        .take(MAX_CHOICES.saturating_sub(usize::from(other_choice.is_some())))
        .collect();
    if let Some(choice) = other_choice {
        normalized.push(choice);
    }
    while normalized.len() > MAX_CHOICES {
        normalized.pop();
    }
    (Some(normalized), Some(original_len))
}

fn is_other_choice(choice: &str) -> bool {
    let normalized = choice.trim().to_lowercase();
    normalized == "other"
        || normalized == "others"
        || normalized == "other questions"
        || normalized.contains("其他")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ToolContext;

    fn default_context() -> ToolContext {
        ToolContext::default()
    }

    #[tokio::test]
    async fn test_clarify_simple_question() {
        let tool = ClarifyTool;
        let result = tool
            .execute(
                serde_json::json!({
                    "question": "Which database do you want to use?"
                }),
                default_context(),
            )
            .await;

        assert!(result.success);
        let parsed: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(parsed["type"], "clarification");
        assert_eq!(parsed["question"], "Which database do you want to use?");
        assert!(parsed.get("choices").is_none());
    }

    #[tokio::test]
    async fn test_clarify_with_choices() {
        let tool = ClarifyTool;
        let result = tool
            .execute(
                serde_json::json!({
                    "question": "Pick a framework:",
                    "choices": ["React", "Vue", "Svelte"]
                }),
                default_context(),
            )
            .await;

        assert!(result.success);
        let parsed: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(parsed["choiceCount"], 3);
        assert_eq!(parsed["choices"][0], "React");
    }

    #[tokio::test]
    async fn test_clarify_truncates_too_many_choices() {
        let tool = ClarifyTool;
        let result = tool
            .execute(
                serde_json::json!({
                    "question": "Pick one:",
                    "choices": ["A", "B", "C", "D", "E", "其他问题"]
                }),
                default_context(),
            )
            .await;

        assert!(result.success);
        let parsed: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(parsed["choiceCount"], 4);
        assert_eq!(parsed["originalChoiceCount"], 6);
        assert_eq!(parsed["choices"][0], "A");
        assert_eq!(parsed["choices"][3], "其他问题");
        assert_eq!(parsed["choicesTruncated"], true);
    }

    #[tokio::test]
    async fn test_clarify_empty_question() {
        let tool = ClarifyTool;
        let result = tool
            .execute(
                serde_json::json!({
                    "question": "   "
                }),
                default_context(),
            )
            .await;

        assert!(!result.success);
        assert!(result.error.unwrap().contains("empty"));
    }

    #[tokio::test]
    async fn test_clarify_max_choices_allowed() {
        let tool = ClarifyTool;
        let result = tool
            .execute(
                serde_json::json!({
                    "question": "Pick one:",
                    "choices": ["A", "B", "C", "D"]
                }),
                default_context(),
            )
            .await;

        assert!(result.success);
        let parsed: Value = serde_json::from_str(&result.content).unwrap();
        assert_eq!(parsed["choiceCount"], 4);
    }
}
