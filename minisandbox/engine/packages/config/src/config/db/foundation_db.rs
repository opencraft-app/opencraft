use std::path::PathBuf;

use anyhow::{Result, bail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn default_transaction_retry_limit() -> i32 {
	10
}

/// FoundationDB configuration for UniversalDB.
#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FoundationDb {
	/// Path to the FDB cluster file. Uses the platform default when omitted.
	#[serde(default)]
	pub cluster_file: Option<PathBuf>,

	/// Maximum attempts for a UniversalDB transaction, including the initial attempt.
	#[serde(default = "default_transaction_retry_limit")]
	pub transaction_retry_limit: i32,

	/// Allows several independently named Rivet Cells to share one physical FDB cluster.
	///
	/// This is disabled by default because transaction tags and key prefixes do not isolate FDB's
	/// logs, storage servers, Ratekeeper, recovery, or coordinator failure domain. Enabling it must
	/// be an explicit choice on every process connected to a cluster registered for sharing.
	#[serde(default)]
	pub allow_shared_cluster: bool,
}

impl Default for FoundationDb {
	fn default() -> Self {
		Self {
			cluster_file: None,
			transaction_retry_limit: default_transaction_retry_limit(),
			allow_shared_cluster: false,
		}
	}
}

impl FoundationDb {
	pub fn validate(&self) -> Result<()> {
		if self.transaction_retry_limit <= 0 {
			bail!("foundation_db.transaction_retry_limit must be positive");
		}
		Ok(())
	}
}
