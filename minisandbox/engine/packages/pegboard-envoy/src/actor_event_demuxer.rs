use std::collections::HashMap;
use std::sync::{
	Arc,
	atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use gas::prelude::*;
use rivet_envoy_protocol as protocol;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::{
	event_delivery::{retry_until_cancelled, try_enqueue},
	metrics,
};

struct Channel {
	tx: mpsc::Sender<protocol::EventWrapper>,
	handle: JoinHandle<()>,
	last_seen: Instant,
	pending: Arc<AtomicUsize>,
}

// An Envoy has a bounded Actor capacity. Keeping a small per-Actor queue prevents a persistent
// FDB outage from turning lifecycle events into an unbounded-memory attack. If this fills, the
// WebSocket is closed and the Envoy client's unacknowledged event history is replayed after
// reconnect.
const EVENT_CHANNEL_CAPACITY: usize = 64;
const EVENT_DISPATCH_BATCH_SIZE: usize = 64;
const EVENT_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

pub struct ActorEventDemuxer {
	ctx: StandaloneCtx,
	envoy_key: String,
	channels: HashMap<Id, Channel>,
	last_gc: Instant,
	gc_interval: Duration,
	max_last_seen: Duration,
	cancellation_token: CancellationToken,
	_guard: DropGuard,
}

impl ActorEventDemuxer {
	pub fn new(ctx: StandaloneCtx, envoy_key: String) -> Self {
		let pegboard_config = ctx.config().pegboard();
		let gc_interval = Duration::from_millis(pegboard_config.envoy_event_demuxer_gc_interval());
		let max_last_seen =
			Duration::from_millis(pegboard_config.envoy_event_demuxer_max_last_seen_threshold());
		let token = CancellationToken::new();
		let drop_guard = token.clone().drop_guard();

		Self {
			ctx,
			envoy_key,
			channels: HashMap::new(),
			last_gc: Instant::now(),
			gc_interval,
			max_last_seen,
			cancellation_token: token,
			_guard: drop_guard,
		}
	}

	/// Process an event by routing it to the appropriate actor's queue
	pub fn ingest(&mut self, actor_id: Id, event: protocol::EventWrapper) -> Result<()> {
		tracing::debug!(envoy_key=%self.envoy_key, ?actor_id, index=?event.checkpoint.index, "actor demuxer ingest");

		if let Some(channel) = self.channels.get_mut(&actor_id) {
			enqueue_or_reconnect(&channel.tx, &channel.pending, event, actor_id)?;
			channel.last_seen = Instant::now();
		} else {
			let (tx, rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);
			let pending = Arc::new(AtomicUsize::new(0));

			let handle = tokio::spawn(channel_handler(
				self.ctx.clone(),
				self.envoy_key.clone(),
				self.cancellation_token.clone(),
				actor_id,
				rx,
				pending.clone(),
			));

			// Send initial event
			enqueue_or_reconnect(&tx, &pending, event, actor_id)?;

			self.channels.insert(
				actor_id,
				Channel {
					tx,
					handle,
					last_seen: Instant::now(),
					pending,
				},
			);
		}

		metrics::INGESTED_EVENTS_TOTAL.inc();

		// Run gc periodically
		if self.last_gc.elapsed() > self.gc_interval {
			self.last_gc = Instant::now();

			// Never collect a dispatcher while it owns unacknowledged work. Once pending reaches zero,
			// dropping the sender is sufficient for the receiver task to exit after its empty read.
			self.channels.retain(|_, channel| {
				channel.pending.load(Ordering::Acquire) != 0
					|| channel.last_seen.elapsed() < self.max_last_seen
			});

			metrics::EVENT_DEMUXER_COUNT.set(self.channels.len() as i64);
		}

		Ok(())
	}

	/// Shutdown all tasks and wait for them to complete
	#[tracing::instrument(skip_all)]
	pub async fn shutdown(self) {
		tracing::debug!(channels=?self.channels.len(), "shutting down actor demuxer");

		// Drop all senders
		let mut handles = self
			.channels
			.into_iter()
			.map(|(_, channel)| channel.handle)
			.collect::<Vec<_>>()
			.into_iter();

		// A normal disconnect gets a short opportunity to durably drain accepted events. During a
		// persistent FDB outage, do not hang connection teardown forever: cancellation causes the
		// still-unacknowledged client history to be replayed on the next connection.
		let deadline = tokio::time::Instant::now() + EVENT_SHUTDOWN_GRACE;
		while let Some(mut handle) = handles.next() {
			if tokio::time::timeout_at(deadline, &mut handle)
				.await
				.is_err()
			{
				tracing::warn!(
					grace_ms = EVENT_SHUTDOWN_GRACE.as_millis(),
					"actor event drain timed out; cancelling for reconnect replay"
				);
				self.cancellation_token.cancel();
				let _ = handle.await;
				for handle in handles {
					let _ = handle.await;
				}
				break;
			}
		}

		tracing::debug!("actor demuxer shut down");
	}
}

fn enqueue_or_reconnect<T>(
	tx: &mpsc::Sender<T>,
	pending: &AtomicUsize,
	event: T,
	actor_id: Id,
) -> Result<()> {
	match try_enqueue(tx, pending, event) {
		Ok(()) => Ok(()),
		Err(mpsc::error::TrySendError::Full(_)) => {
			metrics::EVENT_DEMUXER_RECONNECT_TOTAL
				.with_label_values(&["queue_full"])
				.inc();
			bail!("actor event queue full for {actor_id}; reconnect required for replay")
		}
		Err(mpsc::error::TrySendError::Closed(_)) => {
			metrics::EVENT_DEMUXER_RECONNECT_TOTAL
				.with_label_values(&["dispatcher_closed"])
				.inc();
			bail!("actor event dispatcher closed for {actor_id}; reconnect required for replay")
		}
	}
}

#[tracing::instrument(name="demuxer_channel", skip_all, fields(ray_id=?ctx.ray_id(), req_id=?ctx.req_id(), %envoy_key, ?actor_id))]
async fn channel_handler(
	ctx: StandaloneCtx,
	envoy_key: String,
	cancellation_token: CancellationToken,
	actor_id: Id,
	mut rx: mpsc::Receiver<protocol::EventWrapper>,
	pending: Arc<AtomicUsize>,
) {
	loop {
		let mut buffer = Vec::new();

		// Batch process events
		tokio::select! {
			count = rx.recv_many(&mut buffer, EVENT_DISPATCH_BATCH_SIZE) => {
				if count == 0 {
					break;
				}

				let mut retry_attempts = 0_u64;
				let delivered = retry_until_cancelled(
					&cancellation_token,
					|| dispatch_events(&ctx, &envoy_key, actor_id, buffer.clone()),
					|err, backoff| {
						retry_attempts = retry_attempts.saturating_add(1);
						metrics::EVENT_DISPATCH_RETRY_TOTAL.inc();
						// Keep the first failures prominent, then reduce an extended outage to
						// logarithmic log volume. The counter above retains exact cardinality.
						if retry_attempts.is_power_of_two() {
							tracing::error!(
								?err,
								retry_attempts,
								backoff_ms = backoff.as_millis(),
								"actor event processor retrying"
							);
						}
					},
				)
				.await;
				if !delivered {
					break;
				}
				pending.fetch_sub(count, Ordering::AcqRel);
			}
			_ = cancellation_token.cancelled() => break,
		}
	}
}

#[tracing::instrument(skip_all, fields(%envoy_key, ?actor_id))]
async fn dispatch_events(
	ctx: &StandaloneCtx,
	envoy_key: &str,
	actor_id: Id,
	events: Vec<protocol::EventWrapper>,
) -> Result<()> {
	tracing::debug!(count=?events.len(), "actor demuxer dispatch");

	// The Actor record is the placement truth. Resolving through the workflow's
	// actor_id tag can miss a live workflow when its secondary tag index lags a
	// bursty create. That failure is especially damaging for Sleep intents: the
	// Envoy retries forever while a single active Actor permanently fences Host
	// drain. The public sleep API already resolves the Actor record and signals
	// its exact durable workflow ID for the same reason. Keep both paths on the
	// same invariant.
	let Some(actor) = ctx
		.op(pegboard::ops::actor::get_for_gateway::Input { actor_id })
		.await?
	else {
		tracing::warn!(?actor_id, "actor event target no longer exists");
		return Ok(());
	};

	let res = ctx
		.signal(pegboard::workflows::actor2::Events {
			envoy_key: envoy_key.to_string(),
			events,
		})
		.to_workflow_id(actor.workflow_id)
		.graceful_not_found()
		.send()
		.await
		.with_context(|| format!("failed to forward signal to actor workflow: {}", actor_id))?;
	if res.is_none() {
		tracing::warn!(
			?actor_id,
			"failed to send signal to actor workflow, likely already stopped"
		);
	}

	Ok(())
}
