use std::{collections::BTreeSet, path::PathBuf, process, sync::Arc};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use clap::{Parser, ValueEnum};
use depot::conveyer::Db;
use depot::doctor::{DoctorInput, DoctorSelector, SkipOptions, doctor, exit_code_for_verdict};
use depot_client_types::{ColumnValue, QueryResult};
use gas::prelude::Id;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use universaldb::utils::Subspace;
use universaldb::{Database, utils::IsolationLevel::*};
use uuid::Uuid;

#[derive(Parser)]
pub enum SubCommand {
	/// Diagnose Depot-backed SQLite storage for one database
	Doctor(DoctorOpts),
	/// Execute SQL against one Depot-backed SQLite database
	Execute(ExecuteOpts),
	/// Show the durable cold-object backup recovery certificate
	BackupFenceShow,
	/// Observe the configured fdbbackup repository and renew the recovery fence once
	BackupFenceControllerRunOnce,
	/// Rebind the durable recovery policy after the old contract has been explicitly retired
	BackupFencePolicyRebind(BackupFencePolicyRebindOpts),
	/// Show the Cell-wide irreversible cold-object deletion policy
	ColdGcPolicyShow,
	/// CAS-update the Cell-wide irreversible cold-object deletion policy
	ColdGcPolicySet(ColdGcPolicySetOpts),
	/// Read one bounded physical object-store inventory page and classify it against FDB ownership
	ColdInventoryScan(ColdInventoryScanOpts),
	/// Show the immutable completion receipt for one exact cold-object key
	ColdDeleteReceiptShow(ColdDeleteReceiptShowOpts),
	/// Show the durable Cell-wide cold-storage physical accounting ledger
	ColdStorageAccountingShow,
	/// Measure raw FDB keys and bytes without starting Engine workflow workers
	Footprint(FootprintOpts),
}

impl SubCommand {
	pub async fn execute(self, config: rivet_config::Config) -> Result<()> {
		match self {
			Self::Doctor(opts) => opts.execute(config).await,
			Self::Execute(opts) => opts.execute(config).await,
			Self::BackupFenceShow => backup_fence_show(config).await,
			Self::BackupFenceControllerRunOnce => backup_fence_controller_run_once(config).await,
			Self::BackupFencePolicyRebind(opts) => opts.execute(config).await,
			Self::ColdGcPolicyShow => cold_gc_policy_show(config).await,
			Self::ColdGcPolicySet(opts) => opts.execute(config).await,
			Self::ColdInventoryScan(opts) => opts.execute(config).await,
			Self::ColdDeleteReceiptShow(opts) => opts.execute(config).await,
			Self::ColdStorageAccountingShow => cold_storage_accounting_show(config).await,
			Self::Footprint(opts) => opts.execute(config).await,
		}
	}
}

async fn cold_storage_accounting_show(config: rivet_config::Config) -> Result<()> {
	let pools = rivet_pools::Pools::new(config).await?;
	let udb = pools.udb()?;
	let accounting = depot::cold_tier::accounting::read(&udb).await?;
	println!("{}", serde_json::to_string_pretty(&accounting)?);
	Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum FootprintScope {
	Application,
	Depot,
	Gasoline,
}

impl FootprintScope {
	fn name(self) -> &'static str {
		match self {
			Self::Application => "application",
			Self::Depot => "depot",
			Self::Gasoline => "gasoline",
		}
	}

	fn prefix(self, config: &rivet_config::Config) -> Vec<u8> {
		match self {
			Self::Application => Vec::new(),
			Self::Depot => vec![depot::keys::SQLITE_SUBSPACE_PREFIX],
			Self::Gasoline => {
				Subspace::new(&(0usize, 1usize, 2usize, config.gasoline_cell_namespace()))
					.bytes()
					.to_vec()
			}
		}
	}
}

#[derive(Parser)]
pub struct FootprintOpts {
	/// Scope to measure. Repeat to select multiple scopes; defaults to all three.
	#[arg(long, value_enum)]
	scope: Vec<FootprintScope>,
	/// Maximum rows read by each individual FDB transaction.
	#[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u16).range(1..=1000))]
	page_limit: u16,
}

impl FootprintOpts {
	async fn execute(self, config: rivet_config::Config) -> Result<()> {
		let pools = rivet_pools::Pools::new(config.clone()).await?;
		let udb = pools.udb()?;
		let scopes = if self.scope.is_empty() {
			vec![
				FootprintScope::Application,
				FootprintScope::Depot,
				FootprintScope::Gasoline,
			]
		} else {
			self.scope
		};
		let mut measured = serde_json::Map::new();
		for scope in scopes {
			let name = scope.name();
			ensure!(
				!measured.contains_key(name),
				"duplicate footprint scope {name}"
			);
			let mut cursor = None;
			let mut pages = 0u64;
			let mut keys = 0u64;
			let mut key_bytes = 0u64;
			let mut value_bytes = 0u64;
			let mut transcript = Sha256::new();
			let mut seen_cursors = BTreeSet::new();
			loop {
				let page = depot::inspect::footprint_page(
					&udb,
					pools.node_id(),
					name.to_owned(),
					scope.prefix(&config),
					cursor,
					Some(usize::from(self.page_limit)),
				)
				.await?;
				pages += 1;
				keys += u64::try_from(page.row_count)?;
				key_bytes += u64::try_from(page.key_bytes)?;
				value_bytes += u64::try_from(page.value_bytes)?;
				transcript.update(serde_json::to_vec(&json!({
					"row_count": page.row_count,
					"key_bytes": page.key_bytes,
					"value_bytes": page.value_bytes,
					"page_sha256": page.page_sha256,
					"first_key": page.first_key,
					"last_key": page.last_key,
				}))?);
				if let Some(next_cursor) = page.next_cursor {
					ensure!(
						seen_cursors.insert(next_cursor.clone()),
						"footprint cursor cycle in scope {name}"
					);
					cursor = Some(next_cursor);
				} else {
					break;
				}
			}
			measured.insert(
				name.to_owned(),
				json!({
					"scope": name,
					"pages": pages,
					"page_limit": self.page_limit,
					"keys": keys,
					"key_bytes": key_bytes,
					"value_bytes": value_bytes,
					"raw_bytes": key_bytes + value_bytes,
					"content_sha256": hex::encode(transcript.finalize()),
				}),
			);
		}
		println!(
			"{}",
			serde_json::to_string_pretty(&json!({
				"offline_reader": true,
				"writers_required_stopped": true,
				"byte_semantics": "raw logical key+value bytes; excludes FDB/storage replication overhead",
				"scopes": measured,
			}))?
		);
		Ok(())
	}
}

#[derive(Parser)]
pub struct BackupFencePolicyRebindOpts {
	/// Current SHA-256 fingerprint printed by backup-fence-show.
	#[arg(long)]
	expected_current_sha256: String,
	/// Confirms that every restore under the old base URL is no longer supported or available.
	#[arg(long)]
	confirm_old_recovery_contract_retired: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ColdGcPolicyState {
	Enabled,
	Disabled,
}

#[derive(Parser)]
pub struct ColdGcPolicySetOpts {
	/// Current revision printed by cold-gc-policy-show. Missing policy has revision zero.
	#[arg(long)]
	expected_revision: u64,
	#[arg(long, value_enum)]
	state: ColdGcPolicyState,
	/// Required when enabling irreversible exact-key deletion.
	#[arg(long)]
	confirm_irreversible_exact_key_deletion: bool,
	#[arg(long, default_value_t = depot::cold_tier::DEFAULT_COLD_GC_GRACE_PERIOD_MS)]
	grace_period_ms: u64,
	#[arg(long, default_value_t = depot::cold_tier::DEFAULT_COLD_GC_MAX_DELETE_CONCURRENCY)]
	max_delete_concurrency: u16,
	#[arg(long, default_value_t = depot::cold_tier::DEFAULT_COLD_GC_MAX_OBJECTS_PER_BATCH)]
	max_objects_per_batch: u16,
	#[arg(long, default_value_t = depot::cold_tier::DEFAULT_COLD_GC_RETRY_MAX_ATTEMPTS)]
	retry_max_attempts: u16,
	#[arg(long, default_value_t = depot::cold_tier::DEFAULT_COLD_GC_RETRY_INITIAL_BACKOFF_MS)]
	retry_initial_backoff_ms: u64,
	#[arg(long, default_value_t = depot::cold_tier::DEFAULT_COLD_GC_RETRY_MAX_BACKOFF_MS)]
	retry_max_backoff_ms: u64,
	/// Validate eligibility and expose backlog without issuing object-store DELETE calls.
	#[arg(long)]
	dry_run: bool,
}

#[derive(Parser)]
pub struct ColdInventoryScanOpts {
	/// Opaque cursor returned by the previous page.
	#[arg(long)]
	cursor: Option<String>,
	#[arg(long, default_value_t = 250, value_parser = clap::value_parser!(u16).range(1..=1000))]
	page_limit: u16,
}

#[derive(Parser)]
pub struct ColdDeleteReceiptShowOpts {
	#[arg(long)]
	object_key: String,
}

impl ColdDeleteReceiptShowOpts {
	async fn execute(self, config: rivet_config::Config) -> Result<()> {
		let pools = rivet_pools::Pools::new(config).await?;
		let udb = pools.udb()?;
		let receipt = depot::cold_tier::read_cold_delete_receipt(&udb, &self.object_key)
			.await?
			.context("cold delete receipt was not found")?;
		println!("{}", serde_json::to_string_pretty(&receipt)?);
		Ok(())
	}
}

impl ColdInventoryScanOpts {
	async fn execute(self, config: rivet_config::Config) -> Result<()> {
		let pools = rivet_pools::Pools::new(config.clone()).await?;
		let udb = pools.udb()?;
		let report = depot::cold_tier::scan_cold_inventory_page(
			&config,
			&udb,
			self.cursor.as_deref(),
			self.page_limit,
		)
		.await?;
		println!("{}", serde_json::to_string_pretty(&report)?);
		Ok(())
	}
}

impl ColdGcPolicySetOpts {
	async fn execute(self, config: rivet_config::Config) -> Result<()> {
		let enabling = self.state == ColdGcPolicyState::Enabled;
		ensure!(
			!enabling || self.confirm_irreversible_exact_key_deletion,
			"--confirm-irreversible-exact-key-deletion is required when enabling ColdGcPolicy"
		);
		if enabling {
			ensure!(
				config.sqlite().backup_recovery_fence_controller().is_some(),
				"cannot enable ColdGcPolicy without sqlite.backup_recovery_fence_controller"
			);
		}
		let pools = rivet_pools::Pools::new(config).await?;
		let udb = pools.udb()?;
		if enabling {
			let fence = depot::backup_fence::read_cold_backup_recovery_fence(&udb)
				.await?
				.context("cannot enable ColdGcPolicy before a recovery fence is certified")?;
			let fingerprint =
				depot::backup_fence::read_cold_backup_recovery_policy_fingerprint(&udb)
					.await?
					.context("cannot enable ColdGcPolicy before recovery policy binding")?;
			let now_ms = rivet_util::timestamp::now();
			ensure!(
				fence.policy_fingerprint == fingerprint
					&& fence.verified_at_ms <= now_ms
					&& fence.valid_until_ms >= now_ms,
				"cannot enable ColdGcPolicy without a fresh matching backup recovery fence"
			);
		}
		let policy = depot::cold_tier::set_cold_gc_policy(
			&udb,
			self.expected_revision,
			depot::cold_tier::ColdGcPolicySpec {
				deletion_enabled: enabling,
				grace_period_ms: self.grace_period_ms,
				max_delete_concurrency: self.max_delete_concurrency,
				max_objects_per_batch: self.max_objects_per_batch,
				retry_max_attempts: self.retry_max_attempts,
				retry_initial_backoff_ms: self.retry_initial_backoff_ms,
				retry_max_backoff_ms: self.retry_max_backoff_ms,
				dry_run: self.dry_run,
			},
			rivet_util::timestamp::now(),
		)
		.await?;
		println!("{}", serde_json::to_string_pretty(&policy)?);
		Ok(())
	}
}

async fn cold_gc_policy_show(config: rivet_config::Config) -> Result<()> {
	let pools = rivet_pools::Pools::new(config).await?;
	let udb = pools.udb()?;
	let policy = depot::cold_tier::read_cold_gc_policy(&udb).await?;
	println!("{}", serde_json::to_string_pretty(&policy)?);
	Ok(())
}

impl BackupFencePolicyRebindOpts {
	async fn execute(self, config: rivet_config::Config) -> Result<()> {
		ensure!(
			self.confirm_old_recovery_contract_retired,
			"--confirm-old-recovery-contract-retired is required"
		);
		let controller = config
			.sqlite()
			.backup_recovery_fence_controller()
			.context("sqlite.backup_recovery_fence_controller is not configured")?;
		let expected: [u8; 32] = hex::decode(self.expected_current_sha256.trim())
			.context("decode --expected-current-sha256")?
			.try_into()
			.map_err(|_| {
				anyhow::anyhow!("--expected-current-sha256 must contain exactly 32 bytes")
			})?;
		let replacement = crate::backup_fence_controller::backup_policy_fingerprint(controller);
		let pools = rivet_pools::Pools::new(config).await?;
		let udb = pools.udb()?;
		ensure!(
			!depot::cold_tier::read_cold_gc_policy(&udb)
				.await?
				.spec
				.deletion_enabled,
			"disable ColdGcPolicy before rebinding the backup recovery policy"
		);
		depot::backup_fence::rebind_cold_backup_recovery_policy(&udb, expected, replacement)
			.await?;
		println!(
			"{}",
			serde_json::to_string_pretty(&json!({
				"policy_fingerprint_sha256": hex::encode(replacement),
				"fence_invalidated": true,
				"restore_floor_high_water_preserved": true,
			}))?
		);
		Ok(())
	}
}

async fn backup_fence_show(config: rivet_config::Config) -> Result<()> {
	let pools = rivet_pools::Pools::new(config).await?;
	let udb = pools.udb()?;
	let fence = depot::backup_fence::read_cold_backup_recovery_fence(&udb).await?;
	let policy_fingerprint =
		depot::backup_fence::read_cold_backup_recovery_policy_fingerprint(&udb).await?;
	println!(
		"{}",
		serde_json::to_string_pretty(&json!({
			"fence": fence,
			"policy_fingerprint_sha256": policy_fingerprint.map(hex::encode),
		}))?
	);
	Ok(())
}

async fn backup_fence_controller_run_once(config: rivet_config::Config) -> Result<()> {
	let controller = config
		.sqlite()
		.backup_recovery_fence_controller()
		.context("sqlite.backup_recovery_fence_controller is not configured")?
		.clone();
	let cluster_file = crate::backup_fence_controller::foundationdb_cluster_file(&config)?;
	let pools = rivet_pools::Pools::new(config).await?;
	let udb = pools.udb()?;
	let observation = crate::backup_fence_controller::observe_and_certify_once(
		&controller,
		cluster_file.as_deref(),
		&udb,
	)
	.await?;
	println!("{}", serde_json::to_string_pretty(&observation)?);
	Ok(())
}

#[derive(Parser)]
pub struct DoctorOpts {
	#[arg(long)]
	bucket_id: Option<Uuid>,
	#[arg(long)]
	database_id: Option<String>,
	#[arg(long)]
	actor_id: Option<Id>,
	#[arg(long)]
	database_branch_id: Option<Uuid>,
	#[arg(long)]
	artifact_dir: Option<PathBuf>,
	#[arg(long)]
	skip_full_integrity_check: bool,
	#[arg(long)]
	skip_first_bad_txid: bool,
	#[arg(long)]
	skip_page_provenance: bool,
	#[arg(long)]
	skip_resolver_compare: bool,
	#[arg(long)]
	min_txid: Option<u64>,
	#[arg(long)]
	max_txid: Option<u64>,
}

impl DoctorOpts {
	pub async fn execute(self, config: rivet_config::Config) -> Result<()> {
		let pools = rivet_pools::Pools::new(config).await?;
		let udb = pools.udb()?;
		let selector = self.selector(&udb).await?;

		let input = DoctorInput {
			selector,
			artifact_dir: self.artifact_dir,
			skip: SkipOptions {
				full_integrity_check: self.skip_full_integrity_check,
				first_bad_txid: self.skip_first_bad_txid,
				page_provenance: self.skip_page_provenance,
				resolver_compare: self.skip_resolver_compare,
			},
			min_txid: self.min_txid,
			max_txid: self.max_txid,
			progress_hook: None,
		};

		let report = doctor(&udb, input).await.context("run depot doctor")?;
		let code = exit_code_for_verdict(report.verdict.verdict);
		println!("{}", serde_json::to_string_pretty(&report)?);

		if code == 0 {
			Ok(())
		} else {
			process::exit(code);
		}
	}

	async fn selector(&self, udb: &Database) -> Result<DoctorSelector> {
		let bucket_database = self.bucket_id.is_some() || self.database_id.is_some();
		let actor = self.actor_id.is_some();
		let branch = self.database_branch_id.is_some();
		let selector_count =
			usize::from(bucket_database) + usize::from(actor) + usize::from(branch);
		if selector_count != 1 {
			bail!(
				"provide exactly one selector: --bucket-id/--database-id, --actor-id, or --database-branch-id"
			);
		}

		if bucket_database {
			return Ok(DoctorSelector::BucketDatabase {
				bucket_id: self
					.bucket_id
					.context("--bucket-id is required with --database-id")?,
				database_id: self
					.database_id
					.clone()
					.context("--database-id is required with --bucket-id")?,
			});
		}

		if actor {
			let actor_id = self.actor_id.context("--actor-id is required")?;
			let namespace_id = lookup_actor_namespace_id(udb, actor_id).await?;
			return Ok(DoctorSelector::Actor {
				namespace_id,
				actor_id,
			});
		}

		Ok(DoctorSelector::DatabaseBranch {
			database_branch_id: self
				.database_branch_id
				.context("--database-branch-id is required")?,
		})
	}
}

#[derive(Parser)]
pub struct ExecuteOpts {
	#[arg(long)]
	bucket_id: Option<Uuid>,
	#[arg(long)]
	database_id: Option<String>,
	#[arg(long)]
	actor_id: Option<Id>,
	#[arg(short = 'q', long)]
	query: String,
}

impl ExecuteOpts {
	pub async fn execute(self, config: rivet_config::Config) -> Result<()> {
		let pools = rivet_pools::Pools::new(config.clone()).await?;
		let udb = pools.udb()?;
		depot::cold_tier::ensure_cold_tier_identity(&config, &udb)
			.await
			.context("validate Depot cold-tier identity")?;
		let cold_tier = depot::cold_tier::cold_tier_from_config(&config)
			.await
			.context("initialize Depot cold tier")?;
		let target = self.target(&udb).await?;
		let db = Arc::new(match cold_tier {
			Some(cold_tier) => Db::new_with_cold_tier(
				Arc::new((*udb).clone()),
				target.bucket_id,
				target.database_id.clone(),
				pools.node_id(),
				cold_tier,
			),
			None => Db::new(
				Arc::new((*udb).clone()),
				target.bucket_id,
				target.database_id.clone(),
				pools.node_id(),
			),
		});

		let sqlite = depot_client_embedded::open_database_from_embedded_depot(
			db,
			target.database_id,
			0,
			tokio::runtime::Handle::current(),
			None,
		)
		.await
		.context("open Depot-backed SQLite database")?;
		let result = sqlite.exec(self.query).await.context("execute SQL");
		let close_result = sqlite.close().await.context("close SQLite database");
		let result = match (result, close_result) {
			(Ok(result), Ok(())) => result,
			(Err(error), _) => return Err(error),
			(Ok(_), Err(error)) => return Err(error),
		};

		println!(
			"{}",
			serde_json::to_string_pretty(&query_result_json(result))?
		);

		Ok(())
	}

	async fn target(&self, udb: &Database) -> Result<ExecuteTarget> {
		let bucket_database = self.bucket_id.is_some() || self.database_id.is_some();
		let actor = self.actor_id.is_some();
		let selector_count = usize::from(bucket_database) + usize::from(actor);
		if selector_count != 1 {
			bail!("provide exactly one selector: --bucket-id/--database-id or --actor-id");
		}

		if bucket_database {
			let bucket_id = self
				.bucket_id
				.context("--bucket-id is required with --database-id")?;
			let database_id = self
				.database_id
				.clone()
				.context("--database-id is required with --bucket-id")?;
			return Ok(ExecuteTarget {
				bucket_id: Id::v1(bucket_id, 0),
				database_id,
			});
		}

		let actor_id = self.actor_id.context("--actor-id is required")?;
		let namespace_id = lookup_actor_namespace_id(udb, actor_id).await?;
		Ok(ExecuteTarget {
			bucket_id: namespace_id,
			database_id: actor_id.to_string(),
		})
	}
}

struct ExecuteTarget {
	bucket_id: Id,
	database_id: String,
}

fn query_result_json(result: QueryResult) -> Value {
	json!({
		"columns": result.columns,
		"rows": result.rows.into_iter().map(row_json).collect::<Vec<_>>(),
	})
}

fn row_json(row: Vec<ColumnValue>) -> Value {
	Value::Array(row.into_iter().map(column_value_json).collect())
}

fn column_value_json(value: ColumnValue) -> Value {
	match value {
		ColumnValue::Null => Value::Null,
		ColumnValue::Integer(value) => json!(value),
		ColumnValue::Float(value) => json!(value),
		ColumnValue::Text(value) => json!(value),
		ColumnValue::Blob(value) => json!({
			"type": "blob",
			"base64": STANDARD.encode(value),
		}),
	}
}

async fn lookup_actor_namespace_id(udb: &Database, actor_id: Id) -> Result<Id> {
	udb.txn("engine_depot_lookup_actor_namespace", |tx| async move {
		let tx = tx.with_subspace(pegboard::keys::subspace());
		let namespace_id_key = pegboard::keys::actor::NamespaceIdKey::new(actor_id);

		tx.read_opt(&namespace_id_key, Serializable)
			.await?
			.with_context(|| format!("actor namespace id not found for actor_id {actor_id}"))
	})
	.await
	.context("look up actor namespace id")
}
