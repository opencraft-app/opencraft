use std::fs;
use std::path::{Component, Path};

use anyhow::{bail, Context, Result};

use crate::protocol::StageFilesManifest;

pub(crate) fn validate_stage_files_manifest(
    manifest: &StageFilesManifest,
    session_id: &str,
    workspace_root: &Path,
    current_generation: Option<u64>,
) -> Result<Vec<String>> {
    if let Some(manifest_session_id) = manifest.session_id.as_deref() {
        if manifest_session_id.trim().is_empty() {
            bail!("stage-files session_id must not be empty");
        }
        if manifest_session_id != session_id {
            bail!(
                "stage-files session_id '{}' does not match daemon session '{}'",
                manifest_session_id,
                session_id
            );
        }
    }

    if let Some(generation) = manifest.generation {
        if let Some(current_generation) = current_generation {
            if generation < current_generation {
                bail!(
                    "stage-files generation {} is older than active generation {}",
                    generation,
                    current_generation
                );
            }
        }
    }

    if let Some(manifest_workspace_root) = manifest.workspace_root.as_deref() {
        if manifest_workspace_root.trim().is_empty() {
            bail!("stage-files workspace_root must not be empty");
        }
        if !same_stage_root(manifest_workspace_root, workspace_root) {
            bail!(
                "stage-files workspace_root '{}' does not match daemon workspace '{}'",
                manifest_workspace_root,
                workspace_root.display()
            );
        }
    }

    let mut relative_paths = Vec::with_capacity(manifest.files.len());
    for file in &manifest.files {
        let relative_path = normalize_stage_workspace_path(&file.workspace_path)?;
        validate_stage_outer_path(file.outer_path.as_str(), workspace_root, &relative_path)?;
        let local_path = workspace_root.join(&relative_path);
        let metadata = fs::metadata(&local_path).with_context(|| {
            format!(
                "staged file '{}' is not available in daemon workspace",
                local_path.display()
            )
        })?;
        if !metadata.is_file() {
            bail!(
                "staged file '{}' is not a regular file",
                local_path.display()
            );
        }
        if let Some(expected_bytes) = file.bytes {
            if metadata.len() != expected_bytes {
                bail!(
                    "staged file '{}' has {} bytes, expected {}",
                    local_path.display(),
                    metadata.len(),
                    expected_bytes
                );
            }
        }
        relative_paths.push(relative_path);
    }
    Ok(relative_paths)
}

pub(crate) fn persist_stage_files_manifest(
    workspace_root: &Path,
    manifest: &StageFilesManifest,
) -> Result<()> {
    let state_dir = workspace_root.join(".hermes-sidecar");
    fs::create_dir_all(&state_dir).with_context(|| {
        format!(
            "failed to create sidecar state directory '{}'",
            state_dir.display()
        )
    })?;
    let path = state_dir.join("staged-files.json");
    let body =
        serde_json::to_vec_pretty(manifest).context("failed to serialize stage-files manifest")?;
    fs::write(&path, body)
        .with_context(|| format!("failed to record stage-files manifest '{}'", path.display()))
}

fn validate_stage_outer_path(
    outer_path: &str,
    workspace_root: &Path,
    workspace_relative_path: &str,
) -> Result<()> {
    let outer_path = outer_path.trim();
    if outer_path.is_empty() {
        return Ok(());
    }

    let relative = if Path::new(outer_path).is_absolute() {
        let stripped = Path::new(outer_path)
            .strip_prefix(workspace_root)
            .with_context(|| {
                format!(
                    "stage-files outer_path '{}' is outside workspace '{}'",
                    outer_path,
                    workspace_root.display()
                )
            })?;
        normalize_stage_path(stripped)?
    } else {
        normalize_stage_workspace_path(outer_path)?
    };

    if relative != workspace_relative_path {
        bail!(
            "stage-files outer_path '{}' does not match workspace_path '{}'",
            outer_path,
            workspace_relative_path
        );
    }
    Ok(())
}

fn normalize_stage_workspace_path(raw: &str) -> Result<String> {
    if raw.trim().is_empty() {
        bail!("stage-files workspace_path must not be empty");
    }
    if raw.chars().any(char::is_control) {
        bail!("stage-files workspace_path contains control characters");
    }
    let raw = raw.trim_start_matches("./");
    normalize_stage_path(Path::new(raw))
}

fn normalize_stage_path(path: &Path) -> Result<String> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => {
                let value = value.to_string_lossy();
                if value.is_empty() || value.chars().any(char::is_control) {
                    bail!("stage-files path contains an invalid segment");
                }
                components.push(value.into_owned());
            }
            Component::ParentDir => bail!("stage-files path must not contain '..'"),
            Component::RootDir | Component::Prefix(_) => {
                bail!("stage-files path must be relative to the workspace")
            }
        }
    }
    if components.is_empty() {
        bail!("stage-files path must not be empty");
    }
    Ok(components.join("/"))
}

fn same_stage_root(raw: &str, workspace_root: &Path) -> bool {
    let expected = workspace_root.to_string_lossy();
    raw.trim_end_matches('/') == expected.trim_end_matches('/')
}
