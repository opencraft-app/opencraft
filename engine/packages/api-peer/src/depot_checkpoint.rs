use anyhow::{Context, Result, ensure};
use depot::{
	conveyer::branch,
	keys,
	types::decode_db_head,
	workflows::compaction::{
		DATABASE_BRANCH_ID_TAG, DbManagerInput, ForceCompaction, ForceCompactionWork,
		database_branch_tag_value,
	},
};
use gas::prelude::*;
use rivet_api_builder::ApiCtx;
use serde::{Deserialize, Serialize};
use universaldb::utils::IsolationLevel::Snapshot;

#[derive(Debug, Deserialize)]
pub struct DatabasePath {
	pub bucket_id: String,
	pub database_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateCheckpointRequest {
	/// Wake the bounded reclaim lane immediately after the checkpoint's hot and cold work. This is
	/// an operational scheduling hint, not permission to bypass retention, pins, generation fences,
	/// exact cold-object publication, hashes, or transaction budgets.
	#[serde(default)]
	pub force_reclaim: bool,
}

/// A checkpoint freezes an evidence watermark, not Actor admission. Commits after
/// `target_head_txid` remain available and form the next hot tail while Depot compacts and
/// publishes everything through the target in the background.
#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateCheckpointResponse {
	pub checkpoint_contract_version: u32,
	pub request_id: String,
	pub bucket_id: String,
	pub database_id: String,
	pub branch_id: String,
	pub target_head_txid: u64,
	pub target_db_size_pages: u32,
	pub target_post_apply_checksum: u64,
	pub service_interrupted: bool,
	pub force_reclaim_accepted: bool,
}

#[tracing::instrument(skip_all)]
pub async fn create(
	ctx: ApiCtx,
	path: DatabasePath,
	_query: (),
	body: CreateCheckpointRequest,
) -> Result<CreateCheckpointResponse> {
	ensure!(
		ctx.config().sqlite().workflow_cold_storage().is_some(),
		"Depot checkpoint requires sqlite.workflow_cold_storage"
	);
	let bucket_id = super::depot_inspect::parse_bucket_id(&path.bucket_id)?;
	let database_id = path.database_id.clone();
	let udb = ctx.pools().udb()?;
	let (branch_id, head) = udb
		.txn("depot_create_online_checkpoint", move |tx| {
			let database_id = database_id.clone();
			async move {
				let branch_id =
					branch::resolve_database_branch(&tx, bucket_id, &database_id, Snapshot)
						.await?
						.context("Depot checkpoint database was not found")?;
				let head = tx
					.informal()
					.get(&keys::branch_meta_head_key(branch_id), Snapshot)
					.await?
					.context("Depot checkpoint database has no durable head")?;
				Ok((branch_id, decode_db_head(&head)?))
			}
		})
		.await?;
	ensure!(
		head.head_txid > 0,
		"Depot checkpoint database has an empty head"
	);

	let tag_value = database_branch_tag_value(branch_id);
	let manager_workflow_id = ctx
		.workflow(DbManagerInput::new(branch_id, None))
		.tag(DATABASE_BRANCH_ID_TAG, &tag_value)
		.unique()
		.dispatch()
		.await?;
	let request_id = ctx.req_id();
	ctx.signal(ForceCompaction {
		database_branch_id: branch_id,
		request_id,
		requested_work: ForceCompactionWork {
			hot: true,
			cold: true,
			reclaim: body.force_reclaim,
			final_settle: true,
		},
	})
	.to_workflow_id(manager_workflow_id)
	.send()
	.await?
	.context("Depot checkpoint manager disappeared before accepting the request")?;

	Ok(CreateCheckpointResponse {
		checkpoint_contract_version: 2,
		request_id: request_id.to_string(),
		bucket_id: path.bucket_id,
		database_id: path.database_id,
		branch_id: branch_id.as_uuid().to_string(),
		target_head_txid: head.head_txid,
		target_db_size_pages: head.db_size_pages,
		target_post_apply_checksum: head.post_apply_checksum,
		service_interrupted: false,
		force_reclaim_accepted: body.force_reclaim,
	})
}
