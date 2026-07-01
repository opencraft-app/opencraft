use std::{
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use chrono::Utc;
use russh::{ChannelMsg, Disconnect, client};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use vela_store::StoredNode;

use crate::local_runtime::{API_PROTOCOL, RUNTIME_PROTOCOL, ReadyEvent};

use super::{
    ActiveRuntimeTargetHandle, ConnectedRuntimeTarget, RuntimeTargetConnector, RuntimeTargetError,
    RuntimeTargetSnapshot, target_id_for_node,
};

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct SshNodeConfig {
    host: String,
    port: u16,
    username: String,
    target_os: String,
    target_arch: String,
}

#[derive(Debug, Clone)]
struct RemotePaths {
    root_dir: String,
    bin_dir: String,
    run_dir: String,
    data_dir: String,
    exact_bin: String,
    tmp_bin: String,
    ready_file: String,
    pid_file: String,
    log_file: String,
}

#[derive(Debug, Clone)]
struct VeladArtifact {
    bytes: Vec<u8>,
    build_id: String,
    target_triple: String,
}

#[derive(Debug, Clone)]
pub struct RusshSshRuntimeTargetConnector {
    artifact_dir: Option<PathBuf>,
}

impl Default for RusshSshRuntimeTargetConnector {
    fn default() -> Self {
        Self {
            artifact_dir: env::var("VELAD_REMOTE_ARTIFACT_DIR")
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        }
    }
}

#[async_trait]
impl RuntimeTargetConnector for RusshSshRuntimeTargetConnector {
    async fn connect(
        &self,
        node: StoredNode,
        password: String,
    ) -> Result<ConnectedRuntimeTarget, RuntimeTargetError> {
        let config = SshNodeConfig::from_node(&node)?;
        let artifact = self.resolve_artifact(&config)?;
        let mut session = SshSession::connect(&config, &password).await?;
        let instance_id = format!("rt_{}", uuid::Uuid::new_v4().simple());
        let remote_token = uuid::Uuid::new_v4().simple().to_string();

        let sftp = session.sftp().await?;
        let home = sftp
            .canonicalize(".")
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("resolve remote home: {err}")))?;
        let paths = RemotePaths::new(home, &artifact, &instance_id);
        ensure_dir(&sftp, &paths.root_dir).await?;
        ensure_dir(&sftp, &paths.bin_dir).await?;
        ensure_dir(&sftp, &paths.run_dir).await?;
        ensure_dir(&sftp, &paths.data_dir).await?;
        upload_artifact_if_missing(&mut session, &sftp, &paths, &artifact).await?;
        sftp.close()
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("close sftp: {err}")))?;

        launch_remote_daemon(&mut session, &paths, &artifact, &remote_token, &instance_id).await?;
        let ready =
            wait_for_ready_file(&mut session, &paths, &artifact, &instance_id, READY_TIMEOUT)
                .await?;
        let remote_addr = ready
            .listen_addr
            .parse::<SocketAddr>()
            .map_err(|err| RuntimeTargetError::transport(format!("invalid ready addr: {err}")))?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("bind local tunnel: {err}")))?;
        let local_addr = listener.local_addr().map_err(|err| {
            RuntimeTargetError::transport(format!("read local tunnel addr: {err}"))
        })?;
        let session = Arc::new(tokio::sync::Mutex::new(session));
        let tunnel_task = spawn_tunnel(listener, Arc::clone(&session), remote_addr);
        let api_base_url = format!("http://{local_addr}/api/v1");
        let verified = verify_remote_runtime(&api_base_url, &ready).await?;
        let snapshot = RuntimeTargetSnapshot {
            id: target_id_for_node(&node.node_id),
            kind: "remote",
            provider: node.provider,
            node_id: Some(node.node_id),
            display_name: node.display_name,
            status: "ready".to_string(),
            generation: 1,
            local_api_base_url: Some(api_base_url.clone()),
            remote_listen_addr: Some(ready.listen_addr.clone()),
            last_seen_at: Some(Utc::now()),
            last_error: None,
            runtime_protocol: Some(verified.runtime_protocol.clone()),
            api_protocol: Some(verified.api_protocol.clone()),
            version: Some(verified.version.clone()),
        };

        Ok(ConnectedRuntimeTarget {
            snapshot,
            handle: Arc::new(SshRuntimeTargetHandle {
                api_base_url,
                management_token: remote_token,
                session,
                tunnel_task,
            }),
        })
    }
}

struct SshRuntimeTargetHandle {
    api_base_url: String,
    management_token: String,
    session: Arc<tokio::sync::Mutex<SshSession>>,
    tunnel_task: JoinHandle<()>,
}

#[async_trait]
impl ActiveRuntimeTargetHandle for SshRuntimeTargetHandle {
    async fn disconnect(&self) -> Result<(), RuntimeTargetError> {
        let client = reqwest::Client::new();
        let result = client
            .post(format!("{}/runtime/shutdown", self.api_base_url))
            .bearer_auth(&self.management_token)
            .timeout(REQUEST_TIMEOUT)
            .json(&serde_json::json!({}))
            .send()
            .await;
        if let Err(err) = result {
            tracing::warn!("remote velad shutdown request failed: {err}");
        }
        self.tunnel_task.abort();
        let mut session = self.session.lock().await;
        let _ = session.disconnect().await;
        Ok(())
    }
}

struct SshSession {
    handle: client::Handle<AcceptAnyServerKey>,
}

impl SshSession {
    async fn connect(config: &SshNodeConfig, password: &str) -> Result<Self, RuntimeTargetError> {
        let ssh_config = client::Config {
            nodelay: true,
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let mut handle = client::connect(
            Arc::new(ssh_config),
            (&*config.host, config.port),
            AcceptAnyServerKey,
        )
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("ssh connect: {err}")))?;
        let auth = handle
            .authenticate_password(config.username.clone(), password.to_string())
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("ssh password auth: {err}")))?;
        if !auth.success() {
            return Err(RuntimeTargetError::new(
                "ssh_auth_failed",
                "ssh password authentication failed",
            ));
        }
        Ok(Self { handle })
    }

    async fn exec(&mut self, command: &str) -> Result<ExecOutput, RuntimeTargetError> {
        let mut channel =
            self.handle.channel_open_session().await.map_err(|err| {
                RuntimeTargetError::transport(format!("open exec channel: {err}"))
            })?;
        channel
            .exec(true, command)
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("exec request: {err}")))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                _ => {}
            }
        }
        Ok(ExecOutput {
            status: exit_status.unwrap_or(255),
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
        })
    }

    async fn sftp(&mut self) -> Result<SftpSession, RuntimeTargetError> {
        let channel =
            self.handle.channel_open_session().await.map_err(|err| {
                RuntimeTargetError::transport(format!("open sftp channel: {err}"))
            })?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("start sftp subsystem: {err}")))?;
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("open sftp session: {err}")))
    }

    async fn disconnect(&mut self) -> Result<(), RuntimeTargetError> {
        self.handle
            .disconnect(Disconnect::ByApplication, "vela disconnect", "en")
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("ssh disconnect: {err}")))
    }
}

struct ExecOutput {
    status: u32,
    stdout: String,
    stderr: String,
}

struct AcceptAnyServerKey;

impl client::Handler for AcceptAnyServerKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

impl SshNodeConfig {
    fn from_node(node: &StoredNode) -> Result<Self, RuntimeTargetError> {
        let ssh = node
            .config
            .get("ssh")
            .and_then(Value::as_object)
            .ok_or_else(|| RuntimeTargetError::unavailable("node ssh config is missing"))?;
        let target = node.config.get("target").and_then(Value::as_object);
        let host = ssh
            .get("host")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RuntimeTargetError::unavailable("node ssh host is missing"))?
            .to_string();
        let username = ssh
            .get("username")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RuntimeTargetError::unavailable("node ssh username is missing"))?
            .to_string();
        let port = ssh
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .unwrap_or(22);
        let target_os = target
            .and_then(|target| target.get("os"))
            .and_then(Value::as_str)
            .unwrap_or("linux")
            .to_string();
        let target_arch = target
            .and_then(|target| target.get("arch"))
            .and_then(Value::as_str)
            .unwrap_or("x86_64")
            .to_string();
        Ok(Self {
            host,
            port,
            username,
            target_os,
            target_arch,
        })
    }
}

impl RusshSshRuntimeTargetConnector {
    fn resolve_artifact(
        &self,
        config: &SshNodeConfig,
    ) -> Result<VeladArtifact, RuntimeTargetError> {
        let target_triple = target_triple(&config.target_os, &config.target_arch)?;
        let path = self
            .artifact_override_path(&target_triple)
            .or_else(|| self.artifact_dir_path(&config.target_os, &config.target_arch))
            .or_else(|| self.repo_dist_path(&config.target_os, &config.target_arch))
            .or_else(|| self.current_exe_if_target_matches(&config.target_os, &config.target_arch))
            .ok_or_else(|| {
                RuntimeTargetError::new(
                    "remote_velad_binary_missing",
                    format!("missing velad artifact for {target_triple}"),
                )
            })?;
        let bytes = std::fs::read(&path).map_err(|err| {
            RuntimeTargetError::new(
                "remote_velad_binary_missing",
                format!("read velad artifact {}: {err}", path.display()),
            )
        })?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let short_sha = sha256.chars().take(12).collect::<String>();
        let build_id = format!("{}-{short_sha}", env!("CARGO_PKG_VERSION"));
        Ok(VeladArtifact {
            bytes,
            build_id,
            target_triple,
        })
    }

    fn artifact_override_path(&self, target_triple: &str) -> Option<PathBuf> {
        env::var(format!(
            "VELAD_REMOTE_ARTIFACT_{}",
            target_triple
                .chars()
                .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
                .collect::<String>()
                .to_ascii_uppercase()
        ))
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    }

    fn artifact_dir_path(&self, target_os: &str, target_arch: &str) -> Option<PathBuf> {
        let dir = self.artifact_dir.as_ref()?;
        Some(dir.join(artifact_relative_path(target_os, target_arch)))
    }

    fn repo_dist_path(&self, target_os: &str, target_arch: &str) -> Option<PathBuf> {
        let cwd = env::current_dir().ok()?;
        Some(
            cwd.join("dist")
                .join("velad")
                .join(artifact_relative_path(target_os, target_arch)),
        )
    }

    fn current_exe_if_target_matches(&self, target_os: &str, target_arch: &str) -> Option<PathBuf> {
        let host_arch = match env::consts::ARCH {
            "x86_64" | "amd64" => "x86_64",
            _ => return None,
        };
        if env::consts::OS == target_os && host_arch == target_arch {
            env::current_exe().ok()
        } else {
            None
        }
    }
}

impl RemotePaths {
    fn new(home: String, artifact: &VeladArtifact, instance_id: &str) -> Self {
        let bin_dir = format!("{home}/.vela/bin");
        let root_dir = format!("{home}/.vela");
        let run_dir = format!("{home}/.vela/run");
        let data_dir = format!("{home}/.vela/data");
        let exact_bin = format!(
            "{bin_dir}/velad-{}-{}",
            artifact.build_id, artifact.target_triple
        );
        let tmp_bin = format!("{exact_bin}.{instance_id}.tmp");
        let ready_file = format!("{run_dir}/velad.{instance_id}.ready.json");
        let pid_file = format!("{run_dir}/velad.{instance_id}.pid");
        let log_file = format!("{run_dir}/velad.{instance_id}.log");
        Self {
            root_dir,
            bin_dir,
            run_dir,
            data_dir,
            exact_bin,
            tmp_bin,
            ready_file,
            pid_file,
            log_file,
        }
    }
}

async fn ensure_dir(sftp: &SftpSession, path: &str) -> Result<(), RuntimeTargetError> {
    if sftp
        .try_exists(path)
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("stat remote dir {path}: {err}")))?
    {
        return Ok(());
    }
    sftp.create_dir(path)
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("create remote dir {path}: {err}")))
}

async fn upload_artifact_if_missing(
    session: &mut SshSession,
    sftp: &SftpSession,
    paths: &RemotePaths,
    artifact: &VeladArtifact,
) -> Result<(), RuntimeTargetError> {
    if sftp
        .try_exists(&paths.exact_bin)
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("stat remote velad: {err}")))?
    {
        return Ok(());
    }

    if sftp.try_exists(&paths.tmp_bin).await.unwrap_or(false) {
        let _ = sftp.remove_file(&paths.tmp_bin).await;
    }
    let mut file = sftp
        .open_with_flags(
            &paths.tmp_bin,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("create remote tmp velad: {err}")))?;
    file.write_all(&artifact.bytes)
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("upload remote velad: {err}")))?;
    file.sync_all()
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("sync remote velad: {err}")))?;
    file.shutdown()
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("close remote velad: {err}")))?;
    sftp.rename(&paths.tmp_bin, &paths.exact_bin)
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("install remote velad: {err}")))?;

    let chmod = format!("chmod 0755 {}", posix_quote(&paths.exact_bin));
    let output = session.exec(&chmod).await?;
    if output.status != 0 {
        return Err(RuntimeTargetError::transport(format!(
            "chmod remote velad failed: {}{}",
            output.stdout, output.stderr
        )));
    }
    Ok(())
}

async fn launch_remote_daemon(
    session: &mut SshSession,
    paths: &RemotePaths,
    artifact: &VeladArtifact,
    token: &str,
    instance_id: &str,
) -> Result<(), RuntimeTargetError> {
    let db_url = format!("sqlite://{}/vela.sqlite?mode=rwc", paths.data_dir);
    let command = format!(
        "rm -f {ready} {pid}; nohup {bin} --listen 127.0.0.1:0 --database-url {db} --management-token {token} --ready-file {ready} --build-id {build} --target-triple {triple} --remote-instance-id {instance} > {log} 2>&1 & echo $! > {pid}",
        ready = posix_quote(&paths.ready_file),
        pid = posix_quote(&paths.pid_file),
        bin = posix_quote(&paths.exact_bin),
        db = posix_quote(&db_url),
        token = posix_quote(token),
        build = posix_quote(&artifact.build_id),
        triple = posix_quote(&artifact.target_triple),
        instance = posix_quote(instance_id),
        log = posix_quote(&paths.log_file),
    );
    let output = session.exec(&command).await?;
    if output.status != 0 {
        return Err(RuntimeTargetError::transport(format!(
            "launch remote velad failed: {}{}",
            output.stdout, output.stderr
        )));
    }
    Ok(())
}

async fn wait_for_ready_file(
    session: &mut SshSession,
    paths: &RemotePaths,
    artifact: &VeladArtifact,
    instance_id: &str,
    timeout: Duration,
) -> Result<ReadyEvent, RuntimeTargetError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let command = format!(
            "if test -s {ready}; then cat {ready}; fi",
            ready = posix_quote(&paths.ready_file)
        );
        let output = session.exec(&command).await?;
        if output.status == 0 && !output.stdout.trim().is_empty() {
            let ready: ReadyEvent = serde_json::from_str(output.stdout.trim()).map_err(|err| {
                RuntimeTargetError::transport(format!("parse remote ready file: {err}"))
            })?;
            validate_ready_event(&ready, artifact, instance_id)?;
            return Ok(ready);
        }
        if tokio::time::Instant::now() >= deadline {
            let tail = session
                .exec(&format!(
                    "if test -f {log}; then tail -n 80 {log}; fi",
                    log = posix_quote(&paths.log_file)
                ))
                .await
                .map(|output| output.stdout)
                .unwrap_or_default();
            return Err(RuntimeTargetError::new(
                "remote_ready_timeout",
                format!("remote velad did not write ready file before deadline\n{tail}"),
            ));
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

fn validate_ready_event(
    ready: &ReadyEvent,
    artifact: &VeladArtifact,
    instance_id: &str,
) -> Result<(), RuntimeTargetError> {
    if ready.runtime_protocol != RUNTIME_PROTOCOL {
        return Err(RuntimeTargetError::transport(format!(
            "unsupported remote runtime protocol {}",
            ready.runtime_protocol
        )));
    }
    if ready.api_protocol != API_PROTOCOL {
        return Err(RuntimeTargetError::transport(format!(
            "unsupported remote api protocol {}",
            ready.api_protocol
        )));
    }
    if ready.version != env!("CARGO_PKG_VERSION") {
        return Err(RuntimeTargetError::new(
            "remote_version_mismatch",
            format!(
                "remote velad version {} does not match {}",
                ready.version,
                env!("CARGO_PKG_VERSION")
            ),
        ));
    }
    if ready.build_id.as_deref() != Some(artifact.build_id.as_str()) {
        return Err(RuntimeTargetError::transport(
            "remote ready build id mismatch",
        ));
    }
    if ready.target_triple.as_deref() != Some(artifact.target_triple.as_str()) {
        return Err(RuntimeTargetError::transport(
            "remote ready target triple mismatch",
        ));
    }
    if ready.remote_instance_id.as_deref() != Some(instance_id) {
        return Err(RuntimeTargetError::transport(
            "remote ready instance id mismatch",
        ));
    }
    Ok(())
}

async fn verify_remote_runtime(
    api_base_url: &str,
    ready: &ReadyEvent,
) -> Result<ReadyEvent, RuntimeTargetError> {
    let client = reqwest::Client::new();
    let info: ReadyEvent = client
        .get(format!("{api_base_url}/runtime-info"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("fetch runtime-info: {err}")))?
        .error_for_status()
        .map_err(|err| RuntimeTargetError::transport(format!("runtime-info status: {err}")))?
        .json()
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("decode runtime-info: {err}")))?;
    if info.pid != ready.pid || info.listen_addr != ready.listen_addr {
        return Err(RuntimeTargetError::transport(
            "remote runtime-info does not match ready file",
        ));
    }
    Ok(info)
}

fn spawn_tunnel(
    listener: TcpListener,
    session: Arc<tokio::sync::Mutex<SshSession>>,
    remote_addr: SocketAddr,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((socket, originator_addr)) = listener.accept().await else {
                break;
            };
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                if let Err(err) =
                    forward_socket(socket, session, originator_addr, remote_addr).await
                {
                    tracing::warn!("ssh tunnel connection failed: {err}");
                }
            });
        }
    })
}

async fn forward_socket(
    mut socket: TcpStream,
    session: Arc<tokio::sync::Mutex<SshSession>>,
    originator_addr: SocketAddr,
    remote_addr: SocketAddr,
) -> Result<(), RuntimeTargetError> {
    let channel = {
        let ssh = session.lock().await;
        ssh.handle
            .channel_open_direct_tcpip(
                remote_addr.ip().to_string(),
                remote_addr.port().into(),
                originator_addr.ip().to_string(),
                originator_addr.port().into(),
            )
            .await
            .map_err(|err| RuntimeTargetError::transport(format!("open tunnel channel: {err}")))?
    };
    let mut remote = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut remote)
        .await
        .map_err(|err| RuntimeTargetError::transport(format!("copy tunnel bytes: {err}")))?;
    Ok(())
}

fn target_triple(target_os: &str, target_arch: &str) -> Result<String, RuntimeTargetError> {
    match (target_os, target_arch) {
        ("linux", "x86_64") | ("linux", "amd64") => Ok("x86_64-unknown-linux-gnu".to_string()),
        ("darwin", "x86_64") | ("darwin", "amd64") => Ok("x86_64-apple-darwin".to_string()),
        _ => Err(RuntimeTargetError::new(
            "unsupported_remote_target",
            format!("unsupported remote target {target_os}/{target_arch}"),
        )),
    }
}

fn artifact_relative_path(target_os: &str, target_arch: &str) -> PathBuf {
    let os = match target_os {
        "darwin" => "darwin",
        _ => "linux",
    };
    let arch = match target_arch {
        "amd64" | "x86_64" => "amd64",
        value => value,
    };
    Path::new(&format!("{os}-{arch}")).join("velad")
}

fn posix_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_quote_handles_spaces_and_single_quotes() {
        assert_eq!(posix_quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(posix_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn target_triple_rejects_arm_in_v1() {
        assert_eq!(
            target_triple("linux", "x86_64").unwrap(),
            "x86_64-unknown-linux-gnu"
        );
        assert_eq!(
            target_triple("darwin", "amd64").unwrap(),
            "x86_64-apple-darwin"
        );
        assert_eq!(
            target_triple("linux", "aarch64").unwrap_err().code,
            "unsupported_remote_target"
        );
    }
}
