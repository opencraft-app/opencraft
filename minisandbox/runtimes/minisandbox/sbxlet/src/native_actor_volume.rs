//! Native FDB-hot/COS-cold PVM ActorBlockVolume provider.

use std::{
	collections::BTreeMap,
	fs::File,
	io,
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Instant,
};

use anyhow::{Context, Result, ensure};
use minisandbox_core::engine::PvmBlockBackend;
use minisandbox_fdb_adapter::{
	CHUNK_BYTES, CachedChunkStore, ChunkHash, ChunkStore, CosChunkStore, FdbBlockMetaStore,
	FdbBlockMetaStoreError, HotPage, PageMutation, VolumeInitializationState, VolumeRecovery,
	WritebackSettlement, WritebackWorker, load_sparse_template_pages, settle_one_chunk_coordinated,
};
use rivet_minisandbox_host::MinisandboxActorIdentity;
use tokio::runtime::Handle;

use crate::{ActorBlockVolumeAttachment, ActorBlockVolumeProvider};

const PAGE_BYTES: usize = 4 * 1024;
const PAGE_BYTES_U64: u64 = PAGE_BYTES as u64;

/// Production ActorBlockVolume provider with no SQLite or local authoritative state.
pub struct NativeActorBlockVolumeProvider {
	runtime: Handle,
	metadata: FdbBlockMetaStore,
	chunks: Arc<CachedChunkStore<CosChunkStore>>,
	logical_size: u64,
	template_pages: Arc<[PageMutation]>,
	template_id: String,
}

impl NativeActorBlockVolumeProvider {
	/// Creates one provider around shared FDB, COS, RAM, and NVMe clients.
	pub fn new(
		runtime: Handle,
		metadata: FdbBlockMetaStore,
		chunks: Arc<CachedChunkStore<CosChunkStore>>,
		logical_size: u64,
		template_path: PathBuf,
		template_id: String,
	) -> Result<Self> {
		ensure!(
			logical_size > 0 && logical_size.is_multiple_of(u64::try_from(CHUNK_BYTES).unwrap()),
			"ActorBlockVolume size must be non-zero and 4 MiB aligned"
		);
		ensure!(
			!template_id.is_empty(),
			"ActorBlockVolume template ID is empty"
		);
		let template_size = std::fs::metadata(&template_path)
			.with_context(|| {
				format!(
					"inspect ActorBlockVolume template {}",
					template_path.display()
				)
			})?
			.len();
		ensure!(
			template_size == logical_size,
			"ActorBlockVolume template size {template_size} does not match {logical_size}"
		);
		let mut template = File::open(&template_path).with_context(|| {
			format!("open ActorBlockVolume template {}", template_path.display())
		})?;
		let template_pages: Arc<[PageMutation]> =
			load_sparse_template_pages(logical_size, &mut template)?.into();
		tracing::info!(
			template_id,
			hot_pages = template_pages.len(),
			hot_bytes = template_pages.len().saturating_mul(PAGE_BYTES),
			"loaded FDB-first ActorBlockVolume template"
		);
		Ok(Self {
			runtime,
			metadata,
			chunks,
			logical_size,
			template_pages,
			template_id,
		})
	}
}

impl ActorBlockVolumeProvider for NativeActorBlockVolumeProvider {
	fn open_writer(
		&self,
		identity: &MinisandboxActorIdentity,
	) -> Result<ActorBlockVolumeAttachment> {
		let volume_id = identity.actor_id.clone();
		let generation = u64::from(identity.generation);
		let total_started = Instant::now();
		let open_started = Instant::now();
		let state = self.runtime.block_on(self.metadata.open_volume(
			&volume_id,
			self.logical_size,
			generation,
			&self.template_id,
		))?;
		let open_ms = open_started.elapsed().as_millis();
		let initialize_started = Instant::now();
		if state.initialization == VolumeInitializationState::Initializing {
			self.runtime.block_on(self.metadata.initialize_hot_pages(
				&volume_id,
				generation,
				&self.template_pages,
			))?;
		}
		let initialize_ms = initialize_started.elapsed().as_millis();
		let recovery_started = Instant::now();
		let recovery = self
			.runtime
			.block_on(self.metadata.recover_volume(&volume_id, generation))?;
		let recovery_ms = recovery_started.elapsed().as_millis();
		let recovery_chunks = recovery.chunks.len();
		let recovery_hot_pages = recovery
			.chunks
			.values()
			.map(|chunk| chunk.hot_pages.len())
			.sum::<usize>();
		tracing::info!(
			%volume_id,
			generation,
			open_ms,
			initialize_ms,
			recovery_ms,
			recovery_chunks,
			recovery_hot_pages,
			total_ms = total_started.elapsed().as_millis(),
			"opened local-free ActorBlockVolume data plane"
		);
		let coordinator = Arc::new(tokio::sync::Mutex::new(()));
		let (worker, settlements) = {
			let _runtime = self.runtime.enter();
			WritebackWorker::spawn_coordinated_with_settlements(
				self.metadata.clone(),
				self.chunks.clone(),
				volume_id.clone(),
				generation,
				coordinator.clone(),
			)
		};
		Ok(ActorBlockVolumeAttachment {
			volume: Box::new(NativePvmBlockBackend {
				runtime: self.runtime.clone(),
				metadata: self.metadata.clone(),
				chunks: self.chunks.clone(),
				volume_id,
				generation,
				logical_size: self.logical_size,
				manifest: VolumeManifest::from_recovery(recovery),
				operation: AtomicU64::new(1),
				worker,
				settlements,
				coordinator,
			}),
		})
	}
}

struct NativePvmBlockBackend {
	runtime: Handle,
	metadata: FdbBlockMetaStore,
	chunks: Arc<CachedChunkStore<CosChunkStore>>,
	volume_id: String,
	generation: u64,
	logical_size: u64,
	manifest: VolumeManifest,
	operation: AtomicU64,
	worker: WritebackWorker,
	settlements: tokio::sync::mpsc::UnboundedReceiver<WritebackSettlement>,
	coordinator: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone)]
struct LocalChunk {
	base_hash: Option<ChunkHash>,
	hot_pages: BTreeMap<u64, HotPage>,
}

struct VolumeManifest {
	chunks: BTreeMap<u64, LocalChunk>,
}

impl VolumeManifest {
	fn from_recovery(recovery: VolumeRecovery) -> Self {
		let chunks = recovery
			.chunks
			.into_iter()
			.map(|(chunk_no, snapshot)| {
				let hot_pages = snapshot
					.hot_pages
					.into_iter()
					.map(|page| (page.block_no, page))
					.collect();
				(
					chunk_no,
					LocalChunk {
						base_hash: snapshot.base_hash,
						hot_pages,
					},
				)
			})
			.collect();
		Self { chunks }
	}
}

impl NativePvmBlockBackend {
	fn drain_settlements(&mut self) {
		while let Ok(settlement) = self.settlements.try_recv() {
			self.apply_settlement(settlement);
		}
	}

	fn apply_settlement(&mut self, settlement: WritebackSettlement) {
		let Some(chunk) = self.manifest.chunks.get_mut(&settlement.chunk_no) else {
			return;
		};
		let matched = settlement
			.cleared_pages
			.iter()
			.filter(|page| {
				chunk
					.hot_pages
					.get(&page.block_no)
					.is_some_and(|current| current.sequence == page.sequence)
			})
			.map(|page| page.block_no)
			.collect::<Vec<_>>();
		if matched.is_empty() && !settlement.cleared_pages.is_empty() {
			return;
		}
		for block_no in matched {
			chunk.hot_pages.remove(&block_no);
		}
		chunk.base_hash = settlement.base_hash;
	}

	fn check_range(&self, offset: u64, length: u64) -> io::Result<()> {
		offset
			.checked_add(length)
			.filter(|end| *end <= self.logical_size)
			.map(|_| ())
			.ok_or_else(|| io::Error::other("ActorBlockVolume request exceeds capacity"))
	}

	async fn load_local_chunk(
		chunks: Arc<CachedChunkStore<CosChunkStore>>,
		chunk: Option<LocalChunk>,
	) -> Result<(Option<Arc<[u8]>>, Option<LocalChunk>)> {
		let base = match chunk.as_ref().and_then(|chunk| chunk.base_hash) {
			Some(hash) => Some(chunks.get_chunk(hash).await?),
			None => None,
		};
		Ok((base, chunk))
	}

	async fn read_range(&mut self, offset: u64, length: usize) -> Result<Vec<u8>> {
		self.drain_settlements();
		let length_u64 = u64::try_from(length)?;
		self.check_range(offset, length_u64)?;
		if length == 0 {
			return Ok(Vec::new());
		}
		let first_chunk = offset / u64::try_from(CHUNK_BYTES).unwrap();
		let last_chunk = (offset + length_u64 - 1) / u64::try_from(CHUNK_BYTES).unwrap();
		let loads = (first_chunk..=last_chunk)
			.map(|chunk_no| {
				let chunks = self.chunks.clone();
				let local = self.manifest.chunks.get(&chunk_no).cloned();
				async move {
					Self::load_local_chunk(chunks, local)
						.await
						.map(|loaded| (chunk_no, loaded))
				}
			})
			.collect::<Vec<_>>();
		let loaded = futures_util::future::try_join_all(loads).await?;
		let mut output = Vec::with_capacity(length);
		for (chunk_no, (base, local)) in loaded {
			let chunk_start = chunk_no * u64::try_from(CHUNK_BYTES).unwrap();
			let copy_start = usize::try_from(offset.saturating_sub(chunk_start))?;
			let request_end = offset + length_u64;
			let copy_end = usize::try_from(
				request_end.min(chunk_start + u64::try_from(CHUNK_BYTES).unwrap()) - chunk_start,
			)?;
			let mut segment = match base {
				Some(base) => base[copy_start..copy_end].to_vec(),
				None => vec![0; copy_end - copy_start],
			};
			if let Some(local) = local {
				for page in local.hot_pages.values() {
					let page_in_chunk =
						page.block_no % u64::try_from(CHUNK_BYTES / PAGE_BYTES).unwrap();
					let page_start = usize::try_from(page_in_chunk)? * PAGE_BYTES;
					let overlap_start = page_start.max(copy_start);
					let overlap_end = (page_start + PAGE_BYTES).min(copy_end);
					if overlap_start >= overlap_end {
						continue;
					}
					let destination =
						&mut segment[overlap_start - copy_start..overlap_end - copy_start];
					match &page.bytes {
						Some(source) => destination.copy_from_slice(
							&source[overlap_start - page_start..overlap_end - page_start],
						),
						None => destination.fill(0),
					}
				}
			}
			output.extend_from_slice(&segment);
		}
		ensure!(output.len() == length, "ActorBlockVolume short read");
		Ok(output)
	}

	fn write_range(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
		self.drain_settlements();
		self.check_range(
			offset,
			u64::try_from(bytes.len()).map_err(io::Error::other)?,
		)?;
		if bytes.is_empty() {
			return Ok(());
		}
		let first_page = offset / PAGE_BYTES_U64;
		let end = offset + u64::try_from(bytes.len()).map_err(io::Error::other)?;
		let last_page = (end - 1) / PAGE_BYTES_U64;
		let mut pages = Vec::with_capacity(
			usize::try_from(last_page - first_page + 1).map_err(io::Error::other)?,
		);
		for block_no in first_page..=last_page {
			let page_start = block_no * PAGE_BYTES_U64;
			let overlap_start = offset.max(page_start);
			let overlap_end = end.min(page_start + PAGE_BYTES_U64);
			let mut page =
				if overlap_start == page_start && overlap_end == page_start + PAGE_BYTES_U64 {
					vec![0; PAGE_BYTES]
				} else {
					self.runtime
						.clone()
						.block_on(self.read_range(page_start, PAGE_BYTES))
						.map_err(|error| io::Error::other(error.to_string()))?
				};
			let destination_start =
				usize::try_from(overlap_start - page_start).map_err(io::Error::other)?;
			let source_start = usize::try_from(overlap_start - offset).map_err(io::Error::other)?;
			let copy_len =
				usize::try_from(overlap_end - overlap_start).map_err(io::Error::other)?;
			page[destination_start..destination_start + copy_len]
				.copy_from_slice(&bytes[source_start..source_start + copy_len]);
			pages.push(PageMutation {
				block_no,
				bytes: page.iter().any(|byte| *byte != 0).then_some(page),
			});
		}
		self.commit_pages(pages)
	}

	fn discard_range(&mut self, offset: u64, length: u64) -> io::Result<()> {
		self.drain_settlements();
		self.check_range(offset, length)?;
		if length == 0 {
			return Ok(());
		}
		let end = offset + length;
		let chunk_bytes = u64::try_from(CHUNK_BYTES).unwrap();
		let full_start = offset.div_ceil(chunk_bytes).saturating_mul(chunk_bytes);
		let full_end = (end / chunk_bytes).saturating_mul(chunk_bytes);
		let mut pages = Vec::new();
		if full_start < full_end {
			self.append_discard_pages(offset, full_start, &mut pages)?;
			let chunk_nos = (full_start / chunk_bytes..full_end / chunk_bytes).collect();
			self.commit_chunks(chunk_nos)?;
			self.append_discard_pages(full_end, end, &mut pages)?;
		} else {
			self.append_discard_pages(offset, end, &mut pages)?;
		}
		if pages.is_empty() {
			Ok(())
		} else {
			self.commit_pages(pages)
		}
	}

	fn append_discard_pages(
		&mut self,
		offset: u64,
		end: u64,
		pages: &mut Vec<PageMutation>,
	) -> io::Result<()> {
		if offset == end {
			return Ok(());
		}
		let first_page = offset / PAGE_BYTES_U64;
		let last_page = (end - 1) / PAGE_BYTES_U64;
		for block_no in first_page..=last_page {
			let page_start = block_no * PAGE_BYTES_U64;
			let overlap_start = offset.max(page_start);
			let overlap_end = end.min(page_start + PAGE_BYTES_U64);
			let bytes = if overlap_start == page_start && overlap_end == page_start + PAGE_BYTES_U64
			{
				None
			} else {
				let mut page = self
					.runtime
					.clone()
					.block_on(self.read_range(page_start, PAGE_BYTES))
					.map_err(|error| io::Error::other(error.to_string()))?;
				let start =
					usize::try_from(overlap_start - page_start).map_err(io::Error::other)?;
				let length =
					usize::try_from(overlap_end - overlap_start).map_err(io::Error::other)?;
				page[start..start + length].fill(0);
				page.iter().any(|byte| *byte != 0).then_some(page)
			};
			pages.push(PageMutation { block_no, bytes });
		}
		Ok(())
	}

	fn commit_pages(&mut self, pages: Vec<PageMutation>) -> io::Result<()> {
		let op_id = self.next_operation_id("pages");
		let mut empty_drains = 0_u8;
		let last_sequence = loop {
			let metadata = self.metadata.clone();
			let coordinator = self.coordinator.clone();
			let volume_id = self.volume_id.clone();
			let generation = self.generation;
			let op_id = op_id.clone();
			let attempt_pages = pages.clone();
			match self.runtime.block_on(async move {
				let _mutation = coordinator.lock().await;
				metadata
					.write_pages(&volume_id, generation, &op_id, attempt_pages)
					.await
			}) {
				Ok(sequence) => break sequence,
				Err(FdbBlockMetaStoreError::HotTierFull) => {
					self.worker.notify();
					let report = self
						.runtime
						.block_on(settle_one_chunk_coordinated(
							&self.metadata,
							self.chunks.as_ref(),
							&self.volume_id,
							self.generation,
							&self.coordinator,
						))
						.map_err(|error| io::Error::other(error.to_string()))?;
					if let Some(settlement) = report.settlement {
						self.apply_settlement(settlement);
					}
					if report.chunk_no.is_none() {
						empty_drains = empty_drains.saturating_add(1);
						if empty_drains > 1 {
							return Err(io::Error::other(
								"ActorBlockVolume hot tier is full without dirty data",
							));
						}
					}
				}
				Err(error) => return Err(io::Error::other(error.to_string())),
			}
		};
		self.apply_committed_pages(&pages, last_sequence)?;
		self.worker.notify();
		Ok(())
	}

	fn apply_committed_pages(
		&mut self,
		pages: &[PageMutation],
		last_sequence: u64,
	) -> io::Result<()> {
		let first_sequence = last_sequence
			.checked_sub(
				u64::try_from(pages.len())
					.map_err(io::Error::other)?
					.saturating_sub(1),
			)
			.ok_or_else(|| io::Error::other("ActorBlockVolume sequence underflow"))?;
		let mut by_chunk = BTreeMap::<u64, Vec<(u64, &PageMutation)>>::new();
		for (offset, page) in pages.iter().enumerate() {
			let sequence = first_sequence
				.checked_add(u64::try_from(offset).map_err(io::Error::other)?)
				.ok_or_else(|| io::Error::other("ActorBlockVolume sequence overflow"))?;
			by_chunk
				.entry(page.block_no / u64::try_from(CHUNK_BYTES / PAGE_BYTES).unwrap())
				.or_default()
				.push((sequence, page));
		}
		for (chunk_no, mutations) in by_chunk {
			let entry = self
				.manifest
				.chunks
				.entry(chunk_no)
				.or_insert_with(|| LocalChunk {
					base_hash: None,
					hot_pages: BTreeMap::new(),
				});
			for (sequence, mutation) in mutations {
				entry.hot_pages.insert(
					mutation.block_no,
					HotPage {
						block_no: mutation.block_no,
						sequence,
						bytes: mutation.bytes.clone(),
					},
				);
			}
		}
		Ok(())
	}

	fn commit_chunks(&mut self, chunk_nos: Vec<u64>) -> io::Result<()> {
		let op_id = self.next_operation_id("discard");
		let metadata = self.metadata.clone();
		let coordinator = self.coordinator.clone();
		let volume_id = self.volume_id.clone();
		let generation = self.generation;
		let committed_chunks = chunk_nos.clone();
		self.runtime
			.block_on(async move {
				let _mutation = coordinator.lock().await;
				metadata
					.discard_chunks(&volume_id, generation, &op_id, committed_chunks)
					.await
			})
			.map_err(|error| io::Error::other(error.to_string()))?;
		for chunk_no in chunk_nos {
			self.manifest.chunks.remove(&chunk_no);
		}
		self.worker.notify();
		Ok(())
	}

	fn next_operation_id(&self, operation: &str) -> String {
		let sequence = self.operation.fetch_add(1, Ordering::Relaxed);
		format!("pvm-{operation}-{:x}-{sequence:x}", self.generation)
	}
}

impl PvmBlockBackend for NativePvmBlockBackend {
	fn size(&self) -> u64 {
		self.logical_size
	}

	fn read_at(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
		self.runtime
			.clone()
			.block_on(self.read_range(offset, length))
			.map_err(|error| io::Error::other(error.to_string()))
	}

	fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
		self.write_range(offset, bytes)
	}

	fn discard(&mut self, offset: u64, length: u64) -> io::Result<()> {
		self.discard_range(offset, length)
	}

	fn flush(&mut self) -> io::Result<()> {
		self.drain_settlements();
		// Every write ACK already follows an FDB commit. COS settlement is an
		// optimization and is never part of guest-visible durability.
		Ok(())
	}
}
