//! Reproducible structured concurrency fuzzing for the shared `SQLite` writer.
//!
//! This is intentionally an ordinary test rather than a coverage-guided fuzz
//! target so the exact interleaving pressure remains part of every CI run.

use std::sync::{Arc, Barrier};

use minisandbox_block_backend::SqliteBlockBackendFactory;
use tempfile::tempdir;

const ROOT_SEED: u64 = 0x6d69_6e69_7361_6e64;
const VOLUMES: usize = 32;
const ACTIONS_PER_VOLUME: usize = 128;
const BLOCK_BYTES: usize = 4 * 1024;
const VOLUME_BYTES: usize = 64 * BLOCK_BYTES;

#[derive(Clone, Copy)]
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value
    }

    fn bounded(&mut self, upper: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(upper).unwrap()).unwrap()
    }
}

fn random_range(rng: &mut Rng) -> (usize, usize) {
    const LENGTHS: [usize; 8] = [1, 31, 511, 4096, 4097, 8192, 12_288, 16_384];
    let length = LENGTHS[rng.bounded(LENGTHS.len())];
    let mut offset = rng.bounded(VOLUME_BYTES - length + 1);
    if rng.next().is_multiple_of(2) {
        offset = offset / BLOCK_BYTES * BLOCK_BYTES;
    }
    (offset, length)
}

fn payload(rng: &mut Rng, length: usize) -> Vec<u8> {
    let base = u8::try_from(rng.next() & 0xff).unwrap();
    (0..length)
        .map(|index| base.wrapping_add(u8::try_from(index % 251).unwrap().wrapping_mul(17)))
        .collect()
}

#[test]
#[allow(clippy::too_many_lines)]
fn deterministic_shared_writer_fuzzes_4096_concurrent_actions() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("blocks.db");
    let cos_root = directory.path().join("cos");
    let factory = SqliteBlockBackendFactory::open(&database, &cos_root).unwrap();
    let start = Arc::new(Barrier::new(VOLUMES));

    let backends = (0..VOLUMES)
        .map(|volume| {
            let volume_id = format!("fuzz-source-{volume}");
            let backend = factory
                .open_volume(&volume_id, u64::try_from(VOLUME_BYTES).unwrap())
                .unwrap();
            (volume, volume_id, backend)
        })
        .collect::<Vec<_>>();

    let workers = backends
        .into_iter()
        .map(|(volume, volume_id, mut backend)| {
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                let mut rng = Rng(
                    ROOT_SEED
                        ^ u64::try_from(volume + 1)
                            .unwrap()
                            .wrapping_mul(0x9e37_79b9_7f4a_7c15),
                );
                let mut oracle = vec![0_u8; VOLUME_BYTES];
                start.wait();

                for action in 0..ACTIONS_PER_VOLUME {
                    let selector = rng.bounded(100);
                    if selector < 48 {
                        let (offset, length) = random_range(&mut rng);
                        let bytes = payload(&mut rng, length);
                        let fua = rng.next().is_multiple_of(4);
                        backend
                            .write_at(u64::try_from(offset).unwrap(), &bytes, fua)
                            .unwrap_or_else(|error| {
                                panic!(
                                    "seed={ROOT_SEED:#x} volume={volume} action={action} write: {error}"
                                )
                            });
                        oracle[offset..offset + length].copy_from_slice(&bytes);
                    } else if selector < 68 {
                        let (offset, length) = random_range(&mut rng);
                        let fua = rng.next().is_multiple_of(4);
                        backend
                            .trim(u64::try_from(offset).unwrap(), length, fua)
                            .unwrap_or_else(|error| {
                                panic!(
                                    "seed={ROOT_SEED:#x} volume={volume} action={action} trim: {error}"
                                )
                            });
                        oracle[offset..offset + length].fill(0);
                    } else if selector < 88 {
                        let (offset, length) = random_range(&mut rng);
                        let actual = backend
                            .read_at(u64::try_from(offset).unwrap(), length)
                            .unwrap_or_else(|error| {
                                panic!(
                                    "seed={ROOT_SEED:#x} volume={volume} action={action} read: {error}"
                                )
                            });
                        assert_eq!(
                            actual,
                            oracle[offset..offset + length],
                            "seed={ROOT_SEED:#x} volume={volume} action={action} read mismatch"
                        );
                    } else {
                        backend.flush().unwrap_or_else(|error| {
                            panic!(
                                "seed={ROOT_SEED:#x} volume={volume} action={action} flush: {error}"
                            )
                        });
                    }
                }

                backend.flush().unwrap();
                assert_eq!(
                    backend.read_at(0, VOLUME_BYTES).unwrap(),
                    oracle,
                    "seed={ROOT_SEED:#x} volume={volume} final image mismatch"
                );
                (volume, volume_id, oracle)
            })
        })
        .collect::<Vec<_>>();

    let completed = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();

    // Concurrent lifecycle traffic uses the same actor: seal every source,
    // fork it, release the pin, verify COW isolation, then retire both roots.
    let lifecycle_start = Arc::new(Barrier::new(VOLUMES));
    let lifecycle_workers = completed
        .into_iter()
        .map(|(volume, source_id, oracle)| {
            let factory = factory.clone();
            let lifecycle_start = Arc::clone(&lifecycle_start);
            std::thread::spawn(move || {
                let snapshot_id = format!("fuzz-snapshot-{volume}");
                let child_id = format!("fuzz-child-{volume}");
                lifecycle_start.wait();

                factory.snapshot_volume(&source_id, &snapshot_id).unwrap();
                factory.fork_snapshot(&snapshot_id, &child_id).unwrap();
                factory.delete_snapshot(&snapshot_id).unwrap();

                let mut child = factory
                    .open_volume(&child_id, u64::try_from(VOLUME_BYTES).unwrap())
                    .unwrap();
                assert_eq!(child.read_at(0, VOLUME_BYTES).unwrap(), oracle);
                let child_byte = u8::try_from(volume).unwrap().wrapping_add(1);
                child.write_at(0, &[child_byte; BLOCK_BYTES], true).unwrap();

                let mut source = factory
                    .open_volume(&source_id, u64::try_from(VOLUME_BYTES).unwrap())
                    .unwrap();
                assert_eq!(
                    source.read_at(0, VOLUME_BYTES).unwrap(),
                    oracle,
                    "volume={volume} child write leaked into source"
                );
                drop(child);
                drop(source);

                factory
                    .delete_volume(&child_id, &format!("fuzz-delete-child-{volume}"))
                    .unwrap();
                factory
                    .delete_volume(&source_id, &format!("fuzz-delete-source-{volume}"))
                    .unwrap();
            })
        })
        .collect::<Vec<_>>();

    for worker in lifecycle_workers {
        worker.join().unwrap();
    }
}
