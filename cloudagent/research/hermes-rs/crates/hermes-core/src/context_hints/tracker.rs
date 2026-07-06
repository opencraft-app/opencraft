use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tracing::debug;

use super::policy::{normalize_path, HintInjectionPolicy};
use super::scanner::{ContextHintBatch, HintFileScanner};

#[derive(Debug, Clone)]
pub struct ContextHintTracker {
    working_dir: PathBuf,
    visited_dirs: HashSet<PathBuf>,
    policy: HintInjectionPolicy,
    scanner: HintFileScanner,
}

impl ContextHintTracker {
    pub fn new(working_dir: PathBuf) -> Self {
        Self {
            working_dir: normalize_path(&working_dir),
            visited_dirs: HashSet::new(),
            policy: HintInjectionPolicy,
            scanner: HintFileScanner::default(),
        }
    }

    pub fn set_working_dir(&mut self, working_dir: &Path) {
        let normalized = normalize_path(working_dir);
        if normalized != self.working_dir {
            self.working_dir = normalized;
            self.visited_dirs.clear();
        }
    }

    pub fn maybe_hint_for_tool_call(
        &mut self,
        tool_name: &str,
        args: &Value,
    ) -> Option<ContextHintBatch> {
        let target_dir = self
            .policy
            .target_directory(tool_name, args, &self.working_dir)?;
        if !self.visited_dirs.insert(target_dir.clone()) {
            return None;
        }

        let batch = self.scanner.scan(&self.working_dir, &target_dir)?;
        if batch.is_empty() {
            return None;
        }

        debug!(
            tool = %tool_name,
            directory = %target_dir.display(),
            count = batch.files.len(),
            "Loaded subdirectory context hint"
        );

        Some(batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hermes_hint_tracker_{}_{}",
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

        let mut tracker = ContextHintTracker::new(root.clone());
        let args = json!({ "path": "crates/demo/src/lib.rs" });

        let first = tracker
            .maybe_hint_for_tool_call("read_file", &args)
            .expect("subdirectory hint should be loaded");
        let observation = first.to_model_observation();
        assert!(observation.contains("crates/demo/AGENTS.md"));
        assert!(observation.contains("demo rules"));
        assert!(!observation.contains("root rules"));

        let second = tracker.maybe_hint_for_tool_call("read_file", &args);
        assert!(second.is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn access_outside_working_dir_is_ignored() {
        let root = test_dir("outside");
        let mut tracker = ContextHintTracker::new(root.clone());
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
        let mut tracker = ContextHintTracker::new(root_a.clone());
        assert!(tracker
            .maybe_hint_for_tool_call("read_file", &args)
            .unwrap()
            .to_model_observation()
            .contains("a rules"));

        tracker.set_working_dir(&root_b);
        let hint = tracker
            .maybe_hint_for_tool_call("read_file", &args)
            .expect("new working dir should reset visit cache");
        assert!(hint.to_model_observation().contains("b rules"));

        let _ = std::fs::remove_dir_all(root_a);
        let _ = std::fs::remove_dir_all(root_b);
    }
}
