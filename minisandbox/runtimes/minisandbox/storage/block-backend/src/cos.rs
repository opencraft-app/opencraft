use std::{
	collections::BTreeMap,
	fs,
	path::{Path, PathBuf},
	sync::{Arc, Mutex, OnceLock, Weak},
};

use minisandbox_block_engine::{DeleteStatus, ObjectStore, ObjectStoreError, PutStatus};
use minisandbox_cos_emulator::{
	ByteRange, CosEmulator, DataOperation, DataRequest, DataResponse, EmulatorError,
};

/// Durable local Tencent-COS test adapter used by reference block frontends.
#[derive(Clone, Debug)]
pub struct EmulatorObjectStore {
	emulator: SharedEmulator,
	bucket: String,
	access_path: String,
}

type SharedEmulator = Arc<Mutex<CosEmulator>>;
static OPEN_EMULATORS: OnceLock<Mutex<BTreeMap<PathBuf, Weak<Mutex<CosEmulator>>>>> =
	OnceLock::new();

impl EmulatorObjectStore {
	/// Opens one persistent emulator truth directory.
	///
	/// # Errors
	///
	/// Returns an emulator storage or ownership error.
	pub fn open(root: &Path) -> Result<Self, EmulatorError> {
		fs::create_dir_all(root)?;
		let root = fs::canonicalize(root)?;
		let registry = OPEN_EMULATORS.get_or_init(|| Mutex::new(BTreeMap::new()));
		let mut registry = registry
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		let emulator = if let Some(emulator) = registry.get(&root).and_then(Weak::upgrade) {
			emulator
		} else {
			let emulator = Arc::new(Mutex::new(CosEmulator::open(&root)?));
			registry.insert(root, Arc::downgrade(&emulator));
			emulator
		};
		Ok(Self {
			emulator,
			bucket: "minisandbox-block".to_owned(),
			access_path: "local-reference".to_owned(),
		})
	}
}

impl ObjectStore for EmulatorObjectStore {
	fn put_immutable(
		&mut self,
		object_key: &str,
		bytes: &[u8],
	) -> Result<PutStatus, ObjectStoreError> {
		let response = self.execute(DataRequest {
			operation: DataOperation::Put,
			bucket: self.bucket.clone(),
			key: object_key.to_owned(),
			access_path: self.access_path.clone(),
			body: bytes.to_vec(),
			range: None,
		})?;
		match response.status {
			200..=299 => Ok(PutStatus::Stored),
			409 => Err(ObjectStoreError::ImmutableConflict),
			504 => Ok(PutStatus::Indeterminate),
			_ => Err(ObjectStoreError::Unavailable),
		}
	}

	fn get_range(
		&mut self,
		object_key: &str,
		offset: u64,
		length: u64,
	) -> Result<Vec<u8>, ObjectStoreError> {
		let end = offset
			.checked_add(length)
			.and_then(|exclusive| exclusive.checked_sub(1))
			.ok_or(ObjectStoreError::Corrupt)?;
		let response = self.execute(DataRequest {
			operation: DataOperation::Get,
			bucket: self.bucket.clone(),
			key: object_key.to_owned(),
			access_path: self.access_path.clone(),
			body: Vec::new(),
			range: Some(ByteRange::Inclusive { start: offset, end }),
		})?;
		match response.status {
			200 | 206 => Ok(response.body),
			404 => Err(ObjectStoreError::NotFound),
			409 => Err(ObjectStoreError::Corrupt),
			_ => Err(ObjectStoreError::Unavailable),
		}
	}

	fn delete_exact(&mut self, object_key: &str) -> Result<DeleteStatus, ObjectStoreError> {
		let response = self.execute(DataRequest {
			operation: DataOperation::Delete,
			bucket: self.bucket.clone(),
			key: object_key.to_owned(),
			access_path: self.access_path.clone(),
			body: Vec::new(),
			range: None,
		})?;
		match response.status {
			200..=299 => Ok(DeleteStatus::Deleted),
			404 => Ok(DeleteStatus::NotFound),
			504 => Ok(DeleteStatus::Indeterminate),
			_ => Err(ObjectStoreError::Unavailable),
		}
	}
}

impl EmulatorObjectStore {
	fn execute(&self, request: DataRequest) -> Result<DataResponse, ObjectStoreError> {
		self.emulator
			.lock()
			.map_err(|_| ObjectStoreError::Unavailable)?
			.execute(request)
			.map_err(|error| map_emulator_error(&error))
	}
}

fn map_emulator_error(error: &EmulatorError) -> ObjectStoreError {
	match error {
		EmulatorError::ImmutableConflict => ObjectStoreError::ImmutableConflict,
		EmulatorError::CorruptState | EmulatorError::InvalidArgument(_) => {
			ObjectStoreError::Corrupt
		}
		EmulatorError::Io(_) | EmulatorError::AlreadyOpen => ObjectStoreError::Unavailable,
	}
}

#[cfg(test)]
mod tests {
	use tempfile::tempdir;

	use super::*;

	#[test]
	fn same_provider_root_is_shared_by_concurrent_frontends() {
		let directory = tempdir().unwrap();
		let first = EmulatorObjectStore::open(directory.path()).unwrap();
		let second = EmulatorObjectStore::open(directory.path()).unwrap();
		assert!(Arc::ptr_eq(&first.emulator, &second.emulator));

		drop(first);
		drop(second);
		EmulatorObjectStore::open(directory.path()).unwrap();
	}
}
