//! Fork/child-agent primitives.
//!
//! Core exposes only bounded child-session inputs and explicit communication
//! switches. Supervisor policies such as "one folder, one coding agent" belong
//! outside this module.

use crate::session::AgentSession;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForkCommunication {
    pub parent_inbox_sink: bool,
    pub child_inbox_sink: bool,
    pub parent_to_child_stream: bool,
    pub child_to_parent_stream: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForkSpec {
    pub label: Option<String>,
    pub purpose: Option<String>,
    pub bounded_context: Option<String>,
    pub allowed_tools: Vec<String>,
    pub communication: ForkCommunication,
}

#[derive(Debug, Clone)]
pub struct ForkedSession {
    pub child: AgentSession,
    pub spec: ForkSpec,
}

impl ForkedSession {
    pub fn from_parent(parent: &AgentSession, spec: ForkSpec) -> Self {
        Self {
            child: AgentSession::new(format!("{}:fork", parent.session_id), parent.cwd.clone()),
            spec,
        }
    }

    pub fn system_context(&self) -> String {
        let mut lines = Vec::new();
        if let Some(label) = self
            .spec
            .label
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(format!("Fork label: {}", label.trim()));
        }
        if let Some(purpose) = self
            .spec
            .purpose
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(format!("Fork purpose: {}", purpose.trim()));
        }
        if let Some(context) = self
            .spec
            .bounded_context
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            lines.push(format!("Fork context (bounded):\n{}", context.trim()));
        }
        if !self.spec.allowed_tools.is_empty() {
            lines.push(format!(
                "Allowed tools in this fork: {}",
                self.spec.allowed_tools.join(", ")
            ));
        }
        if self.spec.communication.parent_inbox_sink {
            lines.push("A parent inbox sink is explicitly available.".to_string());
        }
        if self.spec.communication.child_to_parent_stream {
            lines.push("A child-to-parent stream is explicitly available.".to_string());
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fork_defaults_to_isolated_communication() {
        let parent = AgentSession::new("parent", "/tmp/project");
        let fork = ForkedSession::from_parent(&parent, ForkSpec::default());

        assert_ne!(fork.child.session_id, parent.session_id);
        assert_eq!(fork.child.cwd, parent.cwd);
        assert!(!fork.spec.communication.parent_inbox_sink);
        assert!(!fork.spec.communication.child_to_parent_stream);
    }

    #[test]
    fn fork_context_is_bounded_and_explicit() {
        let parent = AgentSession::new("parent", "/tmp/project");
        let fork = ForkedSession::from_parent(
            &parent,
            ForkSpec {
                label: Some("frontend".to_string()),
                bounded_context: Some("Only inspect frontend/".to_string()),
                allowed_tools: vec!["read".to_string()],
                ..ForkSpec::default()
            },
        );

        let context = fork.system_context();
        assert!(context.contains("frontend"));
        assert!(context.contains("Only inspect frontend/"));
        assert!(context.contains("read"));
    }
}
