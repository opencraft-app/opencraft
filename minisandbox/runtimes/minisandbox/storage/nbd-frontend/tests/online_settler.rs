//! Mounted-volume hot-watermark settlement integration tests.

use std::{thread, time::Duration};

use minisandbox_block_engine::BLOCK_SIZE;
use minisandbox_nbd_frontend::{OnlineSettlerConfig, SqliteBlockBackend};
use tempfile::TempDir;

const VOLUME_BYTES: u64 = 2 * 1024 * 1024;
const BLOCK_SIZE_USIZE: usize = 4 * 1024;
const HIGH_BLOCKS: u64 = 16;
const LOW_BLOCKS: u64 = 8;
const PACK_BLOCKS: u64 = 8;

#[test]
fn attached_backend_settles_oldest_live_versions_below_low_watermark() {
    let directory = TempDir::new().expect("online settler tempdir");
    let database = directory.path().join("blocks.db");
    let cos_root = directory.path().join("cos");
    let mut backend = SqliteBlockBackend::open(&database, &cos_root, "online-volume", VOLUME_BYTES)
        .expect("open online backend");
    backend
        .start_online_settler(OnlineSettlerConfig {
            high_watermark_bytes: HIGH_BLOCKS * BLOCK_SIZE,
            low_watermark_bytes: LOW_BLOCKS * BLOCK_SIZE,
            max_pack_bytes: PACK_BLOCKS * BLOCK_SIZE,
        })
        .expect("start online settler");

    for block_no in 0_u64..64 {
        let byte = u8::try_from(block_no + 1).expect("test byte fits");
        backend
            .write_at(block_no * BLOCK_SIZE, &vec![byte; BLOCK_SIZE_USIZE], false)
            .expect("foreground durable write");
    }

    let stats = wait_until_cold(&backend);
    assert!(stats.hot_payload_bytes <= LOW_BLOCKS * BLOCK_SIZE);
    assert!(stats.cold_locations >= 64 - LOW_BLOCKS);
    assert!(stats.packs > 0);
    assert_eq!(stats.active_settlement_rounds, 0);
    assert!(stats.completed_settlement_rounds >= 1);

    // The frontend remains attached and serves a mixture of cold and hot
    // versions while the worker owns no independent SQLite connection.
    for block_no in 0_u64..64 {
        let expected = u8::try_from(block_no + 1).expect("test byte fits");
        assert_eq!(
            backend
                .read_at(block_no * BLOCK_SIZE, BLOCK_SIZE_USIZE)
                .expect("read during online settlement"),
            vec![expected; BLOCK_SIZE_USIZE]
        );
    }
    backend
        .write_at(0, &vec![0xee; BLOCK_SIZE_USIZE], true)
        .expect("overwrite while online settler is active");

    let summary = backend
        .stop_online_settler(true)
        .expect("stop and drain online settler")
        .expect("online settler was configured");
    assert!(summary.passes > 0);
    assert!(summary.packs > 0);
    assert!(summary.final_hot_payload_bytes <= LOW_BLOCKS * BLOCK_SIZE);
    let final_stats = backend.repository_stats().expect("final round stats");
    assert_eq!(final_stats.active_settlement_rounds, 0);
    assert!(final_stats.completed_settlement_rounds >= 2);
    assert_eq!(
        backend
            .read_at(0, BLOCK_SIZE_USIZE)
            .expect("read foreground overwrite"),
        vec![0xee; BLOCK_SIZE_USIZE]
    );

    drop(backend);
    let mut reopened =
        SqliteBlockBackend::open(&database, &cos_root, "online-volume", VOLUME_BYTES)
            .expect("reopen online backend");
    for block_no in 0_u64..64 {
        let expected = if block_no == 0 {
            0xee
        } else {
            u8::try_from(block_no + 1).expect("test byte fits")
        };
        assert_eq!(
            reopened
                .read_at(block_no * BLOCK_SIZE, BLOCK_SIZE_USIZE)
                .expect("read after online-settler restart"),
            vec![expected; BLOCK_SIZE_USIZE]
        );
    }
}

fn wait_until_cold(backend: &SqliteBlockBackend) -> minisandbox_block_engine::RepositoryStats {
    for _ in 0..500 {
        let stats = backend.repository_stats().expect("online repository stats");
        if stats.hot_payload_bytes <= LOW_BLOCKS * BLOCK_SIZE
            && stats.cold_locations > 0
            && stats.active_settlement_rounds == 0
        {
            return stats;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("online settler did not reach its low watermark");
}
