use std::path::{Component, Path, PathBuf};

use serde_json::Value;

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

#[derive(Debug, Clone, Copy, Default)]
pub struct HintInjectionPolicy;

impl HintInjectionPolicy {
    pub fn target_directory(
        &self,
        tool_name: &str,
        args: &Value,
        working_dir: &Path,
    ) -> Option<PathBuf> {
        if !self.is_filesystem_or_process_tool(tool_name) && !self.args_have_path(args) {
            return None;
        }

        let working_dir = normalize_path(working_dir);
        let object = args.as_object()?;
        for key in PATH_ARGUMENT_KEYS {
            let Some(raw_path) = object.get(*key).and_then(Value::as_str) else {
                continue;
            };
            if raw_path.trim().is_empty() {
                continue;
            }
            let target = normalize_path(&resolve_against_working_dir(&working_dir, raw_path));
            let directory = if FILE_LIKE_KEYS.contains(key) && looks_like_file_path(raw_path) {
                target.parent().map(Path::to_path_buf).unwrap_or(target)
            } else {
                target
            };
            let directory = normalize_path(&directory);
            if directory != working_dir && directory.starts_with(&working_dir) {
                return Some(directory);
            }
        }

        None
    }

    fn is_filesystem_or_process_tool(&self, tool_name: &str) -> bool {
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

    fn args_have_path(&self, args: &Value) -> bool {
        args.as_object().is_some_and(|object| {
            PATH_ARGUMENT_KEYS
                .iter()
                .any(|key| object.contains_key(*key))
        })
    }
}

pub(crate) fn normalize_path(path: &Path) -> PathBuf {
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

fn resolve_against_working_dir(working_dir: &Path, raw_path: &str) -> PathBuf {
    let path = Path::new(raw_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        working_dir.join(path)
    }
}

fn looks_like_file_path(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains('.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn policy_rejects_paths_outside_working_dir() {
        let policy = HintInjectionPolicy;
        let root = PathBuf::from("/workspace");
        let args = json!({ "path": "../other/file.rs" });

        assert!(policy.target_directory("read_file", &args, &root).is_none());
    }

    #[test]
    fn policy_extracts_parent_directory_for_file_paths() {
        let policy = HintInjectionPolicy;
        let root = PathBuf::from("/workspace");
        let args = json!({ "path": "crates/demo/src/lib.rs" });

        let directory = policy
            .target_directory("read_file", &args, &root)
            .expect("target directory");
        assert_eq!(directory, PathBuf::from("/workspace/crates/demo/src"));
    }
}
