use anyhow::Result;
use gas::prelude::*;
use hyper_tungstenite::tungstenite::Message;
use pegboard::pubsub_subjects::GatewayReceiverSubject;
use rivet_envoy_protocol::{self as protocol, PROTOCOL_VERSION, versioned};
use std::{
	sync::Arc,
	time::{Duration, Instant},
};
use tokio::sync::watch;
use universalpubsub as ups;
use universalpubsub::{NextOutput, PublishOpts, Subscriber};
use vbare::OwnedVersionedData;
use xxhash_rust::xxh3::xxh3_64;

use crate::{LifecycleResult, conn::Conn, metrics, tunnel_message_task, ws_to_tunnel_task};

const COMMAND_RECONCILE_INTERVAL: Duration = Duration::from_secs(10);

enum Incoming {
	Pubsub(ups::Message),
	ReconcileCommands,
}

#[tracing::instrument(name = "tunnel_to_ws_task", skip_all, fields(ray_id=?ctx.ray_id(), req_id=?ctx.req_id(), namespace_id=%conn.namespace_id, pool_name=%conn.pool_name, envoy_key=%conn.envoy_key, protocol_version=%conn.protocol_version))]
pub async fn task(
	ctx: StandaloneCtx,
	conn: Arc<Conn>,
	mut tunnel_sub: Subscriber,
	mut eviction_sub: Subscriber,
	mut tunnel_to_ws_abort_rx: watch::Receiver<()>,
) -> Result<LifecycleResult> {
	// Spread empty-backlog reads across the interval so a fleet reconnect does not make every
	// Envoy hit FDB at once. Pubsub remains the low-latency path; this timer is the durable fallback.
	let jitter_ms = xxh3_64(conn.envoy_key.as_bytes())
		% u64::try_from(COMMAND_RECONCILE_INTERVAL.as_millis()).unwrap_or(10_000);
	let first_reconcile = tokio::time::Instant::now() + Duration::from_millis(jitter_ms + 1);
	let mut command_reconcile_tick =
		tokio::time::interval_at(first_reconcile, COMMAND_RECONCILE_INTERVAL);
	command_reconcile_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

	loop {
		match recv_msg(
			&conn,
			&mut tunnel_sub,
			&mut eviction_sub,
			&mut tunnel_to_ws_abort_rx,
			&mut command_reconcile_tick,
		)
		.await?
		{
			Ok(Incoming::Pubsub(msg)) => {
				let evicted = handle_message(&ctx, &conn, msg).await?;
				if evicted {
					return Ok(LifecycleResult::Evicted);
				}
			}
			Ok(Incoming::ReconcileCommands) => {
				reconcile_pending_commands(&ctx, &conn).await?;
			}
			Err(lifecycle_res) => return Ok(lifecycle_res),
		}
	}
}

async fn reconcile_pending_commands(ctx: &StandaloneCtx, conn: &Conn) -> Result<()> {
	let cursor = conn.pending_command_scan_cursor.lock().await.clone();
	let page = crate::command_reconcile::read_page(
		&conn.udb,
		conn.namespace_id,
		&conn.envoy_key,
		cursor.as_deref(),
		crate::command_reconcile::PAGE_SIZE,
	)
	.await?;
	let command_count = page.commands.len();
	crate::conn::forward_commands_to_envoy(ctx, conn, page.commands).await?;
	*conn.pending_command_scan_cursor.lock().await = page.next_cursor;

	if command_count > 0 {
		tracing::info!(
			command_count,
			"replayed durable commands from bounded per-Envoy reconciliation"
		);
	}
	Ok(())
}

#[tracing::instrument(skip_all)]
async fn recv_msg(
	conn: &Conn,
	tunnel_sub: &mut Subscriber,
	eviction_sub: &mut Subscriber,
	tunnel_to_ws_abort_rx: &mut watch::Receiver<()>,
	command_reconcile_tick: &mut tokio::time::Interval,
) -> Result<std::result::Result<Incoming, LifecycleResult>> {
	let tunnel_msg = tokio::select! {
		res = tunnel_sub.next() => {
			if let NextOutput::Message(tunnel_msg) = res? {
				Incoming::Pubsub(tunnel_msg)
			} else {
				tracing::debug!("tunnel sub closed");
				bail!("tunnel sub closed");
			}
		}
		_ = eviction_sub.next() => {
			tracing::debug!("envoy evicted");

			metrics::EVICTION_TOTAL
				.with_label_values(&[
					conn.namespace_id.to_string().as_str(),
					&conn.pool_name,
					conn.protocol_version.to_string().as_str(),
				])
				.inc();

			return Ok(Err(LifecycleResult::Evicted));
		}
		_ = tunnel_to_ws_abort_rx.changed() => {
			tracing::debug!("task aborted");
			return Ok(Err(LifecycleResult::Aborted));
		}
		_ = command_reconcile_tick.tick() => Incoming::ReconcileCommands,
	};

	if let Incoming::Pubsub(message) = &tunnel_msg {
		tracing::debug!(
			payload_len = message.payload.len(),
			"received message from pubsub, forwarding to WebSocket"
		);
	}

	Ok(Ok(tunnel_msg))
}

#[tracing::instrument(skip_all)]
async fn handle_message(
	ctx: &StandaloneCtx,
	conn: &Conn,
	tunnel_msg: ups::Message,
) -> Result<bool> {
	tracing::trace!(
		namespace_id = %conn.namespace_id,
		pool_name = %conn.pool_name,
		envoy_key = %conn.envoy_key,
		message_id=?tunnel_msg.message_id,
		payload_len = tunnel_msg.payload.len(),
		"received gateway message from pubsub"
	);

	// Parse message
	let start = Instant::now();
	let msg = match versioned::ToEnvoyConn::deserialize_with_embedded_version(&tunnel_msg.payload) {
		Result::Ok(x) => x,
		Err(err) => {
			tracing::error!(?err, "failed to parse tunnel message");
			return Ok(false);
		}
	};
	let is_command_message = matches!(&msg, protocol::ToEnvoyConn::ToEnvoyCommands(_));
	if !is_command_message {
		// Preserve the existing acknowledgement timing for ordinary tunnel traffic. Commands are
		// the exception below: they ACK only after websocket admission because ActorCommandKey is
		// their durable retry source and the client explicitly deduplicates command checkpoints.
		tunnel_msg.reply(&[]).await?;
		metrics::ACK_MSG_DURATION
			.with_label_values(&[conn.namespace_id.to_string().as_str(), &conn.pool_name])
			.observe(start.elapsed().as_secs_f64());
	}

	// Convert to ToEnvoy types
	let mut tunnel_message_meta = None;
	let to_client_msg = match msg {
		protocol::ToEnvoyConn::ToEnvoyConnPing(ping) => {
			// Publish pong to UPS
			let gateway_reply_to = GatewayReceiverSubject::new(ping.gateway_id);
			let msg_serialized = versioned::ToGateway::wrap_latest(
				protocol::ToGateway::ToGatewayPong(protocol::ToGatewayPong {
					request_id: ping.request_id,
					ts: ping.ts,
				}),
			)
			.serialize_with_embedded_version(PROTOCOL_VERSION)
			.context("failed to serialize pong message for gateway")?;
			ctx.ups()
				.context("failed to get UPS instance for tunnel message")?
				.publish(&gateway_reply_to, &msg_serialized, PublishOpts::one())
				.await
				.with_context(|| {
					format!(
						"failed to publish tunnel message to gateway reply topic: {}",
						gateway_reply_to
					)
				})?;

			// Not sent to envoy
			return Ok(false);
		}
		protocol::ToEnvoyConn::ToEnvoyConnClose => return Ok(true),
		protocol::ToEnvoyConn::ToEnvoyCommands(command_wrappers) => {
			crate::conn::forward_commands_to_envoy(ctx, conn, command_wrappers).await?;
			tunnel_msg.reply(&[]).await?;
			metrics::ACK_MSG_DURATION
				.with_label_values(&[conn.namespace_id.to_string().as_str(), &conn.pool_name])
				.observe(start.elapsed().as_secs_f64());
			return Ok(false);
		}
		protocol::ToEnvoyConn::ToEnvoyAckEvents(x) => protocol::ToEnvoy::ToEnvoyAckEvents(x),
		protocol::ToEnvoyConn::ToEnvoyTunnelMessage(x) => {
			let gateway_id = x.message_id.gateway_id;
			let request_id = x.message_id.request_id;
			let message_index = x.message_id.message_index;
			let message_kind = to_envoy_tunnel_message_kind_name(&x.message_kind);
			let inner_data_len = to_envoy_tunnel_message_inner_data_len(&x.message_kind);
			tracing::trace!(
				gateway_id = %tunnel_message_task::display_id(&gateway_id),
				request_id = %tunnel_message_task::display_id(&request_id),
				message_index,
				message_kind,
				inner_data_len,
				"decoded tunnel message from gateway"
			);
			tunnel_message_meta = Some((
				gateway_id,
				request_id,
				message_index,
				message_kind,
				inner_data_len,
			));
			let _ = conn
				.authorized_tunnel_routes
				.insert_async((x.message_id.gateway_id, x.message_id.request_id), ())
				.await;
			// Start the envoy-side actor wake timer for ToEnvoyWebSocketOpen so
			// ws_to_tunnel_task can observe the duration when the matching
			// ToRivetWebSocketOpen (or ToRivetWebSocketClose) reply arrives.
			// Arm the entry before sending on the WS so a fast reply cannot race
			// past the insert and observe nothing.
			if matches!(
				&x.message_kind,
				protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketOpen(_)
			) {
				let _ = conn
					.pending_websocket_opens
					.insert_async(
						(x.message_id.gateway_id, x.message_id.request_id),
						Instant::now(),
					)
					.await;
			}
			protocol::ToEnvoy::ToEnvoyTunnelMessage(x)
		}
	};

	// Forward raw message to WebSocket
	let serialized_msg =
		versioned::ToEnvoy::wrap_latest(to_client_msg).serialize(conn.protocol_version)?;
	let ws_msg = Message::Binary(serialized_msg.into());
	if let Some((gateway_id, request_id, message_index, message_kind, inner_data_len)) =
		&tunnel_message_meta
	{
		tracing::trace!(
			gateway_id = %tunnel_message_task::display_id(gateway_id),
			request_id = %tunnel_message_task::display_id(request_id),
			message_index,
			message_kind,
			inner_data_len,
			serialized_len = ws_msg.len(),
			"sending tunnel message to actor websocket"
		);
	}
	let _in_flight = ws_to_tunnel_task::WsResponseInFlightGuard::new();
	conn.ws_handle
		.send(ws_msg)
		.await
		.context("failed to send message to WebSocket")?;
	drop(_in_flight);
	if let Some((gateway_id, request_id, message_index, message_kind, inner_data_len)) =
		&tunnel_message_meta
	{
		tracing::trace!(
			gateway_id = %tunnel_message_task::display_id(gateway_id),
			request_id = %tunnel_message_task::display_id(request_id),
			message_index,
			message_kind,
			inner_data_len,
			"sent tunnel message to actor websocket"
		);
	}

	metrics::PROCESS_MSG_DURATION
		.with_label_values(&[conn.namespace_id.to_string().as_str(), &conn.pool_name])
		.observe(start.elapsed().as_secs_f64());
	metrics::MSG_PROCESSED_TOTAL
		.with_label_values(&[conn.namespace_id.to_string().as_str(), &conn.pool_name])
		.inc();

	Ok(false)
}

fn to_envoy_tunnel_message_kind_name(kind: &protocol::ToEnvoyTunnelMessageKind) -> &'static str {
	match kind {
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyRequestStart(_) => "ToEnvoyRequestStart",
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyRequestChunk(_) => "ToEnvoyRequestChunk",
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyRequestAbort => "ToEnvoyRequestAbort",
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketOpen(_) => "ToEnvoyWebSocketOpen",
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketMessage(_) => "ToEnvoyWebSocketMessage",
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketClose(_) => "ToEnvoyWebSocketClose",
	}
}

fn to_envoy_tunnel_message_inner_data_len(kind: &protocol::ToEnvoyTunnelMessageKind) -> usize {
	match kind {
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyRequestStart(msg) => {
			msg.body.as_ref().map_or(0, Vec::len)
		}
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyRequestChunk(msg) => msg.body.len(),
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketMessage(msg) => msg.data.len(),
		protocol::ToEnvoyTunnelMessageKind::ToEnvoyRequestAbort
		| protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketOpen(_)
		| protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketClose(_) => 0,
	}
}
