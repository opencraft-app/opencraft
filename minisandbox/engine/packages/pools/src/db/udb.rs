use std::{ops::Deref, sync::Arc};

use anyhow::*;
use rivet_config::{Config, config};
use universaldb::{
	prelude::Serializable,
	tuple::Subspace,
	utils::keys::{GLOBAL, RIVET},
};

const STORAGE_CELL_POLICY_MAGIC: &[u8] = b"rivet-fdb-cell-policy-v1\0";
const MAX_SHARED_STORAGE_CELLS: usize = 8;

#[derive(Debug, PartialEq, Eq)]
enum StorageCellPolicy {
	Exclusive(String),
	Shared(Vec<String>),
}

impl StorageCellPolicy {
	fn decode(value: &[u8]) -> Result<Self> {
		let body = value
			.strip_prefix(STORAGE_CELL_POLICY_MAGIC)
			.context("unknown FoundationDB storage Cell policy format")?;
		let (mode, cells) = body
			.split_first()
			.context("empty FoundationDB storage Cell policy")?;
		let cells = cells
			.strip_prefix(b"\0")
			.context("invalid FoundationDB storage Cell policy separator")?;
		let cells = cells
			.split(|byte| *byte == 0)
			.map(|cell| {
				ensure!(
					!cell.is_empty(),
					"empty Cell in FoundationDB storage Cell policy"
				);
				std::str::from_utf8(cell)
					.context("FoundationDB storage Cell policy is not UTF-8")
					.map(str::to_owned)
			})
			.collect::<Result<Vec<_>>>()?;

		match (*mode, cells.as_slice()) {
			(b'E', [cell]) => Ok(Self::Exclusive(cell.clone())),
			(b'S', [_first, ..]) if cells.len() <= MAX_SHARED_STORAGE_CELLS => {
				ensure!(
					cells.windows(2).all(|pair| pair[0] < pair[1]),
					"FoundationDB shared storage Cell policy is not sorted and unique"
				);
				Ok(Self::Shared(cells))
			}
			(b'E', _) => bail!("exclusive FoundationDB storage Cell policy must name one Cell"),
			(b'S', _) => bail!(
				"shared FoundationDB storage Cell policy must name 1-{MAX_SHARED_STORAGE_CELLS} Cells"
			),
			_ => bail!("unknown FoundationDB storage Cell policy mode"),
		}
	}

	fn encode(&self) -> Vec<u8> {
		let (mode, cells): (u8, Vec<&str>) = match self {
			Self::Exclusive(cell) => (b'E', vec![cell]),
			Self::Shared(cells) => (b'S', cells.iter().map(String::as_str).collect()),
		};
		let mut value = Vec::with_capacity(
			STORAGE_CELL_POLICY_MAGIC.len()
				+ 2 + cells.iter().map(|cell| cell.len() + 1).sum::<usize>(),
		);
		value.extend_from_slice(STORAGE_CELL_POLICY_MAGIC);
		value.push(mode);
		for cell in cells {
			value.push(0);
			value.extend_from_slice(cell.as_bytes());
		}
		value
	}

	fn admit(self, cell: &str, allow_shared_cluster: bool) -> Result<Self> {
		match self {
			Self::Exclusive(owner) if owner == cell && !allow_shared_cluster => {
				Ok(Self::Exclusive(owner))
			}
			Self::Exclusive(owner) if owner == cell => Ok(Self::Shared(vec![owner])),
			Self::Exclusive(owner) => bail!(
				"FoundationDB cluster is exclusively bound to Cell '{owner}', not '{cell}'; redeploy the owner with foundation_db.allow_shared_cluster=true before sharing"
			),
			Self::Shared(cells) if !allow_shared_cluster => bail!(
				"FoundationDB cluster is registered as shared by Cells [{}], but Cell '{cell}' did not set foundation_db.allow_shared_cluster=true",
				cells.join(", ")
			),
			Self::Shared(mut cells) => {
				if !cells.iter().any(|existing| existing == cell) {
					ensure!(
						cells.len() < MAX_SHARED_STORAGE_CELLS,
						"FoundationDB cluster already has the maximum of {MAX_SHARED_STORAGE_CELLS} shared Cells"
					);
					cells.push(cell.to_owned());
					cells.sort_unstable();
				}
				Ok(Self::Shared(cells))
			}
		}
	}
}

fn storage_cell_policy_key() -> Vec<u8> {
	Subspace::all().pack(&(RIVET, GLOBAL, "fdb-storage-cell-policy", 1usize))
}

async fn enforce_fdb_storage_cell_policy(
	db: &universaldb::Database,
	cell: &str,
	allow_shared_cluster: bool,
) -> Result<()> {
	let key = storage_cell_policy_key();
	let cell = cell.to_owned();
	db.txn("claim_fdb_storage_cell", |tx| {
		let key = key.clone();
		let cell = cell.clone();
		async move {
			let current = tx.get(&key, Serializable).await?;
			let next = match current.as_ref() {
				Some(value) => StorageCellPolicy::decode(value.as_slice())?
					.admit(&cell, allow_shared_cluster)?,
				None if allow_shared_cluster => StorageCellPolicy::Shared(vec![cell.clone()]),
				None => StorageCellPolicy::Exclusive(cell.clone()),
			};
			let encoded = next.encode();
			if current.as_ref().map(|value| value.as_slice()) != Some(encoded.as_slice()) {
				tx.set(&key, &encoded);
			}
			Ok(())
		}
	})
	.await
	.context("failed to claim FoundationDB physical cluster for Rivet storage Cell")
}

#[derive(Clone)]
pub struct UdbPool {
	db: universaldb::Database,
}

impl Deref for UdbPool {
	type Target = universaldb::Database;

	fn deref(&self) -> &Self::Target {
		&self.db
	}
}

#[tracing::instrument(skip(config))]
pub async fn setup(config: &Config) -> Result<Option<UdbPool>> {
	let db_driver = match config.database() {
		config::Database::FoundationDb(fdb) => {
			#[cfg(feature = "foundationdb")]
			{
				let driver = universaldb::driver::FoundationDbDatabaseDriver::new(
					universaldb::driver::FoundationDbConfig {
						cluster_file: fdb.cluster_file.clone(),
					},
				)?;
				universaldb::driver::DatabaseDriver::txn_retry_limit(
					&driver,
					fdb.transaction_retry_limit,
				)?;
				Arc::new(driver) as universaldb::DatabaseDriverHandle
			}
			#[cfg(not(feature = "foundationdb"))]
			{
				let _ = fdb;
				bail!(
					"FoundationDB is configured, but this Rivet binary was built without the `foundationdb` feature"
				)
			}
		}
		config::Database::Postgres(pg) => {
			// A NATS config (set directly or inherited from the UPS config in
			// `validate_and_set_defaults`) selects UniversalDB multi-node mode.
			let nats = pg
				.nats
				.as_ref()
				.map(|nats| universaldb::driver::postgres::NatsConfig {
					addresses: nats.addresses.clone(),
					username: nats.username.clone(),
					password: nats.password.as_ref().map(|p| p.read().clone()),
					connection_timeout_ms: nats.connection_timeout_ms,
					client_capacity: nats.client_capacity,
					subscription_capacity: nats.subscription_capacity,
				});

			let postgres_config = universaldb::driver::postgres::PostgresConfig {
				connection_string: pg.url.read().clone(),
				ssl_config: pg.ssl.as_ref().map(|ssl| {
					universaldb::driver::postgres::PostgresSslConfig {
						ssl_root_cert_path: ssl.root_cert_path.clone(),
						ssl_client_cert_path: ssl.client_cert_path.clone(),
						ssl_client_key_path: ssl.client_key_path.clone(),
					}
				}),
				nats,
			};

			Arc::new(
				universaldb::driver::PostgresDatabaseDriver::new_with_config(postgres_config)
					.await?,
			) as universaldb::DatabaseDriverHandle
		}
		config::Database::FileSystem(fs) => {
			Arc::new(universaldb::driver::RocksDbDatabaseDriver::new(fs.path.clone()).await?)
				as universaldb::DatabaseDriverHandle
		}
	};

	let db = universaldb::Database::new(db_driver)
		.with_default_transaction_tag(config.gasoline_cell_namespace());
	if let config::Database::FoundationDb(fdb) = config.database() {
		enforce_fdb_storage_cell_policy(
			&db,
			config.gasoline_cell_namespace(),
			fdb.allow_shared_cluster,
		)
		.await?;
	}

	tracing::debug!("udb started");

	Ok(Some(UdbPool { db }))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn storage_cell_policy_requires_a_two_sided_shared_opt_in() {
		let exclusive = StorageCellPolicy::Exclusive("actor-bj-a01".into());
		assert_eq!(
			exclusive
				.admit("actor-bj-a01", false)
				.expect("the exclusive owner should be admitted"),
			StorageCellPolicy::Exclusive("actor-bj-a01".into())
		);

		let error = StorageCellPolicy::Exclusive("actor-bj-a01".into())
			.admit("actor-sh-a01", true)
			.expect_err("a new Cell cannot unilaterally convert another Cell's cluster");
		assert!(error.to_string().contains("redeploy the owner"));

		let shared = StorageCellPolicy::Exclusive("actor-bj-a01".into())
			.admit("actor-bj-a01", true)
			.expect("the owner should be able to opt in first")
			.admit("actor-sh-a01", true)
			.expect("a second opted-in Cell should then be admitted");
		assert_eq!(
			shared,
			StorageCellPolicy::Shared(vec!["actor-bj-a01".into(), "actor-sh-a01".into()])
		);

		let error = shared
			.admit("actor-bj-a01", false)
			.expect_err("every process must acknowledge a shared physical cluster");
		assert!(error.to_string().contains("did not set"));
	}

	#[test]
	fn storage_cell_policy_encoding_is_versioned_and_fail_closed() {
		let policy = StorageCellPolicy::Shared(vec!["actor-bj-a01".into(), "actor-sh-a01".into()]);
		assert_eq!(
			StorageCellPolicy::decode(&policy.encode()).expect("policy should round trip"),
			policy
		);
		assert!(StorageCellPolicy::decode(b"legacy-unversioned-value").is_err());
		assert!(
			StorageCellPolicy::decode(b"rivet-fdb-cell-policy-v1\0S\0actor-sh-a01\0actor-bj-a01")
				.is_err()
		);
	}

	#[tokio::test]
	async fn concurrent_first_claims_leave_exactly_one_exclusive_owner() {
		let temp_dir = tempfile::tempdir().expect("temporary RocksDB directory");
		let driver = universaldb::driver::RocksDbDatabaseDriver::new(temp_dir.path().join("udb"))
			.await
			.expect("RocksDB driver should start");
		let db = universaldb::Database::new(Arc::new(driver));

		let (beijing, shanghai) = tokio::join!(
			enforce_fdb_storage_cell_policy(&db, "actor-bj-a01", false),
			enforce_fdb_storage_cell_policy(&db, "actor-sh-a01", false),
		);
		assert_ne!(
			beijing.is_ok(),
			shanghai.is_ok(),
			"a concurrent empty-cluster claim must elect exactly one exclusive Cell"
		);

		let (owner, other) = if beijing.is_ok() {
			("actor-bj-a01", "actor-sh-a01")
		} else {
			("actor-sh-a01", "actor-bj-a01")
		};
		enforce_fdb_storage_cell_policy(&db, owner, false)
			.await
			.expect("the elected owner should restart idempotently");
		assert!(
			enforce_fdb_storage_cell_policy(&db, other, true)
				.await
				.is_err(),
			"a second Cell must not unilaterally enable sharing"
		);

		enforce_fdb_storage_cell_policy(&db, owner, true)
			.await
			.expect("the owner should explicitly convert the policy to shared");
		enforce_fdb_storage_cell_policy(&db, other, true)
			.await
			.expect("the second explicitly opted-in Cell should now join");
		assert!(
			enforce_fdb_storage_cell_policy(&db, owner, false)
				.await
				.is_err(),
			"a process without the shared-cluster acknowledgement must fail closed"
		);
	}

	#[tokio::test]
	async fn same_cell_restart_storm_is_idempotent() {
		let temp_dir = tempfile::tempdir().expect("temporary RocksDB directory");
		let driver = universaldb::driver::RocksDbDatabaseDriver::new(temp_dir.path().join("udb"))
			.await
			.expect("RocksDB driver should start");
		let db = universaldb::Database::new(Arc::new(driver));
		enforce_fdb_storage_cell_policy(&db, "actor-bj-a01", false)
			.await
			.expect("initial Cell claim should succeed");

		let results = futures_util::future::join_all(
			(0..32).map(|_| enforce_fdb_storage_cell_policy(&db, "actor-bj-a01", false)),
		)
		.await;
		assert!(
			results.iter().all(Result::is_ok),
			"all same-Cell restart claims should be read-only and succeed: {results:?}"
		);
	}
}
