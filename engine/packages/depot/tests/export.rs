mod common;

use std::sync::Arc;

use anyhow::Result;
use depot::{
	conveyer::{export::ExportLease, history_pin, keys},
	debug,
	keys::PAGE_SIZE,
	types::{DbHistoryPin, DbHistoryPinKind, DirtyPage, RestorePointId, SnapshotSelector},
};
use universaldb::utils::IsolationLevel::Snapshot;

fn page(pgno: u32, fill: u8) -> DirtyPage {
	DirtyPage {
		pgno,
		bytes: vec![fill; PAGE_SIZE as usize],
	}
}

#[tokio::test]
async fn export_leases_keep_an_exact_image_and_release_independently() -> Result<()> {
	common::test_matrix("depot-export-lease", |_tier, ctx| {
		Box::pin(async move {
			let udb = ctx.udb.clone();
			let db = Arc::new(ctx.db);
			db.commit(vec![page(1, 0x11)], 2, 1_000).await?;
			let branch_id = debug::dump_database_ancestry(&db).await?[0].0;

			let first = ExportLease::acquire(db.clone()).await?;
			let second = ExportLease::acquire(db.clone()).await?;
			assert_eq!(first.db_size_pages(), 2);
			assert_eq!(history_pin_count(&udb, branch_id).await?, 2);

			db.commit(vec![page(1, 0x22), page(2, 0x33)], 3, 2_000)
				.await?;
			let exported = first.read_pages(1, 2).await?;
			assert_eq!(exported[0].bytes, Some(vec![0x11; PAGE_SIZE as usize]));
			assert_eq!(exported[1].bytes, Some(vec![0; PAGE_SIZE as usize]));

			first.release().await?;
			assert_eq!(history_pin_count(&udb, branch_id).await?, 1);
			second.release().await?;
			assert_eq!(history_pin_count(&udb, branch_id).await?, 0);

			Ok(())
		})
	})
	.await
}

async fn history_pin_count(
	udb: &universaldb::Database,
	branch_id: depot::types::DatabaseBranchId,
) -> Result<usize> {
	udb.txn(
		"test_depot_export_history_pin_count",
		move |tx| async move { history_pin::read_indexed_pin_count(&tx, branch_id, Snapshot).await },
	)
	.await
}

#[tokio::test]
async fn acquiring_an_export_reaps_only_expired_internal_export_pins() -> Result<()> {
	common::test_matrix("depot-export-orphan-reaper", |_tier, ctx| {
		Box::pin(async move {
			let udb = ctx.udb.clone();
			let db = Arc::new(ctx.db);
			db.commit(vec![page(1, 0x44)], 1, 1_000).await?;
			let target = db.resolve_restore_target(SnapshotSelector::Latest).await?;
			let branch_id = target.database_branch_id;
			let old_export = DbHistoryPin {
				at_versionstamp: target.versionstamp,
				at_txid: target.txid,
				kind: DbHistoryPinKind::RestorePoint,
				owner_database_branch_id: None,
				owner_bucket_branch_id: None,
				owner_restore_point: None,
				created_at_ms: 0,
			};
			let user_restore_point = DbHistoryPin {
				owner_restore_point: Some(RestorePointId::format(1_000, target.txid)?),
				..old_export.clone()
			};
			udb.txn("test_seed_export_orphan", move |tx| {
				let old_export = old_export.clone();
				let user_restore_point = user_restore_point.clone();
				async move {
					history_pin::write_db_history_pin(
						&tx,
						branch_id,
						b"export/crashed-engine",
						old_export,
					)
					.await?;
					history_pin::write_db_history_pin(
						&tx,
						branch_id,
						b"restore_point/user",
						user_restore_point,
					)
					.await
				}
			})
			.await?;

			let lease = ExportLease::acquire(db).await?;
			assert_eq!(history_pin_count(&udb, branch_id).await?, 2);
			let user_key = keys::db_pin_key(branch_id, b"restore_point/user");
			let user_pin = udb
				.txn("test_read_user_restore_point", move |tx| {
					let user_key = user_key.clone();
					async move {
						tx.informal()
							.get(&user_key, Snapshot)
							.await
							.map_err(Into::into)
					}
				})
				.await?;
			assert!(user_pin.is_some());
			let orphan_key = keys::db_pin_key(branch_id, b"export/crashed-engine");
			let orphan_pin = udb
				.txn("test_read_export_orphan", move |tx| {
					let orphan_key = orphan_key.clone();
					async move {
						tx.informal()
							.get(&orphan_key, Snapshot)
							.await
							.map_err(Into::into)
					}
				})
				.await?;
			assert!(orphan_pin.is_none());
			lease.release().await?;
			assert_eq!(history_pin_count(&udb, branch_id).await?, 1);
			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn exported_bytes_are_a_standard_sqlite_database() -> Result<()> {
	common::test_matrix("depot-export-sqlite-image", |_tier, ctx| {
		Box::pin(async move {
			let source = tempfile::NamedTempFile::new()?;
			{
				let conn = rusqlite::Connection::open(source.path())?;
				conn.pragma_update(None, "page_size", PAGE_SIZE)?;
				conn.execute_batch(
					"CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
					 INSERT INTO messages(body) VALUES ('hello'), ('from actor');",
				)?;
			}
			let source_bytes = std::fs::read(source.path())?;
			assert_eq!(source_bytes.len() % PAGE_SIZE as usize, 0);
			let dirty_pages = source_bytes
				.chunks_exact(PAGE_SIZE as usize)
				.enumerate()
				.map(|(index, bytes)| DirtyPage {
					pgno: u32::try_from(index).expect("test page index fits u32") + 1,
					bytes: bytes.to_vec(),
				})
				.collect::<Vec<_>>();
			let page_count = u32::try_from(dirty_pages.len())?;
			let db = Arc::new(ctx.db);
			db.commit(dirty_pages, page_count, 1_000).await?;

			let lease = ExportLease::acquire(db).await?;
			let mut exported = Vec::new();
			let mut first_pgno = 1;
			while first_pgno <= lease.db_size_pages() {
				let last_pgno = first_pgno
					.saturating_add(depot::conveyer::export::EXPORT_PAGE_BATCH_SIZE - 1)
					.min(lease.db_size_pages());
				exported.extend_from_slice(&lease.read_chunk(first_pgno, last_pgno).await?);
				first_pgno = last_pgno.saturating_add(1);
			}
			lease.release().await?;
			assert_eq!(exported, source_bytes);

			let downloaded = tempfile::NamedTempFile::new()?;
			std::fs::write(downloaded.path(), exported)?;
			let conn = rusqlite::Connection::open(downloaded.path())?;
			let integrity: String =
				conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
			assert_eq!(integrity, "ok");
			let messages: i64 =
				conn.query_row("SELECT count(*) FROM messages", [], |row| row.get(0))?;
			assert_eq!(messages, 2);

			Ok(())
		})
	})
	.await
}
