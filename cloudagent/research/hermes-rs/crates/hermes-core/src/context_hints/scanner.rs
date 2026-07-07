use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HintFile {
    pub relative_path: PathBuf,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextHintBatch {
    pub target_dir: PathBuf,
    pub files: Vec<HintFile>,
}

impl ContextHintBatch {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn to_model_observation(&self) -> String {
        format!(
            "<subdirectory_context_hints>\n{}\n</subdirectory_context_hints>",
            self.files
                .iter()
                .map(HintFile::to_model_observation)
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    }

    pub fn to_json_value(&self) -> Value {
        json!({
            "type": "subdirectory_context_hints",
            "target_dir": self.target_dir.display().to_string(),
            "files": self.files.iter().map(HintFile::to_json_value).collect::<Vec<_>>(),
        })
    }
}

impl HintFile {
    pub fn to_model_observation(&self) -> String {
        format!(
            "<context_file path=\"{}\">\n{}\n</context_file>",
            self.relative_path.display(),
            self.content
        )
    }

    pub fn to_json_value(&self) -> Value {
        json!({
            "path": self.relative_path.display().to_string(),
            "content": self.content,
        })
    }
}

#[derive(Debug, Clone)]
pub struct HintFileScanner {
    max_chars_per_file: usize,
}

impl Default for HintFileScanner {
    fn default() -> Self {
        Self {
            max_chars_per_file: MAX_HINT_CHARS_PER_FILE,
        }
    }
}

impl HintFileScanner {
    pub fn scan(&self, working_dir: &Path, target_dir: &Path) -> Option<ContextHintBatch> {
        let mut files = Vec::new();
        let mut seen_files = HashSet::new();
        let mut current = target_dir.to_path_buf();

        loop {
            if current == *working_dir {
                break;
            }

            for filename in SUBDIRECTORY_CONTEXT_FILES {
                let path = current.join(filename);
                let identity = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if !seen_files.insert(identity) {
                    continue;
                }
                if let Some(file) = self.read_context_file(working_dir, &path) {
                    files.push(file);
                }
            }

            match current.parent() {
                Some(parent) if parent != current && current.starts_with(working_dir) => {
                    current = parent.to_path_buf();
                }
                _ => break,
            }
        }

        if files.is_empty() {
            None
        } else {
            Some(ContextHintBatch {
                target_dir: target_dir.to_path_buf(),
                files,
            })
        }
    }

    fn read_context_file(&self, working_dir: &Path, path: &Path) -> Option<HintFile> {
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
        let relative_path = path.strip_prefix(working_dir).unwrap_or(path).to_path_buf();
        Some(HintFile {
            relative_path,
            content: self.truncate_hint(&scanned),
        })
    }

    fn truncate_hint(&self, content: &str) -> String {
        let count = content.chars().count();
        if count <= self.max_chars_per_file {
            return content.to_string();
        }
        let head = content
            .chars()
            .take(self.max_chars_per_file)
            .collect::<String>();
        format!("{head}\n\n[...truncated subdirectory context: {count} chars total]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hermes_hint_scanner_{}_{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scanner_reads_subdirectory_context_without_root_context() {
        let root = test_dir("subdir");
        let subdir = root.join("crates").join("demo");
        std::fs::create_dir_all(&subdir).unwrap();
        std::fs::write(root.join("AGENTS.md"), "root rules").unwrap();
        std::fs::write(subdir.join("AGENTS.md"), "demo rules").unwrap();

        let batch = HintFileScanner::default()
            .scan(&root, &subdir)
            .expect("hint batch");
        assert_eq!(batch.files.len(), 1);
        assert_eq!(
            batch.files[0].relative_path,
            PathBuf::from("crates/demo/AGENTS.md")
        );
        assert!(batch.files[0].content.contains("demo rules"));
        assert!(!batch.to_model_observation().contains("root rules"));

        let _ = std::fs::remove_dir_all(root);
    }
}
