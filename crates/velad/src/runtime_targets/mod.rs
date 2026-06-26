use std::{
    collections::HashMap,
    error::Error,
    fmt,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use vela_store::StoredNode;

pub mod ssh_transport;

pub const NODE_PROVIDER_SCHEMA: &str = "velad.node_providers.v1";
pub const NODES_SCHEMA: &str = "velad.nodes.v1";
pub const RUNTIME_TARGETS_SCHEMA: &str = "velad.runtime_targets.v1";
pub const SSH_PROVIDER_ID: &str = "ssh";
pub const LOCAL_TARGET_ID: &str = "local";

const KEYRING_SERVICE: &str = "dev.velalink.velad.nodes";

#[derive(Debug, Clone)]
pub struct SecretStoreError {
    pub code: &'static str,
    pub message: String,
}

impl SecretStoreError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "secret_store_unavailable",
            message: message.into(),
        }
    }
}

impl fmt::Display for SecretStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl Error for SecretStoreError {}

#[async_trait]
pub trait NodeSecretStore: Send + Sync {
    async fn put_password(&self, secret_ref: &str, password: &str) -> Result<(), SecretStoreError>;
    async fn get_password(&self, secret_ref: &str) -> Result<String, SecretStoreError>;
}

#[derive(Clone, Debug)]
pub struct KeyringNodeSecretStore {
    service: String,
}

impl Default for KeyringNodeSecretStore {
    fn default() -> Self {
        Self {
            service: KEYRING_SERVICE.to_string(),
        }
    }
}

#[async_trait]
impl NodeSecretStore for KeyringNodeSecretStore {
    async fn put_password(&self, secret_ref: &str, password: &str) -> Result<(), SecretStoreError> {
        let entry = keyring::Entry::new(&self.service, secret_ref)
            .map_err(|err| SecretStoreError::unavailable(err.to_string()))?;
        entry
            .set_password(password)
            .map_err(|err| SecretStoreError::unavailable(err.to_string()))
    }

    async fn get_password(&self, secret_ref: &str) -> Result<String, SecretStoreError> {
        let entry = keyring::Entry::new(&self.service, secret_ref)
            .map_err(|err| SecretStoreError::unavailable(err.to_string()))?;
        entry
            .get_password()
            .map_err(|err| SecretStoreError::unavailable(err.to_string()))
    }
}

#[derive(Default, Debug)]
pub struct MemoryNodeSecretStore {
    passwords: Mutex<HashMap<String, String>>,
}

impl MemoryNodeSecretStore {
    pub fn password(&self, secret_ref: &str) -> Option<String> {
        self.passwords.lock().ok()?.get(secret_ref).cloned()
    }
}

#[async_trait]
impl NodeSecretStore for MemoryNodeSecretStore {
    async fn put_password(&self, secret_ref: &str, password: &str) -> Result<(), SecretStoreError> {
        self.passwords
            .lock()
            .map_err(|_| SecretStoreError::unavailable("secret store lock was poisoned"))?
            .insert(secret_ref.to_string(), password.to_string());
        Ok(())
    }

    async fn get_password(&self, secret_ref: &str) -> Result<String, SecretStoreError> {
        self.passwords
            .lock()
            .map_err(|_| SecretStoreError::unavailable("secret store lock was poisoned"))?
            .get(secret_ref)
            .cloned()
            .ok_or_else(|| SecretStoreError::unavailable("node password is not configured"))
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeTargetError {
    pub code: &'static str,
    pub message: String,
}

impl RuntimeTargetError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("target_unavailable", message)
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self::new("ssh_transport_failed", message)
    }
}

impl fmt::Display for RuntimeTargetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl Error for RuntimeTargetError {}

#[derive(Clone, Debug)]
pub struct RuntimeTargetSnapshot {
    pub id: String,
    pub kind: &'static str,
    pub provider: String,
    pub node_id: Option<String>,
    pub display_name: String,
    pub status: String,
    pub generation: u64,
    pub local_api_base_url: Option<String>,
    pub remote_listen_addr: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub last_error: Option<RuntimeTargetError>,
    pub runtime_protocol: Option<String>,
    pub api_protocol: Option<String>,
    pub version: Option<String>,
}

#[async_trait]
pub trait ActiveRuntimeTargetHandle: Send + Sync {
    async fn disconnect(&self) -> Result<(), RuntimeTargetError>;
}

pub struct ConnectedRuntimeTarget {
    pub snapshot: RuntimeTargetSnapshot,
    pub handle: Arc<dyn ActiveRuntimeTargetHandle>,
}

#[async_trait]
pub trait RuntimeTargetConnector: Send + Sync {
    async fn connect(
        &self,
        node: StoredNode,
        password: String,
    ) -> Result<ConnectedRuntimeTarget, RuntimeTargetError>;
}

pub struct RuntimeTargetManager {
    connector: Arc<dyn RuntimeTargetConnector>,
    snapshots: tokio::sync::Mutex<HashMap<String, RuntimeTargetSnapshot>>,
    handles: tokio::sync::Mutex<HashMap<String, Arc<dyn ActiveRuntimeTargetHandle>>>,
}

impl Default for RuntimeTargetManager {
    fn default() -> Self {
        Self::new(Arc::new(
            ssh_transport::RusshSshRuntimeTargetConnector::default(),
        ))
    }
}

impl RuntimeTargetManager {
    pub fn new(connector: Arc<dyn RuntimeTargetConnector>) -> Self {
        Self {
            connector,
            snapshots: tokio::sync::Mutex::new(HashMap::new()),
            handles: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn snapshots(&self) -> HashMap<String, RuntimeTargetSnapshot> {
        self.snapshots.lock().await.clone()
    }

    pub async fn connect_node(
        &self,
        node: StoredNode,
        password: String,
    ) -> Result<RuntimeTargetSnapshot, RuntimeTargetError> {
        let target_id = target_id_for_node(&node.node_id);
        if let Some(snapshot) = self.snapshots.lock().await.get(&target_id).cloned() {
            if snapshot.status == "ready" || snapshot.status == "connecting" {
                return Ok(snapshot);
            }
        }

        self.snapshots.lock().await.insert(
            target_id.clone(),
            RuntimeTargetSnapshot {
                id: target_id.clone(),
                kind: "remote",
                provider: node.provider.clone(),
                node_id: Some(node.node_id.clone()),
                display_name: node.display_name.clone(),
                status: "connecting".to_string(),
                generation: 0,
                local_api_base_url: None,
                remote_listen_addr: None,
                last_seen_at: None,
                last_error: None,
                runtime_protocol: None,
                api_protocol: None,
                version: None,
            },
        );

        match self.connector.connect(node.clone(), password).await {
            Ok(connected) => {
                let snapshot = connected.snapshot;
                self.handles
                    .lock()
                    .await
                    .insert(target_id.clone(), connected.handle);
                self.snapshots
                    .lock()
                    .await
                    .insert(target_id, snapshot.clone());
                Ok(snapshot)
            }
            Err(err) => {
                let snapshot = RuntimeTargetSnapshot {
                    id: target_id.clone(),
                    kind: "remote",
                    provider: node.provider,
                    node_id: Some(node.node_id),
                    display_name: node.display_name,
                    status: "failed".to_string(),
                    generation: 0,
                    local_api_base_url: None,
                    remote_listen_addr: None,
                    last_seen_at: Some(Utc::now()),
                    last_error: Some(err.clone()),
                    runtime_protocol: None,
                    api_protocol: None,
                    version: None,
                };
                self.snapshots.lock().await.insert(target_id, snapshot);
                Err(err)
            }
        }
    }

    pub async fn disconnect_target(
        &self,
        target_id: &str,
    ) -> Result<Option<RuntimeTargetSnapshot>, RuntimeTargetError> {
        let handle = self.handles.lock().await.remove(target_id);
        let mut snapshot = self.snapshots.lock().await.remove(target_id);
        if let Some(handle) = handle {
            if let Err(err) = handle.disconnect().await {
                if let Some(snapshot) = snapshot.as_mut() {
                    snapshot.status = "failed".to_string();
                    snapshot.last_error = Some(err.clone());
                    snapshot.last_seen_at = Some(Utc::now());
                }
                return Err(err);
            }
        }
        if let Some(snapshot) = snapshot.as_mut() {
            snapshot.status = "disconnected".to_string();
            snapshot.local_api_base_url = None;
            snapshot.last_seen_at = Some(Utc::now());
        }
        Ok(snapshot)
    }
}

pub fn ssh_password_secret_ref(node_id: &str) -> String {
    format!("node:{node_id}:ssh-password")
}

pub fn node_providers_json() -> Value {
    json!({
        "schema": NODE_PROVIDER_SCHEMA,
        "providers": [
            {
                "id": SSH_PROVIDER_ID,
                "display_name": "SSH",
                "kind": "ssh",
                "auth_methods": ["password"],
                "secret_storage": "local_os_keyring",
                "capabilities": {
                    "native_ssh": true,
                    "sftp_upload": true,
                    "managed_remote_runtime": true,
                    "ready_file_handshake": true,
                    "preinstalled_required": false
                },
                "target_constraints": {
                    "os": ["linux", "darwin"],
                    "arch": ["x86_64", "amd64"]
                }
            }
        ]
    })
}

pub fn nodes_json(nodes: &[StoredNode]) -> Value {
    json!({
        "schema": NODES_SCHEMA,
        "nodes": nodes.iter().map(node_json).collect::<Vec<_>>(),
    })
}

pub fn node_response_json(node: &StoredNode) -> Value {
    json!({
        "schema": NODES_SCHEMA,
        "node": node_json(node),
    })
}

pub fn target_id_for_node(node_id: &str) -> String {
    format!("target:{node_id}")
}

pub fn runtime_targets_json(
    nodes: &[StoredNode],
    local_api_base_url: Option<&str>,
    connected_targets: &HashMap<String, RuntimeTargetSnapshot>,
) -> Value {
    let mut targets = vec![json!({
        "id": LOCAL_TARGET_ID,
        "kind": "local",
        "provider": "local",
        "node_id": null,
        "display_name": "Local velad",
        "status": "connected",
        "transport": {
            "kind": "loopback",
            "api_base_url": local_api_base_url
        },
        "compatibility": {
            "version_policy": "same_process",
            "required_velad_version": env!("CARGO_PKG_VERSION")
        }
    })];

    targets.extend(nodes.iter().map(|node| {
        runtime_target_json(
            node,
            connected_targets.get(&target_id_for_node(&node.node_id)),
        )
    }));
    json!({
        "schema": RUNTIME_TARGETS_SCHEMA,
        "targets": targets,
    })
}

pub fn runtime_target_response_json(snapshot: &RuntimeTargetSnapshot) -> Value {
    json!({
        "schema": RUNTIME_TARGETS_SCHEMA,
        "target": runtime_target_snapshot_json(snapshot),
    })
}

pub fn disconnected_runtime_target_response_json(node: &StoredNode) -> Value {
    json!({
        "schema": RUNTIME_TARGETS_SCHEMA,
        "target": runtime_target_json(node, None),
    })
}

fn node_json(node: &StoredNode) -> Value {
    let ssh = node.config.get("ssh").cloned().unwrap_or_else(|| json!({}));
    let target = node
        .config
        .get("target")
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({
        "id": node.node_id.as_str(),
        "provider": node.provider.as_str(),
        "display_name": node.display_name.as_str(),
        "ssh": ssh,
        "target": target,
        "auth": {
            "method": "password",
            "password_configured": node.secret_ref.is_some(),
            "secret_ref": node.secret_ref.as_deref()
        },
        "created_at": node.created_at.to_rfc3339(),
        "updated_at": node.updated_at.to_rfc3339(),
    })
}

fn runtime_target_json(node: &StoredNode, connected: Option<&RuntimeTargetSnapshot>) -> Value {
    if let Some(snapshot) = connected {
        return runtime_target_snapshot_json(snapshot);
    }
    let ssh = node.config.get("ssh").cloned().unwrap_or_else(|| json!({}));
    let target = node
        .config
        .get("target")
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({
        "id": target_id_for_node(&node.node_id),
        "kind": "remote",
        "provider": node.provider.as_str(),
        "node_id": node.node_id.as_str(),
        "display_name": node.display_name.as_str(),
        "status": "disconnected",
        "transport": {
            "kind": "ssh",
            "ssh": ssh
        },
        "target": target,
        "compatibility": {
            "version_policy": "exact",
            "required_velad_version": env!("CARGO_PKG_VERSION")
        }
    })
}

fn runtime_target_snapshot_json(snapshot: &RuntimeTargetSnapshot) -> Value {
    json!({
        "id": snapshot.id,
        "kind": snapshot.kind,
        "provider": snapshot.provider,
        "node_id": snapshot.node_id,
        "display_name": snapshot.display_name,
        "status": snapshot.status,
        "generation": snapshot.generation,
        "last_seen_at": snapshot.last_seen_at.map(|time| time.to_rfc3339()),
        "last_error": snapshot.last_error.as_ref().map(|err| json!({
            "code": err.code,
            "message": err.message,
        })),
        "transport": {
            "kind": "ssh",
            "api_base_url": snapshot.local_api_base_url,
            "remote_listen_addr": snapshot.remote_listen_addr,
        },
        "runtime_protocol": snapshot.runtime_protocol,
        "api_protocol": snapshot.api_protocol,
        "compatibility": {
            "version_policy": "exact",
            "required_velad_version": env!("CARGO_PKG_VERSION"),
            "version": snapshot.version,
        }
    })
}

#[derive(Default)]
pub struct NoopRuntimeTargetHandle;

#[async_trait]
impl ActiveRuntimeTargetHandle for NoopRuntimeTargetHandle {
    async fn disconnect(&self) -> Result<(), RuntimeTargetError> {
        Ok(())
    }
}
