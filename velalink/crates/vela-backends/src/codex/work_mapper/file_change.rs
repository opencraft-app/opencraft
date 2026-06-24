use super::super::events::string_at;
use super::patch::codex_apply_patch_to_unified_diff;
use super::util::{normalize_file_path, patch_like_string, path_from_value, unknown_detail};
use serde_json::{Value, json};

pub(super) fn file_change_detail(changes: &Value, cwd: Option<&str>) -> Value {
    let entries = file_change_entries(changes, cwd);
    let Some(first) = entries.first() else {
        return unknown_detail(json!({ "files": [] }), json!({ "files": [] }));
    };

    if let Some(diff) = first.diff.clone() {
        return json!({
            "type": "edit",
            "file_path": first.path,
            "unified_diff": diff,
        });
    }
    if is_delete_kind(first.kind.as_deref()) {
        return json!({
            "type": "edit",
            "file_path": first.path,
            "unified_diff": delete_unified_diff(&first.path, first.content.as_deref()),
        });
    }
    if let Some(content) = first.content.clone() {
        if let Some((path, diff)) = codex_apply_patch_to_unified_diff(&content, cwd) {
            return json!({
                "type": "edit",
                "file_path": path,
                "unified_diff": diff,
            });
        }
        return json!({
            "type": "edit",
            "file_path": first.path,
            "new_string": content,
        });
    }

    let files = entries
        .into_iter()
        .map(|entry| {
            json!({
                "path": entry.path,
                "kind": entry.kind.unwrap_or_else(|| "unknown".to_string()),
            })
        })
        .collect::<Vec<_>>();
    unknown_detail(json!({ "files": files.clone() }), json!({ "files": files }))
}

#[derive(Clone, Debug)]
struct FileChangeEntry {
    path: String,
    kind: Option<String>,
    diff: Option<String>,
    content: Option<String>,
}

fn file_change_entries(changes: &Value, cwd: Option<&str>) -> Vec<FileChangeEntry> {
    match changes {
        Value::Array(values) => values
            .iter()
            .filter_map(|entry| file_change_entry(entry, cwd, None))
            .collect(),
        Value::Object(map) => map
            .iter()
            .filter_map(|(path, entry)| file_change_entry(entry, cwd, Some(path)))
            .collect(),
        _ => Vec::new(),
    }
}

fn file_change_entry(
    value: &Value,
    cwd: Option<&str>,
    fallback_path: Option<&str>,
) -> Option<FileChangeEntry> {
    let path = path_from_value(value, cwd)
        .or_else(|| fallback_path.map(|path| normalize_file_path(path, cwd)))?;
    Some(FileChangeEntry {
        path,
        kind: string_at(value, &["kind"]).or_else(|| string_at(value, &["type"])),
        diff: patch_like_string(value),
        content: string_at(value, &["content"]),
    })
}

fn is_delete_kind(kind: Option<&str>) -> bool {
    kind.map(|kind| {
        matches!(
            kind.to_ascii_lowercase().as_str(),
            "delete" | "deleted" | "remove" | "removed"
        )
    })
    .unwrap_or(false)
}

fn delete_unified_diff(path: &str, content: Option<&str>) -> String {
    let header = format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ /dev/null");
    let Some(content) = content.filter(|content| !content.is_empty()) else {
        return header;
    };
    let lines = content.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return header;
    }
    let removed = lines
        .iter()
        .map(|line| format!("-{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{header}\n@@ -1,{} +0,0 @@\n{removed}", lines.len())
}
