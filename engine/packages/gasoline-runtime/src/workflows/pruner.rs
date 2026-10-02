use std::sync::Arc;

use anyhow::Result;
use futures_util::FutureExt;
use gas::{db::debug::DatabaseDebug, prelude::*};

const MAX_PRUNES: usize = 1000;

#[derive(Debug, Deserialize, Serialize)]
pub struct Input {}

#[derive(Debug, Default, Deserialize, Serialize)]
struct PruneState {
	#[serde(default)]
	history_last_key: Option<Vec<u8>>,
	#[serde(default)]
	history_complete: bool,
	#[serde(default)]
	history_prune_count: usize,
	#[serde(default)]
	terminal_complete: bool,
	last_key: Option<Vec<u8>>,
	prune_count: usize,
}

#[workflow]
pub async fn gasoline_pruner(ctx: &mut WorkflowCtx, input: &Input) -> Result<()> {
	ctx.removed::<Repeat>().await?;

	ctx.v(3)
		.repeat(|ctx| {
			async move {
				ctx.loope(PruneState::default(), |ctx, state| {
					async move {
						let res = ctx
							.activity(PruneChunkInput {
								history_last_key: state.history_last_key.clone(),
								history_complete: state.history_complete,
								terminal_complete: state.terminal_complete,
								last_key: state.last_key.clone(),
							})
							.await?;

						match res {
							PruneChunkOutput::Continue {
								history_last_key,
								history_complete,
								history_prune_count,
								terminal_complete,
								new_last_key,
								prune_count,
							} => {
								state.history_last_key = history_last_key;
								state.history_complete = history_complete;
								state.history_prune_count += history_prune_count;
								state.terminal_complete = terminal_complete;
								state.last_key = new_last_key;
								state.prune_count += prune_count;

								Ok(Loop::Continue)
							}
							PruneChunkOutput::Complete {
								history_prune_count,
								prune_count,
							} => {
								state.history_prune_count += history_prune_count;
								state.prune_count += prune_count;

								Ok(Loop::Break(state.prune_count + state.history_prune_count))
							}
						}
					}
					.boxed()
				})
				.await?;

				ctx.sleep(ctx.config().runtime.gasoline_prune_interval_duration())
					.await?;

				Ok(Loop::<()>::Continue)
			}
			.boxed()
		})
		.await?;

	Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
struct PruneChunkInput {
	#[serde(default)]
	history_last_key: Option<Vec<u8>>,
	#[serde(default)]
	history_complete: bool,
	#[serde(default)]
	terminal_complete: bool,
	last_key: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum PruneChunkOutput {
	Continue {
		#[serde(default)]
		history_last_key: Option<Vec<u8>>,
		#[serde(default)]
		history_complete: bool,
		#[serde(default)]
		history_prune_count: usize,
		#[serde(default)]
		terminal_complete: bool,
		new_last_key: Option<Vec<u8>>,
		prune_count: usize,
	},
	Complete {
		#[serde(default)]
		history_prune_count: usize,
		prune_count: usize,
	},
}

#[activity(PruneChunk)]
async fn prune_chunk(ctx: &ActivityCtx, input: &PruneChunkInput) -> Result<PruneChunkOutput> {
	// Create new db instance with debug trait
	let db = db::DatabaseKv::new(ctx.config().clone(), ctx.pools().clone()).await?
		as Arc<dyn DatabaseDebug + Send + Sync>;

	let mut history_complete = input.history_complete;
	let mut history_last_key = input.history_last_key.clone();
	let mut history_prune_count = 0;
	if !history_complete {
		if let Some(duration) = ctx
			.config()
			.runtime
			.gasoline_history_prune_eligibility_duration()
		{
			let before_ts = util::timestamp::now() - duration.as_millis() as i64;
			let (count, new_last_key) = db
				.prune_workflow_histories(before_ts, MAX_PRUNES, history_last_key.as_deref())
				.await?;
			history_prune_count = count;
			history_last_key = new_last_key;
			history_complete = history_last_key.is_none();
		} else {
			history_complete = true;
		}
	}

	let mut terminal_complete = input.terminal_complete;
	let mut new_last_key = input.last_key.clone();
	let mut prune_count = 0;
	if !terminal_complete {
		if let Some(duration) = ctx.config().runtime.gasoline_prune_eligibility_duration() {
			let before_ts = util::timestamp::now() - duration.as_millis() as i64;
			let (count, cursor) = db
				.prune_workflows(before_ts, MAX_PRUNES, new_last_key.as_deref())
				.await?;
			prune_count = count;
			new_last_key = cursor;
			terminal_complete = new_last_key.is_none();
		} else {
			terminal_complete = true;
		}
	}

	tracing::debug!(%history_prune_count, %prune_count, "pruned workflows");
	gas::metrics::PRUNER_HISTORY_PRUNED_TOTAL.inc_by(history_prune_count as u64);
	gas::metrics::PRUNER_TERMINAL_PRUNED_TOTAL.inc_by(prune_count as u64);
	gas::metrics::PRUNER_LAST_HISTORY_PRUNED.set(history_prune_count as i64);
	gas::metrics::PRUNER_LAST_TERMINAL_PRUNED.set(prune_count as i64);
	gas::metrics::PRUNER_LAST_SUCCESS_SECONDS.set(util::timestamp::now() / 1000);

	if history_complete && terminal_complete {
		return Ok(PruneChunkOutput::Complete {
			history_prune_count,
			prune_count,
		});
	}

	Ok(PruneChunkOutput::Continue {
		history_last_key,
		history_complete,
		history_prune_count,
		terminal_complete,
		new_last_key,
		prune_count,
	})
}
