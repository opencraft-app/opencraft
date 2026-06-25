use std::{env, net::SocketAddr};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

pub const RUNTIME_PROTOCOL: &str = "velad.local.v1";
pub const API_PROTOCOL: &str = "velachat.v1";
pub const READY_EVENT_TYPE: &str = "velad.ready";
pub const OTEL_PROTOCOL: &str = "otlp.http.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalRuntimeConfig {
    pub listen_addr: SocketAddr,
    pub database_url: String,
    pub management_token: Option<String>,
}

impl LocalRuntimeConfig {
    pub fn from_env_args() -> anyhow::Result<Self> {
        Self::from_env_args_iter(env::args().skip(1))
    }

    pub fn from_env_args_iter<I, S>(args: I) -> anyhow::Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let cli = CliRuntimeConfig::parse(args)?;
        let listen_addr = cli
            .listen
            .or_else(|| env::var("VELAD_LISTEN_ADDR").ok())
            .unwrap_or_else(|| "127.0.0.1:3857".to_string())
            .parse::<SocketAddr>()
            .context("invalid velad listen address")?;
        let database_url = cli
            .database_url
            .or_else(|| env::var("VELAD_DATABASE_URL").ok())
            .unwrap_or_else(|| "sqlite::memory:".to_string());
        let management_token = cli
            .management_token
            .or_else(|| env::var("VELAD_MANAGEMENT_TOKEN").ok())
            .filter(|value| !value.is_empty());

        Ok(Self {
            listen_addr,
            database_url,
            management_token,
        })
    }
}

#[derive(Default)]
struct CliRuntimeConfig {
    listen: Option<String>,
    database_url: Option<String>,
    management_token: Option<String>,
}

impl CliRuntimeConfig {
    fn parse<I, S>(args: I) -> anyhow::Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut config = Self::default();
        let mut args = args.into_iter().map(Into::into).peekable();
        while let Some(arg) = args.next() {
            if let Some((key, value)) = arg.split_once('=') {
                config.set(key, value.to_string())?;
                continue;
            }
            match arg.as_str() {
                "--listen" | "--database-url" | "--management-token" => {
                    let Some(value) = args.next() else {
                        bail!("{arg} requires a value");
                    };
                    config.set(&arg, value)?;
                }
                "--help" | "-h" => bail!(
                    "usage: velad [--listen ADDR] [--database-url URL] [--management-token TOKEN]"
                ),
                _ => bail!("unknown velad argument: {arg}"),
            }
        }
        Ok(config)
    }

    fn set(&mut self, key: &str, value: String) -> anyhow::Result<()> {
        match key {
            "--listen" => self.listen = Some(value),
            "--database-url" => self.database_url = Some(value),
            "--management-token" => self.management_token = Some(value),
            _ => bail!("unknown velad argument: {key}"),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReadyEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub runtime_protocol: String,
    pub api_protocol: String,
    pub otel_protocol: String,
    pub pid: u32,
    pub listen_addr: String,
    pub api_base_url: String,
    pub otel_base_url: String,
    pub observability_base_url: String,
    pub version: String,
}

impl ReadyEvent {
    pub fn new(listen_addr: SocketAddr) -> Self {
        let listen_addr = listen_addr.to_string();
        Self {
            event_type: READY_EVENT_TYPE.to_string(),
            runtime_protocol: RUNTIME_PROTOCOL.to_string(),
            api_protocol: API_PROTOCOL.to_string(),
            otel_protocol: OTEL_PROTOCOL.to_string(),
            pid: std::process::id(),
            api_base_url: format!("http://{listen_addr}/api/v1"),
            otel_base_url: format!("http://{listen_addr}"),
            observability_base_url: format!("http://{listen_addr}/api/v1/observability"),
            listen_addr,
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct LocalRuntimeState {
    pub info: ReadyEvent,
    pub management_token: Option<String>,
}

impl LocalRuntimeState {
    pub fn new(info: ReadyEvent, management_token: Option<String>) -> Self {
        Self {
            info,
            management_token,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_runtime_config_without_new_dependencies() {
        let config = CliRuntimeConfig::parse([
            "--listen=127.0.0.1:0",
            "--database-url",
            "sqlite:test.db",
            "--management-token",
            "secret",
        ])
        .expect("config");

        assert_eq!(config.listen.as_deref(), Some("127.0.0.1:0"));
        assert_eq!(config.database_url.as_deref(), Some("sqlite:test.db"));
        assert_eq!(config.management_token.as_deref(), Some("secret"));
    }

    #[tokio::test]
    async fn listen_port_zero_ready_event_uses_real_bound_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let ready = ReadyEvent::new(addr);

        assert_ne!(addr.port(), 0);
        assert_eq!(ready.runtime_protocol, RUNTIME_PROTOCOL);
        assert_eq!(ready.api_protocol, API_PROTOCOL);
        assert_eq!(ready.otel_protocol, OTEL_PROTOCOL);
        assert!(ready.listen_addr.ends_with(&format!(":{}", addr.port())));
        assert!(ready.api_base_url.ends_with("/api/v1"));
        assert!(ready.otel_base_url.starts_with("http://127.0.0.1:"));
        assert!(
            ready
                .observability_base_url
                .ends_with("/api/v1/observability")
        );
    }
}
