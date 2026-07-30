use std::collections::HashMap;
mod client;
mod connect_stream;
mod path_sync;
mod registry;
mod sandbox_host;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::{multipart, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::{runtime_config, E2BToolSettings};
use crate::error::{Error, Result};
use crate::workspace::{WorkspaceIdentity, WorkspaceRuntime};

use self::connect_stream::{connect_envelope, read_connect_command_stream};
use self::path_sync::{normalize_absolute_path, normalize_relative_path, should_skip_path};
use self::registry::register_active_session_sandbox;
pub use self::registry::{
    download_active_session_sandbox_file, sync_active_session_sandbox_files,
    upload_active_session_sandbox_file,
};
#[cfg(test)]
use self::sandbox_host::parse_host_port;
use self::sandbox_host::{
    parse_native_host_response, sandbox_host_addr, sandbox_host_bin,
    sandbox_host_bootstrap_command, sandbox_host_cli_fallback_enabled, sandbox_host_port,
    sandbox_host_probe_addr, sandbox_host_sha256, sandbox_host_transport, sandbox_host_url,
    shell_quote, sidecar_timeline, SandboxHostTransport,
};

const DEFAULT_ENVD_PORT: u16 = 49983;

#[derive(Debug, Clone)]
pub struct E2BClientConfig {
    pub domain: String,
    pub api_url: String,
    pub api_key: String,
    pub envd_port: u16,
    pub envd_user: String,
    pub request_timeout: Duration,
}

impl E2BClientConfig {
    pub fn from_settings(settings: &E2BToolSettings) -> Result<Self> {
        let api_key = settings
            .api_key
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| Error::MissingConfig {
                key: "tools.e2b.api_key / E2B_API_KEY".to_string(),
            })?;
        let domain = if settings.domain.trim().is_empty() {
            "ap-beijing.tencentags.com".to_string()
        } else {
            settings.domain.trim().to_string()
        };
        let api_url = settings
            .api_url
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("https://api.{domain}"));

        Ok(Self {
            domain,
            api_url,
            api_key,
            envd_port: DEFAULT_ENVD_PORT,
            envd_user: settings.user.clone(),
            request_timeout: Duration::from_secs(settings.request_timeout_secs),
        })
    }
}

#[derive(Debug, Clone)]
pub struct E2BClient {
    config: E2BClientConfig,
    http_client: Client,
}

#[derive(Debug, Clone)]
pub struct E2BSandbox {
    pub sandbox_id: String,
    pub envd_access_token: String,
    pub traffic_access_token: String,
    pub domain: String,
}

impl E2BSandbox {
    fn proxy_access_token(&self) -> &str {
        if self.traffic_access_token.is_empty() {
            &self.envd_access_token
        } else {
            &self.traffic_access_token
        }
    }
}

#[derive(Debug, Clone)]
pub struct CreateSandboxOptions {
    pub template_id: String,
    pub timeout_secs: u64,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub exited: bool,
    pub status: String,
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceRuntimeShutdownReport {
    pub exit_code: i32,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

#[derive(Debug)]
pub struct SessionSandbox {
    workspace_root: String,
    local_workspace_root: PathBuf,
    command_prefix: Option<String>,
    shutdown_command: Option<String>,
    native_host_ready: Mutex<bool>,
    inner: Mutex<SessionSandboxInner>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSandboxEnvdIdentity {
    pub sandbox_id: String,
    pub domain: String,
    pub envd_access_token: String,
}

#[derive(Debug, Clone)]
pub struct SessionSandboxBinding {
    pub sandbox_id: String,
    pub domain: String,
    pub envd_access_token: String,
    pub traffic_access_token: String,
    pub workspace_root: String,
    pub local_workspace_root: PathBuf,
    pub command_prefix: Option<String>,
    pub command_shell_prefix: Option<String>,
    pub shutdown_command: Option<String>,
}

#[derive(Debug)]
struct SessionSandboxInner {
    client: E2BClient,
    sandbox: E2BSandbox,
}

#[derive(Debug, Serialize)]
struct CreateSandboxRequest<'a> {
    #[serde(rename = "templateID")]
    template_id: &'a str,
    timeout: u64,
    #[serde(rename = "autoPause")]
    auto_pause: bool,
    secure: bool,
    allow_internet_access: bool,
    metadata: &'a HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct CreateSandboxResponse {
    #[serde(rename = "sandboxID")]
    sandbox_id: String,
    #[serde(rename = "envdAccessToken")]
    envd_access_token: Option<String>,
    #[serde(rename = "trafficAccessToken")]
    traffic_access_token: Option<String>,
    domain: Option<String>,
}

#[derive(Debug, Serialize)]
struct StartProcessRequest<'a> {
    process: ProcessStart<'a>,
    stdin: bool,
}

#[derive(Debug, Serialize)]
struct ProcessStart<'a> {
    cmd: &'a str,
    args: Vec<&'a str>,
    envs: &'a HashMap<String, String>,
}

pub fn e2b_enabled() -> bool {
    runtime_config().tools.e2b.enabled
}

pub fn e2b_staged_input_dir() -> String {
    runtime_config().tools.e2b.staged_input_dir
}

pub fn e2b_template() -> Option<String> {
    runtime_config().tools.e2b.template
}

pub fn e2b_timeout_secs() -> u64 {
    runtime_config().tools.e2b.timeout_secs
}

pub fn build_client() -> Result<E2BClient> {
    let settings = runtime_config().tools.e2b;
    E2BClient::from_settings(&settings)
}

pub async fn create_session_sandbox(
    session_id: &str,
    local_workspace_root: &Path,
) -> Result<Arc<SessionSandbox>> {
    let Some(template) = e2b_template() else {
        return Err(Error::MissingConfig {
            key: "INNER_SANDBOX_TEMPLATE / HERMES_E2B_TEMPLATE".to_string(),
        });
    };
    let client = build_client()?;
    info!(event = "inner_create_start", session_id = %session_id, template = %template);
    let mut metadata = HashMap::new();
    metadata.insert("tool".to_string(), "session_workspace".to_string());
    metadata.insert("session_id".to_string(), session_id.to_string());
    let sandbox = client
        .create_sandbox(&CreateSandboxOptions {
            template_id: template,
            timeout_secs: e2b_timeout_secs(),
            metadata,
        })
        .await?;
    let sandbox_id = sandbox.sandbox_id.clone();

    let staged_input_dir = e2b_staged_input_dir();
    let staged_input_dir = staged_input_dir.trim_end_matches('/');
    let workspace_root = if staged_input_dir == "/workspace" {
        "/workspace".to_string()
    } else {
        format!("{}/{}/workspace", staged_input_dir, session_id)
    };
    let session = Arc::new(SessionSandbox {
        workspace_root,
        local_workspace_root: local_workspace_root.to_path_buf(),
        command_prefix: None,
        shutdown_command: None,
        native_host_ready: Mutex::new(false),
        inner: Mutex::new(SessionSandboxInner { client, sandbox }),
    });
    register_active_session_sandbox(&session);
    session.ensure_workspace().await?;
    session.sync_dir(local_workspace_root).await?;
    info!(event = "inner_ready", session_id = %session_id, workspace_root = %session.workspace_root(), sandbox_id = %sandbox_id);
    Ok(session)
}

pub async fn bind_session_sandbox(binding: SessionSandboxBinding) -> Result<Arc<SessionSandbox>> {
    if binding.sandbox_id.trim().is_empty() {
        return Err(Error::Agent("workspace sandbox_id is required".to_string()));
    }
    if binding.domain.trim().is_empty() {
        return Err(Error::Agent(
            "workspace sandbox domain is required".to_string(),
        ));
    }
    if binding.envd_access_token.trim().is_empty() {
        return Err(Error::Agent(
            "workspace envd access token is required".to_string(),
        ));
    }
    let client = build_client()?;
    let sandbox = E2BSandbox {
        sandbox_id: binding.sandbox_id,
        domain: binding.domain,
        envd_access_token: binding.envd_access_token,
        traffic_access_token: binding.traffic_access_token,
    };
    let workspace_root = if binding.workspace_root.trim().is_empty() {
        "/workspace".to_string()
    } else {
        binding.workspace_root
    };
    let session = Arc::new(SessionSandbox {
        workspace_root,
        local_workspace_root: binding.local_workspace_root,
        command_prefix: binding.command_prefix,
        shutdown_command: binding.shutdown_command,
        native_host_ready: Mutex::new(false),
        inner: Mutex::new(SessionSandboxInner { client, sandbox }),
    });
    register_active_session_sandbox(&session);
    Ok(session)
}

impl SessionSandbox {
    pub fn workspace_root(&self) -> &str {
        &self.workspace_root
    }

    pub async fn sandbox_id(&self) -> String {
        self.inner.lock().await.sandbox.sandbox_id.clone()
    }

    pub async fn envd_identity(&self) -> SessionSandboxEnvdIdentity {
        let inner = self.inner.lock().await;
        SessionSandboxEnvdIdentity {
            sandbox_id: inner.sandbox.sandbox_id.clone(),
            domain: inner.sandbox.domain.clone(),
            envd_access_token: inner.sandbox.envd_access_token.clone(),
        }
    }

    pub fn local_workspace_root(&self) -> &Path {
        &self.local_workspace_root
    }

    pub fn resolve_path(&self, path: &str) -> Result<String> {
        let candidate = Path::new(path);
        if candidate.is_absolute() {
            if let Ok(relative) = candidate.strip_prefix(&self.local_workspace_root) {
                let relative = normalize_relative_path(relative)?;
                if relative.is_empty() {
                    return Ok(self.workspace_root.clone());
                }
                return Ok(format!("{}/{}", self.workspace_root, relative));
            }
            return normalize_absolute_path(candidate);
        }

        let relative = normalize_relative_path(candidate)?;
        if relative.is_empty() {
            Ok(self.workspace_root.clone())
        } else {
            Ok(format!("{}/{}", self.workspace_root, relative))
        }
    }

    pub fn resolve_working_dir(&self, path: Option<&str>) -> Result<String> {
        match path {
            Some(path) => self.resolve_path(path),
            None => Ok(self.workspace_root.clone()),
        }
    }

    pub fn display_path(&self, remote_path: &str) -> String {
        let workspace_root = self.workspace_root.trim_end_matches('/');
        if remote_path == workspace_root {
            return self.local_workspace_root.to_string_lossy().into_owned();
        }
        if let Some(relative) = remote_path
            .strip_prefix(workspace_root)
            .and_then(|value| value.strip_prefix('/'))
        {
            return self
                .local_workspace_root
                .join(relative)
                .to_string_lossy()
                .into_owned();
        }
        remote_path.to_string()
    }

    pub fn native_host_configured(&self) -> bool {
        let configured = sandbox_host_url().is_some();
        sidecar_timeline(
            "sandbox_host_config_check",
            &[("configured", configured.to_string())],
        );
        configured
    }

    pub async fn run_command(
        &self,
        command: &str,
        envs: &HashMap<String, String>,
    ) -> Result<CommandResult> {
        let command = match self.command_prefix.as_deref() {
            Some(prefix) if !prefix.trim().is_empty() => {
                // command_prefix is a capability host boundary such as Wisp exec.
                // The target runtime may not expose the outer /workspace path, so
                // prefixed commands must rely on their own absolute paths.
                format!("{prefix} {}", shell_quote(command))
            }
            _ => format!("cd {} && {}", shell_quote(&self.workspace_root), command),
        };
        let inner = self.inner.lock().await;
        inner
            .client
            .run_command(&inner.sandbox, &command, envs)
            .await
    }

    pub async fn native_call(&self, method: &str, params: Value) -> Result<Value> {
        self.ensure_native_host().await?;
        match sandbox_host_transport() {
            SandboxHostTransport::Http => {
                let port = sandbox_host_port()?;
                let inner = self.inner.lock().await;
                match inner
                    .client
                    .native_host_call(&inner.sandbox, port, method, params.clone())
                    .await
                {
                    Ok(value) => Ok(value),
                    Err(error) if sandbox_host_cli_fallback_enabled() => {
                        warn!(
                            event = "sandbox_host_http_call_failed_falling_back_to_cli",
                            method = %method,
                            port = port,
                            error = %error
                        );
                        drop(inner);
                        self.native_call_via_cli(method, params).await
                    }
                    Err(error) => Err(error),
                }
            }
            SandboxHostTransport::Cli => self.native_call_via_cli(method, params).await,
        }
    }

    async fn native_call_via_cli(&self, method: &str, params: Value) -> Result<Value> {
        let bin = sandbox_host_bin();
        let addr = sandbox_host_probe_addr(&sandbox_host_addr());
        let payload = serde_json::to_string(&params)
            .map_err(|error| Error::ParseResponse(error.to_string()))?;
        let command = format!(
            "{} call --url {} --method {} --json {}",
            shell_quote(&bin),
            shell_quote(&format!("http://{addr}")),
            shell_quote(method),
            shell_quote(&payload)
        );
        let result = self.run_command(&command, &HashMap::new()).await?;
        parse_native_host_response(method, &result.stdout)
    }

    pub async fn upload_text(&self, relative_path: &str, content: &str) -> Result<()> {
        self.upload_bytes(relative_path, content.as_bytes().to_vec())
            .await
    }

    pub async fn upload_bytes(&self, relative_path: &str, content: Vec<u8>) -> Result<()> {
        let remote_path = self.remote_path(relative_path);
        self.upload_bytes_at_path(&remote_path, content).await
    }

    pub async fn upload_text_at_path(&self, remote_path: &str, content: &str) -> Result<()> {
        self.upload_bytes_at_path(remote_path, content.as_bytes().to_vec())
            .await
    }

    pub async fn upload_bytes_at_path(&self, remote_path: &str, content: Vec<u8>) -> Result<()> {
        if self
            .command_prefix
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return self
                .upload_bytes_at_path_via_native_host(remote_path, content)
                .await;
        }
        if let Some(parent) = Path::new(remote_path)
            .parent()
            .and_then(|path| path.to_str())
        {
            self.ensure_remote_dir(parent).await?;
        }
        let filename = Path::new(remote_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file");
        let inner = self.inner.lock().await;
        inner
            .client
            .upload_file(&inner.sandbox, remote_path, filename, content)
            .await
    }

    async fn upload_bytes_at_path_via_native_host(
        &self,
        remote_path: &str,
        content: Vec<u8>,
    ) -> Result<()> {
        self.ensure_native_host().await?;
        let port = sandbox_host_port()?;
        let inner = self.inner.lock().await;
        inner
            .client
            .native_host_write_file(&inner.sandbox, port, remote_path, content)
            .await
    }

    pub async fn download_bytes(&self, relative_path: &str) -> Result<Vec<u8>> {
        let remote_path = self.remote_path(relative_path);
        self.download_bytes_at_path(&remote_path).await
    }

    pub async fn download_bytes_at_path(&self, remote_path: &str) -> Result<Vec<u8>> {
        if self
            .command_prefix
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return self
                .download_bytes_at_path_via_native_host(remote_path)
                .await;
        }
        let inner = self.inner.lock().await;
        inner
            .client
            .download_file(&inner.sandbox, remote_path)
            .await
    }

    async fn download_bytes_at_path_via_native_host(&self, remote_path: &str) -> Result<Vec<u8>> {
        self.ensure_native_host().await?;
        let port = sandbox_host_port()?;
        let inner = self.inner.lock().await;
        inner
            .client
            .native_host_read_file(&inner.sandbox, port, remote_path)
            .await
    }

    pub async fn sync_dir(&self, local_root: &Path) -> Result<()> {
        let mut stack = vec![local_root.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in std::fs::read_dir(&current).map_err(|error| {
                Error::Agent(format!(
                    "Failed to read workspace '{}': {}",
                    current.display(),
                    error
                ))
            })? {
                let entry = entry.map_err(|error| Error::Agent(error.to_string()))?;
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();

                if should_skip_path(&name) {
                    continue;
                }

                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !path.is_file() {
                    continue;
                }

                let relative = path
                    .strip_prefix(local_root)
                    .map_err(|error| Error::Agent(error.to_string()))?;
                let relative = relative.to_string_lossy().replace('\\', "/");
                let content = std::fs::read(&path).map_err(|error| {
                    Error::Agent(format!(
                        "Failed to read workspace file '{}': {}",
                        path.display(),
                        error
                    ))
                })?;
                self.upload_bytes(&relative, content).await?;
            }
        }
        Ok(())
    }

    pub async fn sync_files(&self, local_root: &Path, relative_paths: &[String]) -> Result<()> {
        for relative_path in relative_paths {
            let relative = normalize_relative_path(Path::new(relative_path))?;
            if relative.is_empty() {
                return Err(Error::Agent(
                    "staged file path must not be empty".to_string(),
                ));
            }
            let path = local_root.join(&relative);
            if !path.is_file() {
                return Err(Error::Agent(format!(
                    "staged file '{}' is not a regular file",
                    path.display()
                )));
            }
            let content = std::fs::read(&path).map_err(|error| {
                Error::Agent(format!(
                    "Failed to read staged file '{}': {}",
                    path.display(),
                    error
                ))
            })?;
            self.upload_bytes(&relative, content).await?;
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        let _ = self.shutdown_workspace_runtime().await?;
        self.delete_sandbox().await
    }

    pub fn has_shutdown_command(&self) -> bool {
        if let Some(command) = self
            .shutdown_command
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            !command.is_empty()
        } else {
            false
        }
    }

    pub async fn shutdown_workspace_runtime(
        &self,
    ) -> Result<Option<WorkspaceRuntimeShutdownReport>> {
        let Some(command) = self
            .shutdown_command
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        let inner = self.inner.lock().await;
        info!(event = "workspace_runtime_shutdown_start", sandbox_id = %inner.sandbox.sandbox_id);
        match inner
            .client
            .run_command(&inner.sandbox, command, &HashMap::new())
            .await
        {
            Ok(result) if result.exit_code == 0 => {
                let report = workspace_shutdown_report(&result);
                info!(
                    event = "workspace_runtime_shutdown_done",
                    sandbox_id = %inner.sandbox.sandbox_id,
                    exit_code = report.exit_code,
                    stdout_bytes = report.stdout_bytes,
                    stderr_bytes = report.stderr_bytes,
                    stdout_tail = %report.stdout_tail,
                    stderr_tail = %report.stderr_tail
                );
                Ok(Some(report))
            }
            Ok(result) => {
                let error = Error::Agent(format!(
                    "workspace runtime shutdown command failed exit={} stdout={} stderr={}",
                    result.exit_code, result.stdout, result.stderr
                ));
                warn!(
                    event = "workspace_runtime_shutdown_failed",
                    sandbox_id = %inner.sandbox.sandbox_id,
                    exit_code = result.exit_code,
                    stdout = %result.stdout,
                    stderr = %result.stderr
                );
                Err(error)
            }
            Err(error) => {
                warn!(event = "workspace_runtime_shutdown_failed", sandbox_id = %inner.sandbox.sandbox_id, error = %error);
                Err(error)
            }
        }
    }

    pub async fn delete_sandbox(&self) -> Result<()> {
        let inner = self.inner.lock().await;
        info!(event = "inner_shutdown_start", sandbox_id = %inner.sandbox.sandbox_id);
        let result = inner.client.delete_sandbox(&inner.sandbox.sandbox_id).await;
        match &result {
            Ok(_) => info!(event = "inner_shutdown_done", sandbox_id = %inner.sandbox.sandbox_id),
            Err(error) => {
                warn!(event = "inner_shutdown_failed", sandbox_id = %inner.sandbox.sandbox_id, error = %error)
            }
        }
        result
    }

    async fn ensure_workspace(&self) -> Result<()> {
        self.ensure_remote_dir(&self.workspace_root).await
    }

    async fn ensure_native_host(&self) -> Result<()> {
        let Some(url) = sandbox_host_url() else {
            return Err(Error::MissingConfig {
                key: "HERMES_SANDBOX_HOST_URL / SANDBOX_HOST_URL".to_string(),
            });
        };
        let mut ready = self.native_host_ready.lock().await;
        if *ready {
            return Ok(());
        }

        let bin = sandbox_host_bin();
        let addr = sandbox_host_addr();
        let probe_addr = sandbox_host_probe_addr(&addr);
        let sha = sandbox_host_sha256();
        let command = sandbox_host_bootstrap_command(
            &url,
            sha.as_deref(),
            &bin,
            &addr,
            &probe_addr,
            &self.workspace_root,
        );
        sidecar_timeline(
            "sandbox_host_bootstrap_start",
            &[
                ("addr", addr.clone()),
                ("bin", bin.clone()),
                ("workspace_root", self.workspace_root.clone()),
                ("has_sha256", sha.is_some().to_string()),
            ],
        );
        info!(
            event = "sandbox_host_bootstrap_start",
            addr = %addr,
            bin = %bin,
            workspace_root = %self.workspace_root,
            has_sha256 = sha.is_some()
        );
        let result = self
            .run_command(&command, &HashMap::new())
            .await
            .map_err(|error| {
                sidecar_timeline(
                    "sandbox_host_bootstrap_command_failed",
                    &[
                        ("addr", addr.clone()),
                        ("bin", bin.clone()),
                        ("error", error.to_string()),
                    ],
                );
                warn!(
                    event = "sandbox_host_bootstrap_command_failed",
                    addr = %addr,
                    bin = %bin,
                    error = %error
                );
                error
            })?;
        if result.exit_code != 0 {
            sidecar_timeline(
                "sandbox_host_bootstrap_failed",
                &[
                    ("addr", addr.clone()),
                    ("bin", bin.clone()),
                    ("exit_code", result.exit_code.to_string()),
                    ("stdout", result.stdout.clone()),
                    ("stderr", result.stderr.clone()),
                ],
            );
            warn!(
                event = "sandbox_host_bootstrap_failed",
                addr = %addr,
                bin = %bin,
                exit_code = result.exit_code,
                stdout = %result.stdout,
                stderr = %result.stderr
            );
            return Err(Error::Agent(format!(
                "sandbox-host bootstrap failed: stdout={} stderr={}",
                result.stdout, result.stderr
            )));
        }
        sidecar_timeline(
            "sandbox_host_ready",
            &[
                ("addr", addr.clone()),
                ("workspace_root", self.workspace_root.clone()),
            ],
        );
        info!(event = "sandbox_host_ready", addr = %addr, workspace_root = %self.workspace_root);
        *ready = true;
        Ok(())
    }

    async fn ensure_remote_dir(&self, remote_dir: &str) -> Result<()> {
        let command = if remote_dir == "/workspace" {
            let envd_user = {
                let inner = self.inner.lock().await;
                inner.client.config.envd_user.clone()
            };
            format!(
                "sudo -n mkdir -p {} && sudo -n chown {} {}",
                shell_quote(remote_dir),
                shell_quote(&format!("{}:{}", envd_user, envd_user)),
                shell_quote(remote_dir)
            )
        } else {
            format!("mkdir -p {}", shell_quote(remote_dir))
        };
        let inner = self.inner.lock().await;
        let result = inner
            .client
            .run_command(&inner.sandbox, &command, &HashMap::new())
            .await?;
        if result.exit_code != 0 {
            return Err(Error::Agent(format!(
                "failed to create remote dir '{}': stdout={} stderr={}",
                remote_dir, result.stdout, result.stderr
            )));
        }
        Ok(())
    }

    fn remote_path(&self, relative_path: &str) -> String {
        let cleaned = relative_path.trim_start_matches('/');
        format!("{}/{}", self.workspace_root, cleaned)
    }
}

#[async_trait::async_trait]
impl WorkspaceRuntime for SessionSandbox {
    async fn identity(&self) -> Result<WorkspaceIdentity> {
        Ok(WorkspaceIdentity {
            workspace_id: Some(self.workspace_root().to_string()),
            sandbox_id: Some(self.sandbox_id().await),
            template_id: e2b_template(),
        })
    }

    async fn runtime_id(&self) -> Result<String> {
        Ok(self.sandbox_id().await)
    }

    fn workspace_root(&self) -> &str {
        SessionSandbox::workspace_root(self)
    }

    fn resolve_path(&self, path: &str) -> Result<String> {
        SessionSandbox::resolve_path(self, path)
    }

    fn resolve_working_dir(&self, path: Option<&str>) -> Result<String> {
        SessionSandbox::resolve_working_dir(self, path)
    }

    fn display_path(&self, remote_path: &str) -> String {
        SessionSandbox::display_path(self, remote_path)
    }

    fn native_host_configured(&self) -> bool {
        SessionSandbox::native_host_configured(self)
    }

    async fn run_command(
        &self,
        command: &str,
        envs: &HashMap<String, String>,
    ) -> Result<CommandResult> {
        SessionSandbox::run_command(self, command, envs).await
    }

    async fn native_call(&self, method: &str, params: Value) -> Result<Value> {
        SessionSandbox::native_call(self, method, params).await
    }
}

fn workspace_shutdown_report(result: &CommandResult) -> WorkspaceRuntimeShutdownReport {
    WorkspaceRuntimeShutdownReport {
        exit_code: result.exit_code,
        stdout_bytes: result.stdout.len(),
        stderr_bytes: result.stderr.len(),
        stdout_tail: text_tail(&result.stdout, 2048),
        stderr_tail: text_tail(&result.stderr, 4096),
    }
}

fn text_tail(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    format!("...[truncated]\n{}", &value[start..])
}

pub fn session_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("session_{:x}{:x}", now.as_secs(), now.subsec_nanos())
}

#[cfg(test)]
pub(crate) fn test_session_sandbox(
    workspace_root: &str,
    local_workspace_root: &str,
) -> SessionSandbox {
    SessionSandbox {
        workspace_root: workspace_root.to_string(),
        local_workspace_root: PathBuf::from(local_workspace_root),
        command_prefix: None,
        shutdown_command: None,
        native_host_ready: Mutex::new(false),
        inner: Mutex::new(SessionSandboxInner {
            client: E2BClient {
                config: E2BClientConfig {
                    domain: "example.com".to_string(),
                    api_url: "https://api.example.com".to_string(),
                    api_key: "key".to_string(),
                    envd_port: DEFAULT_ENVD_PORT,
                    envd_user: "user".to_string(),
                    request_timeout: Duration::from_secs(30),
                },
                http_client: Client::builder().build().expect("test client"),
            },
            sandbox: E2BSandbox {
                sandbox_id: "sandbox".to_string(),
                envd_access_token: "token".to_string(),
                traffic_access_token: "traffic-token".to_string(),
                domain: "example.com".to_string(),
            },
        }),
    }
}

#[cfg(test)]
mod tests;
