//! File operation tools
//!
//! Tools for reading, writing, searching, and listing files.

use crate::schema::ToolSchema;
use crate::tools::{ToolContext, ToolHandler, ToolResult};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

mod list;
mod search_format;

pub use list::FileListTool;
use search_format::{contains_match, format_search_result, truncate_search_line, wildcard_match};

/// Tool for reading file contents
pub struct FileReadTool;
pub struct ReadFileTool;

#[derive(JsonSchema, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReadArgs {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[async_trait]
impl ToolHandler for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read the contents of a file. Alias for file_read."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<FileReadArgs>("read_file", "Read file contents")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        retag_tool_result(FileReadTool.execute(args, context).await, self.name())
    }
}

#[async_trait]
impl ToolHandler for FileReadTool {
    fn name(&self) -> &str {
        "file_read"
    }

    fn description(&self) -> &str {
        "Read the contents of a file. Supports partial reads with offset and limit parameters."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<FileReadArgs>("file_read", "Read file contents")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        let args: FileReadArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return ToolResult::error("file_read", format!("Invalid arguments: {}", e)),
        };

        if let Some(result) = read_file_with_required_session_sandbox(&args, context).await {
            return result;
        }

        let path = PathBuf::from(&args.path);

        if !path.exists() {
            return ToolResult::error("file_read", format!("File not found: {}", args.path));
        }

        if !path.is_file() {
            return ToolResult::error("file_read", format!("Path is not a file: {}", args.path));
        }

        match std::fs::read_to_string(&path) {
            Ok(content) => {
                let offset = args.offset.unwrap_or(0);
                let limit = args.limit.unwrap_or(usize::MAX);

                let lines: Vec<&str> = content.lines().skip(offset).take(limit).collect();
                let result = lines.join("\n");

                ToolResult::success(
                    "file_read",
                    serde_json::json!({
                        "path": args.path,
                        "content": result,
                        "length": result.len(),
                        "total_lines": content.lines().count()
                    }),
                )
            }
            Err(e) => ToolResult::error("file_read", format!("Failed to read file: {}", e)),
        }
    }
}

/// Tool for writing content to a file
pub struct FileWriteTool;
pub struct WriteFileTool;

#[derive(JsonSchema, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteArgs {
    path: String,
    content: String,
    append: Option<bool>,
}

#[async_trait]
impl ToolHandler for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Write content to a file. Alias for file_write."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<FileWriteArgs>("write_file", "Write content to a file")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        retag_tool_result(FileWriteTool.execute(args, context).await, self.name())
    }
}

#[async_trait]
impl ToolHandler for FileWriteTool {
    fn name(&self) -> &str {
        "file_write"
    }

    fn description(&self) -> &str {
        "Write content to a file. Supports creating new files or overwriting existing ones. Use append=true to add to existing files."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<FileWriteArgs>("file_write", "Write content to a file")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        let args: FileWriteArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return ToolResult::error("file_write", format!("Invalid arguments: {}", e)),
        };

        if let Some(result) = write_file_with_required_session_sandbox(&args, context).await {
            return result;
        }

        let path = PathBuf::from(&args.path);

        if let Some(parent) = path.parent() {
            if !parent.exists() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return ToolResult::error(
                        "file_write",
                        format!("Failed to create directory: {}", e),
                    );
                }
            }
        }

        let result = if args.append.unwrap_or(false) {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| {
                    use std::io::Write;
                    f.write_all(args.content.as_bytes())
                })
        } else {
            std::fs::write(&path, &args.content)
        };

        match result {
            Ok(_) => {
                let metadata = std::fs::metadata(&path).ok();
                ToolResult::success(
                    "file_write",
                    serde_json::json!({
                        "path": args.path,
                        "bytes_written": args.content.len(),
                        "file_size": metadata.map(|m| m.len()).unwrap_or(0)
                    }),
                )
            }
            Err(e) => ToolResult::error("file_write", format!("Failed to write file: {}", e)),
        }
    }
}

async fn read_file_with_session_sandbox(args: Value, context: ToolContext) -> ToolResult {
    let args: FileReadArgs = match serde_json::from_value(args) {
        Ok(value) => value,
        Err(error) => {
            return ToolResult::error("file_read", format!("Invalid arguments: {}", error))
        }
    };
    let Some(sandbox) = context.sandbox() else {
        return ToolResult::error("file_read", "Session sandbox is not available.");
    };
    let remote_path = match sandbox.resolve_path(&args.path) {
        Ok(path) => path,
        Err(error) => return ToolResult::error("file_read", error.to_string()),
    };

    if !sandbox.native_host_configured() {
        return ToolResult::error("file_read", "sandbox-host is required for file_read");
    }
    let payload = match sandbox
        .native_call(
            "fs.read",
            json!({
                "path": remote_path,
                "offset": args.offset.unwrap_or(0) + 1,
                "limit": args.limit.unwrap_or(usize::MAX),
            }),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => return ToolResult::error("file_read", error.to_string()),
    };
    let content = payload
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut content = file_read_result(&args.path, content, &payload);
    add_session_sandbox_metadata(
        &mut content,
        sandbox.sandbox_id().await,
        sandbox.workspace_root(),
    );
    ToolResult::success("file_read", content)
}

async fn read_file_with_required_session_sandbox(
    args: &FileReadArgs,
    context: ToolContext,
) -> Option<ToolResult> {
    let requires_sandbox = requires_session_sandbox_for_path(&context, &args.path);
    if context.sandbox().is_some() {
        return Some(read_file_with_session_sandbox(json!(args), context).await);
    }
    if requires_sandbox {
        return Some(session_sandbox_required("file_read"));
    }
    None
}

fn file_read_result(path: &str, content: String, payload: &Value) -> Value {
    json!({
        "path": path,
        "content": content,
        "length": content.len(),
        "start_line": payload.get("start_line").and_then(Value::as_u64).unwrap_or(1),
        "end_line": payload.get("end_line").and_then(Value::as_u64).unwrap_or(0),
        "total_lines": payload.get("total_lines").and_then(Value::as_u64).unwrap_or(0),
        "total_bytes": payload.get("total_bytes").and_then(Value::as_u64).unwrap_or(0),
        "max_read_bytes": payload.get("max_read_bytes").and_then(Value::as_u64).unwrap_or(0),
        "truncated": payload.get("truncated").and_then(Value::as_bool).unwrap_or(false),
        "truncated_by_bytes": payload.get("truncated_by_bytes").and_then(Value::as_bool).unwrap_or(false),
        "next_offset": payload.get("next_offset").cloned().unwrap_or(Value::Null),
        "hint": payload.get("hint").cloned().unwrap_or(Value::Null),
    })
}

async fn write_file_with_session_sandbox(args: Value, context: ToolContext) -> ToolResult {
    let args: FileWriteArgs = match serde_json::from_value(args) {
        Ok(value) => value,
        Err(error) => {
            return ToolResult::error("file_write", format!("Invalid arguments: {}", error))
        }
    };
    let Some(sandbox) = context.sandbox() else {
        return ToolResult::error("file_write", "Session sandbox is not available.");
    };
    let remote_path = match sandbox.resolve_path(&args.path) {
        Ok(path) => path,
        Err(error) => return ToolResult::error("file_write", error.to_string()),
    };

    if !sandbox.native_host_configured() {
        return ToolResult::error("file_write", "sandbox-host is required for file_write");
    }
    let payload = match sandbox
        .native_call(
            "fs.write",
            json!({
                "path": remote_path,
                "content": args.content,
                "append": args.append.unwrap_or(false),
            }),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => return ToolResult::error("file_write", error.to_string()),
    };
    let mut content = json!({
        "path": args.path,
        "bytes_written": payload.get("bytes").and_then(Value::as_u64).unwrap_or(0),
        "file_size": payload.get("file_size").and_then(Value::as_u64).unwrap_or(0),
    });
    add_session_sandbox_metadata(
        &mut content,
        sandbox.sandbox_id().await,
        sandbox.workspace_root(),
    );
    ToolResult::success("file_write", content)
}

async fn write_file_with_required_session_sandbox(
    args: &FileWriteArgs,
    context: ToolContext,
) -> Option<ToolResult> {
    let requires_sandbox = requires_session_sandbox_for_path(&context, &args.path);
    if context.sandbox().is_some() {
        return Some(write_file_with_session_sandbox(json!(args), context).await);
    }
    if requires_sandbox {
        return Some(session_sandbox_required("file_write"));
    }
    None
}

/// Tool for searching file contents
pub struct FileSearchTool;
pub struct SearchFilesTool;

#[derive(JsonSchema, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSearchArgs {
    path: String,
    pattern: String,
    target: Option<String>,
    #[serde(alias = "file_glob")]
    file_glob: Option<String>,
    #[serde(alias = "case_sensitive")]
    case_sensitive: Option<bool>,
    limit: Option<usize>,
    offset: Option<usize>,
    #[serde(alias = "output_mode")]
    output_mode: Option<String>,
    context: Option<usize>,
    #[serde(alias = "max_results")]
    max_results: Option<usize>,
}

#[async_trait]
impl ToolHandler for SearchFilesTool {
    fn name(&self) -> &str {
        "search_files"
    }

    fn description(&self) -> &str {
        "Search file contents or discover files. Use target=\"content\" for grep-like content search and target=\"files\" for filename/glob discovery."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<FileSearchArgs>("search_files", "Search files")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        retag_tool_result(FileSearchTool.execute(args, context).await, self.name())
    }
}

#[async_trait]
impl ToolHandler for FileSearchTool {
    fn name(&self) -> &str {
        "file_search"
    }

    fn description(&self) -> &str {
        "Search for a pattern within files. Recursively searches directories for matching lines."
    }

    fn schema(&self) -> ToolSchema {
        ToolSchema::from_type::<FileSearchArgs>("file_search", "Search files for pattern")
    }

    async fn execute(&self, args: Value, context: ToolContext) -> ToolResult {
        let args: FileSearchArgs = match serde_json::from_value(args) {
            Ok(a) => a,
            Err(e) => return ToolResult::error("file_search", format!("Invalid arguments: {}", e)),
        };

        if let Some(result) = search_files_with_required_session_sandbox(&args, context).await {
            return result;
        }

        let path = PathBuf::from(&args.path);
        let target = args.target.clone().unwrap_or_else(|| "content".to_string());
        if !matches!(target.as_str(), "content" | "grep" | "files" | "find") {
            return ToolResult::error("file_search", format!("Unsupported target: {}", target));
        }
        let case_sensitive = args.case_sensitive.unwrap_or(true);
        let escaped_pattern = regex::escape(&args.pattern);
        let re = match regex::RegexBuilder::new(&escaped_pattern)
            .case_insensitive(!case_sensitive)
            .build()
        {
            Ok(re) => re,
            Err(e) => {
                return ToolResult::error("file_search", format!("Invalid regex pattern: {}", e))
            }
        };

        let mut results = Vec::new();
        let limit = args.limit.or(args.max_results).unwrap_or(50).max(1);
        let offset = args.offset.unwrap_or(0);
        let output_mode = args
            .output_mode
            .clone()
            .unwrap_or_else(|| "content".to_string());
        let content_detail_output =
            matches!(target.as_str(), "content" | "grep") && output_mode == "content";
        let max_results = if content_detail_output || matches!(target.as_str(), "files" | "find") {
            offset.saturating_add(limit).max(1)
        } else {
            1000
        };
        let context_lines = if content_detail_output {
            args.context.unwrap_or(0).min(20)
        } else {
            0
        };

        fn search_recursive(
            dir: &PathBuf,
            re: &regex::Regex,
            results: &mut Vec<serde_json::Value>,
            max_results: usize,
            context_lines: usize,
        ) {
            if results.len() >= max_results {
                return;
            }

            let entries = match std::fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };

            for entry in entries.flatten() {
                if results.len() >= max_results {
                    break;
                }

                let path = entry.path();

                if path.is_dir() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if !name.starts_with('.')
                            && name != "node_modules"
                            && name != "target"
                            && name != "__pycache__"
                        {
                            search_recursive(&path, re, results, max_results, context_lines);
                        }
                    }
                } else if path.is_file() {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        let lines: Vec<&str> = content.lines().collect();
                        let mut emitted_lines = std::collections::HashSet::new();
                        for (line_num, line) in lines.iter().enumerate() {
                            if re.is_match(line) {
                                let start = line_num.saturating_sub(context_lines);
                                let end = (line_num + context_lines + 1).min(lines.len());
                                for (idx, line) in lines.iter().enumerate().take(end).skip(start) {
                                    if results.len() >= max_results {
                                        break;
                                    }
                                    if !emitted_lines.insert(idx) {
                                        continue;
                                    }
                                    let (content, line_truncated) = truncate_search_line(line, 500);
                                    results.push(serde_json::json!({
                                        "file": path.to_string_lossy(),
                                        "path": path.to_string_lossy(),
                                        "line": idx + 1,
                                        "content": content,
                                        "text": content,
                                        "line_truncated": line_truncated,
                                        "is_context": idx != line_num,
                                    }));
                                }

                                if results.len() >= max_results {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if matches!(target.as_str(), "files" | "find") {
            fn find_recursive(
                dir: &PathBuf,
                pattern: &str,
                file_glob: Option<&str>,
                case_sensitive: bool,
                results: &mut Vec<serde_json::Value>,
                max_results: usize,
            ) {
                if results.len() >= max_results {
                    return;
                }
                let entries = match std::fs::read_dir(dir) {
                    Ok(e) => e,
                    Err(_) => return,
                };
                for entry in entries.flatten() {
                    if results.len() >= max_results {
                        break;
                    }
                    let path = entry.path();
                    let name = entry.file_name().to_string_lossy().to_string();
                    let path_text = path.to_string_lossy().to_string();
                    let matched = contains_match(&name, pattern, case_sensitive)
                        || contains_match(&path_text, pattern, case_sensitive);
                    let globbed = file_glob
                        .map(|glob| wildcard_match(glob, &name) || wildcard_match(glob, &path_text))
                        .unwrap_or(true);
                    if matched && globbed {
                        let metadata = entry.metadata().ok();
                        results.push(serde_json::json!({
                            "file": path_text,
                            "path": path.to_string_lossy(),
                            "name": name,
                            "type": if path.is_dir() { "dir" } else { "file" },
                            "size": metadata.as_ref().map(|m| m.len()).unwrap_or(0)
                        }));
                    }
                    if path.is_dir() {
                        find_recursive(
                            &path,
                            pattern,
                            file_glob,
                            case_sensitive,
                            results,
                            max_results,
                        );
                    }
                }
            }
            if path.is_dir() {
                find_recursive(
                    &path,
                    &args.pattern,
                    args.file_glob.as_deref(),
                    case_sensitive,
                    &mut results,
                    max_results,
                );
            } else if path.is_file() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                let path_text = path.to_string_lossy();
                if (contains_match(name, &args.pattern, case_sensitive)
                    || contains_match(&path_text, &args.pattern, case_sensitive))
                    && args
                        .file_glob
                        .as_deref()
                        .map(|glob| wildcard_match(glob, name) || wildcard_match(glob, &path_text))
                        .unwrap_or(true)
                {
                    results.push(serde_json::json!({
                        "file": path_text,
                        "path": path.to_string_lossy(),
                        "name": name,
                        "type": "file",
                    }));
                }
            } else {
                return ToolResult::error(
                    "file_search",
                    format!("Path does not exist: {}", args.path),
                );
            }
        } else if path.is_dir() {
            search_recursive(&path, &re, &mut results, max_results, context_lines);
        } else if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                let lines: Vec<&str> = content.lines().collect();
                let mut emitted_lines = std::collections::HashSet::new();
                for (line_num, line) in lines.iter().enumerate() {
                    if re.is_match(line) {
                        let start = line_num.saturating_sub(context_lines);
                        let end = (line_num + context_lines + 1).min(lines.len());
                        for (idx, line) in lines.iter().enumerate().take(end).skip(start) {
                            if results.len() >= max_results {
                                break;
                            }
                            if !emitted_lines.insert(idx) {
                                continue;
                            }
                            let (content, line_truncated) = truncate_search_line(line, 500);
                            results.push(serde_json::json!({
                                "file": path.to_string_lossy(),
                                "path": path.to_string_lossy(),
                                "line": idx + 1,
                                "content": content,
                                "text": content,
                                "line_truncated": line_truncated,
                                "is_context": idx != line_num,
                            }));
                        }

                        if results.len() >= max_results {
                            break;
                        }
                    }
                }
            }
        } else {
            return ToolResult::error("file_search", format!("Path does not exist: {}", args.path));
        }

        let formatted =
            format_search_result(results, &target, &output_mode, offset, limit, max_results);

        ToolResult::success(
            "file_search",
            serde_json::json!({
                "pattern": args.pattern,
                "path": args.path,
                "target": target,
                "output_mode": output_mode,
                "matches": formatted.get("matches").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
                "files": formatted.get("files").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
                "counts": formatted.get("counts").cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new())),
                "count": formatted.get("count").and_then(Value::as_u64).unwrap_or(0),
                "total_count": formatted.get("total_count").and_then(Value::as_u64).unwrap_or(0),
                "offset": offset,
                "limit": limit,
                "truncated": formatted.get("truncated").and_then(Value::as_bool).unwrap_or(false),
                "next_offset": formatted.get("next_offset").cloned().unwrap_or(Value::Null),
            }),
        )
    }
}

async fn search_files_with_session_sandbox(args: Value, context: ToolContext) -> ToolResult {
    let args: FileSearchArgs = match serde_json::from_value(args) {
        Ok(value) => value,
        Err(error) => {
            return ToolResult::error("file_search", format!("Invalid arguments: {}", error))
        }
    };
    let Some(sandbox) = context.sandbox() else {
        return ToolResult::error("file_search", "Session sandbox is not available.");
    };
    let remote_path = match sandbox.resolve_path(&args.path) {
        Ok(path) => path,
        Err(error) => return ToolResult::error("file_search", error.to_string()),
    };

    if !sandbox.native_host_configured() {
        return ToolResult::error("file_search", "sandbox-host is required for file_search");
    }
    let target = args.target.clone().unwrap_or_else(|| "content".to_string());
    let file_glob = args.file_glob.clone();
    let limit = args.limit.or(args.max_results).unwrap_or(50);
    let output_mode = args
        .output_mode
        .clone()
        .unwrap_or_else(|| "content".to_string());
    let mut payload = match sandbox
        .native_call(
            "fs.search",
            json!({
                "path": remote_path,
                "pattern": args.pattern,
                "target": target,
                "case_sensitive": args.case_sensitive.unwrap_or(true),
                "file_glob": file_glob,
                "limit": limit,
                "offset": args.offset.unwrap_or(0),
                "output_mode": output_mode,
                "context": args.context.unwrap_or(0),
            }),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => return ToolResult::error("file_search", error.to_string()),
    };
    if let Some(matches) = payload.get_mut("matches").and_then(Value::as_array_mut) {
        for entry in matches {
            if let Some(path) = entry.get_mut("path") {
                if let Some(remote) = path.as_str() {
                    *path = Value::String(sandbox.display_path(remote));
                }
            }
            if let Some(path) = entry.get("path").cloned() {
                entry["file"] = path;
            }
            if let Some(text) = entry.get("text").cloned() {
                entry["content"] = text;
            }
            if entry.get("file").is_none() {
                if let Some(path) = entry.get("path").cloned() {
                    entry["file"] = path;
                }
            }
        }
    }
    if let Some(files) = payload.get_mut("files").and_then(Value::as_array_mut) {
        for entry in files {
            if let Some(remote) = entry.as_str() {
                *entry = Value::String(sandbox.display_path(remote));
            }
        }
    }
    if let Some(counts) = payload.get_mut("counts").and_then(Value::as_object_mut) {
        let mut rewritten = serde_json::Map::new();
        for (path, count) in std::mem::take(counts) {
            rewritten.insert(sandbox.display_path(&path), count);
        }
        *counts = rewritten;
    }
    let mut content = json!({
        "pattern": args.pattern,
        "path": args.path,
        "target": payload.get("target").and_then(Value::as_str).unwrap_or("content"),
        "output_mode": payload.get("output_mode").and_then(Value::as_str).unwrap_or("content"),
        "matches": payload.get("matches").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "files": payload.get("files").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "counts": payload.get("counts").cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new())),
        "count": payload.get("count").and_then(Value::as_u64).unwrap_or(0),
        "total_count": payload.get("total_count").and_then(Value::as_u64).unwrap_or_else(|| payload.get("count").and_then(Value::as_u64).unwrap_or(0)),
        "offset": payload.get("offset").and_then(Value::as_u64).unwrap_or(0),
        "limit": payload.get("limit").and_then(Value::as_u64).unwrap_or(limit as u64),
        "truncated": payload.get("truncated").and_then(Value::as_bool).unwrap_or(false),
        "next_offset": payload.get("next_offset").cloned().unwrap_or(Value::Null),
    });
    add_session_sandbox_metadata(
        &mut content,
        sandbox.sandbox_id().await,
        sandbox.workspace_root(),
    );
    ToolResult::success("file_search", content)
}

async fn search_files_with_required_session_sandbox(
    args: &FileSearchArgs,
    context: ToolContext,
) -> Option<ToolResult> {
    let requires_sandbox = requires_session_sandbox_for_path(&context, &args.path);
    if context.sandbox().is_some() {
        return Some(search_files_with_session_sandbox(json!(args), context).await);
    }
    if requires_sandbox {
        return Some(session_sandbox_required("file_search"));
    }
    None
}

pub(super) fn requires_session_sandbox_for_path(_context: &ToolContext, _path: &str) -> bool {
    true
}

pub(super) fn session_sandbox_required(tool_name: &str) -> ToolResult {
    ToolResult::error(
        tool_name,
        "Session sandbox is required for filesystem access.",
    )
}

pub(super) fn add_session_sandbox_metadata(
    value: &mut Value,
    sandbox_id: String,
    workspace_root: &str,
) {
    if let Some(object) = value.as_object_mut() {
        object.insert("runtime".to_string(), json!("sandbox-host"));
        object.insert("sandbox_id".to_string(), json!(sandbox_id));
        object.insert("workspace_root".to_string(), json!(workspace_root));
    }
}

fn retag_tool_result(mut result: ToolResult, tool_name: &str) -> ToolResult {
    result.tool_call_id = tool_name.to_string();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_read_result_preserves_truncation_metadata() {
        let payload = json!({
            "content": "a\nb",
            "start_line": 1,
            "end_line": 2,
            "total_lines": 10,
            "total_bytes": 1024,
            "max_read_bytes": 128,
            "truncated": true,
            "truncated_by_bytes": false,
            "next_offset": 3,
            "hint": "continue"
        });

        let result = file_read_result("notes.txt", "a\nb".to_string(), &payload);

        assert_eq!(result["path"], "notes.txt");
        assert_eq!(result["length"], 3);
        assert_eq!(result["start_line"], 1);
        assert_eq!(result["end_line"], 2);
        assert_eq!(result["total_lines"], 10);
        assert_eq!(result["total_bytes"], 1024);
        assert_eq!(result["max_read_bytes"], 128);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["truncated_by_bytes"], false);
        assert_eq!(result["next_offset"], 3);
        assert_eq!(result["hint"], "continue");
    }

    #[tokio::test]
    async fn workspace_file_tools_do_not_fallback_to_local_filesystem() {
        let context = ToolContext::default();
        let cases: Vec<(&str, Box<dyn ToolHandler>, Value)> = vec![
            (
                "file_list",
                Box::new(FileListTool),
                json!({"path": "/workspace", "recursive": true, "includeHidden": true}),
            ),
            (
                "file_read",
                Box::new(FileReadTool),
                json!({"path": "/workspace/a.cpp"}),
            ),
            (
                "file_write",
                Box::new(FileWriteTool),
                json!({"path": "/workspace/a.cpp", "content": "int main() { return 0; }"}),
            ),
            (
                "file_search",
                Box::new(FileSearchTool),
                json!({"path": "/workspace", "pattern": "main"}),
            ),
        ];

        for (tool_name, tool, args) in cases {
            let result = tool.execute(args, context.clone()).await;
            assert!(!result.success, "{tool_name} unexpectedly succeeded");
            assert_eq!(result.tool_call_id, tool_name);
            assert!(
                result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Session sandbox is required"),
                "{tool_name} returned unexpected error: {:?}",
                result.error
            );
        }
    }

    #[tokio::test]
    async fn required_session_sandbox_context_disables_local_fallback_for_relative_paths() {
        let context = ToolContext::default().requiring_session_sandbox();
        let result = FileListTool
            .execute(json!({"path": ".", "recursive": false}), context)
            .await;

        assert!(!result.success);
        assert_eq!(result.tool_call_id, "file_list");
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("Session sandbox is required"));
    }

    #[tokio::test]
    async fn file_tools_never_fallback_to_local_filesystem_for_relative_paths() {
        let context = ToolContext::default();
        let cases: Vec<(&str, Box<dyn ToolHandler>, Value)> = vec![
            (
                "file_list",
                Box::new(FileListTool),
                json!({"path": ".", "recursive": false}),
            ),
            (
                "file_read",
                Box::new(FileReadTool),
                json!({"path": "a.cpp"}),
            ),
            (
                "file_write",
                Box::new(FileWriteTool),
                json!({"path": "a.cpp", "content": "int main() { return 0; }"}),
            ),
            (
                "file_search",
                Box::new(FileSearchTool),
                json!({"path": ".", "pattern": "main"}),
            ),
        ];

        for (tool_name, tool, args) in cases {
            let result = tool.execute(args, context.clone()).await;
            assert!(!result.success, "{tool_name} unexpectedly succeeded");
            assert_eq!(result.tool_call_id, tool_name);
            assert!(
                result
                    .error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("Session sandbox is required"),
                "{tool_name} returned unexpected error: {:?}",
                result.error
            );
        }
    }

    #[test]
    fn search_result_formatter_supports_output_modes() {
        let matches = vec![
            json!({"file": "a.txt", "path": "a.txt", "line": 1, "content": "needle"}),
            json!({"file": "a.txt", "path": "a.txt", "line": 3, "content": "needle again"}),
            json!({"file": "b.txt", "path": "b.txt", "line": 1, "content": "needle"}),
        ];

        let content = format_search_result(matches.clone(), "content", "content", 1, 1, 2);
        assert_eq!(content["count"], 1);
        assert_eq!(content["total_count"], 3);
        assert_eq!(content["matches"][0]["file"], "a.txt");
        assert_eq!(content["matches"][0]["line"], 3);
        assert_eq!(content["truncated"], true);
        assert_eq!(content["next_offset"], 2);

        let files = format_search_result(matches.clone(), "content", "files_only", 0, 10, 10);
        assert_eq!(files["count"], 2);
        assert_eq!(files["total_count"], 2);
        assert_eq!(files["files"][0], "a.txt");
        assert_eq!(files["files"][1], "b.txt");

        let counts = format_search_result(matches, "content", "count", 0, 10, 10);
        assert_eq!(counts["counts"]["a.txt"], 2);
        assert_eq!(counts["counts"]["b.txt"], 1);
        assert_eq!(counts["total_count"], 3);
    }
}
