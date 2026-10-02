use anyhow::*;
use std::path::PathBuf;
use tokio::process::Command;
use tokio::time::{Duration, sleep};
use uuid::Uuid;

use crate::DockerRunConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestDatabase {
	FoundationDb,
	Postgres,
	FileSystem,
}

impl TestDatabase {
	pub fn from_env() -> Self {
		use std::result::Result::{Err, Ok};
		match std::env::var("RIVET_TEST_DATABASE") {
			Ok(val) => match val.as_str() {
				"foundationdb" => TestDatabase::FoundationDb,
				"postgres" => TestDatabase::Postgres,
				"filesystem" => TestDatabase::FileSystem,
				_ => TestDatabase::FileSystem, // Default
			},
			Err(_) => TestDatabase::FileSystem, // Default
		}
	}

	pub async fn config(
		&self,
		test_id: Uuid,
		dc_label: u16,
	) -> Result<(rivet_config::config::Database, Option<DockerRunConfig>)> {
		match self {
			TestDatabase::FoundationDb => {
				if let Some(cluster_file) = std::env::var_os("RIVET_TEST_FDB_CLUSTER_FILE") {
					let cluster_file = PathBuf::from(cluster_file);
					ensure!(
						cluster_file.is_file(),
						"RIVET_TEST_FDB_CLUSTER_FILE does not exist: {}",
						cluster_file.display()
					);
					return Ok((
						rivet_config::config::Database::FoundationDb(
							rivet_config::config::db::FoundationDb {
								cluster_file: Some(cluster_file),
								// An externally supplied qualification cluster is intentionally shared by
								// several independently namespaced test contexts.
								allow_shared_cluster: true,
								..Default::default()
							},
						),
						None,
					));
				}

				let container_name = format!("test-foundationdb-{test_id}-{dc_label}");
				let (port, existing_container_id) = if let Some(container_id) =
					crate::check_container_exists(&container_name).await?
				{
					let existing_port = crate::get_container_port(&container_name)
						.await?
						.context("FoundationDB port")?;
					(existing_port, Some(container_id))
				} else {
					(
						portpicker::pick_unused_port().context("FoundationDB port")?,
						None,
					)
				};
				let cluster_contents = format!("docker:docker@127.0.0.1:{port}");
				let cluster_file = std::env::temp_dir().join(format!(
					"rivet-test-foundationdb-{test_id}-{dc_label}.cluster"
				));
				std::fs::write(&cluster_file, format!("{cluster_contents}\n"))?;
				let image = std::env::var("RIVET_TEST_FDB_IMAGE")
					.unwrap_or_else(|_| "foundationdb/foundationdb:7.3.79".to_string());

				Ok((
					rivet_config::config::Database::FoundationDb(
						rivet_config::config::db::FoundationDb {
							cluster_file: Some(cluster_file),
							allow_shared_cluster: true,
							..Default::default()
						},
					),
					Some(DockerRunConfig {
						image,
						container_name,
						port_mapping: (port, port),
						env_vars: vec![
							("FDB_NETWORKING_MODE".to_string(), "host".to_string()),
							("FDB_PORT".to_string(), port.to_string()),
							("FDB_CLUSTER_FILE_CONTENTS".to_string(), cluster_contents),
							("FDB_PROCESS_CLASS".to_string(), "storage".to_string()),
						],
						container_id: existing_container_id,
					}),
				))
			}
			TestDatabase::Postgres => {
				let container_name = format!("test-postgres-{test_id}-{dc_label}");
				let password = "test_password";
				let database = "test_db";

				// Check if container already exists and get its port
				let (port, existing_container_id) = if let Some(container_id) =
					crate::check_container_exists(&container_name).await?
				{
					// Get the existing port from the container
					let existing_port = crate::get_container_port(&container_name)
						.await?
						.context("postgres port")?;
					(existing_port, Some(container_id))
				} else {
					// Pick a new port for a new container
					let new_port = portpicker::pick_unused_port().context("postgres port")?;
					(new_port, None)
				};

				let connection_string = format!(
					"host=127.0.0.1 port={} user=postgres password={} dbname={}",
					port, password, database
				);

				let config =
					rivet_config::config::Database::Postgres(rivet_config::config::db::Postgres {
						url: rivet_config::secret::Secret::new(connection_string.clone()),
						ssl: None,
						nats: None,
					});

				let docker_config = DockerRunConfig {
					image: "postgres:18".to_string(),
					container_name: container_name.clone(),
					port_mapping: (port, 5432),
					env_vars: vec![
						("POSTGRES_PASSWORD".to_string(), password.to_string()),
						("POSTGRES_DB".to_string(), database.to_string()),
						("POSTGRES_USER".to_string(), "postgres".to_string()),
					],
					container_id: existing_container_id,
				};

				Ok((config, Some(docker_config)))
			}
			TestDatabase::FileSystem => {
				// Use a unique temp directory for each test
				let temp_dir =
					std::env::temp_dir().join(format!("rivet-test-{}-{}", test_id, dc_label));
				std::fs::create_dir_all(&temp_dir)?;

				let config = rivet_config::config::Database::FileSystem(
					rivet_config::config::db::FileSystem { path: temp_dir },
				);

				Ok((config, None))
			}
		}
	}

	pub async fn wait_for_ready(&self, docker_config: &DockerRunConfig) -> Result<()> {
		match self {
			TestDatabase::FoundationDb => wait_for_foundationdb_ready(docker_config, 20).await,
			TestDatabase::Postgres => {
				wait_for_postgres_ready(docker_config.port_mapping.0, 10).await
			}
			TestDatabase::FileSystem => Ok(()),
		}
	}
}

async fn wait_for_foundationdb_ready(
	docker_config: &DockerRunConfig,
	max_attempts: u32,
) -> Result<()> {
	for attempt in 1..=max_attempts {
		let configure = Command::new("docker")
			.arg("exec")
			.arg(&docker_config.container_name)
			.arg("fdbcli")
			.arg("--exec")
			.arg("configure new single memory")
			.output()
			.await?;
		let status = Command::new("docker")
			.arg("exec")
			.arg(&docker_config.container_name)
			.arg("fdbcli")
			.arg("--exec")
			.arg("status minimal")
			.output()
			.await?;

		if (configure.status.success()
			|| String::from_utf8_lossy(&configure.stdout).contains("already configured"))
			&& status.status.success()
			&& String::from_utf8_lossy(&status.stdout).contains("The database is available")
		{
			return Ok(());
		}

		tracing::debug!(
			attempt,
			max_attempts,
			"waiting for FoundationDB test database"
		);
		if attempt < max_attempts {
			sleep(Duration::from_millis(500)).await;
		}
	}

	bail!(
		"FoundationDB failed to become ready after {} attempts",
		max_attempts
	)
}

/// Wait for Postgres to be ready to accept connections
async fn wait_for_postgres_ready(port: u16, max_attempts: u32) -> Result<()> {
	use std::str::FromStr;
	use tokio_postgres::Config;

	let connection_string = format!("postgres://postgres:test_password@127.0.0.1:{port}/test_db");

	for attempt in 1..=max_attempts {
		tracing::debug!(attempt, max_attempts, "Checking if Postgres is ready");

		match Config::from_str(&connection_string)?
			.connect(tokio_postgres::NoTls)
			.await
		{
			std::result::Result::Ok((client, connection)) => {
				// Spawn connection handler
				tokio::spawn(async move {
					if let Err(e) = connection.await {
						tracing::debug!(error = ?e, "Connection error");
					}
				});

				// Try a simple query
				if client.simple_query("SELECT 1").await.is_ok() {
					tracing::debug!("Postgres is ready");
					return Ok(());
				}
			}
			Err(e) => {
				tracing::debug!(error = ?e, attempt, "Postgres not ready yet");
			}
		}

		if attempt < max_attempts {
			sleep(Duration::from_millis(500)).await;
		}
	}

	anyhow::bail!(
		"Postgres failed to become ready after {} attempts",
		max_attempts
	)
}
