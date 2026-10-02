//! SQLite/COS-backed sector translation, durability, and restart tests.

use minisandbox_nbd_frontend::SqliteBlockBackend;
use tempfile::TempDir;

const TWO_GIB: u64 = 2 * 1024 * 1024 * 1024;

#[test]
fn sector_rmw_fua_restart_and_cold_settlement_preserve_bytes() {
    let directory = TempDir::new().expect("backend tempdir");
    let database = directory.path().join("blocks.db");
    let cos_root = directory.path().join("cos");
    let mut backend =
        SqliteBlockBackend::open(&database, &cos_root, "nbd-test", TWO_GIB).expect("open backend");
    let first_epoch = backend.writer_epoch();

    backend
        .write_at(512, &vec![0xa5; 512], true)
        .expect("sector FUA write");
    backend
        .write_at(3584, &vec![0x6d; 1024], false)
        .expect("cross-block RMW write");
    backend.flush().expect("explicit flush");

    let first_block = backend.read_at(0, 4096).expect("read first block");
    assert_eq!(&first_block[0..512], &[0; 512]);
    assert_eq!(&first_block[512..1024], &[0xa5; 512]);
    assert_eq!(&first_block[3584..4096], &[0x6d; 512]);
    assert_eq!(
        backend.read_at(4096, 512).expect("read second block"),
        vec![0x6d; 512]
    );

    backend
        .trim(3584, 4608, true)
        .expect("partial edge plus full-block versioned trim");
    assert_eq!(
        backend.read_at(512, 512).expect("read before trim edge"),
        vec![0xa5; 512]
    );
    assert_eq!(
        backend.read_at(3584, 4608).expect("read trimmed range"),
        vec![0; 4608]
    );

    let passes = backend.settle_all(64).expect("settle to emulator");
    assert!(passes > 0);
    drop(backend);

    let mut reopened = SqliteBlockBackend::open(&database, &cos_root, "nbd-test", TWO_GIB)
        .expect("reopen backend");
    assert!(reopened.writer_epoch() > first_epoch);
    assert_eq!(
        reopened.read_at(512, 512).expect("read cold sector"),
        vec![0xa5; 512]
    );
    assert_eq!(
        reopened
            .read_at(3584, 512)
            .expect("read restarted trimmed edge"),
        vec![0; 512]
    );
    assert_eq!(
        reopened.read_at(4096, 512).expect("read cold zero sector"),
        vec![0; 512]
    );
}
