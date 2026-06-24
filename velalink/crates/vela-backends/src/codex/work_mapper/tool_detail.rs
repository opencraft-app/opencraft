use super::super::events::string_at;
use super::patch::codex_apply_patch_to_unified_diff;
use super::util::{content_text, patch_like_string, path_arg, path_from_value, unknown_detail};
use serde_json::{Value, json};

pub(super) fn mcp_tool_detail(
    tool: &str,
    arguments: &Value,
    result: &Value,
    cwd: Option<&str>,
) -> Value {
    match tool {
        "read_file" | "read" => json!({
            "type": "read",
            "file_path": path_arg(arguments, cwd).unwrap_or_default(),
            "content": content_text(result.get("content")).unwrap_or_default(),
        }),
        "write_file" | "write" | "create_file" => json!({
            "type": "write",
            "file_path": path_arg(arguments, cwd).unwrap_or_default(),
            "content": string_at(arguments, &["content"])
                .or_else(|| content_text(result.get("content")))
                .unwrap_or_default(),
        }),
        "apply_patch" | "apply_diff" | "edit" => edit_detail_from_record(arguments, cwd)
            .unwrap_or_else(|| unknown_detail(arguments.clone(), result.clone())),
        "web_search" | "search" => json!({
            "type": "search",
            "query": string_at(arguments, &["query"]).unwrap_or_default(),
            "mode": if tool == "web_search" { "web" } else { "code" },
        }),
        _ => unknown_detail(arguments.clone(), result.clone()),
    }
}

fn edit_detail_from_record(value: &Value, cwd: Option<&str>) -> Option<Value> {
    let path = path_from_value(value, cwd).unwrap_or_default();
    let diff = patch_like_string(value);
    let content = string_at(value, &["content"]);
    match (diff, content) {
        (Some(diff), _) => {
            if let Some((patch_path, patch_diff)) = codex_apply_patch_to_unified_diff(&diff, cwd) {
                return Some(json!({
                    "type": "edit",
                    "file_path": patch_path,
                    "unified_diff": patch_diff,
                }));
            }
            Some(json!({
                "type": "edit",
                "file_path": path,
                "unified_diff": diff,
            }))
        }
        (None, Some(content)) => {
            if let Some((patch_path, patch_diff)) = codex_apply_patch_to_unified_diff(&content, cwd)
            {
                return Some(json!({
                    "type": "edit",
                    "file_path": patch_path,
                    "unified_diff": patch_diff,
                }));
            }
            Some(json!({
                "type": "edit",
                "file_path": path,
                "new_string": content,
            }))
        }
        _ => None,
    }
}
