use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};
use hermes_core::{InboxMode, Message};
use serde_json::{json, Value};

use crate::protocol::RuntimeInputBlock;

pub(crate) fn build_session_prompt(prompt: &str, runtime_note: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(note) = runtime_note {
        out.push_str("Runtime note:\n");
        out.push_str("- ");
        out.push_str(note);
    }
    if !prompt.trim().is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(prompt.trim());
    }
    if out.trim().is_empty() {
        "Answer the user concisely.".to_string()
    } else {
        out
    }
}

pub(crate) fn ensure_session_id_matches(expected: &str, actual: &str) -> Result<()> {
    if actual.trim().is_empty() {
        bail!("session_id must not be empty");
    }
    if actual != expected {
        bail!(
            "request session_id '{}' does not match daemon session '{}'",
            actual,
            expected
        );
    }
    Ok(())
}

pub(crate) fn parse_inbox_mode(raw: Option<&str>) -> Result<InboxMode> {
    match raw.unwrap_or("prompt").trim().to_ascii_lowercase().as_str() {
        "" | "prompt" => Ok(InboxMode::Prompt),
        "steer" => Ok(InboxMode::Steer),
        "followup" | "follow_up" => Ok(InboxMode::FollowUp),
        other => bail!("invalid inbox_mode '{}'", other),
    }
}

pub(crate) fn runtime_input_blocks_to_text(blocks: &[RuntimeInputBlock]) -> Result<String> {
    let mut text = String::new();
    for block in blocks {
        match block {
            RuntimeInputBlock::Text { text: block_text } => {
                let block_text = block_text.trim();
                if block_text.is_empty() {
                    continue;
                }
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(block_text);
            }
        }
    }
    if text.is_empty() {
        bail!("session.input requires at least one non-empty text block");
    }
    Ok(text)
}

pub(crate) fn next_input_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("input_{now}")
}

pub(crate) fn resolve_session_cwd(workspace_root: &Path, raw: &str) -> Option<PathBuf> {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return candidate
            .starts_with(workspace_root)
            .then(|| candidate.to_path_buf());
    }

    let mut resolved = workspace_root.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => resolved.push(value),
            _ => return None,
        }
    }
    Some(resolved)
}

pub(crate) fn parse_tool_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| json!({ "text": raw }))
}

pub(crate) fn visible_output_text(message: &Message) -> String {
    let content = message.content.trim();
    if !content.is_empty() {
        return content.to_string();
    }

    if message
        .reasoning
        .as_deref()
        .is_some_and(|reasoning| !reasoning.trim().is_empty())
    {
        return "The model produced reasoning but no final response.".to_string();
    }

    "No response content was produced.".to_string()
}
