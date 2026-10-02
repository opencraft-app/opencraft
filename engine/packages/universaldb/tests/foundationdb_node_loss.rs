#![cfg(feature = "foundationdb")]

use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use universaldb::{Database, driver::FoundationDbConfig, utils::IsolationLevel::Serializable};
use uuid::Uuid;

const PRE_LOSS_WRITES: u64 = 32;
const TRANSITION_WRITES: u64 = 128;
const NODE_DOWN_WRITES: u64 = 64;
const RECOVERED_WRITES: u64 = 32;
const WRITE_DEADLINE: Duration = Duration::from_secs(30);
const DEFAULT_GATE_DEADLINE: Duration = Duration::from_secs(180);

#[derive(Default)]
struct PhaseStats {
	writes: u64,
	total_latency: Duration,
	max_latency: Duration,
}

impl PhaseStats {
	fn observe(&mut self, latency: Duration) {
		self.writes += 1;
		self.total_latency += latency;
		self.max_latency = self.max_latency.max(latency);
	}

	fn print(&self, phase: &str) {
		let average_micros = self
			.total_latency
			.as_micros()
			.checked_div(u128::from(self.writes))
			.unwrap_or_default();
		println!(
			"FDB_FAULT_PHASE phase={phase} writes={} average_us={average_micros} max_us={}",
			self.writes,
			self.max_latency.as_micros()
		);
	}
}

fn entry_key(prefix: &[u8], sequence: u64) -> Vec<u8> {
	let mut key = prefix.to_vec();
	key.extend_from_slice(format!("entry/{sequence:020}").as_bytes());
	key
}

fn manifest_key(prefix: &[u8]) -> Vec<u8> {
	let mut key = prefix.to_vec();
	key.extend_from_slice(b"manifest");
	key
}

fn entry_value(sequence: u64) -> Vec<u8> {
	let mut value = vec![0xa5; 1024];
	value[..8].copy_from_slice(&sequence.to_be_bytes());
	value[8..16].copy_from_slice(&(!sequence).to_be_bytes());
	value
}

async fn commit_entry(db: &Database, prefix: &[u8], sequence: u64) -> Result<Duration> {
	let key = entry_key(prefix, sequence);
	let manifest_key = manifest_key(prefix);
	let value = entry_value(sequence);
	let started = Instant::now();

	tokio::time::timeout(
		WRITE_DEADLINE,
		db.txn("foundationdb_node_loss_write", move |tx| {
			let key = key.clone();
			let manifest_key = manifest_key.clone();
			let value = value.clone();
			async move {
				// The immutable operation key makes a retry safe even when FDB reports that the
				// previous commit may have succeeded. Never overwrite a conflicting value.
				if let Some(existing) = tx.get(&key, Serializable).await? {
					ensure!(
						existing.as_slice() == value,
						"immutable acknowledged entry changed for sequence {sequence}"
					);
					return Ok(());
				}

				tx.set(&key, &value);
				tx.set(&manifest_key, &sequence.to_be_bytes());
				Ok(())
			}
		}),
	)
	.await
	.with_context(|| format!("sequence {sequence} exceeded the {WRITE_DEADLINE:?} deadline"))??;

	Ok(started.elapsed())
}

async fn run_phase(
	db: &Database,
	prefix: &[u8],
	first_sequence: u64,
	writes: u64,
	inter_write_delay: Duration,
) -> Result<PhaseStats> {
	let mut stats = PhaseStats::default();
	for sequence in first_sequence..first_sequence + writes {
		stats.observe(commit_entry(db, prefix, sequence).await?);
		if !inter_write_delay.is_zero() {
			tokio::time::sleep(inter_write_delay).await;
		}
	}
	Ok(stats)
}

fn publish_gate(gate_dir: &Path, name: &str) -> Result<()> {
	std::fs::write(gate_dir.join(name), b"ready\n")
		.with_context(|| format!("failed publishing FDB node-loss gate {name}"))
}

async fn wait_for_gate(gate_dir: &Path, name: &str, deadline: Duration) -> Result<()> {
	let gate = gate_dir.join(name);
	tokio::time::timeout(deadline, async {
		loop {
			if gate.exists() {
				return;
			}
			tokio::time::sleep(Duration::from_millis(50)).await;
		}
	})
	.await
	.with_context(|| format!("timed out waiting for FDB node-loss gate {name}"))?;
	Ok(())
}

async fn verify_acknowledged_entries(db: &Database, prefix: &[u8], count: u64) -> Result<()> {
	for sequence in 0..count {
		let key = entry_key(prefix, sequence);
		let expected = entry_value(sequence);
		let actual = tokio::time::timeout(
			WRITE_DEADLINE,
			db.txn("foundationdb_node_loss_verify", move |tx| {
				let key = key.clone();
				async move { tx.get(&key, Serializable).await }
			}),
		)
		.await
		.with_context(|| format!("verification read {sequence} exceeded its deadline"))??;
		let actual = actual.with_context(|| format!("acknowledged entry {sequence} is missing"))?;
		ensure!(
			actual.as_slice() == expected,
			"acknowledged entry {sequence} was corrupted"
		);
	}

	let key = manifest_key(prefix);
	let manifest = db
		.txn("foundationdb_node_loss_manifest", move |tx| {
			let key = key.clone();
			async move { tx.get(&key, Serializable).await }
		})
		.await?
		.context("acknowledged high-water manifest is missing")?;
	ensure!(
		manifest.as_slice() == (count - 1).to_be_bytes(),
		"acknowledged high-water manifest does not match the final sequence"
	);

	Ok(())
}

/// Opt-in live test driven by the FDB fault qualification wrappers.
///
/// The wrapper overlaps the transition phase with permanent loss of one process's tmpfs-backed
/// local data. Writes continue while the five-process `triple` cluster has only four processes,
/// then the empty process rejoins and FDB restores full replication before final verification.
#[tokio::test]
async fn acknowledged_writes_survive_fdb_fault_and_recovery() -> Result<()> {
	if std::env::var("RIVET_TEST_FDB_NODE_LOSS").as_deref() != Ok("1") {
		return Ok(());
	}

	let gate_dir = PathBuf::from(
		std::env::var_os("RIVET_TEST_FDB_NODE_LOSS_GATE")
			.context("RIVET_TEST_FDB_NODE_LOSS_GATE must be set by the qualification wrapper")?,
	);
	let failed_nodes = std::env::var("RIVET_TEST_FDB_NODE_LOSS_COUNT")
		.unwrap_or_else(|_| "1".to_string())
		.parse::<u8>()
		.context("RIVET_TEST_FDB_NODE_LOSS_COUNT must be 1 or 2")?;
	ensure!(
		matches!(failed_nodes, 1 | 2),
		"RIVET_TEST_FDB_NODE_LOSS_COUNT must be 1 or 2"
	);
	let fault_kind = std::env::var("RIVET_TEST_FDB_FAULT_KIND")
		.unwrap_or_else(|_| "node_and_disk_loss".to_string());
	let gate_deadline = std::env::var("RIVET_TEST_FDB_GATE_DEADLINE_SECONDS")
		.ok()
		.map(|value| {
			value
				.parse::<u64>()
				.map(Duration::from_secs)
				.context("RIVET_TEST_FDB_GATE_DEADLINE_SECONDS must be an integer")
		})
		.transpose()?
		.unwrap_or(DEFAULT_GATE_DEADLINE);
	let cluster_file = std::env::var_os("FDB_CLUSTER_FILE").map(Into::into);
	let driver =
		universaldb::driver::FoundationDbDatabaseDriver::new(FoundationDbConfig { cluster_file })?;
	let db = Database::new(Arc::new(driver));
	let prefix = format!("rivet/test/fdb-node-loss/{}/", Uuid::new_v4()).into_bytes();

	let pre_loss = run_phase(&db, &prefix, 0, PRE_LOSS_WRITES, Duration::ZERO).await?;
	pre_loss.print("pre_loss");
	publish_gate(&gate_dir, "ready")?;
	wait_for_gate(&gate_dir, "node-stop-begun", gate_deadline).await?;

	// The delay keeps this phase in flight while Docker stops the selected FDB process.
	let transition = run_phase(
		&db,
		&prefix,
		PRE_LOSS_WRITES,
		TRANSITION_WRITES,
		Duration::from_millis(10),
	)
	.await?;
	transition.print("transition");
	wait_for_gate(&gate_dir, "node-stopped", gate_deadline).await?;

	let node_down = run_phase(
		&db,
		&prefix,
		PRE_LOSS_WRITES + TRANSITION_WRITES,
		NODE_DOWN_WRITES,
		Duration::ZERO,
	)
	.await?;
	node_down.print("node_down");
	publish_gate(&gate_dir, "node-down-writes-complete")?;
	wait_for_gate(&gate_dir, "cluster-recovered", gate_deadline).await?;

	let recovered_first = PRE_LOSS_WRITES + TRANSITION_WRITES + NODE_DOWN_WRITES;
	let recovered = run_phase(
		&db,
		&prefix,
		recovered_first,
		RECOVERED_WRITES,
		Duration::ZERO,
	)
	.await?;
	recovered.print("recovered");

	let acknowledged = recovered_first + RECOVERED_WRITES;
	verify_acknowledged_entries(&db, &prefix, acknowledged).await?;
	println!(
		"FDB_FAULT_OK fault_kind={fault_kind} failed_nodes={failed_nodes} acknowledged={acknowledged} missing=0 corrupt=0 final_sequence={}",
		acknowledged - 1
	);

	Ok(())
}
