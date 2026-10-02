mod common;

use std::sync::Arc;

use anyhow::{Context, Result};
use depot::{
	cold_tier::{ColdTier, FilesystemColdTier, materialize_cold_shard},
	conveyer::{Db, error::SqliteStorageError, shard_blob::write_branch_shard_blob},
	debug,
	keys::{
		PAGE_SIZE, branch_commit_key, branch_compaction_cold_publish_key,
		branch_compaction_cold_shard_key, branch_compaction_root_key, branch_delta_prefix,
		branch_page_history_key, branches_list_key,
	},
	ltx::{LtxHeader, encode_ltx_v3},
	types::{
		ColdPublishMarker, CompactionRoot, DatabaseBranchId, DirtyPage, decode_commit_row,
		decode_database_branch_record, encode_cold_publish_marker, encode_cold_shard_ref,
		encode_compaction_root,
	},
};
use gas::prelude::Id;
use rivet_pools::NodeId;
use sha2::{Digest, Sha256};
use universaldb::utils::IsolationLevel::Snapshot;

fn page(pgno: u32, fill: u8) -> DirtyPage {
	DirtyPage {
		pgno,
		bytes: vec![fill; PAGE_SIZE as usize],
	}
}

fn incompressible_page(seed: u64) -> Vec<u8> {
	let mut page = Vec::with_capacity(PAGE_SIZE as usize);
	for block in 0_u64..u64::from(PAGE_SIZE) / 32 {
		let mut hash = Sha256::new();
		hash.update(seed.to_be_bytes());
		hash.update(block.to_be_bytes());
		page.extend_from_slice(&hash.finalize());
	}
	page
}

async fn commit_row(
	db: &universaldb::Database,
	branch_id: DatabaseBranchId,
	txid: u64,
) -> Result<depot::types::CommitRow> {
	db.txn("test_depotdebug", move |tx| async move {
		let bytes = tx
			.informal()
			.get(&branch_commit_key(branch_id, txid), Snapshot)
			.await?
			.expect("commit row should exist");

		decode_commit_row(&bytes)
	})
	.await
}

#[tokio::test]
async fn debug_dumps_ancestry_pins_restore_points_and_gc_pin() -> Result<()> {
	common::test_matrix("depot-debug-ancestry", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let database_db = ctx.db;

			database_db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id = debug::dump_database_ancestry(&database_db).await?[0].0;
			let first_commit = commit_row(&db, branch_id, 1).await?;
			let pinned = database_db
				.create_restore_point(depot::types::SnapshotSelector::Latest)
				.await?;
			database_db.commit(vec![page(2, 0x22)], 3, 2_000).await?;

			let ancestry = debug::dump_database_ancestry(&database_db).await?;
			assert_eq!(ancestry, vec![(branch_id, None)]);

			let pins = debug::dump_branch_pins(&database_db).await?;
			assert_eq!(pins.branch_id, branch_id);
			assert_eq!(pins.refcount, 1);
			assert_eq!(pins.restore_point_pin, first_commit.versionstamp);

			let restore_points = debug::list_restore_points(&database_db).await?;
			assert!(restore_points.iter().any(|entry| {
				entry.restore_point_id == pinned
					&& entry.pin_status == depot::types::PinStatus::Ready
			}));

			assert_eq!(
				debug::estimate_gc_pin(&database_db).await?,
				first_commit.versionstamp
			);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn debug_read_at_returns_page_state_for_versionstamp() -> Result<()> {
	common::test_matrix("depot-debug-read-at", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let database_db = ctx.db;

			database_db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id = debug::dump_database_ancestry(&database_db).await?[0].0;
			let first_commit = commit_row(&db, branch_id, 1).await?;
			database_db
				.commit(vec![page(1, 0x22), page(2, 0x33)], 3, 2_000)
				.await?;
			let second_commit = commit_row(&db, branch_id, 2).await?;

			let first_state = debug::read_at(&database_db, first_commit.versionstamp).await?;
			assert_eq!(first_state.txid, 1);
			assert_eq!(first_state.db_size_pages, 2);
			assert_eq!(
				first_state.pages[0].bytes.as_deref(),
				Some(&vec![0x11; PAGE_SIZE as usize][..])
			);
			assert_eq!(
				first_state.pages[1].bytes.as_deref(),
				Some(&vec![0; PAGE_SIZE as usize][..])
			);

			let second_state = debug::read_at(&database_db, second_commit.versionstamp).await?;
			assert_eq!(second_state.txid, 2);
			assert_eq!(second_state.db_size_pages, 3);
			assert_eq!(
				second_state.pages[0].bytes.as_deref(),
				Some(&vec![0x22; PAGE_SIZE as usize][..])
			);
			assert_eq!(
				second_state.pages[1].bytes.as_deref(),
				Some(&vec![0x33; PAGE_SIZE as usize][..])
			);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn debug_read_at_uses_exact_page_history_not_a_branch_delta_scan() -> Result<()> {
	common::test_matrix("depot-debug-read-at-no-delta-scan", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let database_db = ctx.db;

			database_db.commit(vec![page(1, 0x5a)], 1, 1_000).await?;
			let branch_id = debug::dump_database_ancestry(&database_db).await?[0].0;
			let first_commit = commit_row(&db, branch_id, 1).await?;

			// This malformed row is branch-local DELTA noise but is outside the exact target txid
			// prefix. A regression to a branch-wide DELTA scan will try to decode it and fail.
			db.txn(
				"test_depotdebug_seed_unrelated_delta_noise",
				move |tx| async move {
					let mut malformed = branch_delta_prefix(branch_id);
					malformed.push(0x01);
					tx.informal().set(&malformed, b"unrelated");
					Ok(())
				},
			)
			.await?;

			let state = debug::read_at(&database_db, first_commit.versionstamp).await?;
			assert_eq!(state.pages.len(), 1);
			assert_eq!(state.pages[0].bytes, Some(vec![0x5a; PAGE_SIZE as usize]));
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn debug_read_at_resolves_chunked_hot_shard_manifests() -> Result<()> {
	common::test_matrix("depot-debug-read-at-chunked-shard", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let database_db = ctx.db;

			database_db
				.commit(
					vec![DirtyPage {
						pgno: 1,
						bytes: incompressible_page(1),
					}],
					63,
					1_000,
				)
				.await?;
			let branch_id = debug::dump_database_ancestry(&database_db).await?[0].0;
			let first_commit = commit_row(&db, branch_id, 1).await?;
			let pages = (1..=63)
				.map(|pgno| DirtyPage {
					pgno,
					bytes: incompressible_page(u64::from(pgno)),
				})
				.collect::<Vec<_>>();
			let blob = encode_ltx_v3(LtxHeader::delta(1, 63, 1_000), &pages)?;
			db.txn("test_depotdebug_seed_chunked_shard", move |tx| {
				let blob = blob.clone();
				async move {
					let delta_prefix = branch_delta_prefix(branch_id);
					let (begin, end) = universaldb::utils::range_for_prefix(&delta_prefix);
					tx.informal().clear_range(&begin, &end);
					// Reclaimer removes exact per-page history rows in the same atomic batch as
					// their DELTA. Keep this hand-built shard fixture consistent with that invariant.
					for pgno in 1..=63 {
						tx.informal()
							.clear(&branch_page_history_key(branch_id, pgno, 1));
					}
					write_branch_shard_blob(&tx, branch_id, 0, 1, &blob)
				}
			})
			.await?;

			let state = debug::read_at(&database_db, first_commit.versionstamp).await?;
			assert_eq!(state.pages[0].bytes, Some(incompressible_page(1)));
			assert_eq!(state.pages[62].bytes, Some(incompressible_page(63)));

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn debug_read_at_hydrates_exact_cold_object_and_never_silently_zero_fills_failures()
-> Result<()> {
	common::test_matrix("depot-debug-read-at-cold", |_tier, ctx| {
		Box::pin(async move {
			let udb = ctx.udb.clone();
			let database_db = ctx.db;
			database_db.commit(vec![page(1, 0x6a)], 1, 1_000).await?;
			let branch_id = debug::dump_database_ancestry(&database_db).await?[0].0;
			let commit = commit_row(&udb, branch_id, 1).await?;
			let branch_record = udb
				.txn(
					"test_depotdebug_read_branch_lifecycle",
					move |tx| async move {
						let bytes = tx
							.informal()
							.get(&branches_list_key(branch_id), Snapshot)
							.await?
							.context("branch record should exist")?;
						decode_database_branch_record(&bytes)
					},
				)
				.await?;

			let ltx = encode_ltx_v3(LtxHeader::delta(1, 1, 1_000), &[page(1, 0x6a)])?;
			let object_generation_id = Id::new_v1(1);
			let (reference, object_bytes) = materialize_cold_shard(
				branch_id,
				object_generation_id,
				0,
				1,
				1,
				1,
				commit.versionstamp,
				commit.versionstamp,
				branch_record.lifecycle_generation,
				1,
				ltx,
			)?;
			let marker = ColdPublishMarker {
				database_branch_id: branch_id,
				object_generation_id,
				lifecycle_generation: branch_record.lifecycle_generation,
				publish_generation: 1,
				input_fingerprint: [0x11; 32],
				output_ref_count: 1,
				output_refs_hash: [0x22; 32],
				min_txid: 1,
				max_txid: 1,
				min_versionstamp: commit.versionstamp,
				max_versionstamp: commit.versionstamp,
			};
			let root = CompactionRoot {
				schema_version: 1,
				manifest_generation: 1,
				hot_watermark_txid: 1,
				cold_watermark_txid: 1,
				cold_watermark_versionstamp: commit.versionstamp,
			};
			let reference_for_tx = reference.clone();
			udb.txn("test_depotdebug_publish_cold_only_shard", move |tx| {
				let reference = reference_for_tx.clone();
				let marker = marker.clone();
				let root = root.clone();
				async move {
					tx.informal().set(
						&branch_compaction_cold_shard_key(branch_id, 0, 1),
						&encode_cold_shard_ref(reference)?,
					);
					tx.informal().set(
						&branch_compaction_cold_publish_key(branch_id, 1),
						&encode_cold_publish_marker(marker)?,
					);
					tx.informal().set(
						&branch_compaction_root_key(branch_id),
						&encode_compaction_root(root)?,
					);
					let delta_prefix = branch_delta_prefix(branch_id);
					let (delta_begin, delta_end) =
						universaldb::utils::range_for_prefix(&delta_prefix);
					tx.informal().clear_range(&delta_begin, &delta_end);
					tx.informal()
						.clear(&branch_page_history_key(branch_id, 1, 1));
					Ok(())
				}
			})
			.await?;

			let unavailable = debug::read_at(&database_db, commit.versionstamp)
				.await
				.expect_err("an unconfigured cold tier must not synthesize a zero page");
			assert!(matches!(
				unavailable.downcast_ref::<SqliteStorageError>(),
				Some(SqliteStorageError::ColdObjectUnavailable { .. })
			));

			let cold_root = tempfile::tempdir()?;
			let cold_tier = Arc::new(FilesystemColdTier::new_bounded(
				cold_root.path(),
				4 * 1024 * 1024,
				2,
			)?);
			cold_tier
				.put_object(&reference.object_key, &object_bytes)
				.await?;
			let cold_db = Db::new_with_cold_tier(
				udb,
				ctx.bucket_id,
				ctx.database_id,
				NodeId::new(),
				cold_tier.clone(),
			);
			let state = debug::read_at(&cold_db, commit.versionstamp).await?;
			assert_eq!(state.pages[0].bytes, Some(vec![0x6a; PAGE_SIZE as usize]));

			cold_tier
				.delete_objects(std::slice::from_ref(&reference.object_key))
				.await?;
			let missing = debug::read_at(&cold_db, commit.versionstamp)
				.await
				.expect_err("a missing published cold object must fail closed");
			assert!(matches!(
				missing.downcast_ref::<SqliteStorageError>(),
				Some(SqliteStorageError::ColdObjectUnavailable { .. })
			));

			Ok(())
		})
	})
	.await
}
