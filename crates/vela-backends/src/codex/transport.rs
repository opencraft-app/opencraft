use super::events::CodexRawRequest;
use anyhow::Context;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{collections::VecDeque, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

const STDERR_TAIL_LIMIT_BYTES: usize = 8192;

#[derive(Clone, Debug, PartialEq)]
pub enum AppServerInbound {
    Response(Value),
    Request(CodexRawRequest),
    Notification { method: String, params: Value },
}

impl AppServerInbound {
    pub fn response(value: Value) -> Self {
        Self::Response(value)
    }

    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        Self::Notification {
            method: method.into(),
            params,
        }
    }

    pub fn request(id: i64, method: impl Into<String>, params: Value) -> Self {
        Self::Request(CodexRawRequest {
            id,
            method: method.into(),
            params,
        })
    }
}

#[async_trait]
pub trait CodexAppServerHost: Send + Sync {
    async fn connect(&self) -> anyhow::Result<Box<dyn CodexAppServerConnection>>;
}

#[async_trait]
pub trait CodexAppServerConnection: Send {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value>;
    async fn notify(&mut self, method: &str, params: Value) -> anyhow::Result<()>;
    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()>;
    async fn next(&mut self) -> anyhow::Result<Option<AppServerInbound>>;
    async fn close(&mut self) -> anyhow::Result<()>;
}

#[derive(Clone, Debug)]
pub struct CodexStdioAppServerHost {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
}

impl CodexStdioAppServerHost {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            command: "codex".to_string(),
            args: vec!["app-server".to_string()],
            cwd: cwd.into(),
        }
    }
}

#[async_trait]
impl CodexAppServerHost for CodexStdioAppServerHost {
    async fn connect(&self) -> anyhow::Result<Box<dyn CodexAppServerConnection>> {
        let mut child = Command::new(&self.command)
            .args(&self.args)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| {
                format!(
                    "failed to spawn Codex app-server command `{}` with args {:?}",
                    self.command, self.args
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app-server stdin was not available"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app-server stdout was not available"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("Codex app-server stderr was not available"))?;
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        capture_stderr_tail(stderr, Arc::clone(&stderr_tail));
        Ok(Box::new(StdioAppServerConnection {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
            buffered: VecDeque::new(),
            launch: format!("{} {}", self.command, self.args.join(" ")),
            stderr_tail,
        }))
    }
}

fn capture_stderr_tail(mut stderr: tokio::process::ChildStderr, tail: Arc<Mutex<Vec<u8>>>) {
    tokio::spawn(async move {
        let mut buffer = [0; 1024];
        loop {
            let bytes_read = match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(bytes_read) => bytes_read,
            };
            let mut tail = tail.lock().await;
            tail.extend_from_slice(&buffer[..bytes_read]);
            if tail.len() > STDERR_TAIL_LIMIT_BYTES {
                let keep_from = tail.len() - STDERR_TAIL_LIMIT_BYTES;
                tail.drain(..keep_from);
            }
        }
    });
}

struct StdioAppServerConnection {
    child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    next_id: i64,
    buffered: VecDeque<AppServerInbound>,
    launch: String,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
}

#[async_trait]
impl CodexAppServerConnection for StdioAppServerConnection {
    async fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({ "id": id, "method": method, "params": params }))
            .await?;
        loop {
            let inbound = match self.read_one().await? {
                Some(inbound) => inbound,
                None => return Err(self.closed_while_waiting_error(method).await),
            };
            match inbound {
                AppServerInbound::Response(value)
                    if value.get("id").and_then(Value::as_i64) == Some(id) =>
                {
                    if let Some(error) = value.get("error") {
                        anyhow::bail!("Codex app-server {method} failed: {error}");
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                other => self.buffered.push_back(other),
            }
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> anyhow::Result<()> {
        self.write(json!({ "method": method, "params": params }))
            .await
    }

    async fn respond(&mut self, id: i64, result: Value) -> anyhow::Result<()> {
        self.write(json!({ "id": id, "result": result })).await
    }

    async fn next(&mut self) -> anyhow::Result<Option<AppServerInbound>> {
        if let Some(inbound) = self.buffered.pop_front() {
            return Ok(Some(inbound));
        }
        self.read_one().await
    }

    async fn close(&mut self) -> anyhow::Result<()> {
        let _ = self.stdin.shutdown().await;
        let _ = self.child.kill().await;
        Ok(())
    }
}

impl StdioAppServerConnection {
    async fn write(&mut self, value: Value) -> anyhow::Result<()> {
        self.stdin
            .write_all(format!("{}\n", serde_json::to_string(&value)?).as_bytes())
            .await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn read_one(&mut self) -> anyhow::Result<Option<AppServerInbound>> {
        loop {
            let Some(line) = self.lines.next_line().await? else {
                return Ok(None);
            };
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    tracing::trace!(
                        target: "vela_backends::codex",
                        line,
                        error = %error,
                        "ignored non-JSON Codex app-server stdout line"
                    );
                    continue;
                }
            };
            if let Some(id) = value.get("id").and_then(Value::as_i64) {
                if let Some(method) = value.get("method").and_then(Value::as_str) {
                    return Ok(Some(AppServerInbound::request(
                        id,
                        method,
                        value.get("params").cloned().unwrap_or(Value::Null),
                    )));
                }
                return Ok(Some(AppServerInbound::Response(value)));
            }
            let method = value.get("method").and_then(Value::as_str).ok_or_else(|| {
                anyhow::anyhow!("Codex app-server message missing method: {value}")
            })?;
            return Ok(Some(AppServerInbound::notification(
                method,
                value.get("params").cloned().unwrap_or(Value::Null),
            )));
        }
    }

    async fn closed_while_waiting_error(&self, method: &str) -> anyhow::Error {
        let stderr = self.stderr_tail().await;
        if stderr.trim().is_empty() {
            anyhow::anyhow!(
                "Codex app-server closed while waiting for {method}; launch: {}",
                self.launch
            )
        } else {
            anyhow::anyhow!(
                "Codex app-server closed while waiting for {method}; launch: {}; stderr: {}",
                self.launch,
                stderr.trim()
            )
        }
    }

    async fn stderr_tail(&self) -> String {
        let tail = self.stderr_tail.lock().await;
        String::from_utf8_lossy(&tail).to_string()
    }
}
