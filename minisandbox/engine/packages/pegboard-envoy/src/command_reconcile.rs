use anyhow::Result;
use futures_util::TryStreamExt;
use gas::prelude::Id;
use rivet_envoy_protocol as protocol;
use universaldb::prelude::*;

/// Bound every command reconciliation transaction and websocket frame. A cursor carries the
/// per-Envoy scan across pages, so a large backlog cannot turn reconnect into an unbounded FDB
/// range read or starve commands whose actor IDs sort near the end of the subspace.
pub(crate) const PAGE_SIZE: usize = 512;

#[derive(Debug)]
pub(crate) struct PendingCommandPage {
	pub commands: Vec<protocol::CommandWrapper>,
	pub next_cursor: Option<Vec<u8>>,
}

pub(crate) async fn read_page(
	db: &universaldb::Database,
	namespace_id: Id,
	envoy_key: &str,
	cursor: Option<&[u8]>,
	limit: usize,
) -> Result<PendingCommandPage> {
	anyhow::ensure!(limit > 0, "command reconcile page size must be positive");

	let envoy_key = envoy_key.to_string();
	let cursor = cursor.map(ToOwned::to_owned);
	db.txn("envoy_reconcile_commands", move |tx| {
		let envoy_key = envoy_key.clone();
		let cursor = cursor.clone();
		async move {
			let command_subspace = pegboard::keys::subspace().subspace(
				&pegboard::keys::envoy::ActorCommandKey::subspace(namespace_id, envoy_key),
			);
			if let Some(cursor) = cursor.as_deref() {
				anyhow::ensure!(
					cursor.starts_with(command_subspace.bytes()),
					"command reconcile cursor is outside the Envoy subspace"
				);
			}
			let (range_start, range_end) = command_subspace.range();
			let begin = cursor
				.as_deref()
				.map(KeySelector::first_greater_than)
				.unwrap_or_else(|| KeySelector::first_greater_or_equal(range_start));
			let formal = tx.with_subspace(pegboard::keys::subspace());
			let mut entries = formal.get_ranges_keyvalues(
				RangeOption {
					begin,
					end: KeySelector::first_greater_or_equal(range_end),
					limit: Some(limit.saturating_add(1)),
					mode: StreamingMode::Exact,
					..RangeOption::default()
				},
				Snapshot,
			);
			let mut rows = Vec::new();
			while let Some(entry) = entries.try_next().await? {
				rows.push((entry.key().to_vec(), entry));
			}
			drop(entries);

			let has_more = rows.len() > limit;
			if has_more {
				rows.pop();
			}
			let next_cursor = has_more.then(|| {
				rows.last()
					.expect("non-empty full command reconcile page")
					.0
					.clone()
			});
			let commands = rows
				.into_iter()
				.map(|(_, entry)| {
					let (key, command) =
						formal.read_entry::<pegboard::keys::envoy::ActorCommandKey>(&entry)?;
					Ok(protocol::CommandWrapper {
						checkpoint: protocol::ActorCheckpoint {
							actor_id: key.actor_id.to_string(),
							generation: key.generation,
							index: key.index,
						},
						inner: match command {
							protocol::ActorCommandKeyData::CommandStartActor(command) => {
								protocol::Command::CommandStartActor(command)
							}
							protocol::ActorCommandKeyData::CommandStopActor(command) => {
								protocol::Command::CommandStopActor(command)
							}
						},
					})
				})
				.collect::<Result<Vec<_>>>()?;

			Ok(PendingCommandPage {
				commands,
				next_cursor,
			})
		}
	})
	.await
}
