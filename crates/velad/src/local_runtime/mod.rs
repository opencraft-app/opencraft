use std::{
    env, fs,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
};

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
    pub ready_file: Option<PathBuf>,
    pub build_id: Option<String>,
    pub target_triple: Option<String>,
    pub remote_instance_id: Option<String>,
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
        let ready_file = cli
            .ready_file
            .or_else(|| env::var("VELAD_READY_FILE").ok())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let build_id = cli
            .build_id
            .or_else(|| env::var("VELAD_BUILD_ID").ok())
            .filter(|value| !value.is_empty());
        let target_triple = cli
            .target_triple
            .or_else(|| env::var("VELAD_TARGET_TRIPLE").ok())
            .filter(|value| !value.is_empty());
        let remote_instance_id = cli
            .remote_instance_id
            .or_else(|| env::var("VELAD_REMOTE_INSTANCE_ID").ok())
            .filter(|value| !value.is_empty());

        Ok(Self {
            listen_addr,
            database_url,
            management_token,
            ready_file,
            build_id,
            target_triple,
            remote_instance_id,
        })
    }
}

#[derive(Default)]
struct CliRuntimeConfig {
    listen: Option<String>,
    database_url: Option<String>,
    management_token: Option<String>,
    ready_file: Option<String>,
    build_id: Option<String>,
    target_triple: Option<String>,
    remote_instance_id: Option<String>,
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
                "--listen"
                | "--database-url"
                | "--management-token"
                | "--ready-file"
                | "--build-id"
                | "--target-triple"
                | "--remote-instance-id" => {
                    let Some(value) = args.next() else {
                        bail!("{arg} requires a value");
                    };
                    config.set(&arg, value)?;
                }
                "--help" | "-h" => bail!(
                    "usage: velad [--listen ADDR] [--database-url URL] [--management-token TOKEN] [--ready-file PATH]"
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
            "--ready-file" => self.ready_file = Some(value),
            "--build-id" => self.build_id = Some(value),
            "--target-triple" => self.target_triple = Some(value),
            "--remote-instance-id" => self.remote_instance_id = Some(value),
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_triple: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_instance_id: Option<String>,
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
            build_id: None,
            target_triple: None,
            remote_instance_id: None,
        }
    }

    pub fn with_remote_metadata(
        mut self,
        build_id: Option<String>,
        target_triple: Option<String>,
        remote_instance_id: Option<String>,
    ) -> Self {
        self.build_id = build_id;
        self.target_triple = target_triple;
        self.remote_instance_id = remote_instance_id;
        self
    }
}

pub fn write_ready_file(path: &Path, ready: &ReadyEvent) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create ready file parent {}", parent.display()))?;
    }
    let tmp_path = path.with_extension("tmp");
    let payload = serde_json::to_vec(ready)?;
    {
        let mut file = fs::File::create(&tmp_path)
            .with_context(|| format!("create ready file temp {}", tmp_path.display()))?;
        file.write_all(&payload)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp_path, path).with_context(|| {
        format!(
            "rename ready file {} to {}",
            tmp_path.display(),
            path.display()
        )
    })?;
    if let Some(parent) = path.parent() {
        fs::File::open(parent).and_then(|file| file.sync_all()).ok();
    }
    Ok(())
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
            "--ready-file",
            "/tmp/velad.ready",
            "--build-id=build-1",
            "--target-triple",
            "x86_64-unknown-linux-gnu",
            "--remote-instance-id",
            "rt_1",
        ])
        .expect("config");

        assert_eq!(config.listen.as_deref(), Some("127.0.0.1:0"));
        assert_eq!(config.database_url.as_deref(), Some("sqlite:test.db"));
        assert_eq!(config.management_token.as_deref(), Some("secret"));
        assert_eq!(config.ready_file.as_deref(), Some("/tmp/velad.ready"));
        assert_eq!(config.build_id.as_deref(), Some("build-1"));
        assert_eq!(
            config.target_triple.as_deref(),
            Some("x86_64-unknown-linux-gnu")
        );
        assert_eq!(config.remote_instance_id.as_deref(), Some("rt_1"));
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

    #[test]
    fn ready_file_is_written_atomically_enough_for_ssh_handshake() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("run").join("velad.ready.json");
        let ready = ReadyEvent::new("127.0.0.1:49321".parse().unwrap()).with_remote_metadata(
            Some("build".to_string()),
            Some("x86_64-unknown-linux-gnu".to_string()),
            Some("rt_1".to_string()),
        );

        write_ready_file(&path, &ready).expect("write ready");

        let value: ReadyEvent =
            serde_json::from_slice(&std::fs::read(&path).expect("ready bytes")).expect("json");
        assert_eq!(value.remote_instance_id.as_deref(), Some("rt_1"));
        assert_eq!(value.build_id.as_deref(), Some("build"));
        assert!(!path.with_extension("tmp").exists());
    }
}
