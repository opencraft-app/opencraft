//! Bounded online hot-to-cold settlement for an attached reference volume.

use std::{
	sync::mpsc::{self, Receiver, SyncSender},
	thread::{self, JoinHandle},
	time::Duration,
};

use minisandbox_block_engine::{
	BLOCK_SIZE, BlockEngine, BlockEngineError, BlockRepositoryError, ObjectStore,
};
use thiserror::Error;

const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Hysteresis and pack bounds for one online settler.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OnlineSettlerConfig {
	/// Start cold settlement after durable hot payload reaches this value.
	pub high_watermark_bytes: u64,
	/// Continue settling until hot payload is at or below this value.
	pub low_watermark_bytes: u64,
	/// Maximum immutable object assembled by one bounded pass.
	pub max_pack_bytes: u64,
}

impl OnlineSettlerConfig {
	pub(crate) fn validate(self) -> Result<(), OnlineSettlerError> {
		if self.low_watermark_bytes >= self.high_watermark_bytes
			|| !self.low_watermark_bytes.is_multiple_of(BLOCK_SIZE)
			|| !self.high_watermark_bytes.is_multiple_of(BLOCK_SIZE)
		{
			return Err(OnlineSettlerError::InvalidWatermarks);
		}
		Ok(())
	}
}

/// Observable bounded-settler progress emitted by the validation frontend.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct OnlineSettlerStats {
	/// Wakeups that observed or checked the hot tier.
	pub wakeups: u64,
	/// Bounded pack passes attempted.
	pub passes: u64,
	/// Passes that published or resumed an immutable pack.
	pub packs: u64,
	/// Versions whose cold locations were newly published.
	pub published_blocks: u64,
	/// Versions whose hot payload was evicted by their original pass.
	pub evicted_blocks: u64,
	/// Published hot payloads recovered after an interrupted prior pass.
	pub recovered_evictions: u64,
	/// Largest observed hot payload footprint.
	pub max_hot_payload_bytes: u64,
	/// Hot payload remaining when the worker stopped.
	pub final_hot_payload_bytes: u64,
}

/// Online-settler configuration, worker, or durable-protocol failure.
#[derive(Debug, Error)]
pub enum OnlineSettlerError {
	/// Low/high watermarks are unordered or not 4 KiB aligned.
	#[error("online settler watermarks must be 4 KiB aligned and low < high")]
	InvalidWatermarks,
	/// The maintenance thread could not be created.
	#[error("online settler worker could not be started")]
	Spawn,
	/// The maintenance thread panicked.
	#[error("online settler worker panicked")]
	Panicked,
	/// Durable repository work failed.
	#[error(transparent)]
	Repository(#[from] BlockRepositoryError),
	/// Pack/COS protocol work failed.
	#[error(transparent)]
	Engine(#[from] BlockEngineError),
	/// Hot payload remained but a bounded pass made no progress.
	#[error("online settler made no progress above its low watermark")]
	NoProgress,
}

#[derive(Clone, Copy, Debug)]
enum Command {
	Wake,
	Stop { drain: bool },
}

#[derive(Debug)]
pub(crate) struct OnlineSettler<S> {
	sender: SyncSender<Command>,
	worker: Option<JoinHandle<Result<OnlineSettlerStats, OnlineSettlerError>>>,
	_store: std::marker::PhantomData<S>,
}

impl<S> OnlineSettler<S>
where
	S: ObjectStore + Send + 'static,
{
	pub(crate) fn start(
		mut engine: BlockEngine<S>,
		config: OnlineSettlerConfig,
	) -> Result<Self, OnlineSettlerError> {
		config.validate()?;
		engine.set_max_pack_bytes(config.max_pack_bytes)?;
		let (sender, receiver) = mpsc::sync_channel(1);
		let worker = thread::Builder::new()
			.name("minisandbox-online-settler".to_owned())
			.spawn(move || run_worker(engine, config, &receiver))
			.map_err(|_| OnlineSettlerError::Spawn)?;
		Ok(Self {
			sender,
			worker: Some(worker),
			_store: std::marker::PhantomData,
		})
	}
}

impl<S> OnlineSettler<S> {
	pub(crate) fn notify(&self) {
		// The capacity-one channel deliberately coalesces arbitrary write
		// bursts into one wakeup. A periodic poll remains as a lost-wakeup
		// fallback if the worker has already stopped.
		let _ = self.sender.try_send(Command::Wake);
	}

	pub(crate) fn shutdown(
		&mut self,
		drain: bool,
	) -> Result<OnlineSettlerStats, OnlineSettlerError> {
		let Some(worker) = self.worker.take() else {
			return Ok(OnlineSettlerStats::default());
		};
		let _ = self.sender.send(Command::Stop { drain });
		worker.join().map_err(|_| OnlineSettlerError::Panicked)?
	}
}

impl<S> Drop for OnlineSettler<S> {
	fn drop(&mut self) {
		let _ = self.shutdown(false);
	}
}

fn run_worker(
	mut engine: BlockEngine<impl ObjectStore>,
	config: OnlineSettlerConfig,
	receiver: &Receiver<Command>,
) -> Result<OnlineSettlerStats, OnlineSettlerError> {
	let mut summary = OnlineSettlerStats::default();
	loop {
		let (force, stop) = match receiver.recv_timeout(POLL_INTERVAL) {
			Ok(Command::Wake) | Err(mpsc::RecvTimeoutError::Timeout) => (false, false),
			Ok(Command::Stop { drain }) => (drain, true),
			Err(mpsc::RecvTimeoutError::Disconnected) => (false, true),
		};
		settle_to_low_watermark(&mut engine, config, force, &mut summary)?;
		if stop {
			return Ok(summary);
		}
	}
}

fn settle_to_low_watermark(
	engine: &mut BlockEngine<impl ObjectStore>,
	config: OnlineSettlerConfig,
	force: bool,
	summary: &mut OnlineSettlerStats,
) -> Result<(), OnlineSettlerError> {
	summary.wakeups = summary.wakeups.saturating_add(1);
	let mut hot_bytes = engine.repository().stats()?.hot_payload_bytes;
	summary.max_hot_payload_bytes = summary.max_hot_payload_bytes.max(hot_bytes);
	if !force && hot_bytes < config.high_watermark_bytes {
		summary.final_hot_payload_bytes = hot_bytes;
		return Ok(());
	}

	while hot_bytes > config.low_watermark_bytes {
		let report = engine.settle_once_to_low(config.low_watermark_bytes)?;
		summary.passes = summary.passes.saturating_add(1);
		summary.published_blocks = summary
			.published_blocks
			.saturating_add(report.published_blocks);
		summary.evicted_blocks = summary.evicted_blocks.saturating_add(report.evicted_blocks);
		summary.recovered_evictions = summary
			.recovered_evictions
			.saturating_add(report.recovered_evictions);
		if report.object_key.is_some() {
			summary.packs = summary.packs.saturating_add(1);
		}

		let next_hot_bytes = engine.repository().stats()?.hot_payload_bytes;
		summary.max_hot_payload_bytes = summary.max_hot_payload_bytes.max(next_hot_bytes);
		if next_hot_bytes >= hot_bytes
			&& report.object_key.is_none()
			&& report.recovered_evictions == 0
		{
			return Err(OnlineSettlerError::NoProgress);
		}
		hot_bytes = next_hot_bytes;
	}
	summary.final_hot_payload_bytes = hot_bytes;
	Ok(())
}
