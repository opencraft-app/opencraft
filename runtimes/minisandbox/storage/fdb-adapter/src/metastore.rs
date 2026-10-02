//! Generation-fenced Depot SQLite bridge for Block Engine metadata.

use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use depot_client::{
	database::open_native_database_from_transport,
	vfs::{SqliteTransport, SqliteTransportHandle},
};
use minisandbox_block_engine::{AtomicVfsBlockRepositoryConnection, BlockMetaRepository};
use rivet_envoy_client::{handle::EnvoyHandle, protocol};
use tokio::runtime::Handle;

/// Depot page transport over the sbxlet's existing Envoy connection.
#[derive(Clone)]
pub struct EnvoyDepotSqliteTransport {
	handle: EnvoyHandle,
}

impl EnvoyDepotSqliteTransport {
	/// Binds page I/O to one connected Envoy handle.
	#[must_use]
	pub fn new(handle: EnvoyHandle) -> Self {
		Self { handle }
	}
}

#[async_trait]
impl SqliteTransport for EnvoyDepotSqliteTransport {
	async fn get_pages(
		&self,
		request: protocol::SqliteGetPagesRequest,
	) -> Result<protocol::SqliteGetPagesResponse> {
		self.handle.sqlite_get_pages(request).await
	}

	async fn commit(
		&self,
		request: protocol::SqliteCommitRequest,
	) -> Result<protocol::SqliteCommitResponse> {
		self.handle.sqlite_commit(request).await
	}
}

/// Opens one Block Engine metadata repository on Depot's FDB/COS-backed VFS.
///
/// `actor_id` selects the actor-owned Depot database and `generation` is
/// inserted into every page read and commit. Pegboard Envoy validates that
/// generation and Depot serializably compares the authoritative generation key
/// in the same UniversalDB transaction that commits the SQLite pages.
pub async fn open_depot_block_repository(
	transport: SqliteTransportHandle,
	actor_id: String,
	generation: u64,
	runtime: Handle,
	queue_capacity: usize,
) -> Result<BlockMetaRepository> {
	let native =
		open_native_database_from_transport(transport, actor_id, generation, runtime, None)
			.await
			.context("open Depot VFS for Block Engine metadata")?;

	// SAFETY: `NativeDatabase` and rusqlite resolve to the same pinned
	// libsqlite3-sys ABI. `from_handle` is deliberately non-owning, all SQL is
	// moved to the repository's single owner thread, and the paired native
	// owner below outlives and ultimately closes the raw handle.
	let connection = unsafe { rusqlite::Connection::from_handle(native.as_ptr().cast()) }
		.context("wrap native Depot SQLite handle")?;
	let connection = AtomicVfsBlockRepositoryConnection::new(connection, native);
	BlockMetaRepository::open_atomic_vfs(connection, queue_capacity)
		.map_err(anyhow::Error::from)
		.context("start Block Engine metadata repository")
}

/// Opens a generation-fenced repository through the existing Envoy handle.
pub async fn open_envoy_block_repository(
	handle: EnvoyHandle,
	actor_id: String,
	generation: u64,
	runtime: Handle,
	queue_capacity: usize,
) -> Result<BlockMetaRepository> {
	open_depot_block_repository(
		Arc::new(EnvoyDepotSqliteTransport::new(handle)),
		actor_id,
		generation,
		runtime,
		queue_capacity,
	)
	.await
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeMap,
		sync::{
			Arc, Mutex,
			atomic::{AtomicU64, Ordering},
		},
	};

	use minisandbox_block_backend::SqliteBlockBackendFactory;
	use minisandbox_block_engine::{
		AcquireWriterOutcome, AcquireWriterRequest, BlockData, CommitWriteRequest, WriteOutcome,
	};

	use super::*;

	#[derive(Default)]
	struct MemoryDepotTransport {
		pages: Mutex<BTreeMap<u32, Vec<u8>>>,
		head_txid: AtomicU64,
		generations: Mutex<Vec<Option<u64>>>,
	}

	#[async_trait]
	impl SqliteTransport for MemoryDepotTransport {
		async fn get_pages(
			&self,
			request: protocol::SqliteGetPagesRequest,
		) -> Result<protocol::SqliteGetPagesResponse> {
			self.generations
				.lock()
				.unwrap()
				.push(request.expected_generation);
			let pages = self.pages.lock().unwrap();
			Ok(protocol::SqliteGetPagesResponse::SqliteGetPagesOk(
				protocol::SqliteGetPagesOk {
					pages: request
						.pgnos
						.into_iter()
						.map(|pgno| protocol::SqliteFetchedPage {
							pgno,
							bytes: pages.get(&pgno).cloned(),
						})
						.collect(),
					head_txid: Some(self.head_txid.load(Ordering::Acquire)),
				},
			))
		}

		async fn commit(
			&self,
			request: protocol::SqliteCommitRequest,
		) -> Result<protocol::SqliteCommitResponse> {
			self.generations
				.lock()
				.unwrap()
				.push(request.expected_generation);
			let current = self.head_txid.load(Ordering::Acquire);
			if request
				.expected_head_txid
				.is_some_and(|expected| expected != current)
			{
				return Ok(protocol::SqliteCommitResponse::SqliteErrorResponse(
					protocol::SqliteErrorResponse {
						group: "sqlite".to_owned(),
						code: "head_mismatch".to_owned(),
						message: "head transaction changed".to_owned(),
					},
				));
			}
			let mut pages = self.pages.lock().unwrap();
			pages.retain(|pgno, _| *pgno <= request.db_size_pages);
			for page in request.dirty_pages {
				pages.insert(page.pgno, page.bytes);
			}
			let head_txid = self.head_txid.fetch_add(1, Ordering::AcqRel) + 1;
			Ok(protocol::SqliteCommitResponse::SqliteCommitOk(
				protocol::SqliteCommitOk {
					head_txid: Some(head_txid),
				},
			))
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn depot_vfs_preserves_block_transactions_and_generation_fence() {
		const GENERATION: u64 = 41;
		let transport = Arc::new(MemoryDepotTransport::default());
		let repository = open_depot_block_repository(
			transport.clone(),
			"actor-test".to_owned(),
			GENERATION,
			Handle::current(),
			8,
		)
		.await
		.unwrap();
		let state = repository.create_volume("volume", 4096).unwrap();
		let acquisition = repository
			.acquire_writer(AcquireWriterRequest {
				volume_id: "volume".to_owned(),
				expected_epoch: state.writer_epoch,
				op_id: "activate-41".to_owned(),
			})
			.unwrap();
		let AcquireWriterOutcome::Acquired { new_epoch } = acquisition.outcome else {
			panic!("writer acquisition unexpectedly lost its fence");
		};
		let write = repository
			.commit_write(CommitWriteRequest {
				volume_id: "volume".to_owned(),
				writer_epoch: new_epoch,
				op_id: "write-1".to_owned(),
				block_no: 0,
				bytes: vec![0xa5; 4096],
			})
			.unwrap();
		assert!(matches!(write.outcome, WriteOutcome::Applied { .. }));
		let BlockData::Version {
			hot_bytes: Some(bytes),
			..
		} = repository.read_block_head("volume", 0).unwrap()
		else {
			panic!("written block did not remain available in the hot tier");
		};
		assert_eq!(bytes, [0xa5; 4096]);
		assert!(
			transport
				.generations
				.lock()
				.unwrap()
				.iter()
				.all(|generation| *generation == Some(GENERATION))
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn depot_managed_cold_tier_supports_block_backend_without_second_settler() {
		let transport = Arc::new(MemoryDepotTransport::default());
		let repository = open_depot_block_repository(
			transport,
			"actor-backend".to_owned(),
			7,
			Handle::current(),
			8,
		)
		.await
		.unwrap();
		let factory =
			SqliteBlockBackendFactory::from_components(repository, crate::DepotManagedObjectStore);
		let mut backend = factory.open_volume("actor-volume", 8192).unwrap();
		backend.write_at(0, &[0x3c; 4096], false).unwrap();
		backend.trim(0, 4096, true).unwrap();
		assert_eq!(backend.read_at(0, 4096).unwrap(), [0; 4096]);
	}
}
