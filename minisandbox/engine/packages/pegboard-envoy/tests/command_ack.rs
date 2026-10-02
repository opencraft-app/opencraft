use std::sync::Arc;

use anyhow::Result;
use gas::prelude::Id;
use rivet_envoy_protocol as protocol;
use tempfile::Builder;
use universaldb::driver::RocksDbDatabaseDriver;

#[path = "../src/command_ack.rs"]
mod command_ack;
#[allow(dead_code)]
#[path = "../src/command_ack_fault.rs"]
mod command_ack_fault;
#[allow(dead_code)]
#[path = "../src/command_reconcile.rs"]
mod command_reconcile;

async fn test_db() -> Result<(universaldb::Database, tempfile::TempDir)> {
	let directory = Builder::new()
		.prefix("pegboard-envoy-command-ack-")
		.tempdir()?;
	let driver = RocksDbDatabaseDriver::new(directory.path().to_path_buf()).await?;
	Ok((universaldb::Database::new(Arc::new(driver)), directory))
}

fn checkpoint(actor_id: Id, generation: u32, index: i64) -> protocol::ActorCheckpoint {
	protocol::ActorCheckpoint {
		actor_id: actor_id.to_string(),
		generation,
		index,
	}
}

async fn seed_commands(
	db: &universaldb::Database,
	namespace_id: Id,
	envoy_key: &str,
	actor_id: Id,
	indices: &[i64],
) -> Result<()> {
	db.txn("test_seed_ack_commands", |tx| {
		let indices = indices.to_vec();
		async move {
			let tx = tx.with_subspace(pegboard::keys::subspace());
			for index in indices {
				tx.write(
					&pegboard::keys::envoy::ActorCommandKey::new(
						namespace_id,
						envoy_key.to_string(),
						actor_id,
						1,
						index,
					),
					protocol::ActorCommandKeyData::CommandStopActor(protocol::CommandStopActor {
						reason: protocol::StopActorReason::StopIntent,
					}),
				)?;
			}
			Ok(())
		}
	})
	.await
}

async fn command_indices(
	db: &universaldb::Database,
	namespace_id: Id,
	envoy_key: &str,
	actor_id: Id,
) -> Result<Vec<i64>> {
	let page = command_reconcile::read_page(db, namespace_id, envoy_key, None, 1024).await?;
	Ok(page
		.commands
		.into_iter()
		.filter(|command| {
			command.checkpoint.actor_id == actor_id.to_string()
				&& command.checkpoint.generation == 1
		})
		.map(|command| command.checkpoint.index)
		.collect())
}

#[tokio::test]
async fn lost_commit_barrier_can_repeat_ack_without_clearing_newer_command() -> Result<()> {
	let (db, _directory) = test_db().await?;
	let namespace_id = Id::new_v1(1);
	let envoy_key = "envoy-a";
	let actor_id = Id::new_v1(1);
	seed_commands(&db, namespace_id, envoy_key, actor_id, &[1, 2, 3]).await?;

	let ack = protocol::ToRivetAckCommands {
		last_command_checkpoints: vec![checkpoint(actor_id, 1, 2)],
	};
	command_ack::commit(&db, namespace_id, envoy_key, &ack).await?;
	assert_eq!(
		command_indices(&db, namespace_id, envoy_key, actor_id).await?,
		vec![3]
	);

	// Model a committed FDB clear whose ACK-of-ACK frame was lost with the websocket. The client
	// retains its checkpoint and sends the identical ACK on reconnect.
	command_ack::commit(&db, namespace_id, envoy_key, &ack).await?;
	assert_eq!(
		command_indices(&db, namespace_id, envoy_key, actor_id).await?,
		vec![3]
	);
	Ok(())
}

#[tokio::test]
async fn oversized_command_ack_is_rejected_before_mutation() -> Result<()> {
	let (db, _directory) = test_db().await?;
	let namespace_id = Id::new_v1(1);
	let envoy_key = "envoy-a";
	let actor_id = Id::new_v1(1);
	seed_commands(&db, namespace_id, envoy_key, actor_id, &[1]).await?;

	let ack = protocol::ToRivetAckCommands {
		last_command_checkpoints: (0..=protocol::MAX_COMMAND_ACK_CHECKPOINTS)
			.map(|_| checkpoint(actor_id, 1, 1))
			.collect(),
	};
	let error = command_ack::commit(&db, namespace_id, envoy_key, &ack)
		.await
		.expect_err("oversized ACK must fail closed");
	assert!(error.to_string().contains("limit is 512"));
	assert_eq!(
		command_indices(&db, namespace_id, envoy_key, actor_id).await?,
		vec![1]
	);
	Ok(())
}

#[tokio::test]
async fn malformed_checkpoint_aborts_the_whole_ack_transaction() -> Result<()> {
	let (db, _directory) = test_db().await?;
	let namespace_id = Id::new_v1(1);
	let envoy_key = "envoy-a";
	let actor_id = Id::new_v1(1);
	seed_commands(&db, namespace_id, envoy_key, actor_id, &[1]).await?;

	let ack = protocol::ToRivetAckCommands {
		last_command_checkpoints: vec![
			checkpoint(actor_id, 1, 1),
			protocol::ActorCheckpoint {
				actor_id: "not-an-actor-id".to_string(),
				generation: 1,
				index: 1,
			},
		],
	};
	command_ack::commit(&db, namespace_id, envoy_key, &ack)
		.await
		.expect_err("malformed checkpoint must abort the transaction");
	assert_eq!(
		command_indices(&db, namespace_id, envoy_key, actor_id).await?,
		vec![1]
	);
	Ok(())
}
