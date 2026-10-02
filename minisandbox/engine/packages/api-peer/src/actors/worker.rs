use anyhow::Result;
use rivet_types::actors::WorkerVersionReference;

const MAX_WORKER_NAME_LEN: usize = 63;
const VERSION_PREFIX: &str = "v_";
const VERSION_DIGEST_LEN: usize = 64;

pub fn validate(reference: &WorkerVersionReference) -> Result<()> {
	let worker = reference.worker.as_bytes();
	let worker_valid = !worker.is_empty()
		&& worker.len() <= MAX_WORKER_NAME_LEN
		&& worker[0].is_ascii_lowercase()
		&& worker
			.iter()
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-');
	if !worker_valid {
		return Err(pegboard::errors::Actor::InvalidWorkerReference {
				reason: "worker must be 1-63 lowercase ASCII letters, digits or '-', beginning with a letter"
				.into(),
		}
		.build());
	}

	let Some(version_id) = reference.version_id.as_deref() else {
		return Ok(());
	};
	let Some(digest) = version_id.strip_prefix(VERSION_PREFIX) else {
		return Err(pegboard::errors::Actor::InvalidWorkerReference {
			reason: "version_id must use the v_<sha256> format".into(),
		}
		.build());
	};
	if digest.len() != VERSION_DIGEST_LEN
		|| !digest
			.bytes()
			.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	{
		return Err(pegboard::errors::Actor::InvalidWorkerReference {
			reason: "version_id must contain exactly 64 lowercase hexadecimal digits".into(),
		}
		.build());
	}

	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn accepts_registry_reference() {
		validate(&WorkerVersionReference {
			worker: "my-worker-2".into(),
			version_id: Some(format!("v_{}", "a".repeat(64))),
		})
		.unwrap();
		validate(&WorkerVersionReference {
			worker: "my-worker-2".into(),
			version_id: None,
		})
		.unwrap();
	}

	#[test]
	fn omitted_version_is_a_deployment_reference() {
		let reference: WorkerVersionReference =
			serde_json::from_str(r#"{"worker":"my-worker"}"#).unwrap();
		assert_eq!(reference.version_id, None);
		validate(&reference).unwrap();
		assert_eq!(
			serde_json::to_value(reference).unwrap(),
			serde_json::json!({ "worker": "my-worker" })
		);
	}

	#[test]
	fn rejects_non_canonical_reference() {
		for (worker, version_id) in [
			("Upper", format!("v_{}", "a".repeat(64))),
			("2worker", format!("v_{}", "a".repeat(64))),
			("worker", format!("v_{}", "A".repeat(64))),
			("worker", "latest".into()),
		] {
			assert!(
				validate(&WorkerVersionReference {
					worker: worker.into(),
					version_id: Some(version_id),
				})
				.is_err()
			);
		}
	}
}
