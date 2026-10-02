use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use indoc::formatdoc;
use rivet_service_manager::RunConfig;
use universaldb::utils::IsolationLevel::*;

use crate::keys;

// 7 day logs retention
const LOGS_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Parser)]
pub struct Opts {
	#[arg(short = 's', long, conflicts_with = "except_services")]
	services: Vec<String>,

	/// Exclude the specified services instead of including them
	#[arg(long)]
	except_services: Vec<String>,
}

impl Opts {
	pub async fn execute(
		&self,
		config: rivet_config::Config,
		run_config: &RunConfig,
	) -> Result<()> {
		// Redirect logs if enabled on the edge
		if let Some(logs_dir) = config.logs().redirect_logs_dir.as_ref() {
			rivet_logs::Logs::new(logs_dir.clone(), LOGS_RETENTION)
				.start()
				.await?;
		}

		// Select services to run
		let services = if self.services.is_empty() && self.except_services.is_empty() {
			// Run all services
			run_config.services.clone()
		} else if !self.except_services.is_empty() {
			let mut services = run_config.services.clone();

			for exclude_name in &self.except_services {
				if !run_config
					.services
					.iter()
					.any(|service| service.name == exclude_name)
				{
					bail!("service {exclude_name:?} not found");
				}

				services.retain(|service| service.name != exclude_name);
			}

			services
		} else {
			let mut services = Vec::new();

			for name in &self.services {
				let Some(service) = run_config
					.services
					.iter()
					.find(|service| service.name == name)
				else {
					bail!("service {name:?} not found");
				};

				services.push(service.clone());
			}

			services
		};

		let pools = rivet_pools::Pools::new(config.clone()).await?;
		depot::conveyer::metrics::initialize_cold_tier_metrics();
		depot::metrics::initialize_cold_tier_metrics();

		verify_engine_version(&config, &pools).await?;
		let udb = pools.udb()?;
		depot::cold_tier::ensure_cold_tier_identity(&config, &udb)
			.await
			.context("validate Depot cold-tier identity")?;
		// Every Engine exports the same durable Cell ledger. Fleet PromQL must aggregate replicas
		// with `max by (cell)`, never sum them.
		let accounting_udb = udb.clone();
		tokio::spawn(async move {
			loop {
				match depot::cold_tier::accounting::read(&accounting_udb).await {
					Ok(accounting) => depot::metrics::set_cold_storage_accounting(accounting),
					Err(error) => {
						tracing::warn!(?error, "failed to sample Depot cold storage accounting")
					}
				}
				match depot::cold_tier::read_cold_gc_policy(&accounting_udb).await {
					Ok(policy) => depot::metrics::set_cold_gc_policy(policy),
					Err(error) => tracing::warn!(?error, "failed to sample Depot ColdGcPolicy"),
				}
				tokio::time::sleep(std::time::Duration::from_secs(15)).await;
			}
		});
		if config.sqlite().workflow_cold_storage().is_some() {
			let inventory_config = config.clone();
			let inventory_udb = udb.clone();
			let inventory_holder_id = *pools.node_id().as_uuid().as_bytes();
			tokio::spawn(async move {
				const MAX_AUDIT_OBJECTS: u64 = 100_000;
				const AUDIT_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
				const AUDIT_RETRY_INTERVAL: Duration = Duration::from_secs(60);
				loop {
					let now_ms = rivet_util::timestamp::now();
					match depot::cold_tier::read_cold_inventory_audit_state(&inventory_udb).await {
						Ok(Some(state)) => {
							depot::metrics::set_cold_inventory_audit_state(&state);
							let interval_ms = i64::try_from(AUDIT_INTERVAL.as_millis())
								.expect("cold inventory audit interval fits i64");
							let next_audit_at_ms = state.observed_at_ms.saturating_add(interval_ms);
							if next_audit_at_ms > now_ms {
								tokio::time::sleep(Duration::from_millis(
									u64::try_from(next_audit_at_ms - now_ms)
										.expect("positive audit delay fits u64"),
								))
								.await;
								continue;
							}
						}
						Ok(None) => {}
						Err(error) => {
							tracing::warn!(
								?error,
								"failed to read Depot cold inventory audit state"
							);
							tokio::time::sleep(AUDIT_RETRY_INTERVAL).await;
							continue;
						}
					}

					let delay = match depot::cold_tier::try_acquire_cold_inventory_audit_lease(
						&inventory_udb,
						inventory_holder_id,
						now_ms,
						depot::cold_tier::COLD_INVENTORY_AUDIT_MAX_LEASE_MS,
					)
					.await
					{
						Ok(true) => {
							match depot::cold_tier::audit_cold_inventory(
								&inventory_config,
								&inventory_udb,
								MAX_AUDIT_OBJECTS,
							)
							.await
							{
								Ok(summary) => {
									match depot::cold_tier::complete_cold_inventory_audit(
										&inventory_udb,
										inventory_holder_id,
										summary,
										rivet_util::timestamp::now(),
									)
									.await
									{
										Ok(state) => {
											depot::metrics::set_cold_inventory_audit_state(&state);
											AUDIT_INTERVAL
										}
										Err(error) => {
											tracing::warn!(
												?error,
												"failed to persist Depot cold inventory audit"
											);
											AUDIT_RETRY_INTERVAL
										}
									}
								}
								Err(error) => {
									tracing::warn!(
										?error,
										"failed to audit Depot cold object inventory"
									);
									if let Err(release_error) =
										depot::cold_tier::release_cold_inventory_audit_lease(
											&inventory_udb,
											inventory_holder_id,
										)
										.await
									{
										tracing::warn!(
											?release_error,
											"failed to release Depot cold inventory audit lease"
										);
									}
									AUDIT_RETRY_INTERVAL
								}
							}
						}
						Ok(false) => AUDIT_RETRY_INTERVAL,
						Err(error) => {
							tracing::warn!(
								?error,
								"failed to acquire Depot cold inventory audit lease"
							);
							AUDIT_RETRY_INTERVAL
						}
					};
					tokio::time::sleep(delay).await;
				}
			});
		}

		// Start server
		rivet_service_manager::start(config, pools, services).await?;

		Ok(())
	}
}

/// Verifies that no rollback has occurred (if allowing rollback is disabled).
async fn verify_engine_version(
	config: &rivet_config::Config,
	pools: &rivet_pools::Pools,
) -> Result<()> {
	if config.runtime.allow_version_rollback() {
		return Ok(());
	}

	pools
		.udb()?
		.txn("engine_check_version_rollback", |tx| async move {
			let current_version = semver::Version::parse(env!("CARGO_PKG_VERSION")).context("failed to parse cargo pkg version as semver")?;

			if let Some(existing_version) = tx.read_opt(&keys::EngineVersionKey {}, Serializable).await? {
				if current_version < existing_version {
					return Ok(Err(anyhow!(
						"{}",
						formatdoc!(
							"
						Rivet Engine has been rolled back to a previous version:
						  - Last Used Version: {existing_version}
						  - Current Version:   {current_version}
						Cannot proceed without potential data corruption.
						
						(If you know what you're doing, this error can be disabled in the Rivet config via `allow_version_rollback: true`)
						"
						)
					)));
				}
			}

			tx.write(&keys::EngineVersionKey {}, current_version)?;

			Ok(Ok(()))
		})
		.await?
}
