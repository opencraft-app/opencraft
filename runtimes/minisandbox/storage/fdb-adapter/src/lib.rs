//! FoundationDB-specific tuple layout and live transaction adapter.
//!
//! The key layout is available without the `FoundationDB` C client so it can be
//! reviewed and tested in hermetic builds. The live C-client adapter is kept
//! out until the `SQLite` baseline has been measured.

mod chunk_cache;
mod chunk_store;
mod keys;
#[cfg(feature = "legacy-depot")]
mod metastore;
mod native_metastore;
#[cfg(feature = "legacy-depot")]
mod object_store;
mod writeback_worker;

pub use chunk_cache::{CHUNK_BYTES, ChunkCache, ChunkCacheError, ChunkHash};
pub use chunk_store::{CachedChunkStore, ChunkStore, ChunkStoreError, CosChunkStore};
pub use keys::{
	BLOCK_SIZE, DELTA_SHARD_BLOCKS, KeyLayout, KeyLayoutError, LayerId, PreparedWrite,
	VersionReference, WriteInput,
};
#[cfg(feature = "legacy-depot")]
pub use metastore::{
	EnvoyDepotSqliteTransport, open_depot_block_repository, open_envoy_block_repository,
};
#[cfg(feature = "foundationdb")]
pub use native_metastore::open_foundationdb_metastore;
pub use native_metastore::{
	ChunkSnapshot, FdbBlockMetaStore, FdbBlockMetaStoreError, HotPage, NativeVolumeState,
	PageMutation, VolumeInitializationState, VolumeRecovery, WritebackReport, WritebackSettlement,
	load_sparse_template_pages, settle_one_chunk, settle_one_chunk_coordinated,
};
#[cfg(feature = "legacy-depot")]
pub use object_store::DepotManagedObjectStore;
pub use writeback_worker::WritebackWorker;
