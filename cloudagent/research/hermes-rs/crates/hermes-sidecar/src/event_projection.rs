use hermes_core::{AgentEvent, RuntimeHostEvent};

use crate::protocol::PromptResponseLine;

pub(crate) fn runtime_host_prompt_line(event: RuntimeHostEvent) -> PromptResponseLine {
    PromptResponseLine::RuntimeHost {
        event: event.event,
        session_id: event.session_id,
        sandbox_id: event.sandbox_id,
        workspace_root: event.workspace_root,
        template: event.template,
        error: event.error,
    }
}

pub(crate) fn runtime_host_line_from_agent_event(event: AgentEvent) -> Option<PromptResponseLine> {
    match event {
        AgentEvent::RuntimeHost(event) => Some(runtime_host_prompt_line(event)),
        AgentEvent::RunScoped { event, .. } => runtime_host_line_from_agent_event(*event),
        _ => None,
    }
}
