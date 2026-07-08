use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::runtime::RunRecord;

static TURN_COUNTER: AtomicU64 = AtomicU64::new(1);
static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(crate) fn next_turn_id() -> String {
    let n = TURN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("turn_{n}")
}

pub(crate) fn next_run_id() -> String {
    let n = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("run_{n}")
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

pub(crate) fn advance_runtime_counters(
    run_ledger: &[RunRecord],
    transcript: &[crate::session::TranscriptEntry],
) {
    let max_run_id = run_ledger
        .iter()
        .filter_map(|record| numeric_suffix(&record.run_id, "run_"))
        .chain(
            transcript
                .iter()
                .filter_map(|entry| numeric_suffix(&entry.run_id, "run_")),
        )
        .max()
        .unwrap_or_default();
    let max_turn_id = run_ledger
        .iter()
        .filter_map(|record| numeric_suffix(&record.turn_id, "turn_"))
        .chain(
            transcript
                .iter()
                .filter_map(|entry| numeric_suffix(&entry.turn_id, "turn_")),
        )
        .max()
        .unwrap_or_default();
    advance_counter(&RUN_COUNTER, max_run_id + 1);
    advance_counter(&TURN_COUNTER, max_turn_id + 1);
}

fn advance_counter(counter: &AtomicU64, next: u64) {
    let mut current = counter.load(Ordering::Relaxed);
    while current < next {
        match counter.compare_exchange(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

fn numeric_suffix(value: &str, prefix: &str) -> Option<u64> {
    value.strip_prefix(prefix)?.parse().ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use crate::behavior::BehaviorVersions;
    use crate::client::{ClientConfig, OpenAIClient};
    use crate::runtime::agent::{AgentConfig, AgentExecutor};
    use crate::runtime::store::{RuntimeStore, RuntimeStoreSnapshot};
    use crate::runtime::{AgentRuntime, InboxMode, RunRecord, RunRecordStatus, RunTurnRequest};
    use crate::session::{TranscriptBlock, TranscriptEntry, TranscriptRole};
    use crate::tools::ToolRegistry;

    pub(crate) fn temp_store(prefix: &str) -> RuntimeStore {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        RuntimeStore::new(std::env::temp_dir().join(format!("{prefix}-{now}")))
    }

    pub(crate) fn test_runtime(max_iterations: usize) -> AgentRuntime {
        AgentRuntime::from_agent(AgentExecutor::new(
            AgentConfig {
                max_iterations,
                ..AgentConfig::default()
            },
            OpenAIClient::new(ClientConfig {
                base_url: "https://example.invalid".to_string(),
                api_key: Some("test-key".to_string()),
                timeout: Duration::from_secs(1),
                max_context_length: 128_000,
            }),
            ToolRegistry::new(Duration::from_secs(1)),
        ))
    }

    pub(crate) fn run_record(run_id: &str, status: RunRecordStatus) -> RunRecord {
        RunRecord {
            run_id: run_id.to_string(),
            session_id: "session_1".to_string(),
            turn_id: run_id.replacen("run_", "turn_", 1),
            source: "prompt".to_string(),
            inbox_mode: InboxMode::Prompt,
            status,
            created_at_ms: 1,
            started_at_ms: None,
            completed_at_ms: None,
            error_code: None,
            error_message: None,
            blocked_reason: None,
            reconciled_reason: None,
        }
    }

    #[tokio::test]
    async fn counter_advances_from_restored_ids() {
        let store = temp_store("hermes-agent-runtime-counter-test");
        store
            .save_snapshot(&RuntimeStoreSnapshot {
                schema_version: crate::runtime::store::RUNTIME_STORE_SCHEMA_VERSION,
                session_id: "session_1".to_string(),
                cwd: PathBuf::from("/tmp/workspace"),
                transcript: vec![TranscriptEntry {
                    entry_id: "entry_1".to_string(),
                    parent_id: None,
                    turn_id: "turn_1000000".to_string(),
                    run_id: "run_1000000".to_string(),
                    role: TranscriptRole::User,
                    blocks: vec![TranscriptBlock::Text {
                        text: "hello".to_string(),
                    }],
                    created_at_ms: 1,
                }],
                run_ledger: vec![RunRecord {
                    run_id: "run_1000000".to_string(),
                    session_id: "session_1".to_string(),
                    turn_id: "turn_1000000".to_string(),
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
            })
            .expect("snapshot saved");
        let runtime = test_runtime(0).with_store(store);
        runtime.restore_from_store().await.expect("store restored");

        let completion = runtime
            .enqueue_input(
                InboxMode::Prompt,
                RunTurnRequest {
                    run_id: None,
                    session_id: "session_1".to_string(),
                    prompt: "next".to_string(),
                    cwd: PathBuf::from("."),
                    versions: BehaviorVersions::default(),
                    skills: Default::default(),
                },
            )
            .await
            .expect("enqueue succeeds");
        drop(completion);

        let ledger = runtime.run_ledger_snapshot().await;
        assert!(ledger.iter().any(|record| record.run_id == "run_1000001"));
        assert!(ledger.iter().any(|record| record.turn_id == "turn_1000001"));
    }
}
