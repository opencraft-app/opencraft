use std::collections::HashMap;
use std::sync::Arc;

use rivet_envoy_client::actor::ToActor;
use rivet_envoy_client::async_counter::AsyncCounter;
use rivet_envoy_client::commands::{
	begin_command_ack_session, handle_command_ack_barrier, handle_commands, send_command_ack,
};
use rivet_envoy_client::config::{
	BoxFuture, EnvoyCallbacks, EnvoyConfig, HttpRequest, HttpResponse, WebSocketHandler,
	WebSocketSender,
};
use rivet_envoy_client::context::{SharedContext, WsTxMessage};
use rivet_envoy_client::envoy::EnvoyContext;
use rivet_envoy_client::handle::EnvoyHandle;
use rivet_envoy_client::sqlite::{
	RemoteSqliteRequest, fail_sent_remote_sqlite_requests_with_indeterminate_result,
	handle_remote_sqlite_request,
};
use rivet_envoy_client::utils::{BufferMap, RemoteSqliteIndeterminateResultError};
use rivet_envoy_protocol as protocol;
use tokio::sync::mpsc;

struct IdleCallbacks;

impl EnvoyCallbacks for IdleCallbacks {
	fn on_actor_start(
		&self,
		_handle: EnvoyHandle,
		_actor_id: String,
		_generation: u32,
		_config: protocol::ActorConfig,
		_preloaded_kv: Option<protocol::PreloadedKv>,
	) -> BoxFuture<anyhow::Result<()>> {
		Box::pin(async { Ok(()) })
	}

	fn on_shutdown(&self) {}

	fn fetch(
		&self,
		_handle: EnvoyHandle,
		_actor_id: String,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		_request: HttpRequest,
	) -> BoxFuture<anyhow::Result<HttpResponse>> {
		Box::pin(async { anyhow::bail!("fetch should not be called in command tests") })
	}

	fn websocket(
		&self,
		_handle: EnvoyHandle,
		_actor_id: String,
		_gateway_id: protocol::GatewayId,
		_request_id: protocol::RequestId,
		_request: HttpRequest,
		_path: String,
		_headers: HashMap<String, String>,
		_is_hibernatable: bool,
		_is_restoring_hibernatable: bool,
		_sender: WebSocketSender,
	) -> BoxFuture<anyhow::Result<WebSocketHandler>> {
		Box::pin(async { anyhow::bail!("websocket should not be called in command tests") })
	}

	fn can_hibernate(
		&self,
		_actor_id: &str,
		_gateway_id: &protocol::GatewayId,
		_request_id: &protocol::RequestId,
		_request: &HttpRequest,
	) -> BoxFuture<anyhow::Result<bool>> {
		Box::pin(async { Ok(false) })
	}
}

fn new_envoy_context() -> EnvoyContext {
	let (envoy_tx, _envoy_rx) = mpsc::unbounded_channel();
	let shared = Arc::new(SharedContext {
		config: EnvoyConfig {
			version: 1,
			endpoint: "http://127.0.0.1:1".to_string(),
			token: None,
			namespace: "test".to_string(),
			pool_name: "test".to_string(),
			prepopulate_actor_names: HashMap::new(),
			metadata: None,
			not_global: true,
			debug_latency_ms: None,
			callbacks: Arc::new(IdleCallbacks),
		},
		envoy_key: "test-envoy".to_string(),
		envoy_tx,
		actors: Arc::new(std::sync::Mutex::new(HashMap::new())),
		actors_notify: Arc::new(tokio::sync::Notify::new()),
		live_tunnel_requests: Arc::new(std::sync::Mutex::new(HashMap::new())),
		pending_hibernation_restores: Arc::new(std::sync::Mutex::new(HashMap::new())),
		ws_tx: Arc::new(tokio::sync::Mutex::new(
			None::<mpsc::UnboundedSender<WsTxMessage>>,
		)),
		connection_session: std::sync::atomic::AtomicU64::new(0),
		next_connection_session: std::sync::atomic::AtomicU64::new(0),
		connection_session_tx: tokio::sync::watch::channel(0).0,
		protocol_metadata: Arc::new(tokio::sync::Mutex::new(None)),
		advertised_metadata: Arc::new(tokio::sync::Mutex::new(None)),
		shutting_down: std::sync::atomic::AtomicBool::new(false),
		last_ping_ts: std::sync::atomic::AtomicI64::new(0),
		stopped_tx: tokio::sync::watch::channel(true).0,
	});
	EnvoyContext {
		shared,
		shutting_down: false,
		actors: HashMap::new(),
		buffered_actor_messages: HashMap::new(),
		kv_requests: HashMap::new(),
		next_kv_request_id: 0,
		sqlite_requests: HashMap::new(),
		next_sqlite_request_id: 0,
		remote_sqlite_requests: HashMap::new(),
		next_remote_sqlite_request_id: 0,
		request_to_actor: BufferMap::new(),
		buffered_messages: Vec::new(),
		processed_command_idx: HashMap::new(),
		command_ack_in_flight: None,
		command_ack_sent_in_session: false,
		command_ack_barrier_ready: false,
	}
}

fn stop_command(actor_id: &str, generation: u32, index: i64) -> protocol::CommandWrapper {
	protocol::CommandWrapper {
		checkpoint: protocol::ActorCheckpoint {
			actor_id: actor_id.to_string(),
			generation,
			index,
		},
		inner: protocol::Command::CommandStopActor(protocol::CommandStopActor {
			reason: protocol::StopActorReason::StopIntent,
		}),
	}
}

fn execute_request() -> protocol::SqliteExecuteRequest {
	protocol::SqliteExecuteRequest {
		namespace_id: "test".to_string(),
		actor_id: "actor-replay".to_string(),
		generation: 1,
		sql: "insert into test values (?)".to_string(),
		params: Some(vec![protocol::SqliteBindParam::SqliteValueText(
			protocol::SqliteValueText {
				value: "value".to_string(),
			},
		)]),
	}
}

#[tokio::test]
async fn replayed_stop_command_is_dropped() {
	let mut ctx = new_envoy_context();
	let (actor_tx, mut actor_rx) = mpsc::unbounded_channel::<ToActor>();
	ctx.insert_actor(
		"actor-replay".to_string(),
		1,
		actor_tx,
		Arc::new(AsyncCounter::new()),
		"actor-replay".to_string(),
		-1,
	);

	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 5)]).await;
	assert!(matches!(
		actor_rx.try_recv(),
		Ok(ToActor::Stop { command_idx: 5, .. })
	));

	// Same index replayed: should be skipped.
	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 5)]).await;
	assert!(actor_rx.try_recv().is_err());

	// Lower index from a stale replay: should also be skipped.
	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 3)]).await;
	assert!(actor_rx.try_recv().is_err());

	// Higher index is processed.
	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 7)]).await;
	assert!(matches!(
		actor_rx.try_recv(),
		Ok(ToActor::Stop { command_idx: 7, .. })
	));
}

#[tokio::test]
async fn dedup_is_per_actor_and_generation() {
	let mut ctx = new_envoy_context();
	let (tx_a1, mut rx_a1) = mpsc::unbounded_channel::<ToActor>();
	let (tx_a2, mut rx_a2) = mpsc::unbounded_channel::<ToActor>();
	let (tx_b1, mut rx_b1) = mpsc::unbounded_channel::<ToActor>();
	ctx.insert_actor(
		"actor-a".to_string(),
		1,
		tx_a1,
		Arc::new(AsyncCounter::new()),
		"actor-a".to_string(),
		-1,
	);
	ctx.insert_actor(
		"actor-a".to_string(),
		2,
		tx_a2,
		Arc::new(AsyncCounter::new()),
		"actor-a".to_string(),
		-1,
	);
	ctx.insert_actor(
		"actor-b".to_string(),
		1,
		tx_b1,
		Arc::new(AsyncCounter::new()),
		"actor-b".to_string(),
		-1,
	);

	handle_commands(&mut ctx, vec![stop_command("actor-a", 1, 5)]).await;
	assert!(rx_a1.try_recv().is_ok());

	// Same actor_id, different generation: not deduped.
	handle_commands(&mut ctx, vec![stop_command("actor-a", 2, 5)]).await;
	assert!(rx_a2.try_recv().is_ok());

	// Different actor_id, same index: not deduped.
	handle_commands(&mut ctx, vec![stop_command("actor-b", 1, 5)]).await;
	assert!(rx_b1.try_recv().is_ok());
}

#[tokio::test]
async fn failed_stop_mailbox_delivery_remains_replayable() {
	let mut ctx = new_envoy_context();
	let (closed_tx, closed_rx) = mpsc::unbounded_channel::<ToActor>();
	drop(closed_rx);
	ctx.insert_actor(
		"actor-replay".to_string(),
		1,
		closed_tx,
		Arc::new(AsyncCounter::new()),
		"actor-replay".to_string(),
		-1,
	);

	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 5)]).await;
	assert_eq!(
		ctx.processed_command_idx
			.get(&("actor-replay".to_string(), 1)),
		None
	);
	let failed_entry = ctx
		.get_actor_entry_mut("actor-replay", 1)
		.expect("failed delivery must leave the actor entry replayable");
	assert!(!failed_entry.received_stop);
	assert_eq!(failed_entry.last_command_idx, -1);

	let (replacement_tx, mut replacement_rx) = mpsc::unbounded_channel::<ToActor>();
	ctx.insert_actor(
		"actor-replay".to_string(),
		1,
		replacement_tx,
		Arc::new(AsyncCounter::new()),
		"actor-replay".to_string(),
		-1,
	);
	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 5)]).await;
	assert!(matches!(
		replacement_rx.try_recv(),
		Ok(ToActor::Stop { command_idx: 5, .. })
	));
	assert_eq!(
		ctx.processed_command_idx
			.get(&("actor-replay".to_string(), 1)),
		Some(&5)
	);
}

#[tokio::test]
async fn command_ack_uses_processed_checkpoints_after_actor_removal() {
	let mut ctx = new_envoy_context();
	let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
	*ctx.shared.ws_tx.lock().await = Some(ws_tx);

	// An unknown actor is already in the requested terminal state. There is no ActorEntry from
	// which the old ACK implementation could recover this checkpoint.
	handle_commands(&mut ctx, vec![stop_command("already-absent", 9, 41)]).await;
	assert_eq!(
		ctx.processed_command_idx
			.get(&("already-absent".to_string(), 9)),
		Some(&41)
	);

	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));
	assert!(ctx.processed_command_idx.is_empty());
}

#[tokio::test]
async fn failed_command_ack_keeps_checkpoint_for_reconnect_replay() {
	let mut ctx = new_envoy_context();
	handle_commands(&mut ctx, vec![stop_command("already-absent", 3, 17)]).await;

	// No websocket is installed in this context, so the ACK cannot leave the process.
	send_command_ack(&mut ctx).await;
	assert_eq!(
		ctx.processed_command_idx
			.get(&("already-absent".to_string(), 3)),
		Some(&17)
	);
}

#[tokio::test]
async fn command_checkpoint_is_retained_until_server_commit_barrier() {
	let mut ctx = new_envoy_context();
	let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
	*ctx.shared.ws_tx.lock().await = Some(ws_tx);

	// First empty frame only negotiates the capability for this websocket.
	handle_command_ack_barrier(&mut ctx);
	handle_commands(&mut ctx, vec![stop_command("already-absent", 4, 23)]).await;
	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));
	assert_eq!(
		ctx.processed_command_idx
			.get(&("already-absent".to_string(), 4)),
		Some(&23)
	);
	assert_eq!(
		ctx.command_ack_in_flight
			.as_ref()
			.and_then(|pending| pending.get(&("already-absent".to_string(), 4))),
		Some(&23)
	);
	assert!(ctx.command_ack_sent_in_session);

	// Timer ticks and later command batches cannot duplicate an ACK in the same ordered session.
	send_command_ack(&mut ctx).await;
	assert!(ws_rx.try_recv().is_err());

	// Only the post-commit barrier releases the replay tombstone.
	handle_command_ack_barrier(&mut ctx);
	assert!(ctx.processed_command_idx.is_empty());
	assert!(ctx.command_ack_in_flight.is_none());
}

#[tokio::test]
async fn reconnect_capability_marker_resends_without_releasing_checkpoint() {
	let mut ctx = new_envoy_context();
	let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
	*ctx.shared.ws_tx.lock().await = Some(ws_tx);
	handle_command_ack_barrier(&mut ctx);
	handle_commands(&mut ctx, vec![stop_command("already-absent", 6, 31)]).await;
	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));

	begin_command_ack_session(&mut ctx);
	handle_command_ack_barrier(&mut ctx);
	assert_eq!(
		ctx.processed_command_idx
			.get(&("already-absent".to_string(), 6)),
		Some(&31),
		"the new session marker is not an ACK for the old websocket"
	);
	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));

	handle_command_ack_barrier(&mut ctx);
	assert!(ctx.processed_command_idx.is_empty());
}

#[tokio::test]
async fn command_ack_batches_are_bounded_and_drained_by_commit_barriers() {
	let mut ctx = new_envoy_context();
	let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
	*ctx.shared.ws_tx.lock().await = Some(ws_tx);
	handle_command_ack_barrier(&mut ctx);

	let total = protocol::MAX_COMMAND_ACK_CHECKPOINTS + 7;
	for index in 0..total {
		ctx.processed_command_idx
			.insert((format!("actor-{index}"), 1), index as i64);
	}

	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));
	assert_eq!(
		ctx.command_ack_in_flight.as_ref().map(HashMap::len),
		Some(protocol::MAX_COMMAND_ACK_CHECKPOINTS)
	);
	handle_command_ack_barrier(&mut ctx);
	assert_eq!(ctx.processed_command_idx.len(), 7);

	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));
	assert_eq!(
		ctx.command_ack_in_flight.as_ref().map(HashMap::len),
		Some(7)
	);
	handle_command_ack_barrier(&mut ctx);
	assert!(ctx.processed_command_idx.is_empty());
}

#[tokio::test]
async fn older_commit_barrier_does_not_clear_a_newer_checkpoint() {
	let mut ctx = new_envoy_context();
	let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
	*ctx.shared.ws_tx.lock().await = Some(ws_tx);
	handle_command_ack_barrier(&mut ctx);
	handle_commands(&mut ctx, vec![stop_command("already-absent", 8, 40)]).await;
	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));

	handle_commands(&mut ctx, vec![stop_command("already-absent", 8, 41)]).await;
	handle_command_ack_barrier(&mut ctx);
	assert_eq!(
		ctx.processed_command_idx
			.get(&("already-absent".to_string(), 8)),
		Some(&41)
	);

	send_command_ack(&mut ctx).await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));
	handle_command_ack_barrier(&mut ctx);
	assert!(ctx.processed_command_idx.is_empty());
}

#[tokio::test]
async fn replayed_command_is_dropped_after_remote_sql_lost_response() {
	let mut ctx = new_envoy_context();
	let (actor_tx, mut actor_rx) = mpsc::unbounded_channel::<ToActor>();
	ctx.insert_actor(
		"actor-replay".to_string(),
		1,
		actor_tx,
		Arc::new(AsyncCounter::new()),
		"actor-replay".to_string(),
		-1,
	);

	let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
	*ctx.shared.ws_tx.lock().await = Some(ws_tx);
	let (sql_tx, sql_rx) = tokio::sync::oneshot::channel();
	handle_remote_sqlite_request(
		&mut ctx,
		RemoteSqliteRequest::Execute(execute_request()),
		None,
		sql_tx,
	)
	.await;
	assert!(matches!(ws_rx.recv().await, Some(WsTxMessage::Send(_))));

	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 5)]).await;
	assert!(matches!(
		actor_rx.try_recv(),
		Ok(ToActor::Stop { command_idx: 5, .. })
	));

	fail_sent_remote_sqlite_requests_with_indeterminate_result(&mut ctx);
	let err = sql_rx
		.await
		.expect("response sender should complete")
		.expect_err("sent remote SQL should become indeterminate");
	assert!(
		err.downcast_ref::<RemoteSqliteIndeterminateResultError>()
			.is_some()
	);

	handle_commands(&mut ctx, vec![stop_command("actor-replay", 1, 5)]).await;
	assert!(actor_rx.try_recv().is_err());
}
