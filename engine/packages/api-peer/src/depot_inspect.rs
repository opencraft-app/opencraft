use anyhow::{Context, Result};
use depot::{
	inspect::{self, CatalogQuery, RawScanQuery, RowsQuery, SampleQuery},
	types::{BucketId, DatabaseBranchId},
};
use rivet_api_builder::ApiCtx;
use serde::{Deserialize, Serialize};
use universaldb::utils::Subspace;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct BucketPath {
	pub bucket_id: String,
}

#[derive(Debug, Deserialize)]
pub struct DatabasePath {
	pub bucket_id: String,
	pub database_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShardCachePolicyRequest {
	pub retention_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct ShardCachePolicyResponse {
	pub bucket_id: String,
	pub database_id: String,
	pub retention_ms: Option<i64>,
}

#[cfg(feature = "test-faults")]
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColdDeleteGraceRequest {
	pub grace_ms: i64,
}

#[cfg(feature = "test-faults")]
#[derive(Debug, Serialize)]
pub struct ColdDeleteGraceResponse {
	pub branch_id: String,
	pub grace_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct BranchPath {
	pub branch_id: String,
}

#[derive(Debug, Deserialize)]
pub struct BranchRowsPath {
	pub branch_id: String,
	pub family: String,
}

#[derive(Debug, Deserialize)]
pub struct PageTracePath {
	pub branch_id: String,
	pub pgno: u32,
}

#[derive(Debug, Deserialize)]
pub struct RawKeyPath {
	pub key: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FootprintQuery {
	pub scope: String,
	pub start_after: Option<String>,
	pub limit: Option<usize>,
	pub namespace: Option<String>,
	pub envoy_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DueQueueQuery {
	pub scope: String,
	pub start_after: Option<String>,
	pub limit: Option<usize>,
}

pub async fn summary(ctx: ApiCtx, _path: (), _query: ()) -> Result<inspect::InspectResponse> {
	let udb = ctx.pools().udb()?;
	inspect::summary(&udb, ctx.pools().node_id()).await
}

pub async fn catalog(
	ctx: ApiCtx,
	_path: (),
	query: CatalogQuery,
) -> Result<inspect::CatalogResponse> {
	let udb = ctx.pools().udb()?;
	inspect::catalog(&udb, ctx.pools().node_id(), query).await
}

pub async fn bucket(
	ctx: ApiCtx,
	path: BucketPath,
	query: SampleQuery,
) -> Result<inspect::InspectResponse> {
	let bucket_id = parse_bucket_id(&path.bucket_id)?;
	let udb = ctx.pools().udb()?;
	inspect::bucket(&udb, ctx.pools().node_id(), bucket_id, query).await
}

pub async fn database(
	ctx: ApiCtx,
	path: DatabasePath,
	query: SampleQuery,
) -> Result<inspect::InspectResponse> {
	let bucket_id = parse_bucket_id(&path.bucket_id)?;
	let udb = ctx.pools().udb()?;
	inspect::database(
		&udb,
		ctx.pools().node_id(),
		bucket_id,
		path.database_id,
		query,
	)
	.await
}

pub async fn bottomless_state(
	ctx: ApiCtx,
	path: DatabasePath,
	_query: (),
) -> Result<inspect::InspectResponse> {
	let bucket_id = parse_bucket_id(&path.bucket_id)?;
	let udb = ctx.pools().udb()?;
	let configured = ctx.config().sqlite().workflow_write_debt();
	let write_debt_policy =
		depot::cold_tier::FdbWriteDebtPolicy::new(configured.target_bytes, configured.limit_bytes)?;
	inspect::bottomless_state(
		&udb,
		ctx.pools().node_id(),
		bucket_id,
		path.database_id,
		write_debt_policy,
	)
	.await
}

pub async fn set_shard_cache_policy(
	ctx: ApiCtx,
	path: DatabasePath,
	_query: (),
	body: ShardCachePolicyRequest,
) -> Result<ShardCachePolicyResponse> {
	let bucket_id = parse_bucket_id(&path.bucket_id)?;
	let udb = ctx.pools().udb()?;
	depot::policy::set_database_shard_cache_policy_override(
		&udb,
		bucket_id,
		&path.database_id,
		depot::types::ShardCachePolicy {
			retention_ms: body.retention_ms,
		},
	)
	.await?;
	Ok(ShardCachePolicyResponse {
		bucket_id: path.bucket_id,
		database_id: path.database_id,
		retention_ms: Some(body.retention_ms),
	})
}

pub async fn clear_shard_cache_policy(
	ctx: ApiCtx,
	path: DatabasePath,
	_query: (),
) -> Result<ShardCachePolicyResponse> {
	let bucket_id = parse_bucket_id(&path.bucket_id)?;
	let udb = ctx.pools().udb()?;
	depot::policy::clear_database_shard_cache_policy_override(&udb, bucket_id, &path.database_id)
		.await?;
	Ok(ShardCachePolicyResponse {
		bucket_id: path.bucket_id,
		database_id: path.database_id,
		retention_ms: None,
	})
}

#[cfg(feature = "test-faults")]
pub async fn set_cold_delete_grace(
	_ctx: ApiCtx,
	path: BranchPath,
	_query: (),
	body: ColdDeleteGraceRequest,
) -> Result<ColdDeleteGraceResponse> {
	anyhow::ensure!(
		(0..=60_000).contains(&body.grace_ms),
		"qualification cold-delete grace must be between 0 and 60000 ms"
	);
	let branch_id = parse_database_branch_id(&path.branch_id)?;
	depot::set_cold_object_delete_grace_for_qualification(branch_id, body.grace_ms);
	Ok(ColdDeleteGraceResponse {
		branch_id: path.branch_id,
		grace_ms: Some(body.grace_ms),
	})
}

#[cfg(feature = "test-faults")]
pub async fn clear_cold_delete_grace(
	_ctx: ApiCtx,
	path: BranchPath,
	_query: (),
) -> Result<ColdDeleteGraceResponse> {
	let branch_id = parse_database_branch_id(&path.branch_id)?;
	depot::clear_cold_object_delete_grace_for_qualification(branch_id);
	Ok(ColdDeleteGraceResponse {
		branch_id: path.branch_id,
		grace_ms: None,
	})
}

pub async fn branch(
	ctx: ApiCtx,
	path: BranchPath,
	query: SampleQuery,
) -> Result<inspect::InspectResponse> {
	let branch_id = parse_database_branch_id(&path.branch_id)?;
	let udb = ctx.pools().udb()?;
	inspect::branch(&udb, ctx.pools().node_id(), branch_id, query).await
}

pub async fn page_trace(
	ctx: ApiCtx,
	path: PageTracePath,
	_query: (),
) -> Result<inspect::InspectResponse> {
	let branch_id = parse_database_branch_id(&path.branch_id)?;
	let udb = ctx.pools().udb()?;
	inspect::page_trace(&udb, ctx.pools().node_id(), branch_id, path.pgno).await
}

pub async fn branch_rows(
	ctx: ApiCtx,
	path: BranchRowsPath,
	query: RowsQuery,
) -> Result<inspect::PaginatedRowsResponse> {
	let branch_id = parse_database_branch_id(&path.branch_id)?;
	let family = inspect::RowFamily::parse(&path.family)?;
	let udb = ctx.pools().udb()?;
	inspect::branch_rows(&udb, ctx.pools().node_id(), branch_id, family, query).await
}

pub async fn raw_key(
	ctx: ApiCtx,
	path: RawKeyPath,
	_query: (),
) -> Result<inspect::InspectResponse> {
	let key = inspect::decode_path_key(&path.key)?;
	let udb = ctx.pools().udb()?;
	inspect::raw_key(&udb, ctx.pools().node_id(), key).await
}

pub async fn raw_scan(
	ctx: ApiCtx,
	_path: (),
	query: RawScanQuery,
) -> Result<inspect::PaginatedRowsResponse> {
	let udb = ctx.pools().udb()?;
	inspect::raw_scan(&udb, ctx.pools().node_id(), query).await
}

pub async fn footprint(
	ctx: ApiCtx,
	_path: (),
	query: FootprintQuery,
) -> Result<inspect::FootprintPageResponse> {
	let prefix = match query.scope.as_str() {
		"application" => Vec::new(),
		"depot" => vec![depot::keys::SQLITE_SUBSPACE_PREFIX],
		"depot-dirty" => vec![
			depot::keys::SQLITE_SUBSPACE_PREFIX,
			depot::keys::SQLITE_CMP_DIRTY_PARTITION,
		],
		"depot-compaction" => vec![
			depot::keys::SQLITE_SUBSPACE_PREFIX,
			depot::keys::CMPC_PARTITION,
		],
		"depot-cold-publish" => depot::keys::cold_upload_job_queue_prefix(),
		"depot-hot-jobs" => depot::keys::hot_compaction_job_queue_prefix(),
		"depot-branch-gc" => vec![
			depot::keys::SQLITE_SUBSPACE_PREFIX,
			depot::keys::DB_BRANCH_GC_QUEUE_PARTITION,
		],
		"depot-cold-gc" => vec![
			depot::keys::SQLITE_SUBSPACE_PREFIX,
			depot::keys::DB_BRANCH_COLD_GC_QUEUE_PARTITION,
		],
		"gasoline" => Subspace::new(&(
			0usize,
			1usize,
			2usize,
			ctx.config().gasoline_cell_namespace(),
		))
		.bytes()
		.to_vec(),
		"reconciliation" => {
			let namespace = query
				.namespace
				.as_ref()
				.context("reconciliation footprint requires namespace")?;
			let envoy_key = query
				.envoy_key
				.as_ref()
				.context("reconciliation footprint requires envoy_key")?;
			let namespace = ctx
				.op(namespace::ops::resolve_for_name_global::Input {
					name: namespace.clone(),
				})
				.await?
				.context("reconciliation footprint namespace was not found")?;
			pegboard::keys::subspace()
				.subspace(&pegboard::keys::envoy::ActorCommandKey::subspace(
					namespace.namespace_id,
					envoy_key.clone(),
				))
				.bytes()
				.to_vec()
		}
		other => anyhow::bail!("unsupported footprint scope {other:?}"),
	};
	let response_scope = if query.scope == "reconciliation" {
		format!(
			"reconciliation:{}",
			query.envoy_key.as_deref().unwrap_or_default()
		)
	} else {
		query.scope
	};
	let udb = ctx.pools().udb()?;
	inspect::footprint_page(
		&udb,
		ctx.pools().node_id(),
		response_scope,
		prefix,
		query.start_after,
		query.limit,
	)
	.await
}

pub async fn due_queue(
	ctx: ApiCtx,
	_path: (),
	query: DueQueueQuery,
) -> Result<inspect::DueQueuePageResponse> {
	let queue = match query.scope.as_str() {
		"branch-gc" => inspect::DueQueue::BranchGc,
		"cold-gc" => inspect::DueQueue::ColdGc,
		other => anyhow::bail!("unsupported due queue scope {other:?}"),
	};
	let udb = ctx.pools().udb()?;
	inspect::due_queue_page(
		&udb,
		ctx.pools().node_id(),
		queue,
		query.start_after,
		query.limit,
		chrono::Utc::now().timestamp_millis(),
	)
	.await
}

pub async fn decode_key(
	ctx: ApiCtx,
	path: RawKeyPath,
	_query: (),
) -> Result<inspect::InspectResponse> {
	let key = inspect::decode_path_key(&path.key)?;
	inspect::decode_key_response(ctx.pools().node_id(), key)
}

pub(crate) fn parse_bucket_id(value: &str) -> Result<BucketId> {
	if let Ok(uuid) = Uuid::parse_str(value) {
		return Ok(BucketId::from_uuid(uuid));
	}

	let gas_id =
		gas::prelude::Id::parse(value).context("parse Depot bucket id as UUID or Gas ID")?;
	Ok(BucketId::from_gas_id(gas_id))
}

fn parse_database_branch_id(value: &str) -> Result<DatabaseBranchId> {
	Ok(DatabaseBranchId::from_uuid(
		Uuid::parse_str(value).context("parse Depot database branch id")?,
	))
}
