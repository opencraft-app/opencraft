use std::result::Result::Ok;

use anyhow::*;
use rivet_util::Id;
use universaldb::prelude::*;

pub const WORKFLOW_WAKE_SHARD_COUNT: usize = 32;

pub fn workflow_wake_shard(workflow_id: Id) -> usize {
	// FNV-1a is deliberately specified here instead of `DefaultHasher`: this value is part of the
	// durable FDB key layout and must remain stable across Rust/toolchain upgrades.
	let hash = workflow_id
		.as_bytes()
		.into_iter()
		.fold(0xcbf29ce484222325u64, |hash, byte| {
			(hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
		});
	(hash as usize) % WORKFLOW_WAKE_SHARD_COUNT
}

#[derive(Debug)]
pub enum WakeCondition {
	Immediate,
	Deadline { deadline_ts: i64 },
	SubWorkflow { sub_workflow_id: Id },
	Signal { signal_id: Id },
}

impl WakeCondition {
	fn variant(&self) -> WakeConditionVariant {
		match self {
			WakeCondition::Immediate => WakeConditionVariant::Immediate,
			WakeCondition::Deadline { .. } => WakeConditionVariant::Deadline,
			WakeCondition::SubWorkflow { .. } => WakeConditionVariant::SubWorkflow,
			WakeCondition::Signal { .. } => WakeConditionVariant::Signal,
		}
	}

	pub fn deadline_ts(&self) -> Option<i64> {
		match self {
			WakeCondition::Deadline { deadline_ts } => Some(*deadline_ts),
			_ => None,
		}
	}
}

#[derive(strum::FromRepr)]
enum WakeConditionVariant {
	Immediate = 0,
	Deadline = 1,
	SubWorkflow = 2,
	Signal = 3,
}

#[derive(Debug)]
pub struct WorkflowWakeConditionKey {
	pub workflow_name: String,
	pub ts: i64,
	pub workflow_id: Id,
	pub condition: WakeCondition,
}

impl WorkflowWakeConditionKey {
	pub fn new(workflow_name: String, workflow_id: Id, condition: WakeCondition) -> Self {
		WorkflowWakeConditionKey {
			workflow_name,
			// NOTE: Override current ts with deadline
			ts: if let WakeCondition::Deadline { deadline_ts } = &condition {
				*deadline_ts
			} else {
				rivet_util::timestamp::now()
			},
			workflow_id,
			condition,
		}
	}

	pub fn subspace(shard: usize, ts: i64) -> WorkflowWakeConditionSubspaceKey {
		WorkflowWakeConditionSubspaceKey::new(shard, ts)
	}

	pub fn subspace_without_ts(shard: usize) -> WorkflowWakeConditionSubspaceKey {
		WorkflowWakeConditionSubspaceKey::new_without_ts(shard)
	}
}

impl FormalKey for WorkflowWakeConditionKey {
	type Value = ();

	fn deserialize(&self, _raw: &[u8]) -> Result<Self::Value> {
		Ok(())
	}

	fn serialize(&self, _value: Self::Value) -> Result<Vec<u8>> {
		Ok(Vec::new())
	}
}

impl TuplePack for WorkflowWakeConditionKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let mut offset = VersionstampOffset::None { size: 0 };

		let t = (
			WAKE,
			WORKFLOW,
			workflow_wake_shard(self.workflow_id),
			self.ts,
			&self.workflow_name,
			self.workflow_id,
			self.condition.variant() as usize,
		);
		offset += t.pack(w, tuple_depth)?;

		match &self.condition {
			WakeCondition::Immediate | WakeCondition::Deadline { .. } => {}
			WakeCondition::SubWorkflow { sub_workflow_id } => {
				offset += sub_workflow_id.pack(w, tuple_depth)?;
			}
			WakeCondition::Signal { signal_id } => {
				offset += signal_id.pack(w, tuple_depth)?;
			}
		}

		Ok(offset)
	}
}

impl<'de> TupleUnpack<'de> for WorkflowWakeConditionKey {
	fn unpack(input: &[u8], tuple_depth: TupleDepth) -> PackResult<(&[u8], Self)> {
		let (input, (_, _, shard, ts, workflow_name, workflow_id, wake_condition_variant)) =
			<(usize, usize, usize, i64, String, Id, usize)>::unpack(input, tuple_depth)?;
		if shard != workflow_wake_shard(workflow_id) {
			return Err(PackError::Message(
				"workflow wake shard does not match workflow id".into(),
			));
		}
		let wake_condition_variant = WakeConditionVariant::from_repr(wake_condition_variant)
			.ok_or_else(|| {
				PackError::Message(
					format!("invalid wake condition variant `{wake_condition_variant}` in key")
						.into(),
				)
			})?;

		let (input, v) = match wake_condition_variant {
			WakeConditionVariant::Immediate => (
				input,
				WorkflowWakeConditionKey {
					workflow_name,
					ts,
					workflow_id,
					condition: WakeCondition::Immediate,
				},
			),
			WakeConditionVariant::Deadline => (
				input,
				WorkflowWakeConditionKey {
					workflow_name,
					ts,
					workflow_id,
					condition: WakeCondition::Deadline {
						// See `WorkflowWakeConditionKey::new`
						deadline_ts: ts,
					},
				},
			),
			WakeConditionVariant::SubWorkflow => {
				let (input, sub_workflow_id) = Id::unpack(input, tuple_depth)?;

				(
					input,
					WorkflowWakeConditionKey {
						workflow_name,
						ts,
						workflow_id,
						condition: WakeCondition::SubWorkflow { sub_workflow_id },
					},
				)
			}
			WakeConditionVariant::Signal => {
				let (input, signal_id) = Id::unpack(input, tuple_depth)?;

				(
					input,
					WorkflowWakeConditionKey {
						workflow_name,
						ts,
						workflow_id,
						condition: WakeCondition::Signal { signal_id },
					},
				)
			}
		};

		Ok((input, v))
	}
}

// Prefix structure should match `WorkflowWakeConditionKey` through `ts`.
pub struct WorkflowWakeConditionSubspaceKey {
	shard: usize,
	ts: Option<i64>,
}

impl WorkflowWakeConditionSubspaceKey {
	pub fn new(shard: usize, ts: i64) -> Self {
		WorkflowWakeConditionSubspaceKey {
			shard,
			ts: Some(ts),
		}
	}

	pub fn new_without_ts(shard: usize) -> Self {
		WorkflowWakeConditionSubspaceKey { shard, ts: None }
	}
}

impl TuplePack for WorkflowWakeConditionSubspaceKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let mut offset = VersionstampOffset::None { size: 0 };

		let t = (WAKE, WORKFLOW, self.shard);
		offset += t.pack(w, tuple_depth)?;

		if let Some(ts) = &self.ts {
			offset += ts.pack(w, tuple_depth)?;
		}

		Ok(offset)
	}
}

#[cfg(test)]
mod workflow_wake_shard_tests {
	use super::*;

	#[test]
	fn shard_hash_and_key_range_are_stable() {
		let workflow_id = Id::nil();
		let shard = workflow_wake_shard(workflow_id);
		assert_eq!(shard, 12, "durable wake shard hash changed");

		let root = universaldb::utils::Subspace::new(&("wake-shard-test",));
		let key = WorkflowWakeConditionKey {
			workflow_name: "actor".to_string(),
			ts: 1234,
			workflow_id,
			condition: WakeCondition::Immediate,
		};
		let raw = root.pack(&key);
		let decoded = root
			.unpack::<WorkflowWakeConditionKey>(&raw)
			.expect("sharded wake key should round trip");
		assert_eq!(decoded.workflow_name, "actor");
		assert_eq!(decoded.ts, 1234);
		assert_eq!(decoded.workflow_id, workflow_id);
		assert!(matches!(decoded.condition, WakeCondition::Immediate));

		let shard_range = root
			.subspace(&WorkflowWakeConditionKey::subspace_without_ts(shard))
			.range();
		assert!(raw >= shard_range.0 && raw < shard_range.1);
		let other_range = root
			.subspace(&WorkflowWakeConditionKey::subspace_without_ts(
				(shard + 1) % WORKFLOW_WAKE_SHARD_COUNT,
			))
			.range();
		assert!(raw < other_range.0 || raw >= other_range.1);
	}
}

#[derive(Debug)]
pub struct SubWorkflowWakeKey {
	pub sub_workflow_id: Id,
	/// For ordering.
	pub ts: i64,
	pub workflow_id: Id,
}

impl SubWorkflowWakeKey {
	pub fn new(sub_workflow_id: Id, workflow_id: Id) -> Self {
		SubWorkflowWakeKey {
			sub_workflow_id,
			ts: rivet_util::timestamp::now(),
			workflow_id,
		}
	}

	pub fn subspace(sub_workflow_id: Id) -> SubWorkflowWakeSubspaceKey {
		SubWorkflowWakeSubspaceKey::new(sub_workflow_id)
	}
}

impl FormalKey for SubWorkflowWakeKey {
	/// Workflow name (not sub workflow name).
	type Value = String;

	fn deserialize(&self, raw: &[u8]) -> Result<Self::Value> {
		String::from_utf8(raw.to_vec()).map_err(Into::into)
	}

	fn serialize(&self, value: Self::Value) -> Result<Vec<u8>> {
		Ok(value.into_bytes())
	}
}

impl TuplePack for SubWorkflowWakeKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let t = (
			WAKE,
			SUB_WORKFLOW,
			&self.sub_workflow_id,
			self.ts,
			self.workflow_id,
		);
		t.pack(w, tuple_depth)
	}
}

impl<'de> TupleUnpack<'de> for SubWorkflowWakeKey {
	fn unpack(input: &[u8], tuple_depth: TupleDepth) -> PackResult<(&[u8], Self)> {
		let (input, (_, _, sub_workflow_id, ts, workflow_id)) =
			<(usize, usize, Id, i64, Id)>::unpack(input, tuple_depth)?;
		let v = SubWorkflowWakeKey {
			sub_workflow_id,
			ts,
			workflow_id,
		};

		Ok((input, v))
	}
}

#[derive(Debug)]
pub struct SubWorkflowWakeSubspaceKey {
	sub_workflow_id: Id,
}

impl SubWorkflowWakeSubspaceKey {
	pub fn new(sub_workflow_id: Id) -> Self {
		SubWorkflowWakeSubspaceKey { sub_workflow_id }
	}
}

impl TuplePack for SubWorkflowWakeSubspaceKey {
	fn pack<W: std::io::Write>(
		&self,
		w: &mut W,
		tuple_depth: TupleDepth,
	) -> std::io::Result<VersionstampOffset> {
		let t = (WAKE, SUB_WORKFLOW, self.sub_workflow_id);
		t.pack(w, tuple_depth)
	}
}
