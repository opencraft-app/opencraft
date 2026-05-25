//! Runtime-owned persistence for transcript and run ledger.
//!
//! This store is intentionally owned by the runtime layer. Gateway may keep a
//! projection/read model, but it must not be the write-side source of agent
//! transcript or run facts.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::runtime::{AgentRuntime, RunRecord, StoredQueuedRun};
use crate::session::TranscriptEntry;

const SNAPSHOT_FILE: &str = "runtime_snapshot.json";
pub const RUNTIME_STORE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStoreSnapshot {
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    pub session_id: String,
    pub cwd: PathBuf,
    pub transcript: Vec<TranscriptEntry>,
    pub run_ledger: Vec<RunRecord>,
    #[serde(default)]
    pub pending_runs: Vec<StoredQueuedRun>,
}

impl AgentRuntime {
    pub(crate) async fn persist_state(&self) -> Result<()> {
        let Some(store) = &self.store else {
            return Ok(());
        };
        let (session_id, cwd, transcript) = {
            let session = self.session.lock().await;
            (
                session.session_id.clone(),
                session.cwd.clone(),
                session.transcript.clone(),
            )
        };
        let (run_ledger, pending_runs) = {
            let actor = self.actor.lock().await;
            (actor.run_ledger(), actor.pending_runs_snapshot())
        };
        store.save_snapshot(&RuntimeStoreSnapshot {
            schema_version: RUNTIME_STORE_SCHEMA_VERSION,
            session_id,
            cwd,
            transcript,
            run_ledger,
            pending_runs,
        })
    }
}

fn current_schema_version() -> u32 {
    RUNTIME_STORE_SCHEMA_VERSION
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeStoreLoad {
    Restored,
    ResetMarker { reason: String },
}

#[derive(Debug, Clone)]
pub struct RuntimeStore {
    root: PathBuf,
}

impl RuntimeStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn snapshot_path(&self) -> PathBuf {
        self.root.join(SNAPSHOT_FILE)
    }

    pub fn save_snapshot(&self, snapshot: &RuntimeStoreSnapshot) -> Result<()> {
        fs::create_dir_all(&self.root).map_err(|error| {
            Error::Agent(format!(
                "failed to create runtime store '{}': {}",
                self.root.display(),
                error
            ))
        })?;
        let bytes = serde_json::to_vec_pretty(snapshot)?;
        let tmp_path = self.root.join(format!("{}.tmp", SNAPSHOT_FILE));
        fs::write(&tmp_path, bytes).map_err(|error| {
            Error::Agent(format!(
                "failed to write runtime store snapshot '{}': {}",
                tmp_path.display(),
                error
            ))
        })?;
        fs::rename(&tmp_path, self.snapshot_path()).map_err(|error| {
            Error::Agent(format!(
                "failed to commit runtime store snapshot '{}': {}",
                self.snapshot_path().display(),
                error
            ))
        })
    }

    pub fn load_snapshot(&self) -> Result<Option<RuntimeStoreSnapshot>> {
        let path = self.snapshot_path();
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).map_err(|error| {
            Error::Agent(format!(
                "failed to read runtime store snapshot '{}': {}",
                path.display(),
                error
            ))
        })?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(Error::from)
    }

    pub fn load_or_reset_marker(&self) -> Result<(RuntimeStoreLoad, Option<RuntimeStoreSnapshot>)> {
        match self.load_snapshot() {
            Ok(Some(snapshot)) if snapshot.schema_version == RUNTIME_STORE_SCHEMA_VERSION => {
                Ok((RuntimeStoreLoad::Restored, Some(snapshot)))
            }
            Ok(Some(snapshot)) => Ok((
                RuntimeStoreLoad::ResetMarker {
                    reason: format!(
                        "runtime_store_schema_mismatch: got {}, expected {}",
                        snapshot.schema_version, RUNTIME_STORE_SCHEMA_VERSION
                    ),
                },
                None,
            )),
            Ok(None) => Ok((
                RuntimeStoreLoad::ResetMarker {
                    reason: "runtime_store_missing".to_string(),
                },
                None,
            )),
            Err(error) => Ok((
                RuntimeStoreLoad::ResetMarker {
                    reason: format!("runtime_store_unreadable: {}", error),
                },
                None,
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::runtime::{InboxMode, RunRecord, RunRecordStatus};
    use crate::session::{TranscriptBlock, TranscriptEntry, TranscriptRole};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn temp_store() -> RuntimeStore {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        RuntimeStore::new(std::env::temp_dir().join(format!("hermes-runtime-store-test-{now}-{n}")))
    }

    fn snapshot() -> RuntimeStoreSnapshot {
        RuntimeStoreSnapshot {
            schema_version: crate::runtime::store::RUNTIME_STORE_SCHEMA_VERSION,
            session_id: "session_1".to_string(),
            cwd: PathBuf::from("/tmp/workspace"),
            transcript: vec![TranscriptEntry {
                entry_id: "entry_1".to_string(),
                parent_id: None,
                turn_id: "turn_1".to_string(),
                run_id: "run_1".to_string(),
                role: TranscriptRole::User,
                blocks: vec![TranscriptBlock::Text {
                    text: "hello".to_string(),
                }],
                created_at_ms: 1,
            }],
            run_ledger: vec![RunRecord {
                run_id: "run_1".to_string(),
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                source: "prompt".to_string(),
                inbox_mode: InboxMode::Prompt,
                status: RunRecordStatus::Succeeded,
                created_at_ms: 1,
                started_at_ms: Some(2),
                completed_at_ms: Some(3),
                error_code: None,
                error_message: None,
                blocked_reason: None,
                reconciled_reason: None,
            }],
            pending_runs: Vec::new(),
        }
    }

    #[test]
    fn runtime_store_persists_transcript() {
        let store = temp_store();
        store.save_snapshot(&snapshot()).expect("snapshot saved");

        let loaded = store
            .load_snapshot()
            .expect("snapshot loaded")
            .expect("snapshot exists");
        assert_eq!(loaded.transcript.len(), 1);
        assert_eq!(loaded.transcript[0].entry_id, "entry_1");
        assert_eq!(loaded.transcript[0].run_id, "run_1");
    }

    #[test]
    fn runtime_store_persists_run_ledger() {
        let store = temp_store();
        store.save_snapshot(&snapshot()).expect("snapshot saved");

        let loaded = store
            .load_snapshot()
            .expect("snapshot loaded")
            .expect("snapshot exists");
        assert_eq!(loaded.run_ledger.len(), 1);
        assert_eq!(loaded.run_ledger[0].status, RunRecordStatus::Succeeded);
    }

    #[test]
    fn runtime_store_reset_marker_for_missing_snapshot() {
        let store = temp_store();

        let (marker, snapshot) = store.load_or_reset_marker().expect("load succeeds");

        assert!(snapshot.is_none());
        assert_eq!(
            marker,
            RuntimeStoreLoad::ResetMarker {
                reason: "runtime_store_missing".to_string()
            }
        );
    }
}
