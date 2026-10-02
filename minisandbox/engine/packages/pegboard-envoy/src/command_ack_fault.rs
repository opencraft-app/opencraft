use std::{
	fs::{self, OpenOptions},
	io::Write,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use rivet_envoy_protocol as protocol;
use serde::{Deserialize, Serialize};

/// Platform-only fault plan used by the production-shape ACK-of-ACK qualification.
///
/// The path is inside the Engine container and is not mounted from any actor. Creating this file
/// requires the same Kubernetes authority that can already stop the Engine process. Keeping the
/// hook file-based avoids adding a network endpoint or token parser to the trusted data plane.
pub(crate) const PLAN_PATH: &str = "/tmp/rivet-command-ack-disconnect-plan.json";
const SCHEMA: &str = "rivet-command-ack-disconnect-plan/v1";
const RECEIPT_SCHEMA: &str = "rivet-command-ack-disconnect-fired/v1";
const BOUNDARY: &str = "after_commit_before_barrier";
const MAX_PLAN_BYTES: u64 = 4096;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FaultPlan {
	schema: String,
	nonce: String,
	envoy_key: String,
	actor_id: String,
	generation: Option<u32>,
	index: Option<i64>,
	boundary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FaultReceipt<'a> {
	schema: &'static str,
	nonce: &'a str,
	envoy_key: &'a str,
	actor_id: &'a str,
	generation: u32,
	index: i64,
	boundary: &'static str,
	fired_at_unix_ms: u128,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct FiredFault {
	pub nonce: String,
	pub actor_id: String,
	pub generation: u32,
	pub index: i64,
	pub receipt_path: PathBuf,
}

/// Atomically consume a matching plan after the FDB clear has committed but before the commit
/// barrier is sent. `rename` is the one-shot claim: concurrent websocket tasks cannot fire the
/// same plan twice. A malformed plan fails closed for qualification by returning an error rather
/// than silently weakening the requested fault boundary.
pub(crate) fn claim_after_commit(
	plan_path: &Path,
	envoy_key: &str,
	ack: &protocol::ToRivetAckCommands,
) -> Result<Option<FiredFault>> {
	let metadata = match fs::symlink_metadata(plan_path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error).context("stat command ACK fault plan"),
	};
	ensure!(
		metadata.file_type().is_file(),
		"command ACK fault plan is not a regular file"
	);
	ensure!(
		metadata.len() <= MAX_PLAN_BYTES,
		"command ACK fault plan exceeds {MAX_PLAN_BYTES} bytes"
	);

	let encoded = fs::read(plan_path).context("read command ACK fault plan")?;
	let plan: FaultPlan =
		serde_json::from_slice(&encoded).context("parse command ACK fault plan")?;
	validate_plan(&plan)?;

	if plan.envoy_key != envoy_key {
		return Ok(None);
	}
	let Some(checkpoint) = ack.last_command_checkpoints.iter().find(|checkpoint| {
		checkpoint.actor_id == plan.actor_id
			&& plan
				.generation
				.is_none_or(|generation| checkpoint.generation == generation)
			&& plan.index.is_none_or(|index| checkpoint.index == index)
	}) else {
		return Ok(None);
	};

	let claimed_path = artifact_path(plan_path, &plan.nonce, "claimed.json")?;
	let receipt_path = artifact_path(plan_path, &plan.nonce, "fired.json")?;
	let temporary_receipt_path = artifact_path(plan_path, &plan.nonce, "fired.tmp")?;
	fs::rename(plan_path, &claimed_path).context("claim command ACK fault plan")?;

	let receipt = FaultReceipt {
		schema: RECEIPT_SCHEMA,
		nonce: &plan.nonce,
		envoy_key,
		actor_id: &checkpoint.actor_id,
		generation: checkpoint.generation,
		index: checkpoint.index,
		boundary: BOUNDARY,
		fired_at_unix_ms: SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.context("system time is before Unix epoch")?
			.as_millis(),
	};
	let receipt_bytes = serde_json::to_vec(&receipt).context("encode command ACK fault receipt")?;
	let mut temporary_receipt = OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&temporary_receipt_path)
		.context("create temporary command ACK fault receipt")?;
	temporary_receipt
		.write_all(&receipt_bytes)
		.context("write temporary command ACK fault receipt")?;
	temporary_receipt
		.sync_all()
		.context("sync temporary command ACK fault receipt")?;
	drop(temporary_receipt);
	fs::rename(&temporary_receipt_path, &receipt_path)
		.context("publish command ACK fault receipt")?;
	fs::remove_file(&claimed_path).context("remove claimed command ACK fault plan")?;

	Ok(Some(FiredFault {
		nonce: plan.nonce,
		actor_id: checkpoint.actor_id.clone(),
		generation: checkpoint.generation,
		index: checkpoint.index,
		receipt_path,
	}))
}

fn validate_plan(plan: &FaultPlan) -> Result<()> {
	ensure!(
		plan.schema == SCHEMA,
		"unsupported command ACK fault plan schema"
	);
	ensure!(
		plan.boundary == BOUNDARY,
		"unsupported command ACK fault boundary"
	);
	ensure!(
		!plan.nonce.is_empty()
			&& plan.nonce.len() <= 64
			&& plan
				.nonce
				.bytes()
				.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
		"invalid command ACK fault nonce"
	);
	ensure!(
		!plan.envoy_key.is_empty(),
		"empty command ACK fault envoy key"
	);
	ensure!(
		!plan.actor_id.is_empty(),
		"empty command ACK fault actor id"
	);
	Ok(())
}

fn artifact_path(plan_path: &Path, nonce: &str, suffix: &str) -> Result<PathBuf> {
	let parent = plan_path
		.parent()
		.context("command ACK fault plan has no parent directory")?;
	Ok(parent.join(format!("rivet-command-ack-disconnect-{nonce}.{suffix}")))
}

#[cfg(test)]
mod tests {
	use super::*;
	use tempfile::TempDir;

	fn checkpoint(actor_id: &str, generation: u32, index: i64) -> protocol::ActorCheckpoint {
		protocol::ActorCheckpoint {
			actor_id: actor_id.to_owned(),
			generation,
			index,
		}
	}

	fn write_plan(directory: &TempDir, body: serde_json::Value) -> PathBuf {
		let path = directory.path().join("plan.json");
		fs::write(&path, serde_json::to_vec(&body).unwrap()).unwrap();
		path
	}

	#[test]
	fn matching_plan_is_consumed_once_with_exact_checkpoint_receipt() {
		let directory = TempDir::new().unwrap();
		let path = write_plan(
			&directory,
			serde_json::json!({
				"schema": SCHEMA,
				"nonce": "qualification-1",
				"envoy_key": "envoy-a",
				"actor_id": "actor-a",
				"generation": 7,
				"index": null,
				"boundary": BOUNDARY,
			}),
		);
		let ack = protocol::ToRivetAckCommands {
			last_command_checkpoints: vec![checkpoint("actor-a", 7, 19)],
		};

		let fired = claim_after_commit(&path, "envoy-a", &ack)
			.unwrap()
			.expect("matching fault should fire");
		assert_eq!(fired.actor_id, "actor-a");
		assert_eq!(fired.generation, 7);
		assert_eq!(fired.index, 19);
		assert!(!path.exists());
		let receipt: serde_json::Value =
			serde_json::from_slice(&fs::read(&fired.receipt_path).unwrap()).unwrap();
		assert_eq!(receipt["schema"], RECEIPT_SCHEMA);
		assert_eq!(receipt["boundary"], BOUNDARY);
		assert_eq!(receipt["index"], 19);
		assert!(
			!artifact_path(&path, "qualification-1", "claimed.json")
				.unwrap()
				.exists()
		);
		assert!(
			!artifact_path(&path, "qualification-1", "fired.tmp")
				.unwrap()
				.exists()
		);

		assert_eq!(claim_after_commit(&path, "envoy-a", &ack).unwrap(), None);
	}

	#[test]
	fn wrong_scope_leaves_plan_armed() {
		let directory = TempDir::new().unwrap();
		let path = write_plan(
			&directory,
			serde_json::json!({
				"schema": SCHEMA,
				"nonce": "qualification-2",
				"envoy_key": "envoy-a",
				"actor_id": "actor-a",
				"generation": 8,
				"index": 20,
				"boundary": BOUNDARY,
			}),
		);
		let ack = protocol::ToRivetAckCommands {
			last_command_checkpoints: vec![checkpoint("actor-a", 7, 19)],
		};

		assert_eq!(claim_after_commit(&path, "envoy-b", &ack).unwrap(), None);
		assert_eq!(claim_after_commit(&path, "envoy-a", &ack).unwrap(), None);
		assert!(path.exists());
	}

	#[test]
	fn malformed_plan_fails_closed_without_consuming_it() {
		let directory = TempDir::new().unwrap();
		let path = write_plan(
			&directory,
			serde_json::json!({
				"schema": SCHEMA,
				"nonce": "../escape",
				"envoy_key": "envoy-a",
				"actor_id": "actor-a",
				"generation": null,
				"index": null,
				"boundary": BOUNDARY,
			}),
		);
		let ack = protocol::ToRivetAckCommands {
			last_command_checkpoints: vec![checkpoint("actor-a", 7, 19)],
		};

		let error =
			claim_after_commit(&path, "envoy-a", &ack).expect_err("invalid plan must fail closed");
		assert!(
			error
				.to_string()
				.contains("invalid command ACK fault nonce")
		);
		assert!(path.exists());
	}

	#[cfg(unix)]
	#[test]
	fn symlink_plan_is_rejected() {
		use std::os::unix::fs::symlink;

		let directory = TempDir::new().unwrap();
		let target = directory.path().join("target.json");
		fs::write(&target, b"{}").unwrap();
		let path = directory.path().join("plan.json");
		symlink(&target, &path).unwrap();
		let ack = protocol::ToRivetAckCommands {
			last_command_checkpoints: Vec::new(),
		};

		let error =
			claim_after_commit(&path, "envoy-a", &ack).expect_err("symlink plan must be rejected");
		assert!(error.to_string().contains("not a regular file"));
	}
}
