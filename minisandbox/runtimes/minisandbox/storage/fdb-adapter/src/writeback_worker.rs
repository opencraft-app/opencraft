//! Event-driven FDB-to-COS BlockVolume settlement.

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use tokio::{
	sync::{Notify, mpsc},
	task::JoinHandle,
};

use crate::{
	ChunkStore, FdbBlockMetaStore, FdbBlockMetaStoreError, WritebackSettlement,
	settle_one_chunk_coordinated,
};

const INITIAL_RETRY: Duration = Duration::from_millis(100);
const MAX_RETRY: Duration = Duration::from_secs(10);

/// Owned background settlement task for one fenced volume generation.
pub struct WritebackWorker {
	wake: Arc<Notify>,
	stopping: Arc<AtomicBool>,
	_task: JoinHandle<()>,
}

impl WritebackWorker {
	/// Starts one event-driven worker and immediately scans pre-existing dirty chunks.
	#[must_use]
	pub fn spawn<S: ChunkStore>(
		metadata: FdbBlockMetaStore,
		chunks: Arc<S>,
		volume_id: String,
		writer_generation: u64,
	) -> Self {
		Self::spawn_inner(
			metadata,
			chunks,
			volume_id,
			writer_generation,
			Arc::new(tokio::sync::Mutex::new(())),
			None,
		)
	}

	/// Starts a worker which also reports exact settlements to a disposable
	/// local materialization manifest.
	#[must_use]
	pub fn spawn_with_settlements<S: ChunkStore>(
		metadata: FdbBlockMetaStore,
		chunks: Arc<S>,
		volume_id: String,
		writer_generation: u64,
	) -> (Self, mpsc::UnboundedReceiver<WritebackSettlement>) {
		let (sender, receiver) = mpsc::unbounded_channel();
		let coordinator = Arc::new(tokio::sync::Mutex::new(()));
		(
			Self::spawn_inner(
				metadata,
				chunks,
				volume_id,
				writer_generation,
				coordinator,
				Some(sender),
			),
			receiver,
		)
	}

	/// Starts a reporting worker sharing the writer's mutation coordinator.
	#[must_use]
	pub fn spawn_coordinated_with_settlements<S: ChunkStore>(
		metadata: FdbBlockMetaStore,
		chunks: Arc<S>,
		volume_id: String,
		writer_generation: u64,
		coordinator: Arc<tokio::sync::Mutex<()>>,
	) -> (Self, mpsc::UnboundedReceiver<WritebackSettlement>) {
		let (sender, receiver) = mpsc::unbounded_channel();
		(
			Self::spawn_inner(
				metadata,
				chunks,
				volume_id,
				writer_generation,
				coordinator,
				Some(sender),
			),
			receiver,
		)
	}

	fn spawn_inner<S: ChunkStore>(
		metadata: FdbBlockMetaStore,
		chunks: Arc<S>,
		volume_id: String,
		writer_generation: u64,
		coordinator: Arc<tokio::sync::Mutex<()>>,
		settlements: Option<mpsc::UnboundedSender<WritebackSettlement>>,
	) -> Self {
		let wake = Arc::new(Notify::new());
		let stopping = Arc::new(AtomicBool::new(false));
		let task = tokio::spawn(run(
			metadata,
			chunks,
			volume_id,
			writer_generation,
			wake.clone(),
			stopping.clone(),
			coordinator,
			settlements,
		));
		wake.notify_one();
		Self {
			wake,
			stopping,
			_task: task,
		}
	}

	/// Signals that one or more newly acknowledged hot pages need settlement.
	pub fn notify(&self) {
		self.wake.notify_one();
	}
}

impl Drop for WritebackWorker {
	fn drop(&mut self) {
		// The acknowledged FDB pages remain durable even if this best-effort
		// final drain cannot reach COS. Detach the task, wake it, and let it
		// either empty the dirty index or stop immediately on a stale fence/error.
		self.stopping.store(true, Ordering::Release);
		self.wake.notify_one();
	}
}

async fn run<S: ChunkStore>(
	metadata: FdbBlockMetaStore,
	chunks: Arc<S>,
	volume_id: String,
	writer_generation: u64,
	wake: Arc<Notify>,
	stopping: Arc<AtomicBool>,
	coordinator: Arc<tokio::sync::Mutex<()>>,
	settlements: Option<mpsc::UnboundedSender<WritebackSettlement>>,
) {
	loop {
		wake.notified().await;
		let mut retry = INITIAL_RETRY;
		loop {
			match settle_one_chunk_coordinated(
				&metadata,
				chunks.as_ref(),
				&volume_id,
				writer_generation,
				&coordinator,
			)
			.await
			{
				Ok(report) => {
					if let (Some(sender), Some(settlement)) =
						(settlements.as_ref(), report.settlement)
					{
						let _ = sender.send(settlement);
					}
					if report.chunk_no.is_none() {
						if stopping.load(Ordering::Acquire) {
							return;
						}
						break;
					}
					retry = INITIAL_RETRY;
				}
				Err(FdbBlockMetaStoreError::StaleWriter) => return,
				Err(error) => {
					if stopping.load(Ordering::Acquire) {
						tracing::warn!(
							%volume_id,
							writer_generation,
							%error,
							"BlockVolume final writeback deferred to the next writer"
						);
						return;
					}
					tracing::warn!(
						%volume_id,
						writer_generation,
						%error,
						"BlockVolume writeback failed; retrying"
					);
					tokio::time::sleep(retry).await;
					retry = retry.saturating_mul(2).min(MAX_RETRY);
				}
			}
		}
	}
}
