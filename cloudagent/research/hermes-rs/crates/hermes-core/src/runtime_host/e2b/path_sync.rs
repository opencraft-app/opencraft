use std::path::{Component, Path};

use crate::error::{Error, Result};

pub(super) fn should_skip_path(name: &str) -> bool {
    matches!(
        name,
        ".git" | "target" | "node_modules" | "__pycache__" | "MEMORY.md" | "USER.md"
    )
}

pub(super) fn normalize_relative_path(path: &Path) -> Result<String> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => components.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                if components.pop().is_none() {
                    return Err(Error::Agent(format!(
                        "Path '{}' escapes the session workspace",
                        path.display()
                    )));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(Error::Agent(format!(
                    "Path '{}' must be relative to the session workspace",
                    path.display()
                )));
            }
        }
    }
    Ok(components.join("/"))
}

pub(super) fn normalize_absolute_path(path: &Path) -> Result<String> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(part) => components.push(part.to_string_lossy().into_owned()),
            Component::ParentDir => {
                let _ = components.pop();
            }
            Component::Prefix(_) => {
                return Err(Error::Agent(format!(
                    "Unsupported absolute path '{}'",
                    path.display()
                )));
            }
        }
    }
    Ok(format!("/{}", components.join("/")))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn rejects_paths_that_escape_workspace() {
        let err = normalize_relative_path(Path::new("../outside.txt")).unwrap_err();
        assert!(err.to_string().contains("escapes the session workspace"));
    }
}
