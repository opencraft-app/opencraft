use std::collections::HashMap;
mod client;
mod connect_stream;
mod path_sync;
mod registry;
mod sandbox_host;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
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

#[derive(Debug)]
pub struct SessionSandbox {
    workspace_root: String,
    local_workspace_root: PathBuf,
    command_prefix: Option<String>,
    command_shell_prefix: Option<String>,
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
        command_shell_prefix: None,
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
        command_shell_prefix: binding.command_shell_prefix,
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
                format!("{prefix} {}", shell_quote(&command))
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
            if let Some(shell_prefix) = self
                .command_shell_prefix
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return self
                    .upload_bytes_at_path_via_shell(remote_path, content, shell_prefix)
                    .await;
            }
            return self
                .upload_bytes_at_path_via_command(remote_path, content)
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

    async fn upload_bytes_at_path_via_command(
        &self,
        remote_path: &str,
        content: Vec<u8>,
    ) -> Result<()> {
        if let Ok(text) = String::from_utf8(content.clone()) {
            self.native_call(
                "fs.write",
                serde_json::json!({
                    "path": remote_path,
                    "content": text,
                }),
            )
            .await?;
            return Ok(());
        }
        let Some(parent) = Path::new(remote_path)
            .parent()
            .and_then(|path| path.to_str())
        else {
            return Err(Error::Agent(format!(
                "remote path '{}' has no parent directory",
                remote_path
            )));
        };
        let command = workspace_file_upload_command(parent, remote_path, &content);
        let result = self.run_command(&command, &HashMap::new()).await?;
        if result.exit_code != 0 {
            return Err(Error::Agent(format!(
                "failed to upload file '{}' through workspace command: exit_code={} stdout={} stderr={}",
                remote_path, result.exit_code, result.stdout, result.stderr
            )));
        }
        Ok(())
    }

    async fn upload_bytes_at_path_via_shell(
        &self,
        remote_path: &str,
        content: Vec<u8>,
        shell_prefix: &str,
    ) -> Result<()> {
        let Some(parent) = Path::new(remote_path)
            .parent()
            .and_then(|path| path.to_str())
        else {
            return Err(Error::Agent(format!(
                "remote path '{}' has no parent directory",
                remote_path
            )));
        };
        let host_temp = workspace_file_upload_host_temp_path(remote_path);
        let host_temp_dir = Path::new(&host_temp)
            .parent()
            .and_then(|path| path.to_str())
            .unwrap_or("/tmp");
        let inner = self.inner.lock().await;
        let mkdir = format!("mkdir -p {}", shell_quote(host_temp_dir));
        let mkdir_result = inner
            .client
            .run_command(&inner.sandbox, &mkdir, &HashMap::new())
            .await?;
        if mkdir_result.exit_code != 0 {
            return Err(Error::Agent(format!(
                "failed to create upload staging directory '{}': exit_code={} stdout={} stderr={}",
                host_temp_dir, mkdir_result.exit_code, mkdir_result.stdout, mkdir_result.stderr
            )));
        }
        let filename = Path::new(&host_temp)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("upload.bin");
        inner
            .client
            .upload_file(&inner.sandbox, &host_temp, filename, content)
            .await?;
        let command =
            workspace_file_upload_shell_command(shell_prefix, &host_temp, parent, remote_path);
        let result = inner
            .client
            .run_command(&inner.sandbox, &command, &HashMap::new())
            .await;
        let _ = inner
            .client
            .run_command(
                &inner.sandbox,
                &format!("rm -f {}", shell_quote(&host_temp)),
                &HashMap::new(),
            )
            .await;
        let result = result?;
        if result.exit_code != 0 {
            return Err(Error::Agent(format!(
                "failed to upload file '{}' through workspace shell: exit_code={} stdout={} stderr={}",
                remote_path, result.exit_code, result.stdout, result.stderr
            )));
        }
        Ok(())
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
            let command = workspace_file_download_command(remote_path);
            let result = self.run_command(&command, &HashMap::new()).await?;
            if result.exit_code != 0 {
                return Err(Error::Agent(format!(
                    "failed to download file '{}' through workspace command: exit_code={} stdout={} stderr={}",
                    remote_path, result.exit_code, result.stdout, result.stderr
                )));
            }
            let encoded = workspace_file_download_base64_output(&result.stdout);
            return STANDARD.decode(encoded.as_bytes()).map_err(|error| {
                Error::ParseResponse(format!(
                    "{}; workspace download stdout={}",
                    error,
                    preview_for_error(&result.stdout)
                ))
            });
        }
        let inner = self.inner.lock().await;
        inner
            .client
            .download_file(&inner.sandbox, remote_path)
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
        let inner = self.inner.lock().await;
        info!(event = "inner_shutdown_start", sandbox_id = %inner.sandbox.sandbox_id);
        if let Some(command) = self
            .shutdown_command
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            info!(event = "workspace_runtime_shutdown_start", sandbox_id = %inner.sandbox.sandbox_id);
            match inner
                .client
                .run_command(&inner.sandbox, command, &HashMap::new())
                .await
            {
                Ok(result) if result.exit_code == 0 => {
                    info!(event = "workspace_runtime_shutdown_done", sandbox_id = %inner.sandbox.sandbox_id);
                }
                Ok(result) => {
                    warn!(
                        event = "workspace_runtime_shutdown_failed",
                        sandbox_id = %inner.sandbox.sandbox_id,
                        exit_code = result.exit_code,
                        stdout = %result.stdout,
                        stderr = %result.stderr
                    );
                }
                Err(error) => {
                    warn!(event = "workspace_runtime_shutdown_failed", sandbox_id = %inner.sandbox.sandbox_id, error = %error);
                }
            }
        }
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

fn workspace_file_upload_command(parent: &str, remote_path: &str, content: &[u8]) -> String {
    format!(
        "mkdir -p {} && printf %s {} | base64 -d > {} && test -f {}",
        shell_quote(parent),
        shell_quote(&STANDARD.encode(content)),
        shell_quote(remote_path),
        shell_quote(remote_path)
    )
}

fn workspace_file_upload_shell_command(
    shell_prefix: &str,
    host_temp: &str,
    parent: &str,
    remote_path: &str,
) -> String {
    let inner_script_prefix = format!(
        "mkdir -p {}\nbase64 -d > {} <<'CLOUDAGENT_UPLOAD_B64'\n",
        shell_quote(parent),
        shell_quote(remote_path)
    );
    format!(
        "set -euo pipefail\nhost_temp={host_temp}\n{{\n  printf '%s' {script_prefix}\n  base64 \"$host_temp\"\n  printf '\\nCLOUDAGENT_UPLOAD_B64\\nexit\\n'\n}} | {shell_prefix} >/dev/null\n",
        host_temp = shell_quote(host_temp),
        script_prefix = shell_quote(&inner_script_prefix),
        shell_prefix = shell_prefix,
    )
}

fn workspace_file_upload_host_temp_path(remote_path: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let basename = Path::new(remote_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("upload.bin");
    format!("/tmp/hermes-workspace-upload/{}-{}", now, basename)
}

fn workspace_file_download_command(remote_path: &str) -> String {
    format!(
        "set -e\npath={path}\ntest -f \"$path\"\nbase64 \"$path\" | tr -d '\\n'\n",
        path = shell_quote(remote_path)
    )
}

fn workspace_file_download_base64_output(stdout: &str) -> String {
    let trimmed = stdout.trim();
    if let Some(output) = workspace_file_download_json_output(trimmed) {
        return output;
    }
    let mut streamed = String::new();
    let mut saw_json_line = false;
    for line in trimmed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            saw_json_line = true;
            if let Some(chunk) = workspace_file_download_value_output(&value) {
                streamed.push_str(chunk.trim());
            }
        }
    }
    if saw_json_line && !streamed.is_empty() {
        return streamed;
    }
    trimmed.to_string()
}

fn workspace_file_download_json_output(trimmed: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
    workspace_file_download_value_output(&value).map(|value| value.trim().to_string())
}

fn workspace_file_download_value_output(value: &serde_json::Value) -> Option<&str> {
    for pointer in [
        "/stdout",
        "/output",
        "/result/stdout",
        "/result/output",
        "/data/stdout",
        "/data/output",
        "/event/data/stdout",
        "/event/data/output",
    ] {
        if let Some(value) = value.pointer(pointer).and_then(|value| value.as_str()) {
            return Some(value);
        }
    }
    None
}

fn preview_for_error(value: &str) -> String {
    const LIMIT: usize = 512;
    let mut preview = value.trim().chars().take(LIMIT).collect::<String>();
    preview = preview
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t");
    if value.chars().count() > LIMIT {
        preview.push_str("...");
    }
    preview
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
        command_shell_prefix: None,
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
