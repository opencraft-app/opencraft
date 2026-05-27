use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};

use crate::error::Result;
use crate::runtime_host::e2b::SessionSandbox;

static ACTIVE_SESSION_SANDBOXES: OnceLock<StdMutex<Vec<Weak<SessionSandbox>>>> = OnceLock::new();

fn active_session_sandboxes() -> &'static StdMutex<Vec<Weak<SessionSandbox>>> {
    ACTIVE_SESSION_SANDBOXES.get_or_init(|| StdMutex::new(Vec::new()))
}

pub(super) fn register_active_session_sandbox(sandbox: &Arc<SessionSandbox>) {
    let mut sandboxes = active_session_sandboxes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sandboxes.retain(|candidate| candidate.strong_count() > 0);
    sandboxes.push(Arc::downgrade(sandbox));
}

pub async fn sync_active_session_sandbox_files(
    local_workspace_root: &Path,
    relative_paths: &[String],
) -> Result<bool> {
    let matches = {
        let mut sandboxes = active_session_sandboxes()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut matches = Vec::new();
        sandboxes.retain(|candidate| {
            let Some(sandbox) = candidate.upgrade() else {
                return false;
            };
            if sandbox.local_workspace_root() == local_workspace_root {
                matches.push(sandbox);
            }
            true
        });
        matches
    };

    if matches.is_empty() {
        return Ok(false);
    }

    for sandbox in matches {
        sandbox
            .sync_files(local_workspace_root, relative_paths)
            .await?;
    }
    Ok(true)
}

pub async fn upload_active_session_sandbox_file(
    local_workspace_root: &Path,
    workspace_path: &str,
    content: Vec<u8>,
) -> Result<bool> {
    let matches = matching_session_sandboxes(local_workspace_root);
    if matches.is_empty() {
        return Ok(false);
    }

    for sandbox in matches {
        let remote_path = sandbox.resolve_path(workspace_path)?;
        sandbox
            .upload_bytes_at_path(&remote_path, content.clone())
            .await?;
    }
    Ok(true)
}

pub async fn download_active_session_sandbox_file(
    local_workspace_root: &Path,
    workspace_path: &str,
) -> Result<Option<Vec<u8>>> {
    let matches = matching_session_sandboxes(local_workspace_root);
    let Some(sandbox) = matches.into_iter().last() else {
        return Ok(None);
    };
    let remote_path = sandbox.resolve_path(workspace_path)?;
    sandbox.download_bytes_at_path(&remote_path).await.map(Some)
}

fn matching_session_sandboxes(local_workspace_root: &Path) -> Vec<Arc<SessionSandbox>> {
    let mut sandboxes = active_session_sandboxes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut matches = Vec::new();
    sandboxes.retain(|candidate| {
        let Some(sandbox) = candidate.upgrade() else {
            return false;
        };
        if sandbox.local_workspace_root() == local_workspace_root {
            matches.push(sandbox);
        }
        true
    });
    matches
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[tokio::test]
    async fn reports_no_active_sandbox() {
        let synced =
            sync_active_session_sandbox_files(Path::new("/tmp/no-active-sandbox"), &[]).await;
        assert!(!synced.unwrap());
    }
}
