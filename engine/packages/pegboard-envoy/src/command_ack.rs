use anyhow::{Result, ensure};
use gas::prelude::Id;
use rivet_envoy_protocol as protocol;
use universaldb::{Database, utils::end_of_key_range};

/// Durably apply one bounded command acknowledgement.
///
/// Retrying this operation after the response is lost is safe: every mutation is a range clear,
/// and the ACK-of-ACK is emitted by the caller only after this transaction commits.
pub(crate) async fn commit(
	db: &Database,
	namespace_id: Id,
	envoy_key: &str,
	ack: &protocol::ToRivetAckCommands,
) -> Result<()> {
	ensure!(
		ack.last_command_checkpoints.len() <= protocol::MAX_COMMAND_ACK_CHECKPOINTS,
		"command ACK contains {} checkpoints, limit is {}",
		ack.last_command_checkpoints.len(),
		protocol::MAX_COMMAND_ACK_CHECKPOINTS
	);

	db.txn("envoy_handle_ack", |tx| async move {
		let tx = tx.with_subspace(pegboard::keys::subspace());

		for checkpoint in &ack.last_command_checkpoints {
			let start = tx.pack(
				&pegboard::keys::envoy::ActorCommandKey::subspace_with_actor(
					namespace_id,
					envoy_key.to_string(),
					Id::parse(&checkpoint.actor_id)?,
					checkpoint.generation,
				),
			);
			let end = end_of_key_range(&tx.pack(
				&pegboard::keys::envoy::ActorCommandKey::subspace_with_index(
					namespace_id,
					envoy_key.to_string(),
					Id::parse(&checkpoint.actor_id)?,
					checkpoint.generation,
					checkpoint.index,
				),
			));
			tx.clear_range(&start, &end);
		}

		Ok(())
	})
	.await
}
