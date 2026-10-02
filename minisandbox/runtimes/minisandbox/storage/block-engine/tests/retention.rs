//! Retry-window and concrete-reference retention tests.

use minisandbox_block_engine::{
    AcquireWriterOutcome, AcquireWriterRequest, BLOCK_SIZE, BlockData, BlockMetaRepository,
    BlockRepositoryConfig, BlockRepositoryError, CommitWriteRequest, FlushRequest,
};
use tempfile::TempDir;

#[cfg(all(unix, feature = "fault-injection"))]
use std::{
    fs,
    os::unix::process::ExitStatusExt,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const TWO_GIB: u64 = 2 * 1024 * 1024 * 1024;

fn write(
    volume_id: &str,
    writer_epoch: u64,
    op_id: &str,
    block_no: u64,
    byte: u8,
) -> CommitWriteRequest {
    CommitWriteRequest {
        volume_id: volume_id.to_owned(),
        writer_epoch,
        op_id: op_id.to_owned(),
        block_no,
        bytes: vec![byte; usize::try_from(BLOCK_SIZE).expect("block size")],
    }
}

#[test]
fn closed_writer_epoch_compacts_results_barriers_and_dead_versions() {
    let directory = TempDir::new().expect("retention tempdir");
    let database = directory.path().join("blocks.db");
    let repository =
        BlockMetaRepository::open(BlockRepositoryConfig::new(&database)).expect("open repository");
    repository
        .create_volume("retained", TWO_GIB)
        .expect("create volume");
    let old = repository
        .commit_write(write("retained", 1, "old", 7, 0x11))
        .expect("write old version");
    let current = repository
        .commit_write(write("retained", 1, "current", 7, 0x22))
        .expect("overwrite version");
    repository
        .capture_flush(FlushRequest {
            volume_id: "retained".to_owned(),
            writer_epoch: 1,
            op_id: "flush".to_owned(),
            submitted_sequence: current.commit_version,
        })
        .expect("capture barrier");

    assert!(matches!(
        repository.close_writer_retry_window("retained", 1),
        Err(BlockRepositoryError::InvalidArgument(_))
    ));
    let rotated = repository
        .acquire_writer(AcquireWriterRequest {
            volume_id: "retained".to_owned(),
            expected_epoch: 1,
            op_id: "rotate".to_owned(),
        })
        .expect("rotate writer");
    assert!(matches!(
        rotated.outcome,
        AcquireWriterOutcome::Acquired { new_epoch: 2 }
    ));
    assert_eq!(
        repository
            .close_writer_retry_window("retained", 1)
            .expect("close retry window"),
        1
    );

    let compacted = repository
        .compact_retained_history(128)
        .expect("compact retained history");
    assert_eq!(compacted.operation_results, 4);
    assert_eq!(compacted.flush_barriers, 1);
    assert_eq!(compacted.delta_heads, 0);
    assert_eq!(compacted.versions, 1);
    let stats = repository.stats().expect("compacted stats");
    assert_eq!(stats.operation_results, 0);
    assert_eq!(stats.flush_barriers, 0);
    assert_eq!(stats.versions, 1);
    assert_eq!(stats.delta_heads, 1);
    assert!(matches!(
        repository.commit_write(write("retained", 1, "old", 7, 0x11)),
        Err(BlockRepositoryError::RetryWindowClosed)
    ));
    assert!(matches!(
        repository
            .read_block_head("retained", 7)
            .expect("read current version"),
        BlockData::Version { hot_bytes: Some(bytes), .. }
            if bytes == vec![0x22; usize::try_from(BLOCK_SIZE).expect("block size")]
    ));
    assert_ne!(old.commit_version, current.commit_version);

    drop(repository);
    let reopened = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
        .expect("reopen compacted repository");
    assert_eq!(
        reopened
            .compact_retained_history(128)
            .expect("repeat compaction"),
        minisandbox_block_engine::RetentionCompactionResult {
            operation_results: 0,
            flush_barriers: 0,
            delta_heads: 0,
            versions: 0,
            pack_intents: 0,
            settlement_rounds: 0,
        }
    );
}

#[test]
fn compaction_preserves_snapshot_and_current_delta_references() {
    let directory = TempDir::new().expect("snapshot retention tempdir");
    let database = directory.path().join("blocks.db");
    let repository =
        BlockMetaRepository::open(BlockRepositoryConfig::new(&database)).expect("open repository");
    repository
        .create_volume("parent", TWO_GIB)
        .expect("create parent");
    repository
        .commit_write(write("parent", 1, "base", 9, 0x31))
        .expect("write base");
    let snapshot = repository
        .create_snapshot("parent", "pinned")
        .expect("pin snapshot");
    repository
        .commit_write(write(
            "parent",
            snapshot.source_writer_epoch,
            "diverge",
            9,
            0x42,
        ))
        .expect("write divergence");
    repository
        .acquire_writer(AcquireWriterRequest {
            volume_id: "parent".to_owned(),
            expected_epoch: snapshot.source_writer_epoch,
            op_id: "rotate-parent".to_owned(),
        })
        .expect("rotate parent");
    repository
        .close_writer_retry_window("parent", snapshot.source_writer_epoch)
        .expect("close parent retries");
    let compacted = repository
        .compact_retained_history(128)
        .expect("compact live roots");
    assert_eq!(compacted.versions, 0);
    assert_eq!(compacted.delta_heads, 0);
    let stats = repository.stats().expect("live root stats");
    assert_eq!(stats.versions, 2);
    assert_eq!(stats.delta_heads, 2);

    repository
        .fork_snapshot("pinned", "child")
        .expect("fork retained snapshot");
    assert!(matches!(
        repository
            .read_block_head("child", 9)
            .expect("read retained snapshot"),
        BlockData::Version { hot_bytes: Some(bytes), .. }
            if bytes == vec![0x31; usize::try_from(BLOCK_SIZE).expect("block size")]
    ));
}

#[test]
fn completed_pack_workflow_compacts_only_after_settler_retry_closure() {
    let directory = TempDir::new().expect("settler retention tempdir");
    let database = directory.path().join("blocks.db");
    let repository =
        BlockMetaRepository::open(BlockRepositoryConfig::new(&database)).expect("open repository");
    repository
        .create_volume("cold", TWO_GIB)
        .expect("create volume");
    repository
        .commit_write(write("cold", 1, "cold-write", 3, 0x7a))
        .expect("write cold candidate");

    let generation_one = repository
        .acquire_settler()
        .expect("settler generation one");
    let intent = repository
        .resume_or_prepare_pack(generation_one, BLOCK_SIZE)
        .expect("prepare pack")
        .expect("pack intent");
    repository
        .verify_pack_intent(generation_one, intent.intent_id)
        .expect("verify intent");
    repository
        .publish_pack_intent(generation_one, intent.intent_id)
        .expect("publish intent");
    repository
        .evict_pack_intent_members(generation_one, intent.intent_id, intent.members.clone())
        .expect("evict hot members");
    repository
        .complete_pack_intent(generation_one, intent.intent_id)
        .expect("complete intent");

    let before_close = repository
        .compact_retained_history(128)
        .expect("compact before close");
    assert_eq!(before_close.pack_intents, 0);
    assert_eq!(before_close.settlement_rounds, 0);
    let retained = repository.stats().expect("retained maintenance stats");
    assert_eq!(retained.completed_pack_intents, 1);
    assert_eq!(retained.completed_settlement_rounds, 1);

    let generation_two = repository
        .acquire_settler()
        .expect("settler generation two");
    assert!(generation_two > generation_one);
    repository
        .close_settler_retry_window(generation_one)
        .expect("close settler retries");
    let compacted = repository
        .compact_retained_history(128)
        .expect("compact completed maintenance");
    assert_eq!(compacted.pack_intents, 1);
    assert_eq!(compacted.settlement_rounds, 1);
    let stats = repository.stats().expect("compacted maintenance stats");
    assert_eq!(stats.completed_pack_intents, 0);
    assert_eq!(stats.completed_settlement_rounds, 0);
    assert!(matches!(
        repository
            .read_block_head("cold", 3)
            .expect("read cold metadata after maintenance compaction"),
        BlockData::Version {
            hot_bytes: None,
            cold: Some(_),
            ..
        }
    ));
}

#[cfg(all(unix, feature = "fault-injection"))]
#[test]
fn sigkill_retention_boundaries_are_atomic_and_restartable() {
    for (point, committed_before_kill) in [
        ("before-retention-commit", false),
        ("during-retention-commit", false),
        ("after-retention-commit", true),
    ] {
        let directory = TempDir::new().expect("retention crash tempdir");
        let database = directory.path().join("blocks.db");
        let marker = directory.path().join("stopped.marker");
        let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
            .expect("open retention crash repository");
        repository
            .create_volume("crash-volume", TWO_GIB)
            .expect("create crash volume");
        repository
            .commit_write(write("crash-volume", 1, "retained-write", 13, 0x9a))
            .expect("write retained data");
        repository
            .acquire_writer(AcquireWriterRequest {
                volume_id: "crash-volume".to_owned(),
                expected_epoch: 1,
                op_id: "retained-rotate".to_owned(),
            })
            .expect("rotate retained writer");
        repository
            .close_writer_retry_window("crash-volume", 1)
            .expect("close retained writer retries");
        assert_eq!(
            repository
                .stats()
                .expect("pre-crash stats")
                .operation_results,
            2
        );
        drop(repository);

        let mut child = Command::new(env!("CARGO_BIN_EXE_minisandbox-block-crash-probe"))
            .arg(&database)
            .arg(&marker)
            .arg(point)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn retention crash probe");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(Instant::now() < deadline, "probe timeout at {point}");
            assert!(
                child.try_wait().expect("poll crash probe").is_none(),
                "probe exited before marker at {point}"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!fs::read(&marker).expect("read marker").is_empty());
        let kill_status = unsafe { libc::kill(child.id().cast_signed(), libc::SIGKILL) };
        assert_eq!(kill_status, 0, "kill stopped child at {point}");
        let status = child.wait().expect("wait killed child");
        assert_eq!(status.signal(), Some(libc::SIGKILL), "crash point {point}");

        let repository = BlockMetaRepository::open(BlockRepositoryConfig::new(&database))
            .expect("reopen retention crash repository");
        assert_eq!(
            repository
                .stats()
                .expect("post-crash stats")
                .operation_results,
            if committed_before_kill { 0 } else { 2 },
            "unexpected retention outcome at {point}"
        );
        repository
            .compact_retained_history(128)
            .expect("retry retention compaction");
        assert_eq!(
            repository.stats().expect("final stats").operation_results,
            0
        );
        assert!(matches!(
            repository
                .read_block_head("crash-volume", 13)
                .expect("read retained data after crash"),
            BlockData::Version { hot_bytes: Some(bytes), .. }
                if bytes == vec![0x9a; usize::try_from(BLOCK_SIZE).expect("block size")]
        ));
    }
}
