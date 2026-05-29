use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use hermes_core::{
    install_runtime_config, register_builtin_tools_with_sub_agent, AgentConfig, AgentEvent,
    AgentRuntime, AppConfig, BehaviorSettings, MemoryManager, OpenAIClient, SkillPromptHook,
    ToolNameGateHook, ToolRegistry,
};
use tokio::sync::mpsc;

use crate::protocol::SessionPaths;

const TOKENHUB_BASE_URL: &str = "https://tokenhub.tencentmaas.com/v1";
const CLOUDAGENT_SYSTEM_PROMPT: &str = r#"You are CloudAgent, an AI assistant running inside a sandboxed workspace.

Identity rules:
- If asked what agent or model you are, identify yourself as CloudAgent. Do not call yourself "MCP Agent", "MCP Agent r1.0", "Cursor Agent", or "E2B Agent".
- MCP, ACP, sandbox-host, Wisp, AGS, and similar names are infrastructure or tool protocols. They are not your product identity.
- Describe tools by capability, such as file operations, terminal commands, web access, and memory, without claiming that your identity is an MCP server or MCP agent.

Workspace rules:
- Treat /workspace as the user-visible workspace.
- Use tools to inspect files and runtime state instead of guessing.
- Do not reveal hidden implementation details unless the user asks for them directly."#;
const SESSION_ROOT_BASE: &str = "/tmp/gateway/sessions";

#[derive(Debug)]
pub(crate) struct RuntimeEnv {
    pub(crate) config: AppConfig,
}

pub(crate) fn load_runtime_env() -> Result<RuntimeEnv> {
    let tokenhub_key = require_env("TOKENHUB_API_KEY")?;
    let tokenhub_model = env("TOKENHUB_MODEL", "minimax-m2.7");
    let e2b_api_key = require_env("E2B_API_KEY")?;
    let e2b_domain = env("E2B_DOMAIN", "ap-beijing.tencentags.com");
    let e2b_api_url = env("E2B_API_URL", &format!("https://api.{e2b_domain}"));
    let inner_template = require_env("INNER_SANDBOX_TEMPLATE")?;

    Ok(RuntimeEnv {
        config: build_runtime_config(
            &tokenhub_key,
            &tokenhub_model,
            &e2b_api_key,
            &e2b_domain,
            &e2b_api_url,
            &inner_template,
        ),
    })
}

pub(crate) async fn build_agent(
    runtime: &RuntimeEnv,
    workspace_root: PathBuf,
    memory_root: PathBuf,
    event_tx: mpsc::Sender<AgentEvent>,
) -> Result<AgentRuntime> {
    install_runtime_config(runtime.config.clone());
    std::env::set_current_dir(&workspace_root)
        .with_context(|| format!("failed to enter workspace '{}'", workspace_root.display()))?;

    let client = OpenAIClient::new(hermes_core::client::ClientConfig::from(
        &runtime.config.client,
    ));
    let agent_config = AgentConfig::from(&runtime.config.agent);
    let registry = ToolRegistry::new(agent_config.tool_timeout);
    register_builtin_tools_with_sub_agent(&registry, &client, &runtime.config.agent.model)
        .await
        .context("failed to register agent tools")?;

    let memory_manager = MemoryManager::with_storage_dir(memory_root.clone());
    memory_manager
        .load_from_disk()
        .await
        .with_context(|| format!("failed to load agent memory '{}'", memory_root.display()))?;

    let mut agent =
        hermes_core::AgentExecutor::with_events(agent_config, client, registry, event_tx)
            .with_memory_manager(memory_manager);
    let denied_tools = split_env_list("CLOUDAGENT_DENY_TOOLS");
    if !denied_tools.is_empty() {
        agent = agent.with_gate_hook(Arc::new(ToolNameGateHook::deny_tools(denied_tools)));
    }
    let selected_skills = split_env_list("CLOUDAGENT_SELECTED_SKILLS");
    if !selected_skills.is_empty() {
        agent = agent.with_prompt_transform_hook(Arc::new(SkillPromptHook::new(
            runtime.config.skills.root_dir.clone(),
            selected_skills,
        )));
    }
    Ok(AgentRuntime::from_agent(agent))
}

pub(crate) fn build_runtime_config(
    tokenhub_key: &str,
    tokenhub_model: &str,
    e2b_api_key: &str,
    e2b_domain: &str,
    e2b_api_url: &str,
    inner_template: &str,
) -> AppConfig {
    let mut config = AppConfig::default();
    config.client.base_url = TOKENHUB_BASE_URL.to_string();
    config.client.api_key = Some(tokenhub_key.to_string());
    config.client.timeout_secs = 120;
    config.agent = BehaviorSettings {
        model: tokenhub_model.to_string(),
        max_iterations: 12,
        tool_timeout_secs: 120,
        request_timeout_secs: 180,
        system_prompt: Some(
            std::env::var("HERMES_SYSTEM_PROMPT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| CLOUDAGENT_SYSTEM_PROMPT.to_string()),
        ),
        stream: true,
        context_window: 128_000,
        max_healing_attempts: 2,
        show_reasoning: false,
    };
    config.tools.registry_timeout_secs = 60;
    config.tools.e2b.enabled = true;
    config.tools.e2b.api_key = Some(e2b_api_key.to_string());
    config.tools.e2b.domain = e2b_domain.to_string();
    config.tools.e2b.api_url = Some(e2b_api_url.to_string());
    config.tools.e2b.template = Some(inner_template.to_string());
    config.tools.e2b.timeout_secs = 300;
    config.tools.e2b.request_timeout_secs = 120;
    config.tools.e2b.staged_input_dir = "/workspace".to_string();
    let web_search_provider = env("CLOUDAGENT_WEB_SEARCH_PROVIDER", "");
    let wsa_api_key = std::env::var("TENCENTCLOUD_WSA_APIKEY")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if web_search_provider.eq_ignore_ascii_case("tencent_wsa") || wsa_api_key.is_some() {
        config.tools.web.search_provider = "tencent_wsa".to_string();
        config.tools.web.tencent_wsa_api_key = wsa_api_key;
        config.tools.web.tencent_wsa_endpoint = env(
            "TENCENTCLOUD_WSA_ENDPOINT",
            "https://api.wsa.cloud.tencent.com/SearchPro",
        );
    } else if !web_search_provider.trim().is_empty() {
        config.tools.web.search_provider = web_search_provider;
    }
    config
}

pub(crate) fn session_paths(session_id: &str) -> SessionPaths {
    let root = PathBuf::from(SESSION_ROOT_BASE).join(session_id);
    SessionPaths {
        workspace_root: root.join("workspace"),
        memory_root: root.join("memory"),
    }
}

fn require_env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is required"))
}

fn env(name: &str, fallback: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

fn split_env_list(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}
