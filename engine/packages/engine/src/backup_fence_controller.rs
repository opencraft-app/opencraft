use std::{collections::BTreeSet, path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use rivet_config::config::SqliteBackupRecoveryFenceController;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command};
use url::Url;

const MAX_COMMAND_OUTPUT_BYTES: u64 = 1024 * 1024;
const POLICY_FINGERPRINT_SCHEMA: &[u8] = b"rivet-cold-backup-recovery-policy/v1\0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackupCatalogObservation {
	pub minimum_restorable_version: u64,
	pub maximum_restorable_version: u64,
	pub backup_generation_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackupDescription {
	minimum_restorable_version: u64,
	maximum_restorable_version: u64,
}

pub async fn start(config: rivet_config::Config, pools: rivet_pools::Pools) -> Result<()> {
	let controller = config
		.sqlite()
		.backup_recovery_fence_controller()
		.context("backup fence controller service started without controller config")?
		.clone();
	let cluster_file = foundationdb_cluster_file(&config)?;
	let udb = pools.udb()?;
	let holder_id = *pools.node_id().as_uuid().as_bytes();
	let leadership_lease_ms = i64::try_from(controller.leadership_lease_ms)
		.context("backup controller leadership lease exceeded timestamp range")?;

	loop {
		match depot::backup_fence::try_acquire_cold_backup_controller_lease(
			&udb,
			holder_id,
			rivet_util::timestamp::now(),
			leadership_lease_ms,
		)
		.await
		{
			Ok(true) => {
				match observe_and_certify_once(&controller, cluster_file.as_deref(), &udb).await {
					Ok(observation) => tracing::info!(
						minimum_restorable_version = observation.minimum_restorable_version,
						maximum_restorable_version = observation.maximum_restorable_version,
						backup_generation_count = observation.backup_generation_count,
						"renewed cold backup recovery fence"
					),
					Err(error) => tracing::error!(
						?error,
						"cold backup recovery fence was not renewed; physical deletion will fail closed when the current lease expires"
					),
				}
			}
			Ok(false) => tracing::debug!(
				"another Engine replica holds the cold backup catalog controller lease"
			),
			Err(error) => tracing::error!(
				?error,
				"could not acquire cold backup controller lease; recovery fence was not renewed"
			),
		}

		tokio::time::sleep(Duration::from_millis(controller.poll_interval_ms)).await;
	}
}

pub async fn observe_and_certify_once(
	controller: &SqliteBackupRecoveryFenceController,
	cluster_file: Option<&Path>,
	udb: &universaldb::Database,
) -> Result<BackupCatalogObservation> {
	let observation = observe_backup_catalog(controller, cluster_file).await?;
	let now_ms = rivet_util::timestamp::now();
	let lease_validity_ms = i64::try_from(controller.lease_validity_ms)
		.context("backup fence lease validity exceeded timestamp range")?;
	let policy_fingerprint = backup_policy_fingerprint(controller);
	let fence = depot::types::ColdBackupRecoveryFence {
		policy_fingerprint,
		minimum_restorable_version: observation.minimum_restorable_version,
		verified_at_ms: now_ms,
		valid_until_ms: now_ms
			.checked_add(lease_validity_ms)
			.context("backup fence lease expiry overflow")?,
	};
	depot::backup_fence::certify_cold_backup_recovery_fence(udb, policy_fingerprint, fence).await?;
	Ok(observation)
}

pub fn foundationdb_cluster_file(
	config: &rivet_config::Config,
) -> Result<Option<std::path::PathBuf>> {
	match config.database() {
		rivet_config::config::Database::FoundationDb(database) => Ok(database.cluster_file.clone()),
		_ => bail!("backup fence controller requires a FoundationDB database"),
	}
}

pub fn backup_policy_fingerprint(
	controller: &SqliteBackupRecoveryFenceController,
) -> depot::backup_fence::ColdBackupRecoveryPolicyFingerprint {
	let mut hash = Sha256::new();
	hash.update(POLICY_FINGERPRINT_SCHEMA);
	let mut backup_base_urls = controller
		.backup_base_urls
		.iter()
		.map(|url| url.trim())
		.collect::<Vec<_>>();
	backup_base_urls.sort_unstable();
	for backup_base_url in backup_base_urls {
		hash.update(backup_base_url.as_bytes());
		hash.update([0]);
	}
	hash.update(controller.retention_days.to_be_bytes());
	hash.finalize().into()
}

async fn observe_backup_catalog(
	controller: &SqliteBackupRecoveryFenceController,
	cluster_file: Option<&Path>,
) -> Result<BackupCatalogObservation> {
	verify_fdbbackup_version(controller).await?;

	let before = list_backup_generations(controller).await?;
	for backup_url in &before {
		let description = describe_backup_generation(controller, backup_url).await?;
		// A completed snapshot can expose a single exact restore point. There is no older log range
		// to expire in that case, and fdbbackup 7.3 rejects a day-based expire request as invalid.
		// Ranged generations must still complete expiration successfully before certification.
		if description.minimum_restorable_version < description.maximum_restorable_version {
			expire_backup_generation(controller, cluster_file, backup_url).await?;
		}
	}

	let mut minimum_restorable_version = u64::MAX;
	let mut maximum_restorable_version = 0;
	for backup_url in &before {
		let description = describe_backup_generation(controller, backup_url).await?;
		minimum_restorable_version =
			minimum_restorable_version.min(description.minimum_restorable_version);
		maximum_restorable_version =
			maximum_restorable_version.max(description.maximum_restorable_version);
	}

	// A generation appearing or disappearing during the observation can change the oldest
	// supported restore. Refuse to certify this tick instead of racing backup rotation.
	let after = list_backup_generations(controller).await?;
	ensure!(
		before == after,
		"fdbbackup generation set changed while the recovery catalog was being observed"
	);

	Ok(BackupCatalogObservation {
		minimum_restorable_version,
		maximum_restorable_version,
		backup_generation_count: before.len(),
	})
}

async fn verify_fdbbackup_version(controller: &SqliteBackupRecoveryFenceController) -> Result<()> {
	let output = run_fdbbackup(controller, "version", &["--version".to_string()]).await?;
	let version = parse_fdbbackup_version(&output)?;
	ensure!(
		version == controller.required_fdbbackup_version,
		"fdbbackup version does not match required parser version"
	);
	Ok(())
}

async fn list_backup_generations(
	controller: &SqliteBackupRecoveryFenceController,
) -> Result<BTreeSet<String>> {
	let mut all_backups = BTreeSet::new();
	for backup_base_url in &controller.backup_base_urls {
		let mut args = vec![
			"list".to_string(),
			"-b".to_string(),
			backup_base_url.clone(),
		];
		append_backup_access_args(controller, &mut args);
		let output = run_fdbbackup(controller, "list", &args).await?;
		let backups = parse_backup_generation_list(
			&output,
			backup_base_url,
			controller.max_backup_generations,
		)?;
		for backup in backups {
			ensure!(
				all_backups.insert(backup),
				"fdbbackup generation appeared under multiple configured bases"
			);
			ensure!(
				all_backups.len() <= controller.max_backup_generations,
				"fdbbackup generation count exceeded the configured global bound"
			);
		}
	}
	Ok(all_backups)
}

async fn expire_backup_generation(
	controller: &SqliteBackupRecoveryFenceController,
	cluster_file: Option<&Path>,
	backup_url: &str,
) -> Result<()> {
	let retention_days = controller.retention_days.to_string();
	let mut args = vec!["expire".to_string()];
	if let Some(cluster_file) = cluster_file {
		args.push("-C".to_string());
		args.push(cluster_file.display().to_string());
	}
	args.extend([
		"-d".to_string(),
		backup_url.to_string(),
		"--delete-before-days".to_string(),
		retention_days.clone(),
		"--min-restorable-days".to_string(),
		retention_days,
	]);
	append_backup_access_args(controller, &mut args);
	run_fdbbackup(controller, "expire", &args).await?;
	Ok(())
}

async fn describe_backup_generation(
	controller: &SqliteBackupRecoveryFenceController,
	backup_url: &str,
) -> Result<BackupDescription> {
	let mut args = vec![
		"describe".to_string(),
		"-d".to_string(),
		backup_url.to_string(),
	];
	append_backup_access_args(controller, &mut args);
	let output = run_fdbbackup(controller, "describe", &args).await?;
	parse_backup_description(&output, backup_url)
}

fn append_backup_access_args(
	controller: &SqliteBackupRecoveryFenceController,
	args: &mut Vec<String>,
) {
	for credential in &controller.blob_credentials {
		args.push("--blob-credentials".to_string());
		args.push(credential.clone());
	}
	if let Some(tls_ca_file) = &controller.tls_ca_file {
		args.push("--tls-ca-file".to_string());
		args.push(tls_ca_file.clone());
	}
}

async fn run_fdbbackup(
	controller: &SqliteBackupRecoveryFenceController,
	action: &'static str,
	args: &[String],
) -> Result<Vec<u8>> {
	let mut command = Command::new(&controller.fdbbackup_binary);
	command
		.args(args)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	let mut child = command
		.spawn()
		.with_context(|| format!("spawn fdbbackup {action}"))?;
	let stdout = child.stdout.take().context("capture fdbbackup stdout")?;
	let stderr = child.stderr.take().context("capture fdbbackup stderr")?;

	let completion = async move {
		let stdout_task = read_bounded(stdout);
		let stderr_task = read_bounded(stderr);
		let status_task = async {
			child
				.wait()
				.await
				.with_context(|| format!("wait for fdbbackup {action}"))
		};
		let (stdout, stderr, status) = tokio::try_join!(stdout_task, stderr_task, status_task)?;
		if !status.success() {
			let stderr = String::from_utf8_lossy(&stderr);
			bail!(
				"fdbbackup {action} failed with status {status}: {}",
				stderr.trim()
			);
		}
		Ok(stdout)
	};

	tokio::time::timeout(
		Duration::from_millis(controller.command_timeout_ms),
		completion,
	)
	.await
	.with_context(|| format!("fdbbackup {action} exceeded command timeout"))?
}

async fn read_bounded(reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
	let mut output = Vec::new();
	let mut limited = reader.take(MAX_COMMAND_OUTPUT_BYTES + 1);
	limited
		.read_to_end(&mut output)
		.await
		.context("read fdbbackup command output")?;
	ensure!(
		u64::try_from(output.len()).unwrap_or(u64::MAX) <= MAX_COMMAND_OUTPUT_BYTES,
		"fdbbackup command output exceeded bounded capture"
	);
	Ok(output)
}

fn parse_fdbbackup_version(output: &[u8]) -> Result<String> {
	let output = std::str::from_utf8(output).context("fdbbackup version output was not UTF-8")?;
	let start = output
		.find("(v")
		.context("fdbbackup version output did not contain a version marker")?
		+ 2;
	let end = output[start..]
		.find(')')
		.map(|offset| start + offset)
		.context("fdbbackup version output did not terminate the version marker")?;
	let version = &output[start..end];
	ensure!(
		!version.is_empty()
			&& version
				.bytes()
				.all(|byte| byte.is_ascii_digit() || byte == b'.'),
		"fdbbackup version output contained an invalid version"
	);
	Ok(version.to_string())
}

fn parse_backup_generation_list(
	output: &[u8],
	backup_base_url: &str,
	max_backup_generations: usize,
) -> Result<BTreeSet<String>> {
	let output = std::str::from_utf8(output).context("fdbbackup list output was not UTF-8")?;
	let base = Url::parse(backup_base_url).context("parse configured fdbbackup base URL")?;
	let mut backups = BTreeSet::new();
	for line in output.lines() {
		let candidate = line.trim();
		if candidate.is_empty() {
			continue;
		}
		let candidate_url = Url::parse(candidate).context("parse fdbbackup listed URL")?;
		ensure!(
			is_child_backup_url(&base, &candidate_url),
			"fdbbackup listed a URL outside the configured dedicated base"
		);
		ensure!(
			backups.insert(candidate.to_string()),
			"fdbbackup listed a duplicate backup generation"
		);
		ensure!(
			backups.len() <= max_backup_generations,
			"fdbbackup generation count exceeded the configured bound"
		);
	}
	ensure!(
		!backups.is_empty(),
		"fdbbackup dedicated base did not contain any backup generations"
	);
	Ok(backups)
}

fn is_child_backup_url(base: &Url, candidate: &Url) -> bool {
	if base.scheme() != candidate.scheme()
		|| base.username() != candidate.username()
		|| base.password() != candidate.password()
		|| base.host_str() != candidate.host_str()
		|| base.port_or_known_default() != candidate.port_or_known_default()
		|| !backup_queries_match(base, candidate)
		|| candidate.fragment().is_some()
	{
		return false;
	}
	let base_path = base.path().trim_end_matches('/');
	let candidate_path = candidate.path().trim_end_matches('/');
	candidate_path
		.strip_prefix(base_path)
		.is_some_and(|suffix| suffix.starts_with('/') && suffix.len() > 1)
}

fn backup_queries_match(base: &Url, candidate: &Url) -> bool {
	let mut base_pairs = base
		.query_pairs()
		.map(|(key, value)| (key.into_owned(), value.into_owned()))
		.collect::<Vec<_>>();
	let mut candidate_pairs = candidate
		.query_pairs()
		.map(|(key, value)| (key.into_owned(), value.into_owned()))
		.collect::<Vec<_>>();
	base_pairs.sort_unstable();
	candidate_pairs.sort_unstable();
	if base_pairs == candidate_pairs {
		return true;
	}

	// FoundationDB 7.3's blobstore catalog listing canonicalizes a region-qualified base URL by
	// omitting exactly one `region` query parameter from every listed generation. The endpoint host
	// remains byte-for-byte equal (and therefore still pins the region), while bucket and every
	// other query pair must remain equal. Do not accept a changed or newly-added region.
	if base.scheme() != "blobstore" {
		return false;
	}
	let original_len = base_pairs.len();
	base_pairs.retain(|(key, _)| key != "region");
	original_len == base_pairs.len() + 1 && base_pairs == candidate_pairs
}

fn parse_backup_description(output: &[u8], expected_url: &str) -> Result<BackupDescription> {
	let output = std::str::from_utf8(output).context("fdbbackup describe output was not UTF-8")?;
	let mut reported_url = None;
	let mut restorable = None;
	let mut minimum_restorable_version = None;
	let mut maximum_restorable_version = None;

	for line in output.lines() {
		if let Some(value) = line.strip_prefix("URL: ") {
			set_once(&mut reported_url, value.trim().to_string(), "URL")?;
		} else if let Some(value) = line.strip_prefix("Restorable: ") {
			set_once(&mut restorable, value.trim() == "true", "Restorable")?;
		} else if let Some(value) = line.strip_prefix("MinRestorableVersion:") {
			set_once(
				&mut minimum_restorable_version,
				parse_leading_version(value)?,
				"MinRestorableVersion",
			)?;
		} else if let Some(value) = line.strip_prefix("MaxRestorableVersion:") {
			set_once(
				&mut maximum_restorable_version,
				parse_leading_version(value)?,
				"MaxRestorableVersion",
			)?;
		}
	}

	ensure!(
		reported_url.as_deref() == Some(expected_url),
		"fdbbackup describe returned a different backup URL"
	);
	ensure!(
		restorable == Some(true),
		"fdbbackup generation is not restorable"
	);
	let minimum_restorable_version =
		minimum_restorable_version.context("fdbbackup describe omitted MinRestorableVersion")?;
	let maximum_restorable_version =
		maximum_restorable_version.context("fdbbackup describe omitted MaxRestorableVersion")?;
	ensure!(
		minimum_restorable_version <= maximum_restorable_version,
		"fdbbackup restore version range was inverted"
	);
	Ok(BackupDescription {
		minimum_restorable_version,
		maximum_restorable_version,
	})
}

fn parse_leading_version(value: &str) -> Result<u64> {
	let token = value
		.split_ascii_whitespace()
		.next()
		.context("fdbbackup version field was empty")?;
	ensure!(
		token.bytes().all(|byte| byte.is_ascii_digit()),
		"fdbbackup version field was not an unsigned integer"
	);
	token.parse().context("parse fdbbackup restore version")
}

fn set_once<T>(slot: &mut Option<T>, value: T, field: &str) -> Result<()> {
	if slot.replace(value).is_some() {
		bail!("fdbbackup describe repeated {field}");
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_pinned_version_and_constant_size_description() -> Result<()> {
		assert_eq!(
			parse_fdbbackup_version(b"FoundationDB 7.3 (v7.3.79)\n")?,
			"7.3.79"
		);
		let description = parse_backup_description(
			b"URL: file:///backup/prod/backup-1\nRestorable: true\nSnapshotBytes: 10\nMinRestorableVersion:    397685648 (maxLogEnd -7.00 days)\nMaxRestorableVersion:    417313388 (maxLogEnd -0.00 days)\n",
			"file:///backup/prod/backup-1",
		)?;
		assert_eq!(description.minimum_restorable_version, 397_685_648);
		assert_eq!(description.maximum_restorable_version, 417_313_388);
		Ok(())
	}

	#[test]
	fn rejects_unrestorable_duplicate_or_inverted_description() {
		let unrestorable = b"URL: file:///backup/prod/a\nRestorable: false\nMinRestorableVersion: 10\nMaxRestorableVersion: 20\n";
		assert!(parse_backup_description(unrestorable, "file:///backup/prod/a").is_err());

		let duplicate = b"URL: file:///backup/prod/a\nURL: file:///backup/prod/a\nRestorable: true\nMinRestorableVersion: 10\nMaxRestorableVersion: 20\n";
		assert!(parse_backup_description(duplicate, "file:///backup/prod/a").is_err());

		let inverted = b"URL: file:///backup/prod/a\nRestorable: true\nMinRestorableVersion: 21\nMaxRestorableVersion: 20\n";
		assert!(parse_backup_description(inverted, "file:///backup/prod/a").is_err());
	}

	#[test]
	fn listed_generations_must_be_unique_bounded_children() -> Result<()> {
		let parsed = parse_backup_generation_list(
			b"file:///backup/prod/a\nfile:///backup/prod/b\n",
			"file:///backup/prod",
			2,
		)?;
		assert_eq!(parsed.len(), 2);
		assert!(
			parse_backup_generation_list(b"file:///backup/other/a\n", "file:///backup/prod", 2,)
				.is_err()
		);
		assert!(
			parse_backup_generation_list(
				b"file:///backup/prod/a\nfile:///backup/prod/a\n",
				"file:///backup/prod",
				2,
			)
			.is_err()
		);
		assert!(
			parse_backup_generation_list(
				b"file:///backup/prod/a\nfile:///backup/prod/b\n",
				"file:///backup/prod",
				1,
			)
			.is_err()
		);

		let cos_base =
			"blobstore://@backup.cos.ap-beijing.myqcloud.com?bucket=backup&region=ap-beijing";
		let canonical_generation =
			b"blobstore://@backup.cos.ap-beijing.myqcloud.com/prod/v1?bucket=backup\n";
		assert_eq!(
			parse_backup_generation_list(canonical_generation, cos_base, 1)?.len(),
			1
		);
		assert!(
			parse_backup_generation_list(
				b"blobstore://@backup.cos.ap-beijing.myqcloud.com/prod/v1?bucket=other\n",
				cos_base,
				1,
			)
			.is_err()
		);
		assert!(
			parse_backup_generation_list(
				b"blobstore://@backup.cos.ap-beijing.myqcloud.com/prod/v1?bucket=backup&region=ap-shanghai\n",
				cos_base,
				1,
			)
			.is_err()
		);
		Ok(())
	}

	#[test]
	fn policy_fingerprint_binds_repository_and_retention_not_credentials() {
		let first = test_controller();
		let mut credential_rotation = first.clone();
		credential_rotation.blob_credentials = vec!["/new/credentials.json".to_string()];
		assert_eq!(
			backup_policy_fingerprint(&first),
			backup_policy_fingerprint(&credential_rotation)
		);

		let mut changed_retention = first.clone();
		changed_retention.retention_days += 1;
		assert_ne!(
			backup_policy_fingerprint(&first),
			backup_policy_fingerprint(&changed_retention)
		);

		let mut ordered = first.clone();
		ordered.backup_base_urls = vec![
			"file:///backup/primary".to_string(),
			"file:///backup/secondary".to_string(),
		];
		let mut reversed = ordered.clone();
		reversed.backup_base_urls.reverse();
		assert_eq!(
			backup_policy_fingerprint(&ordered),
			backup_policy_fingerprint(&reversed)
		);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn observes_every_generation_and_expires_only_ranged_backups_without_force() -> Result<()>
	{
		use std::os::unix::fs::PermissionsExt;

		let temp = tempfile::tempdir()?;
		let binary = temp.path().join("fake-fdbbackup");
		let log = temp.path().join("fake-fdbbackup.log");
		std::fs::write(
			&binary,
			format!(
				r#"#!/bin/sh
set -eu
case "$1" in
  --version)
    echo 'FoundationDB 7.3 (v7.3.79)'
    ;;
  list)
    echo 'file:///backup/prod/backup-a'
    echo 'file:///backup/prod/backup-b'
    echo 'file:///backup/prod/backup-c'
    ;;
  expire)
    case " $* " in *' --force '*) exit 91;; esac
    printf '%s\n' "$*" >> '{}'
    ;;
  describe)
    case " $* " in
      *backup-a*) min=100; max=300; url='file:///backup/prod/backup-a';;
      *backup-b*) min=200; max=400; url='file:///backup/prod/backup-b';;
      *backup-c*) min=500; max=500; url='file:///backup/prod/backup-c';;
      *) exit 92;;
    esac
    printf 'URL: %s\nRestorable: true\nMinRestorableVersion: %s\nMaxRestorableVersion: %s\n' "$url" "$min" "$max"
    ;;
  *) exit 93;;
esac
"#,
				log.display()
			),
		)?;
		let mut permissions = std::fs::metadata(&binary)?.permissions();
		permissions.set_mode(0o700);
		std::fs::set_permissions(&binary, permissions)?;

		let mut controller = test_controller();
		controller.fdbbackup_binary = binary.display().to_string();
		controller.command_timeout_ms = 5_000;
		let observation =
			observe_backup_catalog(&controller, Some(Path::new("/etc/fdb.cluster"))).await?;
		assert_eq!(
			observation,
			BackupCatalogObservation {
				minimum_restorable_version: 100,
				maximum_restorable_version: 500,
				backup_generation_count: 3,
			}
		);
		let expire_log = std::fs::read_to_string(log)?;
		assert_eq!(expire_log.lines().count(), 2);
		assert!(expire_log.contains("-C /etc/fdb.cluster"));
		assert!(expire_log.contains("--delete-before-days 7 --min-restorable-days 7"));
		assert!(expire_log.contains("--tls-ca-file /etc/ssl/certs/backup-ca.pem"));
		assert!(!expire_log.contains("--force"));
		Ok(())
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn refuses_to_certify_when_generation_set_changes_mid_observation() -> Result<()> {
		use std::os::unix::fs::PermissionsExt;

		let temp = tempfile::tempdir()?;
		let binary = temp.path().join("rotating-fdbbackup");
		let counter = temp.path().join("list-count");
		std::fs::write(
			&binary,
			format!(
				r#"#!/bin/sh
set -eu
case "$1" in
  --version) echo 'FoundationDB 7.3 (v7.3.79)';;
  list)
    count=0
    if [ -f '{}' ]; then count=$(cat '{}'); fi
    count=$((count + 1))
    printf '%s' "$count" > '{}'
    if [ "$count" -eq 1 ]; then
      echo 'file:///backup/prod/backup-a'
    else
      echo 'file:///backup/prod/backup-b'
    fi
    ;;
  expire) ;;
  describe)
    echo 'URL: file:///backup/prod/backup-a'
    echo 'Restorable: true'
    echo 'MinRestorableVersion: 100'
    echo 'MaxRestorableVersion: 200'
    ;;
  *) exit 93;;
esac
"#,
				counter.display(),
				counter.display(),
				counter.display(),
			),
		)?;
		let mut permissions = std::fs::metadata(&binary)?.permissions();
		permissions.set_mode(0o700);
		std::fs::set_permissions(&binary, permissions)?;

		let mut controller = test_controller();
		controller.fdbbackup_binary = binary.display().to_string();
		controller.command_timeout_ms = 5_000;
		let error = observe_backup_catalog(&controller, None)
			.await
			.expect_err("backup rotation must defer certification to a stable observation tick");
		assert!(format!("{error:#}").contains("generation set changed"));
		Ok(())
	}

	#[tokio::test]
	async fn real_fdbbackup_catalog_observation_if_configured() -> Result<()> {
		let Some(binary) = std::env::var_os("RIVET_TEST_FDBBACKUP_BINARY") else {
			return Ok(());
		};
		let backup_base_url = std::env::var("RIVET_TEST_FDBBACKUP_BASE_URL").context(
			"RIVET_TEST_FDBBACKUP_BASE_URL is required with RIVET_TEST_FDBBACKUP_BINARY",
		)?;
		let mut controller = test_controller();
		controller.fdbbackup_binary = binary.to_string_lossy().into_owned();
		controller.backup_base_urls = vec![backup_base_url];
		controller.command_timeout_ms = 30_000;
		let observation = observe_backup_catalog(&controller, None).await?;
		assert!(observation.minimum_restorable_version > 0);
		assert!(observation.maximum_restorable_version >= observation.minimum_restorable_version);
		assert!(observation.backup_generation_count > 0);
		Ok(())
	}

	fn test_controller() -> SqliteBackupRecoveryFenceController {
		SqliteBackupRecoveryFenceController {
			backup_base_urls: vec!["file:///backup/prod".to_string()],
			retention_days: 7,
			fdbbackup_binary: "/usr/bin/fdbbackup".to_string(),
			required_fdbbackup_version: "7.3.79".to_string(),
			blob_credentials: Vec::new(),
			tls_ca_file: Some("/etc/ssl/certs/backup-ca.pem".to_string()),
			poll_interval_ms: 60_000,
			lease_validity_ms: 600_000,
			command_timeout_ms: 120_000,
			leadership_lease_ms: 300_000,
			max_backup_generations: 128,
		}
	}
}
