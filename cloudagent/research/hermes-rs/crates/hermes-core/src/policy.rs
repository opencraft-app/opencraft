//! Runtime policy primitives.

use std::collections::BTreeSet;

use async_trait::async_trait;

use crate::error::{Error, Result};
use crate::hooks::{GateHook, ToolGateInput};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    Deny(String),
    Defer(String),
}

#[derive(Debug, Clone, Default)]
pub struct ToolNameGateHook {
    denied_tools: BTreeSet<String>,
}

impl ToolNameGateHook {
    pub fn deny_tools<I, S>(tools: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            denied_tools: tools
                .into_iter()
                .map(Into::into)
                .map(|name| name.trim().to_ascii_lowercase())
                .filter(|name| !name.is_empty())
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.denied_tools.is_empty()
    }
}

#[async_trait]
impl GateHook for ToolNameGateHook {
    async fn before_tool(&self, input: &ToolGateInput) -> GateDecision {
        if self
            .denied_tools
            .contains(&input.name.trim().to_ascii_lowercase())
        {
            GateDecision::Deny(format!("tool '{}' denied by policy", input.name))
        } else {
            GateDecision::Allow
        }
    }
}

impl GateDecision {
    pub fn into_result(self) -> Result<()> {
        match self {
            GateDecision::Allow => Ok(()),
            GateDecision::Deny(reason) => Err(Error::Agent(if reason.trim().is_empty() {
                "denied by gate".to_string()
            } else {
                reason
            })),
            GateDecision::Defer(reason) => Err(Error::Agent(if reason.trim().is_empty() {
                "deferred by gate".to_string()
            } else {
                reason
            })),
        }
    }
}
