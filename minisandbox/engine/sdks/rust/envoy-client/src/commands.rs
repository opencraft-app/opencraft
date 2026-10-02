use rivet_envoy_protocol as protocol;

use crate::actor::create_actor;
use crate::connection::ws_send;
use crate::envoy::EnvoyContext;
use crate::stringify::stringify_command_wrapper;

pub const ACK_COMMANDS_INTERVAL_MS: u64 = 5 * 60 * 1000;

/// Start command-ACK negotiation for a new websocket session.
///
/// The in-flight ACK deliberately survives reconnect. The first empty command frame is only the
/// server capability marker; it must not be mistaken for confirmation of an ACK from the previous
/// socket. Once the marker arrives, `send_command_ack` resends that exact ACK idempotently.
pub fn begin_command_ack_session(ctx: &mut EnvoyContext) {
	ctx.command_ack_barrier_ready = false;
	ctx.command_ack_sent_in_session = false;
}

/// Process the empty-command barrier sent by `pegboard-envoy`.
///
/// The first barrier negotiates commit acknowledgements for this websocket. Every later barrier
/// confirms that the server has committed the FDB clear for the single ACK currently in flight.
pub fn handle_command_ack_barrier(ctx: &mut EnvoyContext) {
	if !ctx.command_ack_barrier_ready {
		ctx.command_ack_barrier_ready = true;
		return;
	}

	let Some(applied) = ctx.command_ack_in_flight.take() else {
		return;
	};
	ctx.command_ack_sent_in_session = false;
	for ((actor_id, generation), applied_idx) in applied {
		tracing::info!(
			%actor_id,
			generation,
			index = applied_idx,
			"command ACK commit barrier confirmed"
		);
		let key = (actor_id, generation);
		if ctx
			.processed_command_idx
			.get(&key)
			.is_some_and(|current_idx| *current_idx <= applied_idx)
		{
			ctx.processed_command_idx.remove(&key);
		}
	}
}

pub async fn handle_commands(ctx: &mut EnvoyContext, commands: Vec<protocol::CommandWrapper>) {
	tracing::info!(command_count = commands.len(), "received commands");
	for command_wrapper in &commands {
		tracing::info!(
			command = %stringify_command_wrapper(command_wrapper),
			"received command"
		);
	}

	for command_wrapper in commands {
		let checkpoint = command_wrapper.checkpoint;
		let dedup_key = (checkpoint.actor_id.clone(), checkpoint.generation);
		let command_kind = match &command_wrapper.inner {
			protocol::Command::CommandStartActor(_) => "start",
			protocol::Command::CommandStopActor(_) => "stop",
		};

		// Drop replayed commands. `pegboard-envoy` re-streams every unacked
		// command on reconnect, and the command index is monotonic per
		// `(actor_id, generation)`, so any index at or below the highest one
		// we have already processed is a duplicate.
		if let Some(&last_idx) = ctx.processed_command_idx.get(&dedup_key) {
			if checkpoint.index <= last_idx {
				tracing::info!(
					actor_id = %checkpoint.actor_id,
					generation = checkpoint.generation,
					index = checkpoint.index,
					last_idx,
					command_kind,
					"skipping replayed command"
				);
				continue;
			}
		}
		let processed = match command_wrapper.inner {
			protocol::Command::CommandStartActor(val) => {
				let actor_name = val.config.name.clone();
				let (handle, active_http_request_count) = create_actor(
					ctx.shared.clone(),
					checkpoint.actor_id.clone(),
					checkpoint.generation,
					val.config,
					val.hibernating_requests,
					val.preloaded_kv,
				);

				ctx.insert_actor(
					checkpoint.actor_id.clone(),
					checkpoint.generation,
					handle,
					active_http_request_count,
					actor_name,
					checkpoint.index,
				);
				true
			}
			protocol::Command::CommandStopActor(val) => {
				let entry = ctx.get_actor_entry_mut(&checkpoint.actor_id, checkpoint.generation);

				if let Some(entry) = entry {
					if entry
						.handle
						.send(crate::actor::ToActor::Stop {
							command_idx: checkpoint.index,
							reason: val.reason,
						})
						.is_ok()
					{
						entry.received_stop = true;
						entry.last_command_idx = checkpoint.index;
						true
					} else {
						tracing::warn!(
							actor_id = %checkpoint.actor_id,
							generation = checkpoint.generation,
							index = checkpoint.index,
							"actor stop mailbox was closed; leaving command unprocessed for durable replay"
						);
						false
					}
				} else {
					tracing::warn!(
						actor_id = %checkpoint.actor_id,
						generation = checkpoint.generation,
						"received stop actor command for unknown actor"
					);
					// Absence is the desired terminal state, so this command is safe to ACK.
					true
				}
			}
		};

		// Do not deduplicate or ACK a command merely because it was decoded. In particular, a
		// failed stop mailbox send must remain eligible for the server's durable FDB replay.
		if processed {
			tracing::info!(
				actor_id = %checkpoint.actor_id,
				generation = checkpoint.generation,
				index = checkpoint.index,
				command_kind,
				"processed durable command"
			);
			ctx.processed_command_idx
				.insert(dedup_key, checkpoint.index);
		}
	}
}

pub async fn send_command_ack(ctx: &mut EnvoyContext) {
	// Actor entries are removed as soon as their stopped event is queued, so deriving ACKs from
	// `ctx.actors` loses the stop checkpoint. The dedup map is the complete set of successfully
	// dispatched checkpoints, including already-absent actors.
	let mut replaying_unconfirmed = false;
	let acked = if ctx.command_ack_barrier_ready {
		if let Some(in_flight) = &ctx.command_ack_in_flight {
			if ctx.command_ack_sent_in_session {
				return;
			}
			replaying_unconfirmed = true;
			in_flight.clone()
		} else {
			let pending = ctx
				.processed_command_idx
				.iter()
				.take(protocol::MAX_COMMAND_ACK_CHECKPOINTS)
				.map(|(key, index)| (key.clone(), *index))
				.collect::<std::collections::HashMap<_, _>>();
			if pending.is_empty() {
				return;
			}
			ctx.command_ack_in_flight = Some(pending.clone());
			pending
		}
	} else {
		// Rolling compatibility with a server that predates commit barriers. Once a new server's
		// capability marker arrives, all subsequent ACKs use the strict path above.
		ctx.command_ack_in_flight = None;
		ctx.command_ack_sent_in_session = false;
		ctx.processed_command_idx
			.iter()
			.take(protocol::MAX_COMMAND_ACK_CHECKPOINTS)
			.map(|(key, index)| (key.clone(), *index))
			.collect::<std::collections::HashMap<_, _>>()
	};

	let last_command_checkpoints = acked
		.iter()
		.map(
			|((actor_id, generation), index)| protocol::ActorCheckpoint {
				actor_id: actor_id.clone(),
				generation: *generation,
				index: *index,
			},
		)
		.collect::<Vec<_>>();

	if last_command_checkpoints.is_empty() {
		return;
	}

	let send_failed = ws_send(
		&ctx.shared,
		protocol::ToRivet::ToRivetAckCommands(protocol::ToRivetAckCommands {
			last_command_checkpoints: last_command_checkpoints.clone(),
		}),
	)
	.await;

	// Skip the dedup clear if the ack never left this process. Otherwise
	// `pegboard-envoy` would replay the commands on reconnect with no dedup
	// state to suppress them.
	if send_failed {
		return;
	}
	if replaying_unconfirmed {
		for checkpoint in &last_command_checkpoints {
			tracing::info!(
				actor_id = %checkpoint.actor_id,
				generation = checkpoint.generation,
				index = checkpoint.index,
				"replayed unconfirmed command ACK on replacement websocket session"
			);
		}
	}

	if ctx.command_ack_barrier_ready {
		ctx.command_ack_sent_in_session = true;
	} else {
		for (key, acked_idx) in acked {
			if ctx
				.processed_command_idx
				.get(&key)
				.is_some_and(|current_idx| *current_idx <= acked_idx)
			{
				ctx.processed_command_idx.remove(&key);
			}
		}
	}
}
