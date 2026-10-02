use std::{path::PathBuf, sync::Arc};

use anyhow::Result;
use rivet_config::config::{SqliteWorkflowColdStorage, SqliteWorkflowColdStorageS3AddressingStyle};

use super::{ColdTier, FdbWriteDebtPolicy, FilesystemColdTier, S3ColdTier};

pub async fn cold_tier_from_config(
	config: &rivet_config::Config,
) -> Result<Option<Arc<dyn ColdTier>>> {
	let configured_write_debt = config.sqlite().workflow_write_debt();
	let write_debt_policy = FdbWriteDebtPolicy::new(
		configured_write_debt.target_bytes,
		configured_write_debt.limit_bytes,
	)?;
	match config.sqlite().workflow_cold_storage() {
		Some(SqliteWorkflowColdStorage::FileSystem(file_system)) => Ok(Some(Arc::new(
			FilesystemColdTier::new_with_admission_and_write_debt(
				PathBuf::from(&file_system.root),
				file_system.max_object_size_bytes,
				file_system.max_concurrent_requests,
				file_system.max_queued_requests,
				file_system.queue_timeout_ms,
				write_debt_policy,
			)?,
		))),
		Some(SqliteWorkflowColdStorage::S3(s3)) => Ok(Some(Arc::new(
			S3ColdTier::from_env_with_admission_and_write_debt(
				s3.bucket.clone(),
				s3.endpoint.clone(),
				s3.region.clone(),
				matches!(
					s3.addressing_style,
					SqliteWorkflowColdStorageS3AddressingStyle::Path
				),
				s3.max_object_size_bytes,
				s3.max_concurrent_requests,
				s3.max_queued_requests,
				s3.queue_timeout_ms,
				write_debt_policy,
			)
			.await?,
		))),
		None => Ok(None),
	}
}
