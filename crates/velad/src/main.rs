use std::{
    env, fs,
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

    let config = velad::local_runtime::LocalRuntimeConfig::from_env_args()?;
    let backend_cwd = env::var("VELAD_BACKEND_CWD")
        .or_else(|_| env::current_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|_| ".".to_string());

    let store = Arc::new(SqliteEventStore::connect(&config.database_url).await?);
    let observability =
        vela_observability::ObservabilityStore::connect_for_database_url(&config.database_url)
            .await?;
    init_logging(observability.clone());
    let pi_backend = pi_backend_from_env(backend_cwd.clone())?;
    let default_session_model = pi_backend.model.clone();
    let pi_backend = Arc::new(pi_backend);
    let codex_backend = Arc::new(CodexAppServerBackendAdapter::stdio(backend_cwd.clone()));
    let tcodex_backend = Arc::new(CodexAppServerBackendAdapter::stdio_command(
        backend_cwd.clone(),
        env::var("VELAD_TCODEX_COMMAND").unwrap_or_else(|_| "tcodex".to_string()),
        tcodex_args(),
    ));
    let acp_backend = acp_backend_from_env(backend_cwd.clone());
    let acp_default_model = acp_default_model();
    let acp_backend = Arc::new(acp_backend);
    let backend = BackendRouter::new()
        .with_backend(BackendKind::Pi, pi_backend)
        .with_backend(BackendKind::Codex, codex_backend)
        .with_backend(BackendKind::Tcodex, tcodex_backend)
        .with_backend(BackendKind::Acp, acp_backend);
    #[cfg(feature = "embedded-vela-engine")]
    let (backend, vela_engine_default_model, vela_engine_updater) = {
        let vela_engine = vela_engine::VelaEngineBackendAdapter::new(
            vela_engine::VelaEngineConfig::new("", "", "", backend_cwd.clone()),
        );
        if let Some(settings) = load_stored_vela_engine_settings(&store).await? {
            vela_engine.update_config(vela_engine_config_from_settings(
                settings,
                backend_cwd.clone(),
            ));
        }
        let vela_engine_config = vela_engine.config();
        let default_model = vela_engine_config
            .is_configured()
            .then(|| vela_engine_config.model.clone());
        let vela_engine = Arc::new(vela_engine);
        let updater = Arc::new(VelaEngineSettingsUpdater {
            adapter: Arc::clone(&vela_engine),
            cwd: backend_cwd.clone(),
        });
        (
            backend.with_backend(BackendKind::VelaEngine, vela_engine),
            default_model,
            updater,
        )
    };
    let backend = Arc::new(backend);
    let runtime = Runtime::new(store.clone(), backend).with_observability(observability.clone());
    let listener = tokio::net::TcpListener::bind(config.listen_addr).await?;
    let bound_addr = listener.local_addr()?;
    let ready = velad::local_runtime::ReadyEvent::new(bound_addr);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let state = velad::ApiState::new(store, runtime)
        .with_default_session_model(default_session_model)
        .with_codex_backend(env::var("VELAD_CODEX_MODEL").ok())
        .with_tcodex_backend(env::var("VELAD_TCODEX_MODEL").ok())
        .with_acp_backend(acp_default_model)
        .with_observability(observability);
    #[cfg(feature = "embedded-vela-engine")]
    let state = state.with_vela_engine_backend(vela_engine_default_model);
    #[cfg(feature = "embedded-vela-engine")]
    let state = state.with_backend_settings_updater(vela_engine_updater);
    let app = velad::build_app(state.with_local_runtime(
        velad::local_runtime::LocalRuntimeState::new(ready.clone(), config.management_token),
        shutdown_tx,
    ));

    println!("{}", serde_json::to_string(&ready)?);
    axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_shutdown(shutdown_rx))
        .await?;
    Ok(())
}

async fn wait_for_shutdown(mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
    tokio::select! {
        _ = async {
            while shutdown_rx.changed().await.is_ok() {
                if *shutdown_rx.borrow() {
                    break;
                }
            }
        } => {}
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate_signal() => {}
    }
}

#[cfg(unix)]
async fn terminate_signal() {
    use tokio::signal::unix::{SignalKind, signal};

    if let Ok(mut signal) = signal(SignalKind::terminate()) {
        let _ = signal.recv().await;
    }
}

#[cfg(not(unix))]
async fn terminate_signal() {
    std::future::pending::<()>().await;
}

fn init_logging(observability: vela_observability::ObservabilityStore) {
    use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(vela_observability::tracing_log_layer(observability))
        .with(fmt::layer())
        .try_init();
}

fn acp_backend_from_env(cwd: String) -> AcpBackendAdapter {
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
    let mut host = AcpStdioHost {
        command,
        args,
        cwd: cwd.clone(),
        env: Default::default(),
    };
    host = host.with_cloudagents_defaults(
        env::var("VELA_CLOUDAGENTS_API_KEY")
            .or_else(|_| env::var("VELAD_ACP_API_KEY"))
            .ok(),
        acp_default_model(),
    );
    for (key, value) in env::vars() {
        if let Some(env_key) = key.strip_prefix("VELAD_ACP_ENV_") {
            host.env.insert(env_key.to_string(), value);
        }
    }
    AcpBackendAdapter::hermes(cwd, host)
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

fn tcodex_args() -> Vec<String> {
    env::var("VELAD_TCODEX_ARGS")
        .ok()
        .map(|value| {
            value
                .split_whitespace()
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|args| !args.is_empty())
        .unwrap_or_else(|| vec!["app-server".to_string(), "--stdio".to_string()])
}

#[cfg(feature = "embedded-vela-engine")]
struct VelaEngineSettingsUpdater {
    adapter: Arc<vela_engine::VelaEngineBackendAdapter>,
    cwd: String,
}

#[cfg(feature = "embedded-vela-engine")]
impl velad::BackendSettingsUpdater for VelaEngineSettingsUpdater {
    fn update_vela_engine(&self, settings: velad::VelaEngineBackendSettings) {
        self.adapter
            .update_config(vela_engine_config_from_settings(settings, self.cwd.clone()));
    }
}

#[cfg(feature = "embedded-vela-engine")]
async fn load_stored_vela_engine_settings(
    store: &SqliteEventStore,
) -> anyhow::Result<Option<velad::VelaEngineBackendSettings>> {
    Ok(store
        .get_backend_settings("vela_engine")
        .await?
        .map(|stored| vela_engine_settings_from_json(stored.settings)))
}

#[cfg(feature = "embedded-vela-engine")]
fn vela_engine_settings_from_json(value: serde_json::Value) -> velad::VelaEngineBackendSettings {
    let object = value.as_object();
    velad::VelaEngineBackendSettings {
        endpoint: object
            .and_then(|object| object.get("endpoint"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        api_key: object
            .and_then(|object| object.get("api_key"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: object
            .and_then(|object| object.get("model"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

#[cfg(feature = "embedded-vela-engine")]
fn vela_engine_config_from_settings(
    settings: velad::VelaEngineBackendSettings,
    cwd: String,
) -> vela_engine::VelaEngineConfig {
    vela_engine::VelaEngineConfig::new(settings.endpoint, settings.api_key, settings.model, cwd)
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
