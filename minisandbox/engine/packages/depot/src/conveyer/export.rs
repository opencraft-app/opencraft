//! Consistent, bounded-memory SQLite database image exports.

use std::sync::{
	Arc,
	atomic::{AtomicI64, Ordering},
};

use anyhow::{Context, Result, ensure};
use futures_util::TryStreamExt;
use universaldb::{RangeOption, options::StreamingMode, utils::IsolationLevel::Serializable};
use uuid::Uuid;

use super::{
	Db, history_pin, keys,
	types::{
		DbHistoryPin, DbHistoryPinKind, DepotReadMode, FetchedPage, GetPagesOptions,
		ResolvedRestoreTarget, SnapshotSelector, decode_db_history_pin,
	},
};

/// Number of SQLite pages returned by one export read (256 KiB with 4 KiB pages).
pub const EXPORT_PAGE_BATCH_SIZE: u32 = 64;

const EXPORT_PIN_PREFIX: &[u8] = b"export/";
const DEFAULT_EXPORT_LEASE_TTL_MS: i64 = 10 * 60 * 1_000;
const MIN_EXPORT_LEASE_TTL_MS: i64 = 5_000;
const MAX_EXPORT_LEASE_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_EXPORT_PINS_PER_BRANCH: usize = 4_096;

fn export_lease_ttl_ms() -> i64 {
	std::env::var("RIVET_SQLITE_EXPORT_LEASE_TTL_MS")
		.ok()
		.and_then(|value| value.parse::<i64>().ok())
		.unwrap_or(DEFAULT_EXPORT_LEASE_TTL_MS)
		.clamp(MIN_EXPORT_LEASE_TTL_MS, MAX_EXPORT_LEASE_TTL_MS)
}

/// A temporary history pin for one exact database image.
///
/// The pin has a random identity, so concurrent downloads of the same version cannot release each
/// other's retention. Call [`ExportLease::release`] after the response body is consumed or dropped.
pub struct ExportLease {
	db: Arc<Db>,
	pin_id: Vec<u8>,
	target: ResolvedRestoreTarget,
	db_size_pages: u32,
	last_renewed_at_ms: AtomicI64,
	ttl_ms: i64,
}

impl ExportLease {
	pub async fn acquire(db: Arc<Db>) -> Result<Self> {
		let target = db.resolve_restore_target(SnapshotSelector::Latest).await?;
		let pin_id = format!(
			"{}{}",
			String::from_utf8_lossy(EXPORT_PIN_PREFIX),
			Uuid::new_v4()
		)
		.into_bytes();
		let branch_id = target.database_branch_id;
		let txid = target.txid;
		let ttl_ms = export_lease_ttl_ms();
		let now_ms = rivet_util::timestamp::now();
		let pin_id_for_tx = pin_id.clone();
		let pin = DbHistoryPin {
			at_versionstamp: target.versionstamp,
			at_txid: txid,
			// Export pins have restore-point retention semantics. A missing owner_restore_point
			// distinguishes this short-lived internal lease from a user restore point.
			kind: DbHistoryPinKind::RestorePoint,
			owner_database_branch_id: None,
			owner_bucket_branch_id: None,
			owner_restore_point: None,
			created_at_ms: now_ms,
		};
		db.udb
			.txn("depot_export_pin_acquire", move |tx| {
				let pin_id = pin_id_for_tx.clone();
				let pin = pin.clone();
				async move {
					reap_expired_export_pins(&tx, branch_id, now_ms, ttl_ms).await?;
					tx.informal()
						.get(&keys::branch_commit_key(branch_id, txid), Serializable)
						.await?
						.context("sqlite export target expired before it could be pinned")?;
					history_pin::write_db_history_pin(&tx, branch_id, &pin_id, pin).await
				}
			})
			.await?;

		let metadata = db
			.get_pages_with_options(
				vec![1],
				GetPagesOptions {
					mode: DepotReadMode::DiagnosticNoSideEffects,
					diagnostic_max_txid: Some(target.txid),
					..Default::default()
				},
			)
			.await;
		let metadata = match metadata {
			Ok(metadata) => metadata,
			Err(err) => {
				let _ = release_pin(&db, target.database_branch_id, &pin_id).await;
				return Err(err);
			}
		};

		Ok(Self {
			db,
			pin_id,
			target,
			db_size_pages: metadata.db_size_pages,
			last_renewed_at_ms: AtomicI64::new(now_ms),
			ttl_ms,
		})
	}

	pub fn db_size_pages(&self) -> u32 {
		self.db_size_pages
	}

	pub async fn read_pages(&self, first_pgno: u32, last_pgno: u32) -> Result<Vec<FetchedPage>> {
		self.renew_if_needed().await?;
		self.db
			.get_pages_with_options(
				(first_pgno..=last_pgno).collect(),
				GetPagesOptions {
					mode: DepotReadMode::DiagnosticNoSideEffects,
					diagnostic_max_txid: Some(self.target.txid),
					..Default::default()
				},
			)
			.await
			.map(|result| result.pages)
	}

	/// Reads one ordered range as bytes in standard SQLite database-file layout.
	pub async fn read_chunk(&self, first_pgno: u32, last_pgno: u32) -> Result<Vec<u8>> {
		ensure!(first_pgno > 0, "sqlite export does not accept page 0");
		ensure!(
			first_pgno <= last_pgno && last_pgno <= self.db_size_pages,
			"sqlite export page range is outside the pinned database image"
		);
		let pages = self.read_pages(first_pgno, last_pgno).await?;
		ensure!(
			pages.len() == usize::try_from(last_pgno - first_pgno + 1)?,
			"sqlite export returned an incomplete page batch"
		);
		let page_size = usize::try_from(super::types::SQLITE_PAGE_SIZE)?;
		let mut bytes = Vec::with_capacity(pages.len() * page_size);
		for (expected_pgno, page) in (first_pgno..=last_pgno).zip(pages) {
			ensure!(
				page.pgno == expected_pgno,
				"sqlite export page order mismatch"
			);
			match page.bytes {
				Some(page_bytes) => {
					ensure!(
						page_bytes.len() == page_size,
						"sqlite export page size mismatch"
					);
					bytes.extend_from_slice(&page_bytes);
				}
				None => bytes.resize(bytes.len() + page_size, 0),
			}
		}
		Ok(bytes)
	}

	pub async fn release(self) -> Result<()> {
		release_pin(&self.db, self.target.database_branch_id, &self.pin_id).await
	}

	async fn renew_if_needed(&self) -> Result<()> {
		let now_ms = rivet_util::timestamp::now();
		let previous = self.last_renewed_at_ms.load(Ordering::Relaxed);
		if now_ms.saturating_sub(previous) < self.ttl_ms / 3 {
			return Ok(());
		}

		let branch_id = self.target.database_branch_id;
		let pin_id = self.pin_id.clone();
		let expected_txid = self.target.txid;
		self.db
			.udb
			.txn("depot_export_pin_renew", move |tx| {
				let pin_id = pin_id.clone();
				async move {
					let key = keys::db_pin_key(branch_id, &pin_id);
					let value = tx
						.informal()
						.get(&key, Serializable)
						.await?
						.context("sqlite export lease expired")?;
					let mut pin = decode_db_history_pin(&value)?;
					ensure!(
						pin.at_txid == expected_txid,
						"sqlite export lease target changed"
					);
					pin.created_at_ms = now_ms;
					history_pin::write_db_history_pin(&tx, branch_id, &pin_id, pin).await
				}
			})
			.await?;
		self.last_renewed_at_ms.store(now_ms, Ordering::Relaxed);
		Ok(())
	}
}

async fn reap_expired_export_pins(
	tx: &universaldb::Transaction,
	branch_id: super::types::DatabaseBranchId,
	now_ms: i64,
	ttl_ms: i64,
) -> Result<()> {
	let mut prefix = keys::db_pin_prefix(branch_id);
	prefix.extend_from_slice(EXPORT_PIN_PREFIX);
	let end = universaldb::utils::end_of_prefix_range(&prefix);
	let informal = tx.informal();
	let mut rows = informal.get_ranges_keyvalues(
		RangeOption {
			mode: StreamingMode::Exact,
			limit: Some(MAX_EXPORT_PINS_PER_BRANCH + 1),
			..(prefix.as_slice(), end.as_slice()).into()
		},
		Serializable,
	);
	let mut scanned = 0_usize;
	while let Some(entry) = rows.try_next().await? {
		scanned += 1;
		ensure!(
			scanned <= MAX_EXPORT_PINS_PER_BRANCH,
			"sqlite export pin cleanup exceeded its bounded scan"
		);
		let key = entry.key();
		let Some(pin_id_suffix) = key.strip_prefix(prefix.as_slice()) else {
			continue;
		};
		let pin = decode_db_history_pin(entry.value())?;
		let is_internal_export = pin.kind == DbHistoryPinKind::RestorePoint
			&& pin.owner_database_branch_id.is_none()
			&& pin.owner_bucket_branch_id.is_none()
			&& pin.owner_restore_point.is_none();
		if is_internal_export && now_ms.saturating_sub(pin.created_at_ms) >= ttl_ms {
			let mut pin_id = EXPORT_PIN_PREFIX.to_vec();
			pin_id.extend_from_slice(pin_id_suffix);
			history_pin::delete_db_history_pin(tx, branch_id, &pin_id).await?;
		}
	}
	Ok(())
}

async fn release_pin(
	db: &Db,
	branch_id: super::types::DatabaseBranchId,
	pin_id: &[u8],
) -> Result<()> {
	let pin_id = pin_id.to_vec();
	db.udb
		.txn("depot_export_pin_release", move |tx| {
			let pin_id = pin_id.clone();
			async move { history_pin::delete_db_history_pin(&tx, branch_id, &pin_id).await }
		})
		.await
}
