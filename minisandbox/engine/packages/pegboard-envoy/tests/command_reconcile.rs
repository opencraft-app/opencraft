use std::{collections::HashSet, sync::Arc};

use anyhow::Result;
use gas::prelude::Id;
use rivet_envoy_protocol as protocol;
use tempfile::Builder;

#[path = "../src/command_reconcile.rs"]
mod command_reconcile;

async fn test_db() -> Result<(universaldb::Database, tempfile::TempDir)> {
	let directory = Builder::new()
		.prefix("pegboard-envoy-command-reconcile-")
		.tempdir()?;
	let driver =
		universaldb::driver::RocksDbDatabaseDriver::new(directory.path().to_path_buf()).await?;
	Ok((universaldb::Database::new(Arc::new(driver)), directory))
}

fn stop_command() -> protocol::ActorCommandKeyData {
	protocol::ActorCommandKeyData::CommandStopActor(protocol::CommandStopActor {
		reason: protocol::StopActorReason::StopIntent,
	})
}

#[tokio::test]
async fn pending_command_scan_is_bounded_paginated_and_envoy_local() -> Result<()> {
	assert_eq!(
		command_reconcile::PAGE_SIZE,
		protocol::MAX_COMMAND_ACK_CHECKPOINTS,
		"command replay and ACK transaction bounds must stay aligned"
	);
	let (db, _directory) = test_db().await?;
	let namespace_id = Id::new_v1(1);
	let other_namespace_id = Id::new_v1(1);
	let envoy_key = "target-envoy".to_string();
	let actor_ids = (0..7).map(|_| Id::new_v1(1)).collect::<Vec<_>>();
	let expected = actor_ids
		.iter()
		.enumerate()
		.map(|(index, actor_id)| (actor_id.to_string(), index as i64))
		.collect::<HashSet<_>>();
	let actor_ids_for_write = actor_ids.clone();
	let envoy_key_for_write = envoy_key.clone();
	db.txn("test_seed_envoy_commands", move |tx| {
		let actor_ids = actor_ids_for_write.clone();
		let envoy_key = envoy_key_for_write.clone();
		async move {
			let tx = tx.with_subspace(pegboard::keys::subspace());
			for (index, actor_id) in actor_ids.into_iter().enumerate() {
				tx.write(
					&pegboard::keys::envoy::ActorCommandKey::new(
						namespace_id,
						envoy_key.clone(),
						actor_id,
						1,
						index as i64,
					),
					stop_command(),
				)?;
			}
			// These adjacent command subspaces must never leak into the target scan.
			tx.write(
				&pegboard::keys::envoy::ActorCommandKey::new(
					namespace_id,
					"other-envoy".to_string(),
					Id::new_v1(1),
					1,
					99,
				),
				stop_command(),
			)?;
			tx.write(
				&pegboard::keys::envoy::ActorCommandKey::new(
					other_namespace_id,
					envoy_key,
					Id::new_v1(1),
					1,
					100,
				),
				stop_command(),
			)?;
			Ok(())
		}
	})
	.await?;

	let mut cursor = None;
	let mut actual = HashSet::new();
	let mut page_sizes = Vec::new();
	loop {
		let page =
			command_reconcile::read_page(&db, namespace_id, &envoy_key, cursor.as_deref(), 3)
				.await?;
		page_sizes.push(page.commands.len());
		for command in page.commands {
			assert_eq!(command.checkpoint.generation, 1);
			assert!(matches!(
				command.inner,
				protocol::Command::CommandStopActor(_)
			));
			assert!(actual.insert((command.checkpoint.actor_id, command.checkpoint.index)));
		}
		cursor = page.next_cursor;
		if cursor.is_none() {
			break;
		}
	}

	assert_eq!(page_sizes, vec![3, 3, 1]);
	assert_eq!(actual, expected);
	Ok(())
}

#[tokio::test]
async fn pending_command_scan_rejects_unbounded_or_foreign_cursor() -> Result<()> {
	let (db, _directory) = test_db().await?;
	let namespace_id = Id::new_v1(1);
	let zero = command_reconcile::read_page(&db, namespace_id, "envoy", None, 0)
		.await
		.expect_err("zero page size must be rejected");
	assert!(zero.to_string().contains("page size must be positive"));

	let foreign =
		command_reconcile::read_page(&db, namespace_id, "envoy", Some(b"foreign-subspace"), 1)
			.await
			.expect_err("foreign cursor must be rejected");
	assert!(
		format!("{foreign:#}").contains("outside the Envoy subspace"),
		"unexpected error chain: {foreign:#}"
	);
	Ok(())
}
