//! Behavior version resolution.
//!
//! This is the single assembly point for user-visible agent/workspace versions.
//! `builtin.v1` intentionally maps to the current built-in behavior.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const BUILTIN_V1: &str = "builtin.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BehaviorVersions {
    pub agent_version: String,
    pub workspace_version: String,
}

impl Default for BehaviorVersions {
    fn default() -> Self {
        Self {
            agent_version: BUILTIN_V1.to_string(),
            workspace_version: BUILTIN_V1.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedBehavior {
    pub agent_version: String,
    pub workspace_version: String,
    pub agent_template_id: Option<String>,
    pub workspace_template_id: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct BehaviorRegistry;

impl BehaviorRegistry {
    pub fn resolve(&self, versions: &BehaviorVersions) -> Result<ResolvedBehavior> {
        if versions.agent_version != BUILTIN_V1 {
            return Err(Error::Agent(format!(
                "unknown agent_version: {}",
                versions.agent_version
            )));
        }
        if versions.workspace_version != BUILTIN_V1 {
            return Err(Error::Agent(format!(
                "unknown workspace_version: {}",
                versions.workspace_version
            )));
        }
        Ok(ResolvedBehavior {
            agent_version: versions.agent_version.clone(),
            workspace_version: versions.workspace_version.clone(),
            agent_template_id: None,
            workspace_template_id: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_v1_resolves() {
        let resolved = BehaviorRegistry
            .resolve(&BehaviorVersions::default())
            .expect("builtin behavior resolves");
        assert_eq!(resolved.agent_version, BUILTIN_V1);
        assert_eq!(resolved.workspace_version, BUILTIN_V1);
    }

    #[test]
    fn unknown_agent_version_is_rejected() {
        let err = BehaviorRegistry
            .resolve(&BehaviorVersions {
                agent_version: "canary.bad".to_string(),
                ..BehaviorVersions::default()
            })
            .unwrap_err();
        assert!(err.to_string().contains("unknown agent_version"));
    }

    #[test]
    fn unknown_workspace_version_is_rejected() {
        let err = BehaviorRegistry
            .resolve(&BehaviorVersions {
                workspace_version: "workspace.bad".to_string(),
                ..BehaviorVersions::default()
            })
            .unwrap_err();
        assert!(err.to_string().contains("unknown workspace_version"));
    }
}
