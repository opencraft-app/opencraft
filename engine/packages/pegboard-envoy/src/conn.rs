use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicI64, AtomicU32},
	},
	time::Instant,
};

use anyhow::{Context, ensure};
use depot::conveyer::Db;
use depot_client::database::NativeDatabaseHandle;
use gas::prelude::*;
use hyper_tungstenite::tungstenite::Message;
use pegboard::keys::{envoy::VirtualNodesKey, ns::EnvoyHashIdxKey};
use rivet_config::config::pegboard::EnvoyLoadBalancer;
use rivet_envoy_protocol::{self as protocol, versioned};
use rivet_guard_core::WebSocketHandle;
use rivet_pools::NodeId;
use rivet_types::runner_configs::{RunnerConfig, RunnerConfigKind};
use scc::HashMap;
use universaldb::prelude::*;
use vbare::OwnedVersionedData;
use xxhash_rust::xxh3::xxh3_128_with_seed;

use crate::{
	actor_lifecycle, errors, hibernating_requests, metrics, utils::UrlData, ws_to_tunnel_task,
};

pub type RemoteSqliteExecutors =
	HashMap<(String, u64), Arc<tokio::sync::OnceCell<NativeDatabaseHandle>>>;

const INITIAL_COMMAND_RECONCILE_PAGE_BUDGET: usize = 8;
const WORKER_CODE_MIN_PROTOCOL_VERSION: u16 = 7;

pub struct Conn {
	pub namespace_id: Id,
	pub namespace_name: String,
	pub pool_name: String,
	pub envoy_key: String,
	/// Random identity for one Envoy websocket session. Combined with the request sequence number,
	/// this gives each logical page-commit delivery a stable 128-bit idempotency token.
	pub sqlite_commit_session_id: [u8; 16],
	pub protocol_version: u16,
	pub ws_handle: WebSocketHandle,
	pub authorized_tunnel_routes: HashMap<(protocol::GatewayId, protocol::RequestId), ()>,
	/// Tracks in-flight ToEnvoyWebSocketOpen sends so we can observe envoy-side
	/// actor wake duration when the matching ToRivetWebSocketOpen (or
	/// ToRivetWebSocketClose) reply arrives back from the envoy.
	pub pending_websocket_opens: HashMap<(protocol::GatewayId, protocol::RequestId), Instant>,
	pub udb: Arc<universaldb::Database>,
	pub cold_tier: Option<Arc<dyn depot::cold_tier::ColdTier>>,
	pub node_id: NodeId,
	/// This is a perf-only SQLite conveyer cache, not authoritative actor presence tracking.
	/// Envoys can reconnect to different worker nodes mid-flight, so request handlers
	/// lazily populate it and lifecycle commands only evict stale cache entries.
	pub actor_dbs: HashMap<String, Arc<Db>>,
	pub remote_sqlite_executors: RemoteSqliteExecutors,
	pub pool: RunnerConfig,
	pub connected_at: Instant,
	pub last_rtt: AtomicU32,
	/// Timestamp (epoch ms) of the last pong received from the envoy.
	pub last_ping_ts: AtomicI64,
	pub reported_stopping: AtomicBool,
	/// Bounds zero-capacity metadata to one delayed eviction task per transition.
	pub dynamic_drain_started: AtomicBool,
	/// Full UDB key of the last command read by the bounded per-Envoy reconciler. This cursor is
	/// process-local acceleration only; the durable source of truth remains ActorCommandKey.
	pub pending_command_scan_cursor: tokio::sync::Mutex<Option<Vec<u8>>>,
}

impl Conn {
	pub fn is_serverless(&self) -> bool {
		matches!(self.pool.kind, RunnerConfigKind::Serverless { .. })
	}
}

pub(crate) async fn forward_commands_to_envoy(
	ctx: &StandaloneCtx,
	conn: &Conn,
	mut commands: Vec<protocol::CommandWrapper>,
) -> Result<()> {
	if commands.is_empty() {
		return Ok(());
	}
	ensure!(
		conn.protocol_version >= WORKER_CODE_MIN_PROTOCOL_VERSION
			|| !commands.iter().any(|command| matches!(
				&command.inner,
				protocol::Command::CommandStartActor(start) if start.config.worker.is_some()
			)),
		"refusing to down-convert a Worker actor start for Envoy protocol {}",
		conn.protocol_version
	);

	for command in &mut commands {
		hibernating_requests::hydrate_command_wrapper(ctx, command).await?;
		if matches!(&command.inner, protocol::Command::CommandStopActor(_)) {
			actor_lifecycle::stop_actor(conn, &command.checkpoint).await?;
		}
	}

	let message = versioned::ToEnvoy::wrap_latest(protocol::ToEnvoy::ToEnvoyCommands(commands));
	let serialized = message.serialize(conn.protocol_version)?;
	let _in_flight = ws_to_tunnel_task::WsResponseInFlightGuard::new();
	conn.ws_handle
		.send(Message::Binary(serialized.into()))
		.await
		.context("failed to send reconciled commands to Envoy websocket")?;
	drop(_in_flight);
	Ok(())
}

/// Send an empty command frame as a command-ACK commit barrier.
///
/// The first barrier after `ToEnvoyInit` advertises support. Every later barrier is sent only
/// after `envoy_handle_ack` has committed its `ActorCommandKey` clear. Older clients already treat
/// an empty command list as a no-op, which keeps Engine-first rolling upgrades safe.
pub(crate) async fn send_command_ack_barrier(conn: &Conn) -> Result<()> {
	let message = versioned::ToEnvoy::wrap_latest(protocol::ToEnvoy::ToEnvoyCommands(Vec::new()));
	let serialized = message.serialize(conn.protocol_version)?;
	conn.ws_handle
		.send(Message::Binary(serialized.into()))
		.await
		.context("failed to send command ACK commit barrier")
}

async fn replay_pending_commands(ctx: &StandaloneCtx, conn: &Conn) -> Result<()> {
	let mut cursor = None;
	for _ in 0..INITIAL_COMMAND_RECONCILE_PAGE_BUDGET {
		let page = crate::command_reconcile::read_page(
			&conn.udb,
			conn.namespace_id,
			&conn.envoy_key,
			cursor.as_deref(),
			crate::command_reconcile::PAGE_SIZE,
		)
		.await?;
		if page.commands.is_empty() {
			cursor = None;
			break;
		}
		forward_commands_to_envoy(ctx, conn, page.commands).await?;
		cursor = page.next_cursor;
		if cursor.is_none() {
			break;
		}
	}

	if cursor.is_some() {
		tracing::warn!(
			page_size = crate::command_reconcile::PAGE_SIZE,
			page_budget = INITIAL_COMMAND_RECONCILE_PAGE_BUDGET,
			"Envoy connected with a command backlog beyond the bounded initial replay budget"
		);
	}
	*conn.pending_command_scan_cursor.lock().await = cursor;
	Ok(())
}

#[tracing::instrument(skip_all)]
pub async fn init_conn(
	ctx: &StandaloneCtx,
	ws_handle: WebSocketHandle,
	UrlData {
		protocol_version,
		namespace,
		pool_name,
		envoy_key,
		version,
	}: UrlData,
) -> Result<Arc<Conn>> {
	let start = Instant::now();
	let namespace_name = namespace.clone();
	let namespace = ctx
		.op(namespace::ops::resolve_for_name_global::Input { name: namespace })
		.await
		.with_context(|| format!("failed to resolve namespace: {}", namespace_name))?
		.ok_or_else(|| namespace::errors::Namespace::NotFound.build())
		.with_context(|| format!("namespace not found: {}", namespace_name))?;

	let pool_res = ctx
		.op(pegboard::ops::runner_config::get::Input {
			runners: vec![(namespace.namespace_id, pool_name.clone())],
			bypass_cache: false,
		})
		.await?;

	let Some(pool) = pool_res.into_iter().next() else {
		return Err(errors::WsError::NoRunnerConfig {
			pool_name: pool_name.clone(),
		}
		.build());
	};

	tracing::debug!(namespace_id=?namespace.namespace_id, "new envoy connection");

	metrics::CONNECTION_TOTAL
		.with_label_values(&[
			namespace.namespace_id.to_string().as_str(),
			&pool_name,
			protocol_version.to_string().as_str(),
		])
		.inc();
	metrics::RECEIVE_INIT_PACKET_DURATION
		.with_label_values(&[namespace.namespace_id.to_string().as_str(), &pool_name])
		.observe(start.elapsed().as_secs_f64());

	let udb = ctx.udb()?;
	let conn_udb = Arc::new((*udb).clone());
	let cold_tier = depot::cold_tier::cold_tier_from_config(ctx.config())
		.await
		.context("initialize Depot cold tier for envoy")?;
	let node_id = ctx.pools().node_id();
	let (_, runner_config_protocol_changed) = tokio::try_join!(
		// Send init packet as soon as possible
		async {
			let pb = ctx.config().pegboard();

			// Send init packet
			let init_msg = versioned::ToEnvoy::wrap_latest(protocol::ToEnvoy::ToEnvoyInit(
				protocol::ToEnvoyInit {
					metadata: protocol::ProtocolMetadata {
						envoy_lost_threshold: pb.envoy_lost_threshold(),
						actor_stop_threshold: pb.actor_stop_threshold(),
						max_response_payload_size: pb.envoy_max_response_payload_size() as u64,
					},
				},
			));
			let init_msg_serialized = init_msg.serialize(protocol_version)?;
			ws_handle
				.send(Message::Binary(init_msg_serialized.into()))
				.await
		},
		udb.txn("envoy_conn_register", |tx| {
			let namespace_id = namespace.namespace_id;
			let envoy_key = &envoy_key;
			let pool_name = &pool_name;
			// Only populate the hash-ring index when the operator has selected the
			// Hash strategy. Writing V hash positions + a VirtualNodesKey on every
			// envoy connect under legacy strategies is pure FDB write waste. If
			// the operator later toggles to Hash, the next heartbeat-driven
			// reconnect backfills the entries.
			let virtual_nodes = match ctx.config().pegboard().envoy_load_balancer() {
				EnvoyLoadBalancer::Hash { virtual_nodes, .. } => Some(virtual_nodes),
				_ => None,
			};
			async move {
				let tx = tx.with_subspace(pegboard::keys::subspace());

				let create_ts_key =
					pegboard::keys::envoy::CreateTsKey::new(namespace_id, envoy_key.to_string());
				let last_ping_ts_key =
					pegboard::keys::envoy::LastPingTsKey::new(namespace_id, envoy_key.to_string());
				let version_key =
					pegboard::keys::envoy::VersionKey::new(namespace_id, envoy_key.to_string());

				// Read existing data
				let (create_ts_entry, old_last_ping_ts_entry, version_entry) = tokio::try_join!(
					tx.read_opt(&create_ts_key, Serializable),
					tx.read_opt(&last_ping_ts_key, Serializable),
					tx.read_opt(&version_key, Serializable),
				)?;

				if let Some(old_version) = version_entry {
					if old_version != version {
						tracing::warn!(
							?namespace_id,
							%envoy_key,
							old_version = old_version,
							new_version = version,
							"envoy_key reconnected with changed version; operationally prohibited - investigate"
						);
					}
				}

				// Write init data
				tx.write(
					&pegboard::keys::envoy::PoolNameKey::new(namespace_id, envoy_key.to_string()),
					pool_name.to_string(),
				)?;
				tx.write(
					&pegboard::keys::envoy::VersionKey::new(namespace_id, envoy_key.to_string()),
					version,
				)?;
				tx.atomic_op(
					&pegboard::keys::envoy::SlotsKey::new(namespace_id, envoy_key.to_string()),
					&0i64.to_le_bytes(),
					MutationType::Add,
				);
				let create_ts = if let Some(create_ts) = create_ts_entry {
					create_ts
				} else {
					let create_ts = util::timestamp::now();
					tx.write(&create_ts_key, util::timestamp::now())?;

					create_ts
				};
				tx.write(
					&pegboard::keys::envoy::LastPingTsKey::new(namespace_id, envoy_key.to_string()),
					util::timestamp::now(),
				)?;
				tx.write(
					&pegboard::keys::envoy::ProtocolVersionKey::new(
						namespace_id,
						envoy_key.to_string(),
					),
					protocol_version,
				)?;
				let last_ping_ts = util::timestamp::now();
				// Write new ping
				tx.write(&last_ping_ts_key, last_ping_ts)?;

				// Populate ns indexes
				tx.write(
					&pegboard::keys::ns::ActiveEnvoyKey::new(
						namespace_id,
						create_ts,
						envoy_key.to_string(),
					),
					(),
				)?;
				tx.write(
					&pegboard::keys::ns::ActiveEnvoyByNameKey::new(
						namespace_id,
						pool_name.to_string(),
						create_ts,
						envoy_key.to_string(),
					),
					(),
				)?;

				// Unset expired (upon reconnection)
				if create_ts_entry.is_some() {
					tx.delete(&pegboard::keys::envoy::ExpiredTsKey::new(
						namespace_id,
						envoy_key.to_string(),
					));
				}

				// Remove old LB entry if exists
				if let (Some(old_last_ping_ts), Some(version)) =
					(old_last_ping_ts_entry, version_entry)
				{
					let old_lb_key = pegboard::keys::ns::EnvoyLoadBalancerIdxKey::new(
						namespace_id,
						pool_name.to_string(),
						version,
						old_last_ping_ts,
						envoy_key.to_string(),
					);

					tx.add_conflict_key(&old_lb_key, ConflictRangeType::Read)?;
					tx.delete(&old_lb_key);
				}

				// Insert into LB
				tx.write(
					&pegboard::keys::ns::EnvoyLoadBalancerIdxKey::new(
						namespace_id,
						pool_name.to_string(),
						version,
						last_ping_ts,
						envoy_key.to_string(),
					),
					(),
				)?;
				if let Some(virtual_nodes) = virtual_nodes {
					tx.write(
						&VirtualNodesKey::new(namespace_id, envoy_key.to_string()),
						virtual_nodes,
					)?;
					for i in 0..virtual_nodes {
						tx.write(
							&EnvoyHashIdxKey::new(
								namespace_id,
								pool_name.to_string(),
								version,
								xxh3_128_with_seed(envoy_key.as_bytes(), i as u64).to_be_bytes(),
								envoy_key.to_string(),
							),
							(),
						)?;
					}
				}

				// Update the pool's protocol version. This is required for serverful pools because normally
				// the pool's protocol version is updated via the metadata_poller wf but that only runs for
				// serverless pools.
				let ns_tx = tx.with_subspace(namespace::keys::subspace());
				let runner_config_protocol_version_key =
					pegboard::keys::runner_config::ProtocolVersionKey::new(
						namespace_id,
						pool_name.clone(),
					);

				let existing_runner_config_protocol_version = ns_tx
					.read_opt(&runner_config_protocol_version_key, Serializable)
					.await?;

				let runner_config_protocol_changed =
					existing_runner_config_protocol_version != Some(protocol_version);
				if runner_config_protocol_changed {
					ns_tx.write(&runner_config_protocol_version_key, protocol_version)?;
				}

				Ok(runner_config_protocol_changed)
			}
		})
		.custom_instrument(tracing::info_span!("envoy_init_tx")),
	)?;

	if runner_config_protocol_changed {
		pegboard::utils::purge_runner_config_caches(
			ctx.cache(),
			namespace.namespace_id,
			&pool_name,
		)
		.await?;
	}

	let conn = Arc::new(Conn {
		namespace_id: namespace.namespace_id,
		namespace_name,
		pool_name,
		envoy_key,
		sqlite_commit_session_id: rand::random(),
		protocol_version,
		ws_handle,
		authorized_tunnel_routes: HashMap::new(),
		pending_websocket_opens: HashMap::new(),
		udb: conn_udb,
		cold_tier,
		node_id,
		actor_dbs: HashMap::new(),
		remote_sqlite_executors: HashMap::new(),
		pool: pool.config,
		connected_at: Instant::now(),
		last_rtt: AtomicU32::new(0),
		last_ping_ts: AtomicI64::new(util::timestamp::now()),
		reported_stopping: AtomicBool::new(false),
		dynamic_drain_started: AtomicBool::new(false),
		pending_command_scan_cursor: tokio::sync::Mutex::new(None),
	});

	// Negotiate strict command ACK commit barriers before replaying any durable command. The
	// websocket preserves frame order, so a new client never mistakes a replay for legacy mode.
	send_command_ack_barrier(&conn).await?;

	// Reconcile from the durable per-Envoy command subspace after the init packet. The initial
	// work is explicitly bounded; a cursor lets the connected-task fallback continue later.
	if let Err(err) = replay_pending_commands(ctx, &conn).await {
		actor_lifecycle::shutdown_conn_actors(&conn).await;
		return Err(err);
	}

	if conn.is_serverless() {
		report_success(ctx, namespace.namespace_id, &conn.pool_name).await;
	}

	Ok(conn)
}

/// Report success to the error tracker workflow.
async fn report_success(ctx: &StandaloneCtx, namespace_id: Id, pool_name: &str) {
	if let Err(err) = ctx
		.signal(pegboard::workflows::runner_pool_error_tracker::ReportSuccess {})
		.to_workflow::<pegboard::workflows::runner_pool_error_tracker::Workflow>()
		.tag("namespace_id", namespace_id)
		.tag("runner_name", pool_name)
		.graceful_not_found()
		.send()
		.await
	{
		tracing::warn!(?err, "failed to report serverless success");
	}
}
