use super::super::events::{display_value, string_at};
use serde_json::{Value, json};

pub(super) fn unknown_detail(input: Value, output: Value) -> Value {
    json!({
        "type": "unknown",
        "input": input,
        "output": output,
    })
}

pub(super) fn path_arg(value: &Value, cwd: Option<&str>) -> Option<String> {
    path_from_value(value, cwd)
}

pub(super) fn path_from_value(value: &Value, cwd: Option<&str>) -> Option<String> {
    string_at(value, &["path"])
        .or_else(|| string_at(value, &["file_path"]))
        .or_else(|| string_at(value, &["filePath"]))
        .map(|path| normalize_file_path(&path, cwd))
}

pub(super) fn normalize_file_path(path: &str, cwd: Option<&str>) -> String {
    let trimmed = path.trim();
    let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) else {
        return trimmed.to_string();
    };
    let cwd = cwd.trim_end_matches(['/', '\\']);
    for separator in ['/', '\\'] {
        let prefix = format!("{cwd}{separator}");
        if let Some(relative) = trimmed.strip_prefix(&prefix) {
            return relative.to_string();
        }
    }
    trimmed.to_string()
}

pub(super) fn patch_like_string(value: &Value) -> Option<String> {
    for key in ["diff", "patch", "unified_diff", "unifiedDiff"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

pub(super) fn content_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        other => Some(display_value(other)),
    }
}
