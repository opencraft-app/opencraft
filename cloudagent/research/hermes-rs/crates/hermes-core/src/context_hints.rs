//! Lazy subdirectory context hints for filesystem-oriented tool calls.
//!
//! The turn system prompt already carries the current cwd context. This tracker
//! adds only the extra guidance discovered when a tool first enters a deeper
//! subdirectory, mirroring Hermes' "first visit" context behavior without
//! repeatedly flooding the model with the same files.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use tracing::debug;

use crate::context_files::scan_context_content;

const MAX_HINT_CHARS_PER_FILE: usize = 8_000;

const SUBDIRECTORY_CONTEXT_FILES: &[&str] = &[
    "AGENTS.md",
    "agents.md",
    "CLAUDE.md",
    "claude.md",
    ".hermes.md",
    "HERMES.md",
    ".cursorrules",
];

const PATH_ARGUMENT_KEYS: &[&str] = &[
    "path",
    "file_path",
    "filepath",
    "directory",
    "dir",
    "cwd",
    "workspace_path",
    "target",
];

const FILE_LIKE_KEYS: &[&str] = &["path", "file_path", "filepath", "workspace_path", "target"];

#[derive(Debug, Clone)]
pub struct SubdirectoryContextHintTracker {
    working_dir: PathBuf,
    visited_dirs: HashSet<PathBuf>,
}

impl SubdirectoryContextHintTracker {
    pub fn new(working_dir: PathBuf) -> Self {
        Self {
            working_dir: normalize_path(&working_dir),
            visited_dirs: HashSet::new(),
        }
    }

    pub fn set_working_dir(&mut self, working_dir: &Path) {
        let normalized = normalize_path(working_dir);
        if normalized != self.working_dir {
            self.working_dir = normalized;
            self.visited_dirs.clear();
        }
    }

    pub fn maybe_hint_for_tool_call(&mut self, tool_name: &str, args: &Value) -> Option<String> {
        let target_dir = target_directory_for_tool(tool_name, args, &self.working_dir)?;
        if target_dir == self.working_dir || !target_dir.starts_with(&self.working_dir) {
            return None;
        }
        if !self.visited_dirs.insert(target_dir.clone()) {
            return None;
        }

        let blocks = collect_context_blocks(&self.working_dir, &target_dir);
        if blocks.is_empty() {
            return None;
        }

        debug!(
            tool = %tool_name,
            directory = %target_dir.display(),
            count = blocks.len(),
            "Loaded subdirectory context hint"
        );

        Some(format!(
            "<subdirectory_context_hints>\n{}\n</subdirectory_context_hints>",
            blocks.join("\n\n")
        ))
    }
}

fn target_directory_for_tool(tool_name: &str, args: &Value, working_dir: &Path) -> Option<PathBuf> {
    if !is_filesystem_or_process_tool(tool_name) && !args_has_path(args) {
        return None;
    }

    let object = args.as_object()?;
    for key in PATH_ARGUMENT_KEYS {
        let Some(raw_path) = object.get(*key).and_then(Value::as_str) else {
            continue;
        };
        if raw_path.trim().is_empty() {
            continue;
        }
        let target = normalize_path(&resolve_against_working_dir(working_dir, raw_path));
        let directory = if FILE_LIKE_KEYS.contains(key) && looks_like_file_path(raw_path) {
            target.parent().map(Path::to_path_buf).unwrap_or(target)
        } else {
            target
        };
        let directory = normalize_path(&directory);
        if directory.starts_with(working_dir) {
            return Some(directory);
        }
    }

    None
}

fn is_filesystem_or_process_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "read_file"
            | "file_read"
            | "write_file"
            | "file_write"
            | "file_list"
            | "list_files"
            | "search_files"
            | "file_search"
            | "patch"
            | "terminal"
            | "process"
            | "exec"
    )
}

fn args_has_path(args: &Value) -> bool {
    args.as_object().is_some_and(|object| {
        PATH_ARGUMENT_KEYS
            .iter()
            .any(|key| object.contains_key(*key))
    })
}

fn resolve_against_working_dir(working_dir: &Path, raw_path: &str) -> PathBuf {
    let path = Path::new(raw_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        working_dir.join(path)
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn looks_like_file_path(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains('.'))
}

fn collect_context_blocks(working_dir: &Path, target_dir: &Path) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = target_dir.to_path_buf();

    loop {
        if current == *working_dir {
            break;
        }

        for filename in SUBDIRECTORY_CONTEXT_FILES {
            let path = current.join(filename);
            if let Some(block) = read_context_block(working_dir, &path) {
                blocks.push(block);
            }
        }

        match current.parent() {
            Some(parent) if parent != current && current.starts_with(working_dir) => {
                current = parent.to_path_buf();
            }
            _ => break,
        }
    }

    blocks
}

fn read_context_block(working_dir: &Path, path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("context file");
    let scanned = scan_context_content(trimmed, filename);
    let relative = path.strip_prefix(working_dir).unwrap_or(path);
    Some(format!(
        "<context_file path=\"{}\">\n{}\n</context_file>",
        relative.display(),
        truncate_hint(&scanned)
    ))
}

fn truncate_hint(content: &str) -> String {
    let count = content.chars().count();
    if count <= MAX_HINT_CHARS_PER_FILE {
        return content.to_string();
    }
    let head = content
        .chars()
        .take(MAX_HINT_CHARS_PER_FILE)
        .collect::<String>();
    format!("{head}\n\n[...truncated subdirectory context: {count} chars total]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hermes_subdir_context_{}_{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn first_file_access_in_subdirectory_loads_context_once() {
        let root = test_dir("once");
        let subdir = root.join("crates").join("demo");
        std::fs::create_dir_all(&subdir).unwrap();
        std::fs::write(root.join("AGENTS.md"), "root rules").unwrap();
        std::fs::write(subdir.join("AGENTS.md"), "demo rules").unwrap();

        let mut tracker = SubdirectoryContextHintTracker::new(root.clone());
        let args = json!({ "path": "crates/demo/src/lib.rs" });

        let first = tracker
            .maybe_hint_for_tool_call("read_file", &args)
            .expect("subdirectory hint should be loaded");
        assert!(first.contains("crates/demo/AGENTS.md"));
        assert!(first.contains("demo rules"));
        assert!(!first.contains("root rules"));

        let second = tracker.maybe_hint_for_tool_call("read_file", &args);
        assert!(second.is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn access_outside_working_dir_is_ignored() {
        let root = test_dir("outside");
        let mut tracker = SubdirectoryContextHintTracker::new(root.clone());
        let args = json!({ "path": "../elsewhere/file.rs" });

        assert!(tracker
            .maybe_hint_for_tool_call("read_file", &args)
            .is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn changing_working_dir_resets_visited_directories() {
        let root_a = test_dir("reset_a");
        let root_b = test_dir("reset_b");
        std::fs::create_dir_all(root_a.join("pkg")).unwrap();
        std::fs::create_dir_all(root_b.join("pkg")).unwrap();
        std::fs::write(root_a.join("pkg").join("AGENTS.md"), "a rules").unwrap();
        std::fs::write(root_b.join("pkg").join("AGENTS.md"), "b rules").unwrap();

        let args = json!({ "path": "pkg/lib.rs" });
        let mut tracker = SubdirectoryContextHintTracker::new(root_a.clone());
        assert!(tracker
            .maybe_hint_for_tool_call("read_file", &args)
            .unwrap()
            .contains("a rules"));

        tracker.set_working_dir(&root_b);
        let hint = tracker
            .maybe_hint_for_tool_call("read_file", &args)
            .expect("new working dir should reset visit cache");
        assert!(hint.contains("b rules"));

        let _ = std::fs::remove_dir_all(root_a);
        let _ = std::fs::remove_dir_all(root_b);
    }
}
