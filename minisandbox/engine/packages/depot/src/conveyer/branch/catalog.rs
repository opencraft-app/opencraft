use std::collections::BTreeSet;

use anyhow::{Context, Result, ensure};
use futures_util::{StreamExt, TryStreamExt};
use universaldb::{
	RangeOption,
	options::{MutationType, StreamingMode},
	utils::{IsolationLevel::Serializable, end_of_prefix_range},
};

use super::{
	resolve::resolve_bucket_branch,
	shared::{decode_versionstamp_value, read_bucket_branch_record},
};
use crate::conveyer::{
	constants::MAX_BUCKET_DEPTH,
	error::SqliteStorageError,
	keys,
	types::{
		BucketBranchId, BucketCatalogDbFact, BucketForkFact, BucketId, DatabaseBranchId,
		decode_bucket_catalog_db_fact, encode_bucket_catalog_db_fact, encode_bucket_fork_fact,
	},
	udb,
};

pub async fn list_databases(
	udb: &universaldb::Database,
	bucket: BucketId,
) -> Result<Vec<DatabaseBranchId>> {
	let mut cursor = None;
	let mut databases = Vec::new();
	loop {
		let page = list_databases_page(udb, bucket, cursor, 256).await?;
		databases.extend(page.databases);
		let Some(next_cursor) = page.next_cursor else {
			return Ok(databases);
		};
		cursor = Some(next_cursor);
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseListPage {
	pub databases: Vec<DatabaseBranchId>,
	/// Last candidate examined, not merely the last visible row. This allows a caller to make
	/// progress through arbitrarily many tombstoned/invisible inherited catalog rows.
	pub next_cursor: Option<DatabaseBranchId>,
}

pub async fn list_databases_page(
	udb: &universaldb::Database,
	bucket: BucketId,
	cursor: Option<DatabaseBranchId>,
	limit: usize,
) -> Result<DatabaseListPage> {
	ensure!(
		(1..=256).contains(&limit),
		"database list page limit must be 1..=256"
	);
	udb.txn("depot_list_databases_page", move |tx| async move {
		let Some(bucket_branch_id) = resolve_bucket_branch(&tx, bucket, Serializable).await? else {
			return Ok(DatabaseListPage {
				databases: Vec::new(),
				next_cursor: None,
			});
		};
		list_databases_page_in_bucket_branch(&tx, bucket_branch_id, cursor, limit).await
	})
	.await
}

async fn list_databases_page_in_bucket_branch(
	tx: &universaldb::Transaction,
	bucket_branch_id: BucketBranchId,
	cursor: Option<DatabaseBranchId>,
	limit: usize,
) -> Result<DatabaseListPage> {
	let mut ancestry = Vec::new();
	let mut current_branch_id = bucket_branch_id;
	for depth in 0..=MAX_BUCKET_DEPTH {
		ancestry.push(current_branch_id);
		let record = read_bucket_branch_record(tx, current_branch_id).await?;
		let Some(parent_branch_id) = record.parent else {
			break;
		};
		if depth == MAX_BUCKET_DEPTH {
			return Err(SqliteStorageError::BucketForkChainTooDeep.into());
		}
		current_branch_id = parent_branch_id;
	}

	let work_limit = limit.saturating_mul(4).max(limit);
	let mut candidates = BTreeSet::new();
	let mut safe_source_boundary = None;
	for ancestor in ancestry {
		let prefix = keys::bucket_catalog_prefix(ancestor);
		let start = cursor.map_or_else(
			|| prefix.clone(),
			|cursor| {
				let mut key = keys::bucket_catalog_key(ancestor, cursor);
				key.push(0);
				key
			},
		);
		let end = end_of_prefix_range(&prefix);
		let informal = tx.informal();
		let mut stream = informal.get_ranges_keyvalues(
			RangeOption {
				mode: StreamingMode::Exact,
				limit: Some(work_limit.saturating_add(1)),
				..(start.as_slice(), end.as_slice()).into()
			},
			Serializable,
		);
		let mut count = 0_usize;
		let mut last_included = None;
		while let Some(entry) = stream.try_next().await? {
			count = count.saturating_add(1);
			if count > work_limit {
				let boundary = last_included
					.context("truncated database catalog source had no boundary row")?;
				safe_source_boundary = Some(
					safe_source_boundary
						.map_or(boundary, |current: DatabaseBranchId| current.min(boundary)),
				);
				break;
			}
			let database_id = keys::decode_bucket_catalog_database_id(ancestor, entry.key())?;
			last_included = Some(database_id);
			candidates.insert(database_id);
		}
	}
	if let Some(boundary) = safe_source_boundary {
		candidates.retain(|database_id| *database_id <= boundary);
	}

	let mut candidate_iter = candidates.into_iter();
	let candidate_page = candidate_iter.by_ref().take(work_limit).collect::<Vec<_>>();
	let candidate_has_more = candidate_iter.next().is_some();
	let visibility = futures_util::stream::iter(candidate_page.iter().copied())
		.map(|candidate| async move {
			Ok::<_, anyhow::Error>((
				candidate,
				is_database_visible_in_bucket_branch(tx, bucket_branch_id, candidate).await?,
			))
		})
		.buffered(32)
		.try_collect::<Vec<_>>()
		.await?;
	let mut databases = Vec::with_capacity(limit);
	let mut examined = None;
	for (candidate, visible) in visibility {
		examined = Some(candidate);
		if visible {
			databases.push(candidate);
			if databases.len() == limit {
				return Ok(DatabaseListPage {
					databases,
					next_cursor: examined,
				});
			}
		}
	}
	Ok(DatabaseListPage {
		databases,
		next_cursor: (safe_source_boundary.is_some() || candidate_has_more)
			.then_some(examined)
			.flatten(),
	})
}

pub(super) async fn is_database_visible_in_bucket_branch(
	tx: &universaldb::Transaction,
	bucket_branch_id: BucketBranchId,
	database_id: DatabaseBranchId,
) -> Result<bool> {
	let mut current_branch_id = bucket_branch_id;
	let mut versionstamp_cap = [0xff; 16];

	// Visibility of one database is an ancestry walk of exact point reads. It
	// must not materialize every catalog entry merely to answer membership.
	for depth in 0..=MAX_BUCKET_DEPTH {
		if let Some(value) = tx
			.informal()
			.get(
				&keys::bucket_branches_database_tombstone_key(current_branch_id, database_id),
				Serializable,
			)
			.await?
		{
			let tombstone_versionstamp = if value.is_empty() {
				[0; 16]
			} else {
				decode_versionstamp_value(&value)
					.context("decode exact sqlite bucket database tombstone versionstamp")?
			};
			if tombstone_versionstamp <= versionstamp_cap {
				return Ok(false);
			}
		}

		if let Some(value) = tx
			.informal()
			.get(
				&keys::bucket_catalog_key(current_branch_id, database_id),
				Serializable,
			)
			.await?
		{
			let catalog_versionstamp = decode_versionstamp_value(&value)
				.context("decode exact sqlite bucket catalog versionstamp")?;
			if catalog_versionstamp <= versionstamp_cap {
				return Ok(true);
			}
		}

		let record = read_bucket_branch_record(tx, current_branch_id).await?;
		let Some(parent_branch_id) = record.parent else {
			return Ok(false);
		};
		if depth == MAX_BUCKET_DEPTH {
			return Err(SqliteStorageError::BucketForkChainTooDeep.into());
		}
		versionstamp_cap = record
			.parent_versionstamp
			.context("sqlite bucket branch parent versionstamp is missing")?;
		current_branch_id = parent_branch_id;
	}

	Err(SqliteStorageError::BucketForkChainTooDeep.into())
}

pub(crate) fn write_bucket_catalog_marker(
	tx: &universaldb::Transaction,
	bucket_branch_id: BucketBranchId,
	database_id: DatabaseBranchId,
	catalog_versionstamp: &[u8; 16],
) -> Result<()> {
	tx.informal().atomic_op(
		&keys::bucket_catalog_key(bucket_branch_id, database_id),
		&udb::append_versionstamp_offset(catalog_versionstamp.to_vec(), catalog_versionstamp)
			.context("prepare versionstamped sqlite bucket catalog marker")?,
		MutationType::SetVersionstampedValue,
	);
	let fact = BucketCatalogDbFact {
		database_branch_id: database_id,
		bucket_branch_id,
		catalog_versionstamp: *catalog_versionstamp,
		tombstone_versionstamp: None,
	};
	let encoded_fact =
		encode_bucket_catalog_db_fact(fact).context("encode sqlite bucket catalog proof fact")?;
	tx.informal().atomic_op(
		&keys::bucket_catalog_by_db_key(database_id, bucket_branch_id),
		&udb::append_versionstamp_offset(encoded_fact, catalog_versionstamp)
			.context("prepare versionstamped sqlite bucket catalog proof fact")?,
		MutationType::SetVersionstampedValue,
	);
	// Membership changes affect only this database's reverse catalog. Its durable proof pages
	// are invalidated in this transaction, including a proof that is not yet complete.
	invalidate_database_bucket_proof(tx, database_id);

	Ok(())
}

pub(super) async fn write_bucket_catalog_tombstone_marker(
	tx: &universaldb::Transaction,
	bucket_branch_id: BucketBranchId,
	database_id: DatabaseBranchId,
) -> Result<()> {
	let existing_fact = tx
		.informal()
		.get(
			&keys::bucket_catalog_by_db_key(database_id, bucket_branch_id),
			Serializable,
		)
		.await?
		.as_deref()
		.map(|bytes| decode_bucket_catalog_db_fact(bytes))
		.transpose()
		.context("decode sqlite bucket catalog proof fact before tombstone")?;
	let fact = BucketCatalogDbFact {
		database_branch_id: database_id,
		bucket_branch_id,
		catalog_versionstamp: existing_fact
			.as_ref()
			.map_or([0; 16], |fact| fact.catalog_versionstamp),
		tombstone_versionstamp: Some(udb::INCOMPLETE_VERSIONSTAMP),
	};
	let encoded_fact = encode_bucket_catalog_db_fact(fact)
		.context("encode sqlite bucket catalog tombstone proof fact")?;
	tx.informal().atomic_op(
		&keys::bucket_catalog_by_db_key(database_id, bucket_branch_id),
		&udb::append_versionstamp_offset(encoded_fact, &udb::INCOMPLETE_VERSIONSTAMP)
			.context("prepare versionstamped sqlite bucket catalog tombstone proof fact")?,
		MutationType::SetVersionstampedValue,
	);
	invalidate_database_bucket_proof(tx, database_id);

	Ok(())
}

pub(super) async fn write_bucket_fork_facts(
	tx: &universaldb::Transaction,
	source_bucket_branch_id: BucketBranchId,
	target_bucket_branch_id: BucketBranchId,
	fork_versionstamp: [u8; 16],
) -> Result<()> {
	let root_bucket_branch_id = read_bucket_root_branch_id(tx, source_bucket_branch_id).await?;
	let fact = BucketForkFact {
		source_bucket_branch_id,
		target_bucket_branch_id,
		fork_versionstamp,
		parent_cap_versionstamp: fork_versionstamp,
	};
	let encoded_fact =
		encode_bucket_fork_fact(fact).context("encode sqlite bucket fork proof fact")?;
	tx.informal().set(
		&keys::bucket_fork_pin_key(
			source_bucket_branch_id,
			fork_versionstamp,
			target_bucket_branch_id,
		),
		&encoded_fact,
	);
	tx.informal().set(
		&keys::bucket_child_key(
			source_bucket_branch_id,
			fork_versionstamp,
			target_bucket_branch_id,
		),
		&encoded_fact,
	);
	// A new child can inherit every database visible on the source path. Unlike a catalog
	// mutation, it must invalidate the subscribed proofs across the whole bucket tree.
	bump_bucket_proof_epoch(tx, root_bucket_branch_id);

	Ok(())
}

pub(crate) async fn read_bucket_root_branch_id(
	tx: &universaldb::Transaction,
	bucket_branch_id: BucketBranchId,
) -> Result<BucketBranchId> {
	let mut current_branch_id = bucket_branch_id;

	for depth in 0..=MAX_BUCKET_DEPTH {
		let record = read_bucket_branch_record(tx, current_branch_id).await?;
		let Some(parent_branch_id) = record.parent else {
			return Ok(current_branch_id);
		};
		if depth == MAX_BUCKET_DEPTH {
			return Err(SqliteStorageError::BucketForkChainTooDeep.into());
		}
		current_branch_id = parent_branch_id;
	}

	Err(SqliteStorageError::BucketForkChainTooDeep.into())
}

fn invalidate_database_bucket_proof(
	tx: &universaldb::Transaction,
	database_branch_id: DatabaseBranchId,
) {
	for key in [
		keys::branch_bucket_proof_complete_key(database_branch_id),
		keys::branch_bucket_proof_catalog_complete_key(database_branch_id),
		keys::branch_bucket_proof_catalog_cursor_key(database_branch_id),
	] {
		tx.informal().clear(&key);
	}
	for prefix in [
		keys::branch_bucket_proof_root_prefix(database_branch_id),
		keys::branch_bucket_proof_epoch_shard_prefix(database_branch_id),
		keys::branch_bucket_proof_queue_prefix(database_branch_id),
		keys::branch_bucket_proof_queue_cursor_prefix(database_branch_id),
		keys::branch_bucket_proof_seen_prefix(database_branch_id),
	] {
		tx.informal()
			.clear_range(&prefix, &end_of_prefix_range(&prefix));
	}
}

fn bump_bucket_proof_epoch(tx: &universaldb::Transaction, root_bucket_branch_id: BucketBranchId) {
	tx.informal().atomic_op(
		&keys::bucket_proof_epoch_key(root_bucket_branch_id),
		&1_i64.to_le_bytes(),
		MutationType::Add,
	);
	tx.informal().atomic_op(
		&keys::bucket_proof_epoch_shard_key(keys::bucket_proof_epoch_shard(root_bucket_branch_id)),
		&1_i64.to_le_bytes(),
		MutationType::Add,
	);
}

pub(super) fn versionstamped_marker_value() -> Result<Vec<u8>> {
	udb::append_versionstamp_offset(
		udb::INCOMPLETE_VERSIONSTAMP.to_vec(),
		&udb::INCOMPLETE_VERSIONSTAMP,
	)
}
