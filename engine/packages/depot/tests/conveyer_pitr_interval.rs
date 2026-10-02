mod common;

use anyhow::Result;
use depot::{
	keys,
	pitr_interval::{
		read_latest_pitr_interval_coverage_at_or_before, read_pitr_interval_coverage,
		scan_pitr_interval_coverage_page, write_pitr_interval_coverage,
	},
	types::{DatabaseBranchId, PitrIntervalCoverage},
};
use universaldb::utils::IsolationLevel::Snapshot;
use uuid::Uuid;

fn branch_id() -> DatabaseBranchId {
	DatabaseBranchId::from_uuid(Uuid::from_u128(0x0011_2233_4455_6677_8899_aabb_ccdd_eeff))
}

#[tokio::test]
async fn pitr_interval_scan_is_cursor_paginated() -> Result<()> {
	common::test_matrix("pitr-interval-pagination", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let branch = branch_id();
			for batch_start in (0..205_i64).step_by(50) {
				let rows = (batch_start..(batch_start + 50).min(205))
					.map(|idx| {
						(
							idx * 1_000,
							coverage(u64::try_from(idx + 1).unwrap(), idx * 1_000, 1_000_000),
						)
					})
					.collect();
				seed_rows(&db, branch, rows).await?;
			}
			let mut cursor = None;
			let mut buckets = Vec::new();
			loop {
				let page = db
					.txn("test_read_pitr_interval_page", move |tx| async move {
						scan_pitr_interval_coverage_page(&tx, branch, cursor, 17, Snapshot).await
					})
					.await?;
				assert!(page.rows.len() <= 17);
				buckets.extend(page.rows.into_iter().map(|(bucket, _)| bucket));
				let Some(next) = page.next_cursor else { break };
				assert!(cursor.is_none_or(|previous| next > previous));
				cursor = Some(next);
			}
			assert_eq!(
				buckets,
				(0..205_i64).map(|idx| idx * 1_000).collect::<Vec<_>>()
			);
			Ok(())
		})
	})
	.await
}

fn coverage(txid: u64, wall_clock_ms: i64, expires_at_ms: i64) -> PitrIntervalCoverage {
	PitrIntervalCoverage {
		txid,
		versionstamp: [txid as u8; 16],
		wall_clock_ms,
		expires_at_ms,
	}
}

async fn seed_rows(
	db: &universaldb::Database,
	branch: DatabaseBranchId,
	rows: Vec<(i64, PitrIntervalCoverage)>,
) -> Result<()> {
	db.txn("test_depotconveyer_pitr_interval", move |tx| {
		let rows = rows.clone();

		async move {
			for (bucket_start_ms, coverage) in rows {
				write_pitr_interval_coverage(&tx, branch, bucket_start_ms, coverage).await?;
			}

			Ok(())
		}
	})
	.await
}

#[test]
fn pitr_interval_keys_sort_by_bucket_start_ms() {
	let branch = branch_id();
	let mut keys = vec![
		keys::branch_pitr_interval_key(branch, 1_700_000_600_000),
		keys::branch_pitr_interval_key(branch, 1_700_000_000_000),
		keys::branch_pitr_interval_key(branch, 1_700_000_300_000),
	];
	keys.sort();

	assert_eq!(
		keys,
		vec![
			keys::branch_pitr_interval_key(branch, 1_700_000_000_000),
			keys::branch_pitr_interval_key(branch, 1_700_000_300_000),
			keys::branch_pitr_interval_key(branch, 1_700_000_600_000),
		]
	);
	assert!(keys[0].starts_with(&keys::branch_pitr_interval_prefix(branch)));
	assert_eq!(
		keys::decode_branch_pitr_interval_bucket(branch, &keys[1]).expect("bucket should decode"),
		1_700_000_300_000
	);
}

#[tokio::test]
async fn pitr_interval_overwrite_atomically_replaces_both_secondary_indexes() -> Result<()> {
	common::test_matrix("pitr-interval-secondary-index", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let branch = branch_id();
			let bucket = 1_000;
			let old = coverage(10, 1_100, 5_000);
			let new = coverage(20, 1_900, 9_000);

			seed_rows(&db, branch, vec![(bucket, old.clone())]).await?;
			seed_rows(&db, branch, vec![(bucket, new.clone())]).await?;

			assert_eq!(
				common::read_value(
					&db,
					keys::branch_pitr_interval_by_txid_key(branch, old.txid, bucket),
				)
				.await?,
				None
			);
			assert_eq!(
				common::read_value(
					&db,
					keys::branch_pitr_interval_due_key(branch, old.expires_at_ms, bucket),
				)
				.await?,
				None
			);
			assert_eq!(
				common::read_value(
					&db,
					keys::branch_pitr_interval_by_txid_key(branch, new.txid, bucket),
				)
				.await?,
				Some(Vec::new())
			);
			assert_eq!(
				common::read_value(
					&db,
					keys::branch_pitr_interval_due_key(branch, new.expires_at_ms, bucket),
				)
				.await?,
				Some(new.txid.to_be_bytes().to_vec())
			);

			Ok(())
		})
	})
	.await
}

#[tokio::test]
async fn pitr_interval_helpers_read_exact_between_and_quiet_period_targets() -> Result<()> {
	common::test_matrix("pitr-interval-read", |_tier, ctx| {
		Box::pin(async move {
			let db = ctx.udb.clone();
			let branch = branch_id();

			seed_rows(
				&db,
				branch,
				vec![
					(1_000, coverage(10, 1_000, 10_000)),
					(2_000, coverage(20, 2_500, 10_000)),
					(3_000, coverage(30, 3_000, 10_000)),
				],
			)
			.await?;
			db.txn(
				"test_seed_unrelated_future_pitr_rows",
				move |tx| async move {
					for offset in 0..2_048_i64 {
						tx.informal().set(
							&keys::branch_pitr_interval_key(branch, 100_000 + offset),
							b"malformed-future-coverage",
						);
					}
					Ok(())
				},
			)
			.await?;

			let exact = db
				.txn("test_depotconveyer_pitr_interval", move |tx| async move {
					read_pitr_interval_coverage(&tx, branch, 1_000, Snapshot).await
				})
				.await?
				.expect("exact bucket should exist");
			assert_eq!(exact.txid, 10);

			let between = db
				.txn("test_depotconveyer_pitr_interval", move |tx| async move {
					read_latest_pitr_interval_coverage_at_or_before(&tx, branch, 2_750, Snapshot)
						.await
				})
				.await?
				.expect("between-bucket target should resolve");
			assert_eq!(between.0, 2_000);
			assert_eq!(between.1.txid, 20);

			let quiet_period = db
				.txn("test_depotconveyer_pitr_interval", move |tx| async move {
					read_latest_pitr_interval_coverage_at_or_before(&tx, branch, 2_999, Snapshot)
						.await
				})
				.await?
				.expect("quiet-period target should resolve to the previous retained commit");
			assert_eq!(quiet_period.0, 2_000);
			assert_eq!(quiet_period.1.txid, 20);

			let walked_back = db
				.txn("test_depotconveyer_pitr_interval", move |tx| async move {
					read_latest_pitr_interval_coverage_at_or_before(&tx, branch, 2_100, Snapshot)
						.await
				})
				.await?
				.expect("newer selected row should walk back");
			assert_eq!(walked_back.0, 1_000);
			assert_eq!(walked_back.1.txid, 10);

			Ok(())
		})
	})
	.await
}
