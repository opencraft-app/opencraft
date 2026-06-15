use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use tokio::sync::{broadcast, Mutex};

use crate::protocol::{
    PromptOutcome, PromptResponseLine, RuntimeRunEventRecord, RuntimeRunEventsResponse,
    RuntimeRunResultResponse, RuntimeRunStatus, RuntimeRunStatusResponse, RuntimeRunSubmitResponse,
};

const EVENT_BUFFER: usize = 256;

#[derive(Clone)]
pub(crate) struct RunStore {
    root: PathBuf,
    inner: Arc<Mutex<RunStoreInner>>,
}

#[derive(Default)]
struct RunStoreInner {
    runs: HashMap<String, StoredRun>,
    observers: HashMap<String, broadcast::Sender<RuntimeRunEventRecord>>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct StoredRun {
    run_id: String,
    session_id: String,
    status: RuntimeRunStatus,
    event_count: u64,
    result: Option<StoredRunResult>,
    error: Option<String>,
    created_at_unix_ms: u128,
    updated_at_unix_ms: u128,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct StoredRunResult {
    output_text: String,
    inner_sandbox_id: Option<String>,
    inner_sandbox_domain: Option<String>,
    inner_envd_access_token: Option<String>,
}

impl RunStore {
    pub(crate) fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)
            .with_context(|| format!("failed to create run store '{}'", root.display()))?;
        let mut runs = HashMap::new();
        for entry in fs::read_dir(&root)
            .with_context(|| format!("failed to read run store '{}'", root.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let run_path = entry.path().join("run.json");
            if !run_path.exists() {
                continue;
            }
            let mut run: StoredRun =
                serde_json::from_slice(&fs::read(&run_path).with_context(|| {
                    format!("failed to read stored run '{}'", run_path.display())
                })?)
                .with_context(|| format!("failed to parse stored run '{}'", run_path.display()))?;
            if run.status == RuntimeRunStatus::Running {
                run.status = RuntimeRunStatus::Failed;
                run.error = Some("sidecar restarted while run was active".to_string());
                run.updated_at_unix_ms = now_ms();
                persist_run(&root, &run)?;
            }
            runs.insert(run.run_id.clone(), run);
        }
        Ok(Self {
            root,
            inner: Arc::new(Mutex::new(RunStoreInner {
                runs,
                observers: HashMap::new(),
            })),
        })
    }

    pub(crate) async fn start_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<RuntimeRunSubmitResponse> {
        validate_run_id(run_id)?;
        let mut inner = self.inner.lock().await;
        if let Some(existing) = inner.runs.get(run_id).cloned() {
            if existing.session_id != session_id {
                bail!("run_id belongs to another session");
            }
            return Ok(RuntimeRunSubmitResponse {
                ok: true,
                accepted: false,
                run: status_response(existing),
            });
        }
        let now = now_ms();
        let run = StoredRun {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            status: RuntimeRunStatus::Running,
            event_count: 0,
            result: None,
            error: None,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
        };
        persist_run(&self.root, &run)?;
        inner.runs.insert(run_id.to_string(), run.clone());
        inner
            .observers
            .entry(run_id.to_string())
            .or_insert_with(|| broadcast::channel(EVENT_BUFFER).0);
        Ok(RuntimeRunSubmitResponse {
            ok: true,
            accepted: true,
            run: status_response(run),
        })
    }

    pub(crate) async fn status(&self, run_id: &str) -> Option<RuntimeRunStatusResponse> {
        self.inner
            .lock()
            .await
            .runs
            .get(run_id)
            .cloned()
            .map(status_response)
    }

    pub(crate) async fn events_since(
        &self,
        run_id: &str,
        after_seq: u64,
    ) -> Result<RuntimeRunEventsResponse> {
        let (status, events) = {
            let inner = self.inner.lock().await;
            let run = inner
                .runs
                .get(run_id)
                .with_context(|| format!("run '{}' not found", run_id))?;
            let events = load_events(&self.root, run_id, after_seq)?;
            (run.status.clone(), events)
        };
        Ok(RuntimeRunEventsResponse {
            ok: true,
            run_id: run_id.to_string(),
            events,
            status,
        })
    }

    pub(crate) async fn subscribe(
        &self,
        run_id: &str,
    ) -> Result<broadcast::Receiver<RuntimeRunEventRecord>> {
        let mut inner = self.inner.lock().await;
        if !inner.runs.contains_key(run_id) {
            bail!("run '{}' not found", run_id);
        }
        Ok(inner
            .observers
            .entry(run_id.to_string())
            .or_insert_with(|| broadcast::channel(EVENT_BUFFER).0)
            .subscribe())
    }

    pub(crate) async fn append_event(
        &self,
        run_id: &str,
        line: PromptResponseLine,
    ) -> Result<RuntimeRunEventRecord> {
        let mut inner = self.inner.lock().await;
        let (event, sender) = {
            let run = inner
                .runs
                .get_mut(run_id)
                .with_context(|| format!("run '{}' not found", run_id))?;
            if runtime_run_terminal(&run.status) {
                bail!("run '{}' is already terminal", run_id);
            }
            let event = append_event_locked(&self.root, run_id, run, line)?;
            let sender = inner.observers.get(run_id).cloned();
            (event, sender)
        };
        if let Some(sender) = sender {
            let _ = sender.send(event.clone());
        }
        Ok(event)
    }

    pub(crate) async fn complete_run(&self, run_id: &str, outcome: PromptOutcome) -> Result<()> {
        let line = PromptResponseLine::Result {
            output_text: outcome.output_text.clone(),
            inner_sandbox_id: outcome.inner_sandbox_id.clone(),
            inner_sandbox_domain: outcome.inner_sandbox_domain.clone(),
            inner_envd_access_token: outcome.inner_envd_access_token.clone(),
        };
        let mut inner = self.inner.lock().await;
        let (event, sender) = {
            let run = inner
                .runs
                .get_mut(run_id)
                .with_context(|| format!("run '{}' not found", run_id))?;
            if runtime_run_terminal(&run.status) {
                return Ok(());
            }
            let event = append_event_locked(&self.root, run_id, run, line)?;
            run.status = RuntimeRunStatus::Completed;
            run.updated_at_unix_ms = now_ms();
            run.result = Some(StoredRunResult {
                output_text: outcome.output_text,
                inner_sandbox_id: outcome.inner_sandbox_id,
                inner_sandbox_domain: outcome.inner_sandbox_domain,
                inner_envd_access_token: outcome.inner_envd_access_token,
            });
            persist_result(&self.root, run)?;
            persist_run(&self.root, run)?;
            let sender = inner.observers.get(run_id).cloned();
            (event, sender)
        };
        if let Some(sender) = sender {
            let _ = sender.send(event);
        }
        Ok(())
    }

    pub(crate) async fn fail_run(&self, run_id: &str, code: &str, error: String) -> Result<()> {
        let line = PromptResponseLine::Error {
            code: Some(code.to_string()),
            error: error.clone(),
        };
        let mut inner = self.inner.lock().await;
        let (event, sender) = {
            let run = inner
                .runs
                .get_mut(run_id)
                .with_context(|| format!("run '{}' not found", run_id))?;
            if runtime_run_terminal(&run.status) {
                return Ok(());
            }
            let event = append_event_locked(&self.root, run_id, run, line)?;
            run.status = if code == "prompt_cancelled" {
                RuntimeRunStatus::Cancelled
            } else {
                RuntimeRunStatus::Failed
            };
            run.error = Some(error);
            run.updated_at_unix_ms = now_ms();
            persist_run(&self.root, run)?;
            let sender = inner.observers.get(run_id).cloned();
            (event, sender)
        };
        if let Some(sender) = sender {
            let _ = sender.send(event);
        }
        Ok(())
    }

    pub(crate) async fn result(&self, run_id: &str) -> Option<RuntimeRunResultResponse> {
        self.inner
            .lock()
            .await
            .runs
            .get(run_id)
            .cloned()
            .map(|run| {
                let result = run.result;
                RuntimeRunResultResponse {
                    ok: true,
                    run_id: run.run_id,
                    status: run.status,
                    output_text: result.as_ref().map(|item| item.output_text.clone()),
                    inner_sandbox_id: result
                        .as_ref()
                        .and_then(|item| item.inner_sandbox_id.clone()),
                    inner_sandbox_domain: result
                        .as_ref()
                        .and_then(|item| item.inner_sandbox_domain.clone()),
                    error: run.error,
                }
            })
    }
}

fn status_response(run: StoredRun) -> RuntimeRunStatusResponse {
    RuntimeRunStatusResponse {
        ok: true,
        run_id: run.run_id,
        session_id: run.session_id,
        status: run.status,
        event_count: run.event_count,
        result_readable: run.result.is_some(),
        error: run.error,
        created_at_unix_ms: run.created_at_unix_ms,
        updated_at_unix_ms: run.updated_at_unix_ms,
    }
}

fn run_dir(root: &Path, run_id: &str) -> PathBuf {
    root.join(run_id)
}

fn runtime_run_terminal(status: &RuntimeRunStatus) -> bool {
    matches!(
        status,
        RuntimeRunStatus::Completed | RuntimeRunStatus::Failed | RuntimeRunStatus::Cancelled
    )
}

fn validate_run_id(run_id: &str) -> Result<()> {
    if run_id.trim().is_empty() {
        bail!("run_id is required");
    }
    if run_id.len() > 128 {
        bail!("run_id is too long");
    }
    if !run_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        bail!("run_id contains unsupported characters");
    }
    Ok(())
}

fn append_event_locked(
    root: &Path,
    run_id: &str,
    run: &mut StoredRun,
    line: PromptResponseLine,
) -> Result<RuntimeRunEventRecord> {
    run.event_count += 1;
    run.updated_at_unix_ms = now_ms();
    let event = RuntimeRunEventRecord {
        run_id: run_id.to_string(),
        seq: run.event_count,
        created_at_unix_ms: run.updated_at_unix_ms,
        line,
    };
    persist_event(root, &event)?;
    persist_run(root, run)?;
    Ok(event)
}

fn persist_run(root: &Path, run: &StoredRun) -> Result<()> {
    let dir = run_dir(root, &run.run_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("run.json");
    let temp = dir.join("run.json.tmp");
    fs::write(&temp, serde_json::to_vec(run)?)?;
    fs::rename(temp, path)?;
    Ok(())
}

fn persist_result(root: &Path, run: &StoredRun) -> Result<()> {
    let dir = run_dir(root, &run.run_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("result.json");
    let temp = dir.join("result.json.tmp");
    fs::write(&temp, serde_json::to_vec(&run.result)?)?;
    fs::rename(temp, path)?;
    Ok(())
}

fn persist_event(root: &Path, event: &RuntimeRunEventRecord) -> Result<()> {
    let dir = run_dir(root, &event.run_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("events.jsonl");
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(serde_json::to_string(event)?.as_bytes())?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}

fn load_events(root: &Path, run_id: &str, after_seq: u64) -> Result<Vec<RuntimeRunEventRecord>> {
    let path = run_dir(root, run_id).join("events.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)?;
    let mut out = Vec::new();
    let ends_with_newline = raw.ends_with('\n');
    let lines: Vec<&str> = raw.lines().collect();
    let last_index = lines.len().saturating_sub(1);
    for (index, line) in lines.iter().enumerate() {
        let event: RuntimeRunEventRecord = match serde_json::from_str(line) {
            Ok(event) => event,
            Err(error) if index == last_index && !ends_with_newline => {
                tracing::warn!(
                    run_id,
                    error = %error,
                    "ignoring truncated tail record in runtime run event log"
                );
                break;
            }
            Err(error) => return Err(error.into()),
        };
        if event.seq > after_seq {
            out.push(event);
        }
    }
    Ok(out)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_store_replays_events_after_sequence() {
        let root = unique_test_dir("replay");
        let store = RunStore::new(&root).unwrap();
        store.start_run("session_1", "run_1").await.unwrap();
        store
            .append_event(
                "run_1",
                PromptResponseLine::OutputTextDelta {
                    delta: "first".to_string(),
                },
            )
            .await
            .unwrap();
        store
            .append_event(
                "run_1",
                PromptResponseLine::OutputTextDelta {
                    delta: "second".to_string(),
                },
            )
            .await
            .unwrap();

        let replay = store.events_since("run_1", 1).await.unwrap();

        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].seq, 2);
        assert_eq!(
            replay.events[0].line,
            PromptResponseLine::OutputTextDelta {
                delta: "second".to_string()
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_marks_running_runs_failed_after_restart_and_replays_events() {
        let root = unique_test_dir("reload");
        let store = RunStore::new(&root).unwrap();
        store.start_run("session_1", "run_reload").await.unwrap();
        store
            .append_event(
                "run_reload",
                PromptResponseLine::ReasoningDelta {
                    delta: "thinking".to_string(),
                },
            )
            .await
            .unwrap();

        let reloaded = RunStore::new(&root).unwrap();
        let status = reloaded.status("run_reload").await.unwrap();
        let replay = reloaded.events_since("run_reload", 0).await.unwrap();

        assert_eq!(status.status, RuntimeRunStatus::Failed);
        assert_eq!(
            status.error.as_deref(),
            Some("sidecar restarted while run was active")
        );
        assert_eq!(status.event_count, 1);
        assert_eq!(replay.events.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_ignores_truncated_tail_event_after_crash() {
        let root = unique_test_dir("truncated-tail");
        let store = RunStore::new(&root).unwrap();
        store.start_run("session_1", "run_tail").await.unwrap();
        store
            .append_event(
                "run_tail",
                PromptResponseLine::OutputTextDelta {
                    delta: "durable".to_string(),
                },
            )
            .await
            .unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(run_dir(&root, "run_tail").join("events.jsonl"))
            .unwrap()
            .write_all(br#"{"run_id":"run_tail","seq":"#)
            .unwrap();

        let replay = store.events_since("run_tail", 0).await.unwrap();

        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].seq, 1);
        assert_eq!(
            replay.events[0].line,
            PromptResponseLine::OutputTextDelta {
                delta: "durable".to_string()
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_reports_corrupt_middle_event() {
        let root = unique_test_dir("corrupt-middle");
        let store = RunStore::new(&root).unwrap();
        store.start_run("session_1", "run_corrupt").await.unwrap();
        store
            .append_event(
                "run_corrupt",
                PromptResponseLine::OutputTextDelta {
                    delta: "first".to_string(),
                },
            )
            .await
            .unwrap();
        let path = run_dir(&root, "run_corrupt").join("events.jsonl");
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{bad json}\n")
            .unwrap();
        store
            .append_event(
                "run_corrupt",
                PromptResponseLine::OutputTextDelta {
                    delta: "second".to_string(),
                },
            )
            .await
            .unwrap();

        let err = store.events_since("run_corrupt", 0).await.unwrap_err();

        assert!(err.to_string().contains("key must be a string"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_completes_with_readable_result_and_idempotent_submit() {
        let root = unique_test_dir("complete");
        let store = RunStore::new(&root).unwrap();
        let first = store.start_run("session_1", "run_done").await.unwrap();
        let second = store.start_run("session_1", "run_done").await.unwrap();

        assert!(first.accepted);
        assert!(!second.accepted);

        store
            .complete_run(
                "run_done",
                PromptOutcome {
                    output_text: "done".to_string(),
                    inner_sandbox_id: Some("inner_1".to_string()),
                    inner_sandbox_domain: Some("inner.example.com".to_string()),
                    inner_envd_access_token: Some("token".to_string()),
                },
            )
            .await
            .unwrap();

        let status = store.status("run_done").await.unwrap();
        let result = store.result("run_done").await.unwrap();
        let events = store.events_since("run_done", 0).await.unwrap();

        assert_eq!(status.status, RuntimeRunStatus::Completed);
        assert!(status.result_readable);
        assert_eq!(result.output_text.as_deref(), Some("done"));
        assert_eq!(events.events.len(), 1);
        assert!(matches!(
            events.events[0].line,
            PromptResponseLine::Result { .. }
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_preserves_completed_runs_after_restart() {
        let root = unique_test_dir("completed-reload");
        let store = RunStore::new(&root).unwrap();
        store.start_run("session_1", "run_completed").await.unwrap();
        store
            .complete_run(
                "run_completed",
                PromptOutcome {
                    output_text: "done".to_string(),
                    inner_sandbox_id: None,
                    inner_sandbox_domain: None,
                    inner_envd_access_token: None,
                },
            )
            .await
            .unwrap();

        let reloaded = RunStore::new(&root).unwrap();
        let status = reloaded.status("run_completed").await.unwrap();
        let result = reloaded.result("run_completed").await.unwrap();

        assert_eq!(status.status, RuntimeRunStatus::Completed);
        assert_eq!(result.output_text.as_deref(), Some("done"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_does_not_overwrite_terminal_runs() {
        let root = unique_test_dir("terminal-once");
        let store = RunStore::new(&root).unwrap();
        store.start_run("session_1", "run_terminal").await.unwrap();
        store
            .complete_run(
                "run_terminal",
                PromptOutcome {
                    output_text: "done".to_string(),
                    inner_sandbox_id: None,
                    inner_sandbox_domain: None,
                    inner_envd_access_token: None,
                },
            )
            .await
            .unwrap();

        store
            .fail_run(
                "run_terminal",
                "late_failure",
                "should not replace completion".to_string(),
            )
            .await
            .unwrap();
        let late_append = store
            .append_event(
                "run_terminal",
                PromptResponseLine::OutputTextDelta {
                    delta: "late".to_string(),
                },
            )
            .await;

        let status = store.status("run_terminal").await.unwrap();
        let result = store.result("run_terminal").await.unwrap();
        let events = store.events_since("run_terminal", 0).await.unwrap();

        assert!(late_append.is_err());
        assert_eq!(status.status, RuntimeRunStatus::Completed);
        assert_eq!(status.event_count, 1);
        assert_eq!(result.output_text.as_deref(), Some("done"));
        assert_eq!(events.events.len(), 1);
        assert!(matches!(
            events.events[0].line,
            PromptResponseLine::Result { .. }
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_rejects_cross_session_run_id_reuse() {
        let root = unique_test_dir("scope");
        let store = RunStore::new(&root).unwrap();
        let first = store.start_run("session_1", "run_scoped").await.unwrap();

        let second = store.start_run("session_2", "run_scoped").await;

        assert!(first.accepted);
        assert!(second.is_err());
        assert!(second.unwrap_err().to_string().contains("another session"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_rejects_unsafe_run_ids_instead_of_sanitizing() {
        let root = unique_test_dir("unsafe");
        let store = RunStore::new(&root).unwrap();

        assert!(store.start_run("session_1", "../escape").await.is_err());
        assert!(store.start_run("session_1", "a/b").await.is_err());
        assert!(store.start_run("session_1", "a_b").await.unwrap().accepted);
        assert!(root.join("a_b").join("run.json").exists());
        assert!(!root.join("a").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn run_store_live_subscriber_receives_follow_events() {
        let root = unique_test_dir("follow");
        let store = RunStore::new(&root).unwrap();
        store.start_run("session_1", "run_follow").await.unwrap();
        store
            .append_event(
                "run_follow",
                PromptResponseLine::OutputTextDelta {
                    delta: "already persisted".to_string(),
                },
            )
            .await
            .unwrap();
        let mut subscriber = store.subscribe("run_follow").await.unwrap();

        store
            .append_event(
                "run_follow",
                PromptResponseLine::OutputTextDelta {
                    delta: "live".to_string(),
                },
            )
            .await
            .unwrap();

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), subscriber.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.seq, 2);
        assert_eq!(
            event.line,
            PromptResponseLine::OutputTextDelta {
                delta: "live".to_string()
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "hermes-sidecar-run-store-{}-{}-{}",
            name,
            std::process::id(),
            now_ms()
        ))
    }
}
