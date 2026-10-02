//! Block Engine object boundary when Depot owns physical cold settlement.

use minisandbox_block_engine::{DeleteStatus, ObjectStore, ObjectStoreError, PutStatus};

/// Marker object store for a repository whose complete SQLite image is already
/// stored by Depot over FDB and COS.
///
/// The Block Engine's logical hot payload remains part of its transactionally
/// checked SQLite state. Depot independently moves the SQLite pages containing
/// that payload from FDB to immutable COS shards and restores them through the
/// same VFS. Running the Block Engine's second pack settler would duplicate the
/// cold tier and create two GC authorities, so production backends leave that
/// optional worker disabled and fail closed if it is invoked accidentally.
#[derive(Clone, Copy, Debug, Default)]
pub struct DepotManagedObjectStore;

impl ObjectStore for DepotManagedObjectStore {
	fn put_immutable(
		&mut self,
		_object_key: &str,
		_bytes: &[u8],
	) -> Result<PutStatus, ObjectStoreError> {
		Err(ObjectStoreError::Unavailable)
	}

	fn get_range(
		&mut self,
		_object_key: &str,
		_offset: u64,
		_length: u64,
	) -> Result<Vec<u8>, ObjectStoreError> {
		Err(ObjectStoreError::Unavailable)
	}

	fn delete_exact(&mut self, _object_key: &str) -> Result<DeleteStatus, ObjectStoreError> {
		Err(ObjectStoreError::Unavailable)
	}
}
