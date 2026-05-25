use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};

use super::{
    add_session_sandbox_metadata, requires_session_sandbox_for_path, session_sandbox_required,
};

/// Tool for listing directory contents.
pub struct FileListTool;

#[derive(JsonSchema, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileListArgs {
    path: String,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
}

#[async_trait]
impl ToolHandler for FileListTool {
    fn name(&self) -> &str {
        "file_list"
    }

    fn description(&self) -> &str {
        "List directory contents. Shows files and subdirectories with metadata."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<FileListArgs>("file_list", "List directory contents")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        let args: FileListArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return ToolResult::error("file_list", format!("Invalid arguments: {}", e)),
        };

        let requires_sandbox = requires_session_sandbox_for_path(&context, &args.path);
        if context.sandbox().is_some() {
            return list_files_with_session_sandbox(json!(args), context).await;
        }
        if requires_sandbox {
            return session_sandbox_required("file_list");
        }

        let path = PathBuf::from(&args.path);

        if !path.exists() {
            return ToolResult::error("file_list", format!("Path does not exist: {}", args.path));
        }

        if !path.is_dir() {
            return ToolResult::error(
                "file_list",
                format!("Path is not a directory: {}", args.path),
            );
        }

        let mut entries = Vec::new();
        list_recursive(
            &path,
            &mut entries,
            args.recursive.unwrap_or(false),
            args.include_hidden.unwrap_or(false),
        );

        entries.sort_by(|a, b| {
            let a_is_dir = a["is_dir"].as_bool().unwrap_or(false);
            let b_is_dir = b["is_dir"].as_bool().unwrap_or(false);

            match (a_is_dir, b_is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a["name"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["name"].as_str().unwrap_or("")),
            }
        });

        ToolResult::success(
            "file_list",
            serde_json::json!({
                "path": args.path,
                "entries": entries,
                "count": entries.len()
            }),
        )
    }
}

fn list_recursive(
    dir: &PathBuf,
    entries: &mut Vec<serde_json::Value>,
    recursive: bool,
    include_hidden: bool,
) {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        if !include_hidden && name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let metadata = entry.metadata().ok();

        let entry_json = serde_json::json!({
            "name": name,
            "path": path.to_string_lossy(),
            "is_dir": path.is_dir(),
            "size": metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            "modified": metadata.as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        });

        entries.push(entry_json);

        if recursive && path.is_dir() {
            list_recursive(&path, entries, recursive, include_hidden);
        }
    }
}

async fn list_files_with_session_sandbox(args: Value, context: ToolContext) -> ToolResult {
    let args: FileListArgs = match serde_json::from_value(args) {
        Ok(value) => value,
        Err(error) => {
            return ToolResult::error("file_list", format!("Invalid arguments: {}", error))
        }
    };
    let Some(sandbox) = context.sandbox() else {
        return ToolResult::error("file_list", "Session sandbox is not available.");
    };
    let remote_path = match sandbox.resolve_path(&args.path) {
        Ok(path) => path,
        Err(error) => return ToolResult::error("file_list", error.to_string()),
    };

    if !sandbox.native_host_configured() {
        return ToolResult::error("file_list", "sandbox-host is required for file_list");
    }
    let mut payload = match sandbox
        .native_call(
            "fs.list",
            json!({
                "path": remote_path,
                "recursive": args.recursive.unwrap_or(false),
                "include_hidden": args.include_hidden.unwrap_or(false),
            }),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => return ToolResult::error("file_list", error.to_string()),
    };
    if let Some(entries) = payload.get_mut("entries").and_then(Value::as_array_mut) {
        for entry in entries.iter_mut() {
            if let Some(path) = entry.get_mut("path") {
                if let Some(remote) = path.as_str() {
                    *path = Value::String(sandbox.display_path(remote));
                }
            }
            let is_dir = entry
                .get("type")
                .and_then(Value::as_str)
                .map(|kind| kind == "dir")
                .unwrap_or(false);
            entry["is_dir"] = Value::Bool(is_dir);
        }
    }
    let mut content = json!({
        "path": args.path,
        "entries": payload.get("entries").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "count": payload.get("entries").and_then(Value::as_array).map(|entries| entries.len()).unwrap_or(0),
    });
    add_session_sandbox_metadata(
        &mut content,
        sandbox.sandbox_id().await,
        sandbox.workspace_root(),
    );
    ToolResult::success("file_list", content)
}
