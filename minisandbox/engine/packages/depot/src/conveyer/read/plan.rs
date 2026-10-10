use anyhow::Result;
use universaldb::utils::IsolationLevel::Serializable;

use crate::conveyer::{
	branch,
	db::{BranchAncestry, load_branch_ancestry},
	error::SqliteStorageError,
	keys,
	types::{BucketId, DBHead, DatabaseBranchId, decode_db_head},
};

#[derive(Debug, Clone)]
pub(super) enum StorageScope {
	Branch(BranchReadPlan),
}

impl StorageScope {
	pub(super) fn branch_id(&self) -> DatabaseBranchId {
		match self {
			Self::Branch(plan) => plan.branch_id,
		}
	}

	pub(super) fn branch_ancestry(&self) -> BranchAncestry {
		match self {
			Self::Branch(plan) => plan.ancestry.clone(),
		}
	}
}

#[derive(Debug, Clone)]
pub(super) struct BranchReadPlan {
	pub(super) branch_id: DatabaseBranchId,
	pub(super) head: DBHead,
	pub(super) ancestry: BranchAncestry,
	pub(super) sources: Vec<ReadSource>,
	pub(super) inherited_bucket_cap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum ReadSource {
	Branch(BranchSource),
}

impl ReadSource {
	pub(super) fn pidx_key(self, database_id: &str, pgno: u32) -> Vec<u8> {
		let _ = database_id;
		match self {
			Self::Branch(source) => keys::branch_pidx_key(source.branch_id, pgno),
		}
	}

	pub(super) fn delta_chunk_prefix(self, database_id: &str, txid: u64) -> Vec<u8> {
		let _ = database_id;
		match self {
			Self::Branch(source) => keys::branch_delta_chunk_prefix(source.branch_id, txid),
		}
	}

	pub(super) fn page_history_complete_txid_key(self) -> Vec<u8> {
		match self {
			Self::Branch(source) => keys::branch_page_history_complete_txid_key(source.branch_id),
		}
	}

	pub(super) fn page_history_page_prefix(self, pgno: u32) -> Vec<u8> {
		match self {
			Self::Branch(source) => keys::branch_page_history_page_prefix(source.branch_id, pgno),
		}
	}

	pub(super) fn page_history_key(self, pgno: u32, txid: u64) -> Vec<u8> {
		match self {
			Self::Branch(source) => keys::branch_page_history_key(source.branch_id, pgno, txid),
		}
	}

	pub(super) fn decode_page_history_txid(self, pgno: u32, key: &[u8]) -> Result<u64> {
		match self {
			Self::Branch(source) => {
				keys::decode_branch_page_history_txid(source.branch_id, pgno, key)
			}
		}
	}

	pub(super) fn max_txid(self) -> u64 {
		match self {
			Self::Branch(source) => source.max_txid,
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct BranchSource {
	pub(super) branch_id: DatabaseBranchId,
	pub(super) max_txid: u64,
}

pub(super) async fn resolve_storage_scope(
	tx: &universaldb::Transaction,
	bucket_id: BucketId,
	database_id: &str,
	cached_ancestry: Option<&BranchAncestry>,
) -> Result<StorageScope> {
	Ok(
		match branch::resolve_database_read_branch(
			tx,
			bucket_id,
			database_id,
			// TODO: This can probably be made Snapshot again to reduce contention if
			// read side freshness is not worth the cost.
			Serializable,
		)
		.await?
		{
			Some(resolution) => StorageScope::Branch(
				load_branch_read_plan(
					tx,
					resolution.pointer.current_branch,
					resolution.versionstamp_cap,
					cached_ancestry,
				)
				.await?,
			),
			None => return Err(SqliteStorageError::DatabaseNotFound.into()),
		},
	)
}

async fn load_branch_read_plan(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	bucket_versionstamp_cap: Option<[u8; 16]>,
	cached_ancestry: Option<&BranchAncestry>,
) -> Result<BranchReadPlan> {
	let head_bytes = super::tx::tx_get_value(tx, &keys::branch_meta_head_key(branch_id)).await?;
	let mut head = if let Some(head_bytes) = head_bytes {
		decode_db_head(&head_bytes)?
	} else {
		let head_at_fork_bytes =
			super::tx::tx_get_value(tx, &keys::branch_meta_head_at_fork_key(branch_id))
				.await?
				.ok_or(SqliteStorageError::MetaMissing {
					operation: "get_pages",
				})?;
		decode_db_head(&head_at_fork_bytes)?
	};
	if let Some(cap) = bucket_versionstamp_cap {
		let txid = lookup_txid_for_read(tx, branch_id, cap).await?;
		let commit = branch::read_commit_row(tx, branch_id, txid).await?;
		head.head_txid = txid;
		head.db_size_pages = commit.db_size_pages;
		head.post_apply_checksum = commit.post_apply_checksum;
	}

	let ancestry = if let Some(cached_ancestry) =
		cached_ancestry.filter(|ancestry| ancestry.root_branch_id == branch_id)
	{
		cached_ancestry.clone()
	} else {
		load_branch_ancestry(tx, branch_id).await?
	};

	let mut sources = Vec::new();
	let mut versionstamp_cap = bucket_versionstamp_cap;
	for ancestor in &ancestry.ancestors {
		let max_txid = match ancestor.parent_versionstamp_cap {
			Some(parent_cap) => {
				let cap = versionstamp_cap.map_or(parent_cap, |cap| cap.min(parent_cap));
				versionstamp_cap = Some(cap);
				if cap == parent_cap {
					// A database fork records an exact commit. Missing history must not
					// silently turn this boundary into an earlier snapshot.
					branch::lookup_txid_at_versionstamp(tx, ancestor.branch_id, parent_cap).await?
				} else {
					// A bucket snapshot may fall between this database's commits.
					lookup_txid_for_read(tx, ancestor.branch_id, cap).await?
				}
			}
			None => head.head_txid,
		};
		sources.push(ReadSource::Branch(BranchSource {
			branch_id: ancestor.branch_id,
			max_txid,
		}));
	}

	Ok(BranchReadPlan {
		branch_id,
		head,
		ancestry,
		sources,
		inherited_bucket_cap: bucket_versionstamp_cap.is_some(),
	})
}

async fn lookup_txid_for_read(
	tx: &universaldb::Transaction,
	branch_id: DatabaseBranchId,
	versionstamp: [u8; 16],
) -> Result<u64> {
	Ok(
		branch::lookup_commit_position_at_or_before(tx, branch_id, versionstamp)
			.await?
			.1,
	)
}
