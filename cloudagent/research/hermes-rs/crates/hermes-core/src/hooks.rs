//! Runtime hook surfaces.
//!
//! Observer hooks are read-only. Gate hooks can only allow, deny, or defer.
//! Transform hooks are separate so mutation remains explicit and observable.

use async_trait::async_trait;

use crate::events::AgentEvent;
use crate::policy::GateDecision;
use crate::turn::TurnContext;

#[async_trait]
pub trait ObserverHook: Send + Sync {
    async fn on_event(&self, _event: &AgentEvent) {}
}

#[derive(Debug, Clone)]
pub struct ToolGateInput {
    pub name: String,
    pub arguments: String,
}

#[async_trait]
pub trait GateHook: Send + Sync {
    async fn before_tool(&self, _input: &ToolGateInput) -> GateDecision {
        GateDecision::Allow
    }
}

#[async_trait]
pub trait PromptTransformHook: Send + Sync {
    async fn transform_prompt(&self, prompt: String, _turn: &TurnContext) -> crate::Result<String> {
        Ok(prompt)
    }
}

#[derive(Debug, Default)]
pub struct NoopObserverHook;

#[async_trait]
impl ObserverHook for NoopObserverHook {}

#[derive(Debug, Default)]
pub struct NoopGateHook;

#[async_trait]
impl GateHook for NoopGateHook {}
