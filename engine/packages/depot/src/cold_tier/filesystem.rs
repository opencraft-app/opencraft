use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
	ColdTier, ColdTierError, ColdTierInventoryObject, ColdTierInventoryPage,
	ColdTierObjectMetadata, ColdTierRequestGate, ColdTierRequestPermit, ColdTierResult,
	DEFAULT_MAX_CONCURRENT_REQUESTS, DEFAULT_MAX_OBJECT_SIZE_BYTES, DEFAULT_MAX_QUEUED_REQUESTS,
	DEFAULT_QUEUE_TIMEOUT_MS, FdbWriteDebtPolicy,
};

#[derive(Debug, Clone)]
pub struct FilesystemColdTier {
	root: PathBuf,
	max_object_size_bytes: u64,
	request_gate: ColdTierRequestGate,
	write_debt_policy: FdbWriteDebtPolicy,
}

impl FilesystemColdTier {
	pub fn new(root: impl Into<PathBuf>) -> Self {
		Self::new_bounded(
			root,
			DEFAULT_MAX_OBJECT_SIZE_BYTES,
			DEFAULT_MAX_CONCURRENT_REQUESTS,
		)
		.expect("default cold-tier limits are valid")
	}

	pub fn new_bounded(
		root: impl Into<PathBuf>,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
	) -> anyhow::Result<Self> {
		Self::new_with_admission(
			root,
			max_object_size_bytes,
			max_concurrent_requests,
			DEFAULT_MAX_QUEUED_REQUESTS,
			DEFAULT_QUEUE_TIMEOUT_MS,
		)
	}

	pub fn new_with_admission(
		root: impl Into<PathBuf>,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
		max_queued_requests: usize,
		queue_timeout_ms: u64,
	) -> anyhow::Result<Self> {
		Self::new_with_admission_and_write_debt(
			root,
			max_object_size_bytes,
			max_concurrent_requests,
			max_queued_requests,
			queue_timeout_ms,
			FdbWriteDebtPolicy::default(),
		)
	}

	pub fn new_with_admission_and_write_debt(
		root: impl Into<PathBuf>,
		max_object_size_bytes: u64,
		max_concurrent_requests: usize,
		max_queued_requests: usize,
		queue_timeout_ms: u64,
		write_debt_policy: FdbWriteDebtPolicy,
	) -> anyhow::Result<Self> {
		anyhow::ensure!(
			max_object_size_bytes > 0,
			"max object size must be positive"
		);
		Ok(Self {
			root: root.into(),
			max_object_size_bytes,
			request_gate: ColdTierRequestGate::new(
				max_concurrent_requests,
				max_queued_requests,
				queue_timeout_ms,
			)?,
			write_debt_policy,
		})
	}

	pub fn root(&self) -> &Path {
		&self.root
	}

	fn object_path(&self, key: &str) -> ColdTierResult<PathBuf> {
		validate_object_key(key)?;
		Ok(self.root.join(key))
	}

	fn validate_size(&self, key: &str, size_bytes: u64) -> ColdTierResult<()> {
		if size_bytes > self.max_object_size_bytes {
			return Err(ColdTierError::TooLarge {
				key: key.to_string(),
				actual_bytes: size_bytes,
				max_bytes: self.max_object_size_bytes,
			});
		}
		Ok(())
	}

	async fn permit(
		&self,
		operation: &'static str,
		key: &str,
	) -> ColdTierResult<ColdTierRequestPermit> {
		self.request_gate.acquire(operation, key).await
	}
}

#[async_trait]
impl ColdTier for FilesystemColdTier {
	fn fdb_write_debt_policy(&self) -> FdbWriteDebtPolicy {
		self.write_debt_policy
	}

	async fn put_object(&self, key: &str, bytes: &[u8]) -> ColdTierResult<()> {
		self.validate_size(key, bytes.len() as u64)?;
		let path = self.object_path(key)?;
		let _permit = self.permit("put", key).await?;
		let parent = path.parent().ok_or_else(|| ColdTierError::InvalidKey {
			key: key.to_string(),
			reason: "object has no parent directory",
		})?;
		tokio::fs::create_dir_all(parent)
			.await
			.map_err(|err| backend("create parent directory", key, err))?;

		let file_name = path
			.file_name()
			.and_then(|name| name.to_str())
			.ok_or_else(|| ColdTierError::InvalidKey {
				key: key.to_string(),
				reason: "object filename is not UTF-8",
			})?;
		let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
		let write_result = async {
			let mut file = tokio::fs::File::create(&temporary).await?;
			file.write_all(bytes).await?;
			file.sync_all().await?;
			tokio::fs::rename(&temporary, &path).await
		}
		.await;
		if let Err(err) = write_result {
			let _ = tokio::fs::remove_file(&temporary).await;
			return Err(backend("put object", key, err));
		}

		Ok(())
	}

	async fn get_object(&self, key: &str) -> ColdTierResult<Vec<u8>> {
		let path = self.object_path(key)?;
		let _permit = self.permit("get", key).await?;
		let file = match tokio::fs::File::open(&path).await {
			Ok(file) => file,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
				return Err(ColdTierError::NotFound {
					key: key.to_string(),
				});
			}
			Err(err) => return Err(backend("get object", key, err)),
		};
		let metadata = file
			.metadata()
			.await
			.map_err(|err| backend("read object metadata", key, err))?;
		self.validate_size(key, metadata.len())?;

		let mut bytes = Vec::with_capacity(metadata.len() as usize);
		file.take(self.max_object_size_bytes + 1)
			.read_to_end(&mut bytes)
			.await
			.map_err(|err| backend("read object body", key, err))?;
		self.validate_size(key, bytes.len() as u64)?;
		if bytes.len() as u64 != metadata.len() {
			return Err(ColdTierError::SizeMismatch {
				key: key.to_string(),
				declared_bytes: metadata.len(),
				actual_bytes: bytes.len() as u64,
			});
		}
		Ok(bytes)
	}

	async fn head_object(&self, key: &str) -> ColdTierResult<ColdTierObjectMetadata> {
		let path = self.object_path(key)?;
		let _permit = self.permit("head", key).await?;
		let metadata = match tokio::fs::metadata(path).await {
			Ok(metadata) => metadata,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
				return Err(ColdTierError::NotFound {
					key: key.to_string(),
				});
			}
			Err(err) => return Err(backend("head object", key, err)),
		};
		self.validate_size(key, metadata.len())?;
		Ok(ColdTierObjectMetadata {
			size_bytes: metadata.len(),
			etag: None,
		})
	}

	async fn delete_objects(&self, keys: &[String]) -> ColdTierResult<()> {
		for key in keys {
			let path = self.object_path(key)?;
			let _permit = self.permit("delete", key).await?;
			match tokio::fs::remove_file(path).await {
				Ok(()) => {}
				Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
				Err(err) => return Err(backend("delete object", key, err)),
			}
		}
		Ok(())
	}

	async fn list_inventory_page(
		&self,
		cursor: Option<&str>,
		limit: u16,
	) -> ColdTierResult<ColdTierInventoryPage> {
		if limit == 0 || limit > 1_000 {
			return Err(ColdTierError::InvalidKey {
				key: "<inventory-limit>".to_string(),
				reason: "inventory page limit must be between 1 and 1000",
			});
		}
		let _permit = self.permit("list", cursor.unwrap_or("<start>")).await?;
		let root = self.root.clone();
		let cursor = cursor.map(str::to_string);
		tokio::task::spawn_blocking(move || {
			filesystem_inventory_page(&root, cursor.as_deref(), limit)
		})
		.await
		.map_err(|err| backend("join inventory scan", "<inventory>", err))?
	}
}

fn filesystem_inventory_page(
	root: &Path,
	cursor: Option<&str>,
	limit: u16,
) -> ColdTierResult<ColdTierInventoryPage> {
	fn visit(
		root: &Path,
		directory: &Path,
		objects: &mut Vec<ColdTierInventoryObject>,
	) -> std::io::Result<()> {
		match std::fs::read_dir(directory) {
			Ok(entries) => {
				for entry in entries {
					let entry = entry?;
					let metadata = std::fs::symlink_metadata(entry.path())?;
					if metadata.is_dir() {
						visit(root, &entry.path(), objects)?;
					} else if metadata.is_file() {
						let relative = entry
							.path()
							.strip_prefix(root)
							.expect("visited path is below root")
							.to_string_lossy()
							.replace('\\', "/");
						objects.push(ColdTierInventoryObject {
							key: relative,
							size_bytes: metadata.len(),
							etag: None,
						});
					}
				}
				Ok(())
			}
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(error) => Err(error),
		}
	}

	let mut objects = Vec::new();
	visit(root, root, &mut objects).map_err(|err| backend("list objects", "<inventory>", err))?;
	objects.sort_by(|left, right| left.key.cmp(&right.key));
	if let Some(cursor) = cursor {
		objects.retain(|object| object.key.as_str() > cursor);
	}
	let has_more = objects.len() > usize::from(limit);
	objects.truncate(usize::from(limit));
	let next_cursor = has_more.then(|| {
		objects
			.last()
			.expect("non-empty truncated page")
			.key
			.clone()
	});
	Ok(ColdTierInventoryPage {
		objects,
		next_cursor,
	})
}

pub(super) fn validate_object_key(key: &str) -> ColdTierResult<()> {
	if key.is_empty() {
		return Err(ColdTierError::InvalidKey {
			key: key.to_string(),
			reason: "key must not be empty",
		});
	}
	if key.contains('\\') {
		return Err(ColdTierError::InvalidKey {
			key: key.to_string(),
			reason: "backslash separators are not allowed",
		});
	}
	if key
		.split('/')
		.any(|part| part.is_empty() || part == "." || part == "..")
	{
		return Err(ColdTierError::InvalidKey {
			key: key.to_string(),
			reason: "empty, current, and parent path components are not allowed",
		});
	}
	for component in Path::new(key).components() {
		if !matches!(component, Component::Normal(_)) {
			return Err(ColdTierError::InvalidKey {
				key: key.to_string(),
				reason: "only relative normal path components are allowed",
			});
		}
	}
	Ok(())
}

fn backend(operation: &'static str, key: &str, source: impl Into<anyhow::Error>) -> ColdTierError {
	ColdTierError::Backend {
		operation,
		key: key.to_string(),
		source: source.into(),
	}
}
