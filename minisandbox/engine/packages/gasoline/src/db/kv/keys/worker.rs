use anyhow::Result;
use rivet_util::Id;
use serde::{Deserialize, Serialize};
use universaldb::prelude::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerLeaseValue {
	pub workflow_name: String,
	pub lease_id: Id,
	pub wake_deadline_ts: Option<i64>,
	pub earliest_wake_condition_ts: i64,
}

/// Secondary lease index used both for bounded worker failover and for recovering the result of an
/// ambiguous lease-acquisition commit. Ordering by worker and pull keeps both access paths local.
#[derive(Debug)]
pub struct WorkerLeaseKey {
	pub worker_id: Id,
	pub pull_id: Id,
	pub workflow_id: Id,
}

impl WorkerLeaseKey {
	pub fn new(worker_id: Id, pull_id: Id, workflow_id: Id) -> Self {
		Self {
			worker_id,
			pull_id,
			workflow_id,
		}
	}

	pub fn worker_subspace(worker_id: Id) -> WorkerLeaseSubspaceKey {
		WorkerLeaseSubspaceKey::worker(worker_id)
	}

	pub fn pull_subspace(worker_id: Id, pull_id: Id) -> WorkerLeaseSubspaceKey {
		WorkerLeaseSubspaceKey::pull(worker_id, pull_id)
	}
}

impl FormalKey for WorkerLeaseKey {
	type Value = WorkerLeaseValue;

	fn deserialize(&self, raw: &[u8]) -> Result<Self::Value> {
		serde_json::from_slice(raw).map_err(Into::into)
	}

	fn serialize(&self, value: Self::Value) -> Result<Vec<u8>> {
		serde_json::to_vec(&value).map_err(Into::into)
	}
}

impl TuplePack for WorkerLeaseKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		(
			WORKER,
			LEASE,
			self.worker_id,
			self.pull_id,
			self.workflow_id,
		)
			.pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for WorkerLeaseKey {
	fn unpack(input: &'de [u8], tuple_depth: TupleDepth) -> PackResult<(&'de [u8], Self)> {
		let (input, (_, _, worker_id, pull_id, workflow_id)) =
			<(usize, usize, Id, Id, Id)>::unpack(input, tuple_depth)?;
		Ok((
			input,
			Self {
				worker_id,
				pull_id,
				workflow_id,
			},
		))
	}
}

pub struct WorkerLeaseSubspaceKey {
	worker_id: Id,
	pull_id: Option<Id>,
}

impl WorkerLeaseSubspaceKey {
	fn worker(worker_id: Id) -> Self {
		Self {
			worker_id,
			pull_id: None,
		}
	}

	fn pull(worker_id: Id, pull_id: Id) -> Self {
		Self {
			worker_id,
			pull_id: Some(pull_id),
		}
	}
}

impl TuplePack for WorkerLeaseSubspaceKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let mut offset = (WORKER, LEASE, self.worker_id).pack(w, tuple_depth)?;
		if let Some(pull_id) = self.pull_id {
			offset += pull_id.pack(w, tuple_depth)?;
		}
		Ok(offset)
	}
}

#[derive(Debug)]
pub struct LastPingIdxKey {
	pub last_ping_ts: i64,
	pub worker_id: Id,
}

impl LastPingIdxKey {
	pub fn new(last_ping_ts: i64, worker_id: Id) -> Self {
		Self {
			last_ping_ts,
			worker_id,
		}
	}

	pub fn subspace(last_ping_ts: i64) -> LastPingIdxSubspaceKey {
		LastPingIdxSubspaceKey {
			last_ping_ts: Some(last_ping_ts),
		}
	}

	pub fn entire_subspace() -> LastPingIdxSubspaceKey {
		LastPingIdxSubspaceKey { last_ping_ts: None }
	}
}

impl FormalKey for LastPingIdxKey {
	type Value = ();

	fn deserialize(&self, _raw: &[u8]) -> Result<Self::Value> {
		Ok(())
	}

	fn serialize(&self, _value: Self::Value) -> Result<Vec<u8>> {
		Ok(Vec::new())
	}
}

impl TuplePack for LastPingIdxKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		(WORKER, LAST_PING_TS, self.last_ping_ts, self.worker_id).pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for LastPingIdxKey {
	fn unpack(input: &'de [u8], tuple_depth: TupleDepth) -> PackResult<(&'de [u8], Self)> {
		let (input, (_, _, last_ping_ts, worker_id)) =
			<(usize, usize, i64, Id)>::unpack(input, tuple_depth)?;
		Ok((
			input,
			Self {
				last_ping_ts,
				worker_id,
			},
		))
	}
}

pub struct LastPingIdxSubspaceKey {
	last_ping_ts: Option<i64>,
}

impl TuplePack for LastPingIdxSubspaceKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let mut offset = (WORKER, LAST_PING_TS).pack(w, tuple_depth)?;
		if let Some(last_ping_ts) = self.last_ping_ts {
			offset += last_ping_ts.pack(w, tuple_depth)?;
		}
		Ok(offset)
	}
}

#[derive(Debug)]
pub struct LeaseGcLockKey;

impl LeaseGcLockKey {
	pub fn new() -> Self {
		Self
	}
}

impl FormalKey for LeaseGcLockKey {
	/// Lock owner and expiration timestamp.
	type Value = (Id, i64);

	fn deserialize(&self, raw: &[u8]) -> Result<Self::Value> {
		serde_json::from_slice(raw).map_err(Into::into)
	}

	fn serialize(&self, value: Self::Value) -> Result<Vec<u8>> {
		serde_json::to_vec(&value).map_err(Into::into)
	}
}

impl TuplePack for LeaseGcLockKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		(WORKER, GLOBAL, LEASE).pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for LeaseGcLockKey {
	fn unpack(input: &'de [u8], tuple_depth: TupleDepth) -> PackResult<(&'de [u8], Self)> {
		let (input, (worker, global, lease)) = <(usize, usize, usize)>::unpack(input, tuple_depth)?;
		if worker != WORKER || global != GLOBAL || lease != LEASE {
			return Err(PackError::Message("expected lease GC lock".into()));
		}
		Ok((input, Self))
	}
}

#[derive(Debug)]
pub struct LastPingTsKey {
	worker_id: Id,
}

impl LastPingTsKey {
	pub fn new(worker_id: Id) -> Self {
		LastPingTsKey { worker_id }
	}
}

impl FormalKey for LastPingTsKey {
	// Timestamp.
	type Value = i64;

	fn deserialize(&self, raw: &[u8]) -> Result<Self::Value> {
		Ok(i64::from_be_bytes(raw.try_into()?))
	}

	fn serialize(&self, value: Self::Value) -> Result<Vec<u8>> {
		Ok(value.to_be_bytes().to_vec())
	}
}

impl TuplePack for LastPingTsKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let t = (WORKER, DATA, self.worker_id, LAST_PING_TS);
		t.pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for LastPingTsKey {
	fn unpack(input: &[u8], tuple_depth: TupleDepth) -> PackResult<(&[u8], Self)> {
		let (input, (_, _, worker_id, _)) =
			<(usize, usize, Id, usize)>::unpack(input, tuple_depth)?;
		let v = LastPingTsKey { worker_id };

		Ok((input, v))
	}
}

#[derive(Debug)]
pub struct LastActivePingTsKey {
	worker_id: Id,
}

impl LastActivePingTsKey {
	pub fn new(worker_id: Id) -> Self {
		LastActivePingTsKey { worker_id }
	}
}

impl FormalKey for LastActivePingTsKey {
	// Timestamp.
	type Value = i64;

	fn deserialize(&self, raw: &[u8]) -> Result<Self::Value> {
		Ok(i64::from_be_bytes(raw.try_into()?))
	}

	fn serialize(&self, value: Self::Value) -> Result<Vec<u8>> {
		Ok(value.to_be_bytes().to_vec())
	}
}

impl TuplePack for LastActivePingTsKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let t = (WORKER, DATA, self.worker_id, LAST_ACTIVE_PING_TS);
		t.pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for LastActivePingTsKey {
	fn unpack(input: &[u8], tuple_depth: TupleDepth) -> PackResult<(&[u8], Self)> {
		let (input, (_, _, worker_id, _)) =
			<(usize, usize, Id, usize)>::unpack(input, tuple_depth)?;
		let v = LastActivePingTsKey { worker_id };

		Ok((input, v))
	}
}

#[derive(Debug)]
pub struct VersionKey {
	worker_id: Id,
}

impl VersionKey {
	pub fn new(worker_id: Id) -> Self {
		VersionKey { worker_id }
	}
}

impl FormalKey for VersionKey {
	// Version.
	type Value = i64;

	fn deserialize(&self, raw: &[u8]) -> Result<Self::Value> {
		Ok(i64::from_be_bytes(raw.try_into()?))
	}

	fn serialize(&self, value: Self::Value) -> Result<Vec<u8>> {
		Ok(value.to_be_bytes().to_vec())
	}
}

impl TuplePack for VersionKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let t = (WORKER, DATA, self.worker_id, VERSION);
		t.pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for VersionKey {
	fn unpack(input: &[u8], tuple_depth: TupleDepth) -> PackResult<(&[u8], Self)> {
		let (input, (_, _, worker_id, _)) =
			<(usize, usize, Id, usize)>::unpack(input, tuple_depth)?;
		let v = VersionKey { worker_id };

		Ok((input, v))
	}
}

#[derive(Debug)]
pub struct ActiveWorkerIdxKey {
	last_ping_ts: i64,
	pub version: i64,
	pub worker_id: Id,
}

impl ActiveWorkerIdxKey {
	pub fn new(last_ping_ts: i64, version: i64, worker_id: Id) -> Self {
		ActiveWorkerIdxKey {
			last_ping_ts,
			version,
			worker_id,
		}
	}

	pub fn subspace(last_ping_ts: i64) -> ActiveWorkerIdxSubspaceKey {
		ActiveWorkerIdxSubspaceKey::new(last_ping_ts)
	}

	pub fn entire_subspace() -> ActiveWorkerIdxSubspaceKey {
		ActiveWorkerIdxSubspaceKey::entire()
	}
}

impl FormalKey for ActiveWorkerIdxKey {
	type Value = ();

	fn deserialize(&self, _raw: &[u8]) -> Result<Self::Value> {
		Ok(())
	}

	fn serialize(&self, _value: Self::Value) -> Result<Vec<u8>> {
		Ok(Vec::new())
	}
}

impl TuplePack for ActiveWorkerIdxKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let t = (
			WORKER,
			ACTIVE2,
			self.last_ping_ts,
			// Stored in reverse order (higher versions are first)
			-self.version,
			self.worker_id,
		);
		t.pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for ActiveWorkerIdxKey {
	fn unpack(input: &[u8], tuple_depth: TupleDepth) -> PackResult<(&[u8], Self)> {
		let (input, (_, _, last_ping_ts, version, worker_id)) =
			<(usize, usize, i64, i64, Id)>::unpack(input, tuple_depth)?;
		let v = ActiveWorkerIdxKey {
			last_ping_ts,
			version: -version,
			worker_id,
		};

		Ok((input, v))
	}
}

#[derive(Debug)]
pub struct ActiveWorkerIdxSubspaceKey {
	last_ping_ts: Option<i64>,
}

impl ActiveWorkerIdxSubspaceKey {
	pub fn new(last_ping_ts: i64) -> Self {
		ActiveWorkerIdxSubspaceKey {
			last_ping_ts: Some(last_ping_ts),
		}
	}

	pub fn entire() -> Self {
		ActiveWorkerIdxSubspaceKey { last_ping_ts: None }
	}
}

impl TuplePack for ActiveWorkerIdxSubspaceKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let mut offset = VersionstampOffset::None { size: 0 };

		let t = (WORKER, ACTIVE2);
		offset += t.pack(w, tuple_depth)?;

		if let Some(last_ping_ts) = self.last_ping_ts {
			offset += last_ping_ts.pack(w, tuple_depth)?;
		}

		Ok(offset)
	}
}

#[derive(Debug)]
pub struct MetricsLockKey {}

impl MetricsLockKey {
	pub fn new() -> Self {
		MetricsLockKey {}
	}
}

impl FormalKey for MetricsLockKey {
	// Timestamp.
	type Value = i64;

	fn deserialize(&self, raw: &[u8]) -> Result<Self::Value> {
		Ok(i64::from_be_bytes(raw.try_into()?))
	}

	fn serialize(&self, value: Self::Value) -> Result<Vec<u8>> {
		Ok(value.to_be_bytes().to_vec())
	}
}

impl TuplePack for MetricsLockKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let t = (WORKER, METRICS_LOCK);
		t.pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for MetricsLockKey {
	fn unpack(input: &[u8], tuple_depth: TupleDepth) -> PackResult<(&[u8], Self)> {
		let (input, (_, _)) = <(usize, usize)>::unpack(input, tuple_depth)?;
		let v = MetricsLockKey {};

		Ok((input, v))
	}
}
