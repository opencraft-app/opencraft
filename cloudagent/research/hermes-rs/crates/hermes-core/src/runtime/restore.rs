use crate::error::Result;
use crate::runtime::ids::{advance_runtime_counters, now_ms};
use crate::runtime::store::RuntimeStoreLoad;
use crate::runtime::transcript::{reset_marker_entry, transcript_to_messages};
use crate::runtime::{AgentRuntime, RunRecord, RunRecordStatus, StoredQueuedRun};

impl AgentRuntime {
    pub async fn restore_from_store(&self) -> Result<RuntimeStoreLoad> {
        let Some(store) = &self.store else {
            return Ok(RuntimeStoreLoad::ResetMarker {
                reason: "runtime_store_not_configured".to_string(),
            });
        };
        let (load, snapshot) = store.load_or_reset_marker()?;
        if let Some(mut snapshot) = snapshot {
            let reconcile_reason =
                reconcile_restored_runs(&mut snapshot.run_ledger, &snapshot.pending_runs);
            if let Some(reason) = reconcile_reason.as_deref() {
                let parent_id = snapshot
                    .transcript
                    .last()
                    .map(|entry| entry.entry_id.clone());
                snapshot.transcript.push(reset_marker_entry(
                    snapshot.transcript.len(),
                    parent_id,
                    reason.to_string(),
                ));
            }
            advance_runtime_counters(&snapshot.run_ledger, &snapshot.transcript);
            let restored_history = transcript_to_messages(&snapshot.transcript);
            {
                let mut session = self.session.lock().await;
                session.session_id = snapshot.session_id;
                session.cwd = snapshot.cwd;
                session.replace_transcript(snapshot.transcript);
            }
            self.actor
                .lock()
                .await
                .replace_run_ledger(snapshot.run_ledger);
            self.agent.replace_history(restored_history).await;
            if reconcile_reason.is_some() {
                self.persist_state().await?;
            }
        } else if let RuntimeStoreLoad::ResetMarker { reason } = &load {
            {
                let mut session = self.session.lock().await;
                session.append_reset_marker(reason.clone());
            }
            self.persist_state().await?;
        }
        Ok(load)
    }
}

fn reconcile_restored_runs(
    run_ledger: &mut [RunRecord],
    pending_runs: &[StoredQueuedRun],
) -> Option<String> {
    let mut reconciled = 0usize;
    for record in run_ledger.iter_mut() {
        let reason = match record.status {
            RunRecordStatus::Queued => Some("runtime restored with queued run pending"),
            RunRecordStatus::Running => Some("runtime restored with active run in progress"),
            RunRecordStatus::Aborting => Some("runtime restored with aborting run in progress"),
            RunRecordStatus::Succeeded
            | RunRecordStatus::Failed
            | RunRecordStatus::Canceled
            | RunRecordStatus::Blocked => None,
        };
        if let Some(reason) = reason {
            record.status = RunRecordStatus::Canceled;
            record.error_message = Some(reason.to_string());
            record.reconciled_reason = Some(reason.to_string());
            if record.completed_at_ms.is_none() {
                record.completed_at_ms = Some(now_ms());
            }
            reconciled += 1;
        }
    }
    if reconciled == 0 && pending_runs.is_empty() {
        return None;
    }
    Some(format!(
        "runtime_restore_reconciled_non_terminal_runs: runs={}, pending_descriptors={}",
        reconciled,
        pending_runs.len()
    ))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::runtime::ids::tests::{run_record, temp_store, test_runtime};
    use crate::runtime::store::{RuntimeStoreLoad, RuntimeStoreSnapshot};
    use crate::runtime::{RunRecordStatus, StoredQueuedRun};
    use crate::session::{TranscriptBlock, TranscriptEntry, TranscriptRole};

    #[tokio::test]
    async fn restore_marks_active_runs_interrupted() {
        let store = temp_store("hermes-agent-runtime-restore-test");
        store
            .save_snapshot(&RuntimeStoreSnapshot {
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
                run_ledger: vec![
                    run_record("run_1", RunRecordStatus::Running),
                    run_record("run_2", RunRecordStatus::Queued),
                ],
                pending_runs: vec![StoredQueuedRun {
                    run_id: "run_2".to_string(),
                    turn_id: "turn_2".to_string(),
                    mode: crate::runtime::InboxMode::Prompt,
                    request: crate::runtime::RunTurnRequest::new("session_1", "queued"),
                }],
            })
            .expect("snapshot saved");
        let runtime = test_runtime(0).with_store(store);

        let load = runtime.restore_from_store().await.expect("store restored");

        assert_eq!(load, RuntimeStoreLoad::Restored);
        let ledger = runtime.run_ledger_snapshot().await;
        assert!(ledger
            .iter()
            .all(|record| record.status == RunRecordStatus::Canceled));
        assert!(ledger.iter().all(|record| record.completed_at_ms.is_some()));
        assert!(ledger
            .iter()
            .all(|record| record.reconciled_reason.is_some()));
        let session = runtime.session_snapshot().await;
        assert!(session.transcript.iter().any(|entry| {
            entry.blocks.iter().any(|block| {
                matches!(
                    block,
                    TranscriptBlock::ResetMarker { reason }
                        if reason.contains("runtime_restore_reconciled_non_terminal_runs")
                )
            })
        }));
    }
}
