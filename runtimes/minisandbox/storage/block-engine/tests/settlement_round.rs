//! Durable settlement-round cutoff and recovery tests.

use minisandbox_block_engine::{
    BLOCK_SIZE, BlockMetaRepository, BlockRepositoryConfig, CommitWriteRequest, PackIntent,
};
use tempfile::TempDir;

const VOLUME_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[test]
fn restart_preserves_round_cutoff_budget_and_exact_inflight_pack() {
    let directory = TempDir::new().expect("settlement round tempdir");
    let database = directory.path().join("blocks.db");
    let repository = open(&database);
    repository
        .create_volume("round-volume", VOLUME_BYTES)
        .expect("create round volume");
    for block_no in 0_u64..4 {
        let byte = u8::try_from(block_no).expect("test block fits u8") + 1;
        write(&repository, block_no, byte, "before");
    }

    let generation_one = repository.acquire_settler().expect("first generation");
    let first = repository
        .resume_or_prepare_pack_to_low(generation_one, BLOCK_SIZE, 2 * BLOCK_SIZE)
        .expect("capture first round")
        .expect("first round pack");
    assert_eq!(first.members.len(), 1);

    // This write is serialized after round capture. Recovery is deliberately
    // called with a different low watermark; neither action may move the old
    // round's cutoff or target budget.
    write(&repository, 4, 0xee, "after-cutoff");
    drop(repository);

    let repository = open(&database);
    let generation_two = repository.acquire_settler().expect("second generation");
    let resumed = repository
        .resume_or_prepare_pack_to_low(generation_two, BLOCK_SIZE, 0)
        .expect("resume prepared pack")
        .expect("durable prepared pack");
    assert_eq!(resumed.intent_id, first.intent_id);
    assert_eq!(resumed.round_id, first.round_id);
    assert_eq!(resumed.members, first.members);
    complete(&repository, generation_two, &resumed);
    drop(repository);

    let repository = open(&database);
    let generation_three = repository.acquire_settler().expect("third generation");
    let second = repository
        .resume_or_prepare_pack_to_low(generation_three, BLOCK_SIZE, 0)
        .expect("continue captured round")
        .expect("second captured pack");
    assert_eq!(second.round_id, first.round_id);
    assert_eq!(second.members.len(), 1);
    assert_ne!(second.members[0].block_no, 4, "post-cutoff write leaked");
    complete(&repository, generation_three, &second);

    let stats = repository.stats().expect("completed round stats");
    assert_eq!(stats.active_settlement_rounds, 0);
    assert_eq!(stats.completed_settlement_rounds, 1);
    assert_eq!(stats.completed_pack_intents, 2);
    assert_eq!(stats.cold_locations, 2);
    assert_eq!(stats.hot_payload_bytes, 3 * BLOCK_SIZE);
}

fn open(path: &std::path::Path) -> BlockMetaRepository {
    BlockMetaRepository::open(BlockRepositoryConfig::new(path)).expect("open repository")
}

fn write(repository: &BlockMetaRepository, block_no: u64, byte: u8, op_prefix: &str) {
    repository
        .commit_write(CommitWriteRequest {
            volume_id: "round-volume".to_owned(),
            writer_epoch: 1,
            op_id: format!("{op_prefix}-{block_no}"),
            block_no,
            bytes: vec![byte; usize::try_from(BLOCK_SIZE).expect("block size fits usize")],
        })
        .expect("commit round write");
}

fn complete(repository: &BlockMetaRepository, generation: u64, intent: &PackIntent) {
    repository
        .verify_pack_intent(generation, intent.intent_id)
        .expect("verify exact pack intent");
    repository
        .publish_pack_intent(generation, intent.intent_id)
        .expect("publish exact pack intent");
    assert_eq!(
        repository
            .evict_pack_intent_members(generation, intent.intent_id, intent.members.clone())
            .expect("evict exact pack members"),
        1
    );
    repository
        .complete_pack_intent(generation, intent.intent_id)
        .expect("complete exact pack intent");
}
