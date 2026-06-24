use std::{
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use vela_backends::{
    AcpBackendAdapter, AcpStdioHost, BackendRouter, CodexAppServerBackendAdapter, PiBackendAdapter,
};
use vela_core::BackendKind;
use vela_runtime::Runtime;
use vela_store::SqliteEventStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    load_local_env_files();
    init_logging();

    let listen_addr = env::var("VELAD_LISTEN_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3857".to_string())
        .parse::<SocketAddr>()?;
    let database_url =
        env::var("VELAD_DATABASE_URL").unwrap_or_else(|_| "sqlite::memory:".to_string());
    let backend_cwd = env::var("VELAD_BACKEND_CWD")
        .or_else(|_| env::current_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|_| ".".to_string());

    let store = Arc::new(SqliteEventStore::connect(&database_url).await?);
    let pi_backend = pi_backend_from_env(backend_cwd.clone())?;
    let default_session_model = pi_backend.model.clone();
    let pi_backend = Arc::new(pi_backend);
    let codex_backend = Arc::new(CodexAppServerBackendAdapter::stdio(backend_cwd.clone()));
    let acp_backend = acp_backend_from_env(backend_cwd.clone())?;
    let acp_default_model = acp_default_model();
    let acp_backend = Arc::new(acp_backend);
    let backend = Arc::new(
        BackendRouter::new()
            .with_backend(BackendKind::Pi, pi_backend)
            .with_backend(BackendKind::Codex, codex_backend)
            .with_backend(BackendKind::Acp, acp_backend),
    );
    let runtime = Runtime::new(store.clone(), backend);
    let app = velad::build_app(
        velad::ApiState::new(store, runtime)
            .with_default_session_model(default_session_model)
            .with_codex_backend(env::var("VELAD_CODEX_MODEL").ok())
            .with_acp_backend(acp_default_model),
    );
    let listener = tokio::net::TcpListener::bind(listen_addr).await?;

    eprintln!("velad listening on http://{listen_addr}/api/v1");
    axum::serve(listener, app).await?;
    Ok(())
}

fn init_logging() {
    use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .try_init();
}

fn acp_backend_from_env(cwd: String) -> anyhow::Result<AcpBackendAdapter> {
    let command = env::var("VELAD_ACP_COMMAND").unwrap_or_else(|_| "hermes".to_string());
    let args = env::var("VELAD_ACP_ARGS")
        .ok()
        .map(|value| {
            value
                .split_whitespace()
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|args| !args.is_empty())
        .unwrap_or_else(|| vec!["acp".to_string()]);
    let mut host = AcpStdioHost::new(command, args, cwd.clone());
    host = host.with_cloudagents_defaults(
        env::var("VELA_CLOUDAGENTS_API_KEY")
            .or_else(|_| env::var("VELAD_ACP_API_KEY"))
            .ok(),
        acp_default_model(),
    )?;
    for (key, value) in env::vars() {
        if let Some(env_key) = key.strip_prefix("VELAD_ACP_ENV_") {
            host.env.insert(env_key.to_string(), value);
        }
    }
    Ok(AcpBackendAdapter::hermes(cwd, host))
}

fn acp_default_model() -> Option<String> {
    env::var("VELAD_ACP_MODEL")
        .or_else(|_| env::var("HERMES_INFERENCE_MODEL"))
        .ok()
        .or_else(|| {
            env::var("VELA_CLOUDAGENTS_API_KEY")
                .ok()
                .map(|_| "minimax-m2.7".to_string())
        })
}

fn load_local_env_files() {
    let _ = dotenvy::from_filename(".env.local");
    let _ = dotenvy::dotenv();
}

fn pi_backend_from_env(cwd: String) -> anyhow::Result<PiBackendAdapter> {
    pi_backend_from_settings(
        cwd,
        PiBackendSettings {
            command: env::var("VELAD_PI_COMMAND").ok(),
            session_dir: env::var("VELAD_PI_SESSION_DIR").ok(),
            model: env::var("VELAD_PI_MODEL").ok(),
            thinking: env::var("VELAD_PI_THINKING").ok(),
            session: env::var("VELAD_PI_SESSION").ok(),
            provider: env::var("VELAD_PI_PROVIDER").ok(),
            api_key: env::var("VELAD_PI_API_KEY").ok(),
            no_tools: env::var("VELAD_PI_NO_TOOLS")
                .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
                .unwrap_or(false),
            pi_agent_dir: env::var("PI_CODING_AGENT_DIR")
                .or_else(|_| env::var("VELAD_PI_AGENT_DIR"))
                .ok()
                .map(PathBuf::from),
            cloudagents_api_key_present: env::var("VELA_CLOUDAGENTS_API_KEY").is_ok(),
        },
    )
}

#[derive(Debug, Default)]
struct PiBackendSettings {
    command: Option<String>,
    session_dir: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    session: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    no_tools: bool,
    pi_agent_dir: Option<PathBuf>,
    cloudagents_api_key_present: bool,
}

fn pi_backend_from_settings(
    cwd: String,
    mut settings: PiBackendSettings,
) -> anyhow::Result<PiBackendAdapter> {
    let mut backend = PiBackendAdapter::new(cwd);
    if let Some(command) = settings.command {
        backend.command = command;
    }
    if settings.cloudagents_api_key_present {
        settings
            .provider
            .get_or_insert_with(|| "cloudagents".to_string());
        settings
            .model
            .get_or_insert_with(|| "minimax-m2.7".to_string());
        let agent_dir = settings
            .pi_agent_dir
            .get_or_insert_with(default_cloudagents_pi_agent_dir);
        write_cloudagents_models_json(agent_dir)?;
        backend.env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir.to_string_lossy().to_string(),
        );
    }
    backend.session_dir = settings.session_dir;
    backend.model = settings.model;
    backend.thinking = settings.thinking;
    backend.session = settings.session;
    backend.provider = settings.provider;
    backend.api_key = settings.api_key;
    backend.no_tools = settings.no_tools;
    Ok(backend)
}

fn default_cloudagents_pi_agent_dir() -> PathBuf {
    env::temp_dir().join(format!("vela-pi-agent-{}", std::process::id()))
}

fn write_cloudagents_models_json(agent_dir: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(agent_dir)?;
    fs::write(
        agent_dir.join("models.json"),
        r#"{
  "providers": {
    "cloudagents": {
      "baseUrl": "https://tokenhub.tencentmaas.com/v1",
      "api": "openai-completions",
      "apiKey": "$VELA_CLOUDAGENTS_API_KEY",
      "authHeader": true,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "minimax-m2.7",
          "name": "MiniMax M2.7 via CloudAgents",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
"#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloudagents_key_configures_pi_provider_model_and_agent_dir_without_persisting_secret() {
        let agent_dir = env::temp_dir().join(format!(
            "vela-pi-agent-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));

        let backend = pi_backend_from_settings(
            "/tmp/project".to_string(),
            PiBackendSettings {
                cloudagents_api_key_present: true,
                pi_agent_dir: Some(agent_dir.clone()),
                ..PiBackendSettings::default()
            },
        )
        .expect("backend config");

        assert_eq!(backend.provider.as_deref(), Some("cloudagents"));
        assert_eq!(backend.model.as_deref(), Some("minimax-m2.7"));
        assert_eq!(
            backend.env.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some(agent_dir.to_string_lossy().as_ref())
        );
        assert_eq!(
            backend.launch_args(),
            vec![
                "--mode",
                "rpc",
                "--model",
                "minimax-m2.7",
                "--provider",
                "cloudagents"
            ]
        );

        let models_json = fs::read_to_string(agent_dir.join("models.json")).expect("models.json");
        assert!(models_json.contains("https://tokenhub.tencentmaas.com/v1"));
        assert!(models_json.contains("\"id\": \"minimax-m2.7\""));
        assert!(models_json.contains("$VELA_CLOUDAGENTS_API_KEY"));
        assert!(!models_json.contains("sk-"));
    }

    #[test]
    fn explicit_pi_provider_and_model_override_cloudagents_defaults() {
        let agent_dir = env::temp_dir().join(format!(
            "vela-pi-agent-test-{}-override",
            std::process::id()
        ));

        let backend = pi_backend_from_settings(
            "/tmp/project".to_string(),
            PiBackendSettings {
                provider: Some("custom".to_string()),
                model: Some("custom-model".to_string()),
                cloudagents_api_key_present: true,
                pi_agent_dir: Some(agent_dir),
                ..PiBackendSettings::default()
            },
        )
        .expect("backend config");

        assert_eq!(backend.provider.as_deref(), Some("custom"));
        assert_eq!(backend.model.as_deref(), Some("custom-model"));
        assert_eq!(
            backend.launch_args(),
            vec![
                "--mode",
                "rpc",
                "--model",
                "custom-model",
                "--provider",
                "custom"
            ]
        );
    }
}
