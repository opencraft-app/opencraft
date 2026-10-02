//! A fixed, one-queue virtio-blk service for the PVM Linux profile.
//!
//! This crate deliberately owns no VM descriptor and knows nothing about PVM.
//! Its complete untrusted input is one modern virtio-mmio register page and
//! split-virtqueue descriptors in a caller-supplied guest-RAM view. The caller
//! retains ownership of that mapping and must stop this service before unmapping
//! it.

use std::{
	borrow::{Borrow, BorrowMut},
	fmt,
	fs::File,
	io,
	os::{
		fd::{AsRawFd, FromRawFd},
		unix::fs::FileExt,
	},
	ptr::NonNull,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread::{self, JoinHandle},
};

use virtio_bindings::{
	bindings::{
		virtio_blk::{
			VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH, VIRTIO_BLK_F_RO, VIRTIO_BLK_F_SEG_MAX,
			VIRTIO_BLK_F_SIZE_MAX, VIRTIO_BLK_S_IOERR, VIRTIO_BLK_S_OK,
		},
		virtio_config::VIRTIO_F_VERSION_1,
	},
	virtio_mmio::VIRTIO_MMIO_INT_VRING,
};
use virtio_blk::request::{Request, RequestType};
use virtio_device::{
	VirtioConfig, VirtioDeviceActions, VirtioDeviceType,
	status::{DEVICE_NEEDS_RESET, DRIVER_OK},
};
use virtio_queue::{Queue, QueueState, QueueT, desc::split::Descriptor};
use vm_memory::{
	Bytes, GuestAddress, GuestMemoryMmap, GuestRegionCollection, GuestRegionMmap, MmapRegion,
};
use vmm_sys_util::eventfd::{EFD_CLOEXEC, EventFd};

/// Size of the fixed modern virtio-mmio register window.
pub const MMIO_SIZE: u64 = 0x1000;
/// Offset of the queue doorbell inside the MMIO window.
pub const QUEUE_NOTIFY_OFFSET: u64 = 0x50;
/// Maximum number of descriptors offered by the only split virtqueue.
pub const QUEUE_SIZE: u16 = 128;
/// Maximum data descriptors accepted in one block request.
pub const MAX_DATA_SEGMENTS: usize = 32;
/// Maximum bytes transferred by one request.
pub const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
/// Per-descriptor limit chosen so `size_max * seg_max` cannot exceed one request.
pub const MAX_SEGMENT_BYTES: u64 = MAX_REQUEST_BYTES / MAX_DATA_SEGMENTS as u64;
/// Maximum ranges accepted in one discard request.
pub const MAX_DISCARD_SEGMENTS: usize = 32;
const DISCARD_SEGMENT_BYTES: usize = 16;
const SECTOR_BYTES: u64 = 512;
const SECTOR_BYTES_USIZE: usize = 512;

/// Storage operations consumed by the bounded virtio request executor.
///
/// Implementations are not required to expose a file descriptor, seekable
/// file, host path, or NBD endpoint. This boundary lets the PVM product path
/// call a typed storage backend directly.
pub trait BlockBackend: Send + 'static {
	/// Returns the fixed logical capacity in bytes.
	fn size(&self) -> u64;

	/// Reads exactly `length` bytes at `offset`.
	///
	/// # Errors
	///
	/// Returns an I/O error for unavailable, corrupt, fenced, or invalid data.
	fn read_at(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>>;

	/// Writes all bytes at `offset` before returning.
	///
	/// # Errors
	///
	/// Returns an I/O error for unavailable, fenced, or invalid storage.
	fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()>;

	/// Deterministically makes the range read as zero and releases its prior
	/// backing when the storage engine supports sparse reclamation.
	///
	/// # Errors
	///
	/// Returns an I/O error for unavailable, fenced, or invalid storage.
	fn discard(&mut self, offset: u64, length: u64) -> io::Result<()>;

	/// Captures an ordered durability barrier.
	///
	/// # Errors
	///
	/// Returns an I/O error if the submitted cut cannot be made durable.
	fn flush(&mut self) -> io::Result<()>;
}

#[derive(Debug)]
struct FileBlockBackend {
	file: File,
	size: u64,
}

impl FileBlockBackend {
	fn new(file: File) -> Result<Self, Error> {
		let size = file
			.metadata()
			.map_err(|error| Error::Backing(error.to_string()))?
			.len();
		validate_capacity(size)?;
		Ok(Self { file, size })
	}
}

impl BlockBackend for FileBlockBackend {
	fn size(&self) -> u64 {
		self.size
	}

	fn read_at(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
		let mut bytes = vec![0; length];
		self.file.read_exact_at(&mut bytes, offset)?;
		Ok(bytes)
	}

	fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
		self.file.write_all_at(bytes, offset)
	}

	fn flush(&mut self) -> io::Result<()> {
		self.file.sync_data()
	}

	fn discard(&mut self, offset: u64, length: u64) -> io::Result<()> {
		let offset = i64::try_from(offset).map_err(io::Error::other)?;
		let length = i64::try_from(length).map_err(io::Error::other)?;
		// SAFETY: fallocate consumes a live regular-file descriptor and scalar
		// offsets; it does not dereference userspace pointers.
		let result = unsafe {
			libc::fallocate(
				self.file.as_raw_fd(),
				libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE,
				offset,
				length,
			)
		};
		if result == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		if !matches!(
			error.raw_os_error(),
			Some(libc::EOPNOTSUPP | libc::ENOSYS | libc::EINVAL)
		) {
			return Err(error);
		}
		let zeroes = vec![0_u8; 64 * 1024];
		let mut cursor = u64::try_from(offset).map_err(io::Error::other)?;
		let end = cursor
			.checked_add(u64::try_from(length).map_err(io::Error::other)?)
			.ok_or_else(|| io::Error::other("discard range overflow"))?;
		while cursor < end {
			let chunk = usize::try_from((end - cursor).min(zeroes.len() as u64))
				.map_err(io::Error::other)?;
			self.file.write_all_at(&zeroes[..chunk], cursor)?;
			cursor += u64::try_from(chunk).map_err(io::Error::other)?;
		}
		Ok(())
	}
}

const DEVICE_TYPE_BLOCK: u32 = 2;
const WRITABLE_FEATURES: u64 = (1_u64 << VIRTIO_F_VERSION_1)
	| (1_u64 << VIRTIO_BLK_F_SIZE_MAX)
	| (1_u64 << VIRTIO_BLK_F_SEG_MAX)
	| (1_u64 << VIRTIO_BLK_F_FLUSH)
	| (1_u64 << VIRTIO_BLK_F_DISCARD);
const READ_ONLY_FEATURES: u64 = (1_u64 << VIRTIO_F_VERSION_1)
	| (1_u64 << VIRTIO_BLK_F_SIZE_MAX)
	| (1_u64 << VIRTIO_BLK_F_SEG_MAX)
	| (1_u64 << VIRTIO_BLK_F_RO);
const FICLONE_IOCTL: libc::Ioctl = 0x4004_9409;
static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(1);

/// Errors returned while constructing or operating the bounded block service.
#[derive(Debug)]
pub enum Error {
	/// The caller supplied an invalid guest-memory mapping.
	GuestMemory(String),
	/// The backing file is not a usable block image.
	Backing(String),
	/// The virtio queue or saved device state is invalid.
	DeviceState(String),
	/// An eventfd or worker operation failed.
	Worker(io::Error),
	/// The block worker panicked.
	WorkerPanicked,
}

impl fmt::Display for Error {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::GuestMemory(message) => write!(formatter, "invalid guest memory: {message}"),
			Self::Backing(message) => write!(formatter, "invalid block backing: {message}"),
			Self::DeviceState(message) => write!(formatter, "invalid virtio-blk state: {message}"),
			Self::Worker(error) => write!(formatter, "virtio-blk worker failed: {error}"),
			Self::WorkerPanicked => formatter.write_str("virtio-blk worker panicked"),
		}
	}
}

impl std::error::Error for Error {}

/// A fixed interrupt capability supplied by the embedding VMM.
pub trait Interrupt: Send + Sync + 'static {
	/// Notifies the guest that the used ring has advanced.
	///
	/// # Errors
	///
	/// Returns an I/O error when the embedding interrupt capability cannot be
	/// signalled.
	fn notify(&self) -> io::Result<()>;
}

/// How one private block file was derived from its immutable baseline.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloneMethod {
	/// The host filesystem accepted Linux `FICLONE`.
	Reflink,
	/// The filesystem lacked reflink, so only allocated extents were copied.
	SparseExtentCopy,
}

/// A trusted directory capability used to allocate unlinked per-clone files.
#[derive(Clone, Debug)]
pub struct BlockFilePool {
	directory: Arc<File>,
}

impl BlockFilePool {
	/// Wraps an already-open directory used for template and clone files.
	///
	/// # Errors
	///
	/// Returns [`Error::Backing`] unless `directory` identifies a directory.
	pub fn from_directory(directory: File) -> Result<Self, Error> {
		if !directory
			.metadata()
			.map_err(|error| Error::Backing(error.to_string()))?
			.is_dir()
		{
			return Err(Error::Backing(
				"block-file pool descriptor is not a directory".to_owned(),
			));
		}
		Ok(Self {
			directory: Arc::new(directory),
		})
	}

	/// Captures a quiesced writable file into an unlinked pool-local baseline.
	///
	/// # Errors
	///
	/// Returns [`Error::Backing`] if temporary-file allocation, reflink/sparse
	/// copying, or synchronization fails.
	pub fn snapshot(&self, source: &File) -> Result<BlockFileTemplate, Error> {
		let (baseline, method) = self.clone_file(source)?;
		baseline
			.sync_data()
			.map_err(|error| Error::Backing(error.to_string()))?;
		let length = baseline
			.metadata()
			.map_err(|error| Error::Backing(error.to_string()))?
			.len();
		Ok(BlockFileTemplate {
			pool: self.clone(),
			baseline: Arc::new(baseline),
			length,
			snapshot_method: method,
		})
	}

	fn clone_file(&self, source: &File) -> Result<(File, CloneMethod), Error> {
		let metadata = source
			.metadata()
			.map_err(|error| Error::Backing(error.to_string()))?;
		if !metadata.is_file()
			|| metadata.len() == 0
			|| metadata.len() > i64::MAX as u64
			|| !metadata.len().is_multiple_of(512)
		{
			return Err(Error::Backing(
                "clone source must be a nonempty, sector-aligned regular file no larger than i64::MAX"
                    .to_owned(),
            ));
		}
		let destination = create_unlinked_file(self.directory.as_ref())?;
		destination
			.set_len(metadata.len())
			.map_err(|error| Error::Backing(error.to_string()))?;
		// SAFETY: FICLONE consumes two live regular-file descriptors and does
		// not dereference userspace pointers.
		let reflink =
			unsafe { libc::ioctl(destination.as_raw_fd(), FICLONE_IOCTL, source.as_raw_fd()) };
		if reflink == 0 {
			return Ok((destination, CloneMethod::Reflink));
		}
		let error = io::Error::last_os_error();
		if !matches!(
			error.raw_os_error(),
			Some(libc::EOPNOTSUPP | libc::EXDEV | libc::EINVAL | libc::ENOTTY)
		) {
			return Err(Error::Backing(format!("FICLONE failed: {error}")));
		}
		copy_sparse_extents(source, &destination, metadata.len())?;
		Ok((destination, CloneMethod::SparseExtentCopy))
	}
}

/// An unlinked immutable-by-capability block baseline shared by warm clones.
#[derive(Clone, Debug)]
pub struct BlockFileTemplate {
	pool: BlockFilePool,
	baseline: Arc<File>,
	length: u64,
	snapshot_method: CloneMethod,
}

impl BlockFileTemplate {
	/// Creates a unique writable file for one VM clone.
	///
	/// # Errors
	///
	/// Returns [`Error::Backing`] if the pool cannot reflink or sparsely copy
	/// the baseline.
	pub fn instantiate(&self) -> Result<(File, CloneMethod), Error> {
		self.pool.clone_file(self.baseline.as_ref())
	}

	/// Returns how the stopped warm disk was captured into this template.
	#[must_use]
	pub const fn snapshot_method(&self) -> CloneMethod {
		self.snapshot_method
	}

	/// Returns the logical device capacity.
	#[must_use]
	pub const fn len(&self) -> u64 {
		self.length
	}

	/// Returns whether the retained block baseline has zero capacity.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}
}

fn create_unlinked_file(directory: &File) -> Result<File, Error> {
	// SAFETY: openat reads a static NUL-terminated path and returns a new fd.
	let descriptor = unsafe {
		libc::openat(
			directory.as_raw_fd(),
			c".".as_ptr(),
			libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
			0o600,
		)
	};
	if descriptor >= 0 {
		// SAFETY: `descriptor` is newly returned and ownership transfers once.
		return Ok(unsafe { File::from_raw_fd(descriptor) });
	}

	let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
	let name = format!(".minisandbox-block-{}-{sequence}\0", std::process::id());
	// SAFETY: `name` is NUL-terminated and contains no interior NUL; openat
	// creates one private pool-local file with exclusive ownership.
	let descriptor = unsafe {
		libc::openat(
			directory.as_raw_fd(),
			name.as_ptr().cast(),
			libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_CLOEXEC,
			0o600,
		)
	};
	if descriptor < 0 {
		return Err(Error::Backing(format!(
			"create pool-local temporary block file: {}",
			io::Error::last_os_error()
		)));
	}
	// SAFETY: The same trusted directory and just-created unique name are
	// supplied. The fd keeps the inode alive after unlink.
	let unlink_result = unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr().cast(), 0) };
	if unlink_result < 0 {
		// SAFETY: ownership of the newly created fd has not yet moved to File.
		unsafe { libc::close(descriptor) };
		return Err(Error::Backing(format!(
			"unlink pool-local temporary block file: {}",
			io::Error::last_os_error()
		)));
	}
	// SAFETY: `descriptor` is live, unlinked, and transfers ownership once.
	Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn copy_sparse_extents(source: &File, destination: &File, length: u64) -> Result<(), Error> {
	let mut cursor = 0_u64;
	let mut buffer = vec![0_u8; 1024 * 1024];
	while cursor < length {
		// SAFETY: lseek only updates this retained file description's offset.
		let seek_offset = i64::try_from(cursor).expect("validated image offset fits off_t");
		let data = unsafe { libc::lseek(source.as_raw_fd(), seek_offset, libc::SEEK_DATA) };
		if data < 0 {
			let error = io::Error::last_os_error();
			if error.raw_os_error() == Some(libc::ENXIO) {
				break;
			}
			return Err(Error::Backing(format!("SEEK_DATA failed: {error}")));
		}
		// SAFETY: As above, and `data` was returned by the same regular file.
		let hole = unsafe { libc::lseek(source.as_raw_fd(), data, libc::SEEK_HOLE) };
		if hole < 0 {
			return Err(Error::Backing(format!(
				"SEEK_HOLE failed: {}",
				io::Error::last_os_error()
			)));
		}
		let mut offset = u64::try_from(data).expect("nonnegative data offset fits u64");
		let end = u64::try_from(hole)
			.expect("nonnegative hole offset fits u64")
			.min(length);
		while offset < end {
			let count = usize::try_from((end - offset).min(buffer.len() as u64))
				.expect("bounded extent chunk fits usize");
			source
				.read_exact_at(&mut buffer[..count], offset)
				.map_err(|error| Error::Backing(error.to_string()))?;
			destination
				.write_all_at(&buffer[..count], offset)
				.map_err(|error| Error::Backing(error.to_string()))?;
			offset += count as u64;
		}
		cursor = end;
	}
	Ok(())
}

/// A rust-vmm view over RAM whose allocation remains owned by the embedding VMM.
#[derive(Clone)]
pub struct GuestRam {
	memory: Arc<GuestMemoryMmap<()>>,
}

impl fmt::Debug for GuestRam {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.debug_struct("GuestRam").finish_non_exhaustive()
	}
}

impl GuestRam {
	/// Creates a non-owning rust-vmm view over an existing mapping.
	///
	/// # Safety
	///
	/// `pointer..pointer+length` must remain a live, page-aligned mapping with
	/// exactly `protection` and `flags` until every clone of this value and its
	/// block service have been dropped. No host code may perform non-volatile
	/// concurrent accesses to bytes used by the virtqueue worker.
	///
	/// # Errors
	///
	/// Returns [`Error::GuestMemory`] for an empty, overflowing, unaligned, or
	/// otherwise invalid mapping.
	pub unsafe fn from_raw_mapping(
		pointer: NonNull<u8>,
		length: usize,
		protection: i32,
		flags: i32,
	) -> Result<Self, Error> {
		if length == 0 || !length.is_multiple_of(4096) {
			return Err(Error::GuestMemory(
				"length must be a nonzero multiple of 4096".to_owned(),
			));
		}
		// SAFETY: The caller supplies the complete lifetime and mmap contract;
		// MmapRegion is explicitly configured as a non-owning view.
		let mapping =
			unsafe { MmapRegion::<()>::build_raw(pointer.as_ptr(), length, protection, flags) }
				.map_err(|error| Error::GuestMemory(error.to_string()))?;
		let region = GuestRegionMmap::new(mapping, GuestAddress(0)).ok_or_else(|| {
			Error::GuestMemory("GPA zero plus mapping length overflowed".to_owned())
		})?;
		let memory = GuestRegionCollection::from_regions(vec![region])
			.map_err(|error| Error::GuestMemory(error.to_string()))?;
		Ok(Self {
			memory: Arc::new(memory),
		})
	}

	#[cfg(test)]
	fn anonymous(length: usize) -> Result<Self, Error> {
		let memory = GuestMemoryMmap::from_ranges(&[(GuestAddress(0), length)])
			.map_err(|error| Error::GuestMemory(error.to_string()))?;
		Ok(Self {
			memory: Arc::new(memory),
		})
	}
}

/// Host-owned virtio state required to restore a stopped queue.
#[derive(Clone, Debug)]
pub struct BlockState {
	queue: QueueState,
	driver_features: u64,
	device_features_select: u32,
	driver_features_select: u32,
	device_status: u8,
	queue_select: u16,
	config_generation: u8,
	device_activated: bool,
	interrupt_status: u8,
}

struct BlockDevice {
	config: VirtioConfig<Queue>,
	memory: Arc<GuestMemoryMmap<()>>,
	backend: Box<dyn BlockBackend>,
	capacity: u64,
	device_features: u64,
	read_only: bool,
	interrupt: Arc<dyn Interrupt>,
}

impl fmt::Debug for BlockDevice {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("BlockDevice")
			.field("config", &self.config)
			.finish_non_exhaustive()
	}
}

impl Borrow<VirtioConfig<Queue>> for BlockDevice {
	fn borrow(&self) -> &VirtioConfig<Queue> {
		&self.config
	}
}

impl BorrowMut<VirtioConfig<Queue>> for BlockDevice {
	fn borrow_mut(&mut self) -> &mut VirtioConfig<Queue> {
		&mut self.config
	}
}

impl VirtioDeviceType for BlockDevice {
	fn device_type(&self) -> u32 {
		DEVICE_TYPE_BLOCK
	}
}

impl VirtioDeviceActions for BlockDevice {
	type E = Error;

	fn activate(&mut self) -> Result<(), Self::E> {
		if self.config.driver_features & !self.device_features != 0 {
			return Err(Error::DeviceState(
				"driver acknowledged an unadvertised feature".to_owned(),
			));
		}
		if !self.config.queues[0].is_valid(self.memory.as_ref()) {
			return Err(Error::DeviceState(
				"driver supplied an invalid split virtqueue".to_owned(),
			));
		}
		self.config.device_activated = true;
		Ok(())
	}

	fn reset(&mut self) -> Result<(), Self::E> {
		self.config.driver_features = 0;
		self.config.device_features_select = 0;
		self.config.driver_features_select = 0;
		self.config.device_status = 0;
		self.config.queue_select = 0;
		self.config.device_activated = false;
		self.config.interrupt_status.store(0, Ordering::SeqCst);
		self.config.queues[0].reset();
		Ok(())
	}
}

impl virtio_device::VirtioMmioDevice for BlockDevice {}

impl BlockDevice {
	fn new(
		backend: Box<dyn BlockBackend>,
		memory: Arc<GuestMemoryMmap<()>>,
		interrupt: Arc<dyn Interrupt>,
		read_only: bool,
	) -> Result<Self, Error> {
		let capacity = backend.size();
		validate_capacity(capacity)?;
		let queue =
			Queue::new(QUEUE_SIZE).map_err(|error| Error::DeviceState(error.to_string()))?;
		// virtio_blk_config through `unused1`: capacity plus the bounded
		// discard geometry advertised to Linux.
		let mut config_space = vec![0_u8; 60];
		config_space[0..8].copy_from_slice(&(capacity / SECTOR_BYTES).to_le_bytes());
		config_space[8..12].copy_from_slice(
			&u32::try_from(MAX_SEGMENT_BYTES)
				.expect("segment byte bound fits u32")
				.to_le_bytes(),
		);
		config_space[12..16].copy_from_slice(
			&u32::try_from(MAX_DATA_SEGMENTS)
				.expect("segment bound fits u32")
				.to_le_bytes(),
		);
		config_space[36..40].copy_from_slice(
			&u32::try_from(MAX_REQUEST_BYTES / SECTOR_BYTES)
				.expect("discard sector bound fits u32")
				.to_le_bytes(),
		);
		config_space[40..44].copy_from_slice(
			&u32::try_from(MAX_DISCARD_SEGMENTS)
				.expect("discard segment bound fits u32")
				.to_le_bytes(),
		);
		config_space[44..48].copy_from_slice(&8_u32.to_le_bytes());
		let device_features = if read_only {
			READ_ONLY_FEATURES
		} else {
			WRITABLE_FEATURES
		};
		Ok(Self {
			config: VirtioConfig::new(device_features, vec![queue], config_space),
			memory,
			backend,
			capacity,
			device_features,
			read_only,
			interrupt,
		})
	}

	fn process_queue(&mut self) -> Result<usize, Error> {
		if !self.config.device_activated || self.config.device_status & DRIVER_OK == 0 {
			return Ok(0);
		}
		if !self.config.queues[0].is_valid(self.memory.as_ref()) {
			self.config.device_status |= DEVICE_NEEDS_RESET;
			return Err(Error::DeviceState(
				"active split virtqueue no longer validates".to_owned(),
			));
		}

		let mut processed = 0_usize;
		while processed < usize::from(QUEUE_SIZE) {
			let Some(mut chain) =
				self.config.queues[0].pop_descriptor_chain(Arc::clone(&self.memory))
			else {
				break;
			};
			let head = chain.head_index();
			if !self.direct_chain_is_bounded(head) {
				self.config.device_status |= DEVICE_NEEDS_RESET;
				self.config.queues[0]
					.add_used(self.memory.as_ref(), head, 0)
					.map_err(|error| Error::DeviceState(error.to_string()))?;
				processed += 1;
				break;
			}
			let used_length = match Request::parse(&mut chain) {
				Ok(request) if self.request_within_policy(&request) => {
					self.process_request(&request)
				}
				Ok(request) => {
					let status =
						u8::try_from(VIRTIO_BLK_S_IOERR).expect("virtio block status is one byte");
					let _ = self.memory.write_obj(status, request.status_addr());
					1
				}
				Err(_) => 0,
			};
			self.config.queues[0]
				.add_used(self.memory.as_ref(), head, used_length)
				.map_err(|error| Error::DeviceState(error.to_string()))?;
			processed += 1;
		}

		if processed != 0 {
			let interrupt = u8::try_from(VIRTIO_MMIO_INT_VRING)
				.expect("virtio MMIO interrupt bits fit one byte");
			self.config
				.interrupt_status
				.fetch_or(interrupt, Ordering::SeqCst);
			self.interrupt.notify().map_err(Error::Worker)?;
		}
		Ok(processed)
	}

	fn process_request(&mut self, request: &Request) -> u32 {
		let result = self.execute_request(request);
		let (status, written) = match result {
			Ok(written) => (
				u8::try_from(VIRTIO_BLK_S_OK).expect("virtio block status is one byte"),
				written,
			),
			Err(error) => {
				log::warn!("virtio-blk request failed: {error}");
				(
					u8::try_from(VIRTIO_BLK_S_IOERR).expect("virtio block status is one byte"),
					0,
				)
			}
		};
		if self
			.memory
			.write_obj(status, request.status_addr())
			.is_err()
		{
			return 0;
		}
		written.checked_add(1).unwrap_or(0)
	}

	fn execute_request(&mut self, request: &Request) -> io::Result<u32> {
		let total = usize::try_from(request.total_data_len())
			.map_err(|_| io::Error::other("request length does not fit usize"))?;
		if matches!(request.request_type(), RequestType::In | RequestType::Out)
			&& !total.is_multiple_of(SECTOR_BYTES_USIZE)
		{
			return Err(io::Error::other("request length is not sector aligned"));
		}
		let offset = if matches!(request.request_type(), RequestType::In | RequestType::Out) {
			let offset = request
				.sector()
				.checked_mul(SECTOR_BYTES)
				.ok_or_else(|| io::Error::other("request offset overflow"))?;
			offset
				.checked_add(u64::try_from(total).map_err(|_| io::Error::other("length overflow"))?)
				.filter(|end| *end <= self.capacity)
				.ok_or_else(|| io::Error::other("request exceeds block capacity"))?;
			offset
		} else {
			0
		};

		match request.request_type() {
			RequestType::In => {
				let bytes = self.backend.read_at(offset, total)?;
				if bytes.len() != total {
					return Err(io::Error::other("backend returned a short read"));
				}
				let mut cursor = 0_usize;
				for (address, length) in request.data() {
					let length = usize::try_from(*length)
						.map_err(|_| io::Error::other("descriptor length overflow"))?;
					let next = cursor
						.checked_add(length)
						.ok_or_else(|| io::Error::other("descriptor length overflow"))?;
					self.memory
						.write_slice(
							bytes
								.get(cursor..next)
								.ok_or_else(|| io::Error::other("descriptor exceeds read"))?,
							*address,
						)
						.map_err(io::Error::other)?;
					cursor = next;
				}
				u32::try_from(total).map_err(|_| io::Error::other("used length overflow"))
			}
			RequestType::Out => {
				let mut bytes = vec![0_u8; total];
				let mut cursor = 0_usize;
				for (address, length) in request.data() {
					let length = usize::try_from(*length)
						.map_err(|_| io::Error::other("descriptor length overflow"))?;
					let next = cursor
						.checked_add(length)
						.ok_or_else(|| io::Error::other("descriptor length overflow"))?;
					self.memory
						.read_slice(
							bytes
								.get_mut(cursor..next)
								.ok_or_else(|| io::Error::other("descriptor exceeds write"))?,
							*address,
						)
						.map_err(io::Error::other)?;
					cursor = next;
				}
				self.backend.write_at(offset, &bytes)?;
				Ok(0)
			}
			RequestType::Flush if total == 0 => {
				self.backend.flush()?;
				Ok(0)
			}
			RequestType::Discard => {
				self.execute_discard(request, total)?;
				Ok(0)
			}
			_ => Err(io::Error::other("unsupported virtio-blk request")),
		}
	}

	fn execute_discard(&mut self, request: &Request, total: usize) -> io::Result<()> {
		if total == 0
			|| !total.is_multiple_of(DISCARD_SEGMENT_BYTES)
			|| total / DISCARD_SEGMENT_BYTES > MAX_DISCARD_SEGMENTS
		{
			return Err(io::Error::other("invalid discard segment count"));
		}
		let mut bytes = vec![0_u8; total];
		let mut cursor = 0_usize;
		for (address, length) in request.data() {
			let length = usize::try_from(*length)
				.map_err(|_| io::Error::other("discard descriptor length overflow"))?;
			let next = cursor
				.checked_add(length)
				.ok_or_else(|| io::Error::other("discard descriptor length overflow"))?;
			self.memory
				.read_slice(
					bytes
						.get_mut(cursor..next)
						.ok_or_else(|| io::Error::other("discard descriptor exceeds request"))?,
					*address,
				)
				.map_err(io::Error::other)?;
			cursor = next;
		}
		let max_sectors = MAX_REQUEST_BYTES / SECTOR_BYTES;
		let mut ranges = Vec::with_capacity(total / DISCARD_SEGMENT_BYTES);
		for segment in bytes.chunks_exact(DISCARD_SEGMENT_BYTES) {
			let sector = u64::from_le_bytes(segment[0..8].try_into().expect("fixed slice"));
			let sectors = u64::from(u32::from_le_bytes(
				segment[8..12].try_into().expect("fixed slice"),
			));
			let flags = u32::from_le_bytes(segment[12..16].try_into().expect("fixed slice"));
			if sectors == 0 || sectors > max_sectors || flags != 0 {
				return Err(io::Error::other("invalid discard segment"));
			}
			let offset = sector
				.checked_mul(SECTOR_BYTES)
				.ok_or_else(|| io::Error::other("discard offset overflow"))?;
			let length = sectors
				.checked_mul(SECTOR_BYTES)
				.ok_or_else(|| io::Error::other("discard length overflow"))?;
			offset
				.checked_add(length)
				.filter(|end| *end <= self.capacity)
				.ok_or_else(|| io::Error::other("discard exceeds block capacity"))?;
			ranges.push((offset, length));
		}
		// Validate the complete untrusted request before allowing any backend
		// side effect. A malformed later segment must not partially discard
		// earlier ranges.
		if !self.read_only {
			for (offset, length) in ranges {
				self.backend.discard(offset, length)?;
			}
		}
		Ok(())
	}

	fn flush_backend(&mut self) -> Result<(), Error> {
		self.backend
			.flush()
			.map_err(|error| Error::Backing(error.to_string()))
	}

	fn direct_chain_is_bounded(&self, head: u16) -> bool {
		let queue = &self.config.queues[0];
		let queue_size = queue.size();
		let mut index = head;
		for _ in 0..queue_size {
			if index >= queue_size {
				return false;
			}
			let Some(address) = queue.desc_table().checked_add(
				u64::from(index)
					* u64::try_from(std::mem::size_of::<Descriptor>())
						.expect("descriptor size fits u64"),
			) else {
				return false;
			};
			let Ok(descriptor) = self.memory.read_obj::<Descriptor>(GuestAddress(address)) else {
				return false;
			};
			// Indirect descriptors are deliberately not advertised. Rejecting
			// them here also keeps Request::parse from allocating for an
			// untrusted table with up to u16::MAX entries.
			if descriptor.refers_to_indirect_table() {
				return false;
			}
			if !descriptor.has_next() {
				return true;
			}
			index = descriptor.next();
		}
		false
	}

	fn snapshot(&self) -> BlockState {
		BlockState {
			queue: self.config.queues[0].state(),
			driver_features: self.config.driver_features,
			device_features_select: self.config.device_features_select,
			driver_features_select: self.config.driver_features_select,
			device_status: self.config.device_status,
			queue_select: self.config.queue_select,
			config_generation: self.config.config_generation,
			device_activated: self.config.device_activated,
			interrupt_status: self.config.interrupt_status.load(Ordering::SeqCst),
		}
	}

	fn restore(&mut self, state: &BlockState) -> Result<(), Error> {
		if state.driver_features & !self.device_features != 0 || state.queue_select != 0 {
			return Err(Error::DeviceState(
				"saved features or queue selection are unsupported".to_owned(),
			));
		}
		let queue =
			Queue::try_from(state.queue).map_err(|error| Error::DeviceState(error.to_string()))?;
		if queue.max_size() != QUEUE_SIZE
			|| (queue.ready() && !queue.is_valid(self.memory.as_ref()))
			|| state.device_activated != (state.device_status & DRIVER_OK != 0)
		{
			return Err(Error::DeviceState(
				"saved queue or activation state is inconsistent".to_owned(),
			));
		}
		self.config.queues[0] = queue;
		self.config.driver_features = state.driver_features;
		self.config.device_features_select = state.device_features_select;
		self.config.driver_features_select = state.driver_features_select;
		self.config.device_status = state.device_status;
		self.config.queue_select = state.queue_select;
		self.config.config_generation = state.config_generation;
		self.config.device_activated = state.device_activated;
		self.config
			.interrupt_status
			.store(state.interrupt_status, Ordering::SeqCst);
		Ok(())
	}
	fn request_within_policy(&self, request: &Request) -> bool {
		let operation_allowed = if self.read_only {
			matches!(request.request_type(), RequestType::In)
		} else {
			matches!(
				request.request_type(),
				RequestType::In | RequestType::Out | RequestType::Flush | RequestType::Discard
			)
		};
		operation_allowed
			&& request.data().len() <= MAX_DATA_SEGMENTS
			&& request.total_data_len() <= MAX_REQUEST_BYTES
	}
}

fn validate_capacity(capacity: u64) -> Result<(), Error> {
	if capacity == 0 || capacity > i64::MAX as u64 || !capacity.is_multiple_of(512) {
		return Err(Error::Backing(
			"block capacity must be a nonzero multiple of 512 no larger than i64::MAX".to_owned(),
		));
	}
	Ok(())
}

/// One persistent worker, MMIO register page, and block backend.
pub struct BlockService {
	device: Arc<Mutex<BlockDevice>>,
	kick: Arc<EventFd>,
	paused: Arc<AtomicBool>,
	stopping: Arc<AtomicBool>,
	legacy_file: Option<File>,
	worker: Option<JoinHandle<()>>,
}

impl fmt::Debug for BlockService {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("BlockService")
			.finish_non_exhaustive()
	}
}

impl BlockService {
	/// Opens a fixed modern virtio-blk device over `file` and starts one worker.
	///
	/// # Errors
	///
	/// Returns [`Error`] if the backing, queue, eventfd, or worker cannot be
	/// initialized.
	pub fn new(
		file: File,
		memory: &GuestRam,
		interrupt: Arc<dyn Interrupt>,
	) -> Result<Self, Error> {
		let legacy_file = file
			.try_clone()
			.map_err(|error| Error::Backing(error.to_string()))?;
		let backend = Box::new(FileBlockBackend::new(file)?);
		Self::with_backend_and_legacy_file(backend, memory, interrupt, Some(legacy_file), false)
	}

	/// Opens a host-enforced read-only virtio-blk device over `file`.
	///
	/// The device advertises `VIRTIO_BLK_F_RO` and the request parser rejects
	/// writes and flushes before they reach the backend. Validated DISCARD is
	/// an advisory no-op and cannot mutate the immutable backing file.
	pub fn new_read_only(
		file: File,
		memory: &GuestRam,
		interrupt: Arc<dyn Interrupt>,
	) -> Result<Self, Error> {
		let legacy_file = file
			.try_clone()
			.map_err(|error| Error::Backing(error.to_string()))?;
		let backend = Box::new(FileBlockBackend::new(file)?);
		Self::with_backend_and_legacy_file(backend, memory, interrupt, Some(legacy_file), true)
	}

	/// Starts a fixed modern virtio-blk device over an opaque storage engine.
	///
	/// No file descriptor, host path, NBD device, or seekable image is required
	/// by this entry point.
	///
	/// # Errors
	///
	/// Returns [`Error`] if capacity, queue, eventfd, or worker setup fails.
	pub fn with_backend(
		backend: Box<dyn BlockBackend>,
		memory: &GuestRam,
		interrupt: Arc<dyn Interrupt>,
	) -> Result<Self, Error> {
		Self::with_backend_and_legacy_file(backend, memory, interrupt, None, false)
	}

	/// Starts a host-enforced read-only virtio-blk device over an opaque backend.
	pub fn with_read_only_backend(
		backend: Box<dyn BlockBackend>,
		memory: &GuestRam,
		interrupt: Arc<dyn Interrupt>,
	) -> Result<Self, Error> {
		Self::with_backend_and_legacy_file(backend, memory, interrupt, None, true)
	}

	fn with_backend_and_legacy_file(
		backend: Box<dyn BlockBackend>,
		memory: &GuestRam,
		interrupt: Arc<dyn Interrupt>,
		legacy_file: Option<File>,
		read_only: bool,
	) -> Result<Self, Error> {
		let device = Arc::new(Mutex::new(BlockDevice::new(
			backend,
			Arc::clone(&memory.memory),
			interrupt,
			read_only,
		)?));
		let kick = Arc::new(EventFd::new(EFD_CLOEXEC).map_err(Error::Worker)?);
		let paused = Arc::new(AtomicBool::new(false));
		let stopping = Arc::new(AtomicBool::new(false));
		let worker = spawn_worker(
			Arc::clone(&device),
			Arc::clone(&kick),
			Arc::clone(&paused),
			Arc::clone(&stopping),
		)?;
		Ok(Self {
			device,
			kick,
			paused,
			stopping,
			legacy_file,
			worker: Some(worker),
		})
	}

	/// Returns the eventfd registered on the queue-notify MMIO address.
	#[must_use]
	pub fn kick_event(&self) -> &EventFd {
		&self.kick
	}

	/// Returns whether `address` lies inside this device's fixed MMIO page.
	#[must_use]
	pub fn contains(mmio_base: u64, address: u64) -> bool {
		address
			.checked_sub(mmio_base)
			.is_some_and(|offset| offset < MMIO_SIZE)
	}

	/// Services one MMIO read while the vCPU is stopped.
	pub fn mmio_read(&self, offset: u64, data: &mut [u8]) {
		data.fill(0);
		let device = self
			.device
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		virtio_device::VirtioMmioDevice::read(&*device, offset, data);
	}

	/// Services one MMIO write while the vCPU is stopped.
	///
	/// Queue-notify normally bypasses this path through KVM ioeventfd. Calling
	/// it here as well supplies a correct fallback for providers that still
	/// return the doorbell as a userspace MMIO exit.
	pub fn mmio_write(&self, offset: u64, data: &[u8]) {
		{
			let mut device = self
				.device
				.lock()
				.unwrap_or_else(std::sync::PoisonError::into_inner);
			virtio_device::VirtioMmioDevice::write(&mut *device, offset, data);
		}
		if offset == QUEUE_NOTIFY_OFFSET && data == 0_u32.to_le_bytes() {
			let _ = self.kick.write(1);
		}
	}

	/// Drains all stopped-guest requests, syncs the backing, and freezes the worker.
	///
	/// # Errors
	///
	/// Returns [`Error`] for an invalid queue, failed request processing, or
	/// backing sync failure.
	pub fn quiesce_and_snapshot(&self) -> Result<BlockState, Error> {
		self.paused.store(true, Ordering::SeqCst);
		let mut device = self
			.device
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		device.process_queue()?;
		device.flush_backend()?;
		Ok(device.snapshot())
	}

	/// Restores a validated stopped state and enables queue processing.
	///
	/// # Errors
	///
	/// Returns [`Error::DeviceState`] when the saved state does not fit this
	/// fixed device or the current guest-RAM view.
	pub fn restore_and_resume(&self, state: &BlockState) -> Result<(), Error> {
		let mut device = self
			.device
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner);
		device.restore(state)?;
		self.paused.store(false, Ordering::SeqCst);
		Ok(())
	}

	/// Clones the quiesced backend descriptor for host-side template capture.
	///
	/// # Errors
	///
	/// Returns [`Error::DeviceState`] unless the worker is paused, or
	/// [`Error::Backing`] when descriptor duplication fails.
	pub fn quiesced_backing(&self) -> Result<File, Error> {
		if !self.paused.load(Ordering::SeqCst) {
			return Err(Error::DeviceState(
				"block backing requested before device quiesce".to_owned(),
			));
		}
		self.legacy_file
			.as_ref()
			.ok_or_else(|| {
				Error::DeviceState(
					"opaque block backend has no file descriptor to duplicate".to_owned(),
				)
			})?
			.try_clone()
			.map_err(|error| Error::Backing(error.to_string()))
	}
}

impl Drop for BlockService {
	fn drop(&mut self) {
		self.stopping.store(true, Ordering::SeqCst);
		let _ = self.kick.write(1);
		if let Some(worker) = self.worker.take() {
			let _ = worker.join();
		}
	}
}

fn spawn_worker(
	device: Arc<Mutex<BlockDevice>>,
	kick: Arc<EventFd>,
	paused: Arc<AtomicBool>,
	stopping: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, Error> {
	thread::Builder::new()
		.name("pvm-virtio-blk".to_owned())
		.spawn(move || {
			loop {
				if kick.read().is_err() || stopping.load(Ordering::SeqCst) {
					break;
				}
				let mut device = device
					.lock()
					.unwrap_or_else(std::sync::PoisonError::into_inner);
				if !paused.load(Ordering::SeqCst) {
					let _ = device.process_queue();
				}
			}
		})
		.map_err(Error::Worker)
}

#[cfg(test)]
mod tests {
	use std::{
		fs::OpenOptions,
		sync::atomic::AtomicUsize,
		time::{Duration, Instant},
	};

	use tempfile::tempdir;
	use virtio_bindings::{
		bindings::virtio_blk::{VIRTIO_BLK_F_RO, VIRTIO_BLK_T_OUT},
		virtio_mmio::*,
	};
	use vm_memory::Bytes;

	use super::*;

	#[derive(Default)]
	struct TestInterrupt(AtomicUsize);

	impl Interrupt for TestInterrupt {
		fn notify(&self) -> io::Result<()> {
			self.0.fetch_add(1, Ordering::SeqCst);
			Ok(())
		}
	}

	struct MemoryBackend {
		bytes: Arc<Mutex<Vec<u8>>>,
		flushes: Arc<AtomicUsize>,
	}

	impl BlockBackend for MemoryBackend {
		fn size(&self) -> u64 {
			self.bytes.lock().unwrap().len() as u64
		}

		fn read_at(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
			let offset = usize::try_from(offset).map_err(io::Error::other)?;
			let end = offset
				.checked_add(length)
				.ok_or_else(|| io::Error::other("memory backend range overflow"))?;
			self.bytes
				.lock()
				.unwrap()
				.get(offset..end)
				.map(<[u8]>::to_vec)
				.ok_or_else(|| io::Error::other("memory backend range exceeds capacity"))
		}

		fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
			let offset = usize::try_from(offset).map_err(io::Error::other)?;
			let end = offset
				.checked_add(bytes.len())
				.ok_or_else(|| io::Error::other("memory backend range overflow"))?;
			self.bytes
				.lock()
				.unwrap()
				.get_mut(offset..end)
				.ok_or_else(|| io::Error::other("memory backend range exceeds capacity"))?
				.copy_from_slice(bytes);
			Ok(())
		}

		fn discard(&mut self, offset: u64, length: u64) -> io::Result<()> {
			let offset = usize::try_from(offset).map_err(io::Error::other)?;
			let length = usize::try_from(length).map_err(io::Error::other)?;
			let end = offset
				.checked_add(length)
				.ok_or_else(|| io::Error::other("memory backend range overflow"))?;
			self.bytes
				.lock()
				.unwrap()
				.get_mut(offset..end)
				.ok_or_else(|| io::Error::other("memory backend range exceeds capacity"))?
				.fill(0);
			Ok(())
		}

		fn flush(&mut self) -> io::Result<()> {
			self.flushes.fetch_add(1, Ordering::SeqCst);
			Ok(())
		}
	}

	fn write_u32(service: &BlockService, offset: u32, value: u32) {
		service.mmio_write(u64::from(offset), &value.to_le_bytes());
	}

	fn configure(service: &BlockService, memory: &GuestRam) {
		configure_with_features(
			service,
			memory,
			(1 << VIRTIO_BLK_F_FLUSH) | (1 << VIRTIO_BLK_F_DISCARD),
		);
	}

	fn configure_with_features(service: &BlockService, memory: &GuestRam, features: u32) {
		write_u32(service, VIRTIO_MMIO_STATUS, 1);
		write_u32(service, VIRTIO_MMIO_STATUS, 3);
		write_u32(service, VIRTIO_MMIO_DRIVER_FEATURES_SEL, 0);
		write_u32(service, VIRTIO_MMIO_DRIVER_FEATURES, features);
		write_u32(service, VIRTIO_MMIO_DRIVER_FEATURES_SEL, 1);
		write_u32(service, VIRTIO_MMIO_DRIVER_FEATURES, 1);
		write_u32(service, VIRTIO_MMIO_STATUS, 11);
		write_u32(service, VIRTIO_MMIO_QUEUE_SEL, 0);
		write_u32(service, VIRTIO_MMIO_QUEUE_NUM, 8);
		write_u32(service, VIRTIO_MMIO_QUEUE_DESC_LOW, 0x1000);
		write_u32(service, VIRTIO_MMIO_QUEUE_AVAIL_LOW, 0x2000);
		write_u32(service, VIRTIO_MMIO_QUEUE_USED_LOW, 0x3000);
		write_u32(service, VIRTIO_MMIO_QUEUE_READY, 1);
		write_u32(service, VIRTIO_MMIO_STATUS, 15);

		let mem = memory.memory.as_ref();
		let descriptor = |address: u64, length: u32, flags: u16, next: u16| {
			let mut bytes = [0_u8; 16];
			bytes[0..8].copy_from_slice(&address.to_le_bytes());
			bytes[8..12].copy_from_slice(&length.to_le_bytes());
			bytes[12..14].copy_from_slice(&flags.to_le_bytes());
			bytes[14..16].copy_from_slice(&next.to_le_bytes());
			bytes
		};
		mem.write_slice(&descriptor(0x4000, 16, 1, 1), GuestAddress(0x1000))
			.unwrap();
		mem.write_slice(&descriptor(0x5000, 512, 1, 2), GuestAddress(0x1010))
			.unwrap();
		mem.write_slice(&descriptor(0x6000, 1, 2, 0), GuestAddress(0x1020))
			.unwrap();
		let mut header = [0_u8; 16];
		header[0..4].copy_from_slice(&VIRTIO_BLK_T_OUT.to_le_bytes());
		mem.write_slice(&header, GuestAddress(0x4000)).unwrap();
		mem.write_slice(&[0x5a; 512], GuestAddress(0x5000)).unwrap();
		mem.write_obj(0_u16, GuestAddress(0x2000)).unwrap();
		mem.write_obj(1_u16, GuestAddress(0x2002)).unwrap();
		mem.write_obj(0_u16, GuestAddress(0x2004)).unwrap();
		mem.write_obj(0xff_u8, GuestAddress(0x6000)).unwrap();
	}

	#[test]
	fn modern_mmio_write_reaches_backing_file() {
		let directory = tempdir().unwrap();
		let path = directory.path().join("upper.ext4");
		let file = OpenOptions::new()
			.create(true)
			.truncate(true)
			.read(true)
			.write(true)
			.open(&path)
			.unwrap();
		file.set_len(1024 * 1024).unwrap();
		let memory = GuestRam::anonymous(0x10_000).unwrap();
		let interrupt = Arc::new(TestInterrupt::default());
		let service = BlockService::new(file, &memory, interrupt.clone()).unwrap();

		let mut value = [0_u8; 4];
		service.mmio_read(u64::from(VIRTIO_MMIO_MAGIC_VALUE), &mut value);
		assert_eq!(u32::from_le_bytes(value), 0x7472_6976);
		service.mmio_read(u64::from(VIRTIO_MMIO_VERSION), &mut value);
		assert_eq!(u32::from_le_bytes(value), 2);
		service.mmio_read(u64::from(VIRTIO_MMIO_CONFIG) + 8, &mut value);
		assert_eq!(u64::from(u32::from_le_bytes(value)), MAX_SEGMENT_BYTES);
		service.mmio_read(u64::from(VIRTIO_MMIO_CONFIG) + 12, &mut value);
		assert_eq!(u32::from_le_bytes(value), MAX_DATA_SEGMENTS as u32);

		configure(&service, &memory);
		service.mmio_write(QUEUE_NOTIFY_OFFSET, &0_u32.to_le_bytes());
		let deadline = Instant::now() + Duration::from_secs(1);
		while memory.memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() != 1
			|| interrupt.0.load(Ordering::SeqCst) == 0
		{
			assert!(Instant::now() < deadline, "block worker did not complete");
			thread::yield_now();
		}

		assert_eq!(
			memory.memory.read_obj::<u8>(GuestAddress(0x6000)).unwrap(),
			0
		);
		assert_ne!(interrupt.0.load(Ordering::SeqCst), 0);
		let bytes = std::fs::read(path).unwrap();
		assert_eq!(&bytes[..512], &[0x5a; 512]);
	}

	#[test]
	fn opaque_backend_needs_no_block_file_or_descriptor() {
		let bytes = Arc::new(Mutex::new(vec![0_u8; 1024 * 1024]));
		let flushes = Arc::new(AtomicUsize::new(0));
		let backend = MemoryBackend {
			bytes: Arc::clone(&bytes),
			flushes: Arc::clone(&flushes),
		};
		let memory = GuestRam::anonymous(0x10_000).unwrap();
		let interrupt = Arc::new(TestInterrupt::default());
		let service =
			BlockService::with_backend(Box::new(backend), &memory, interrupt.clone()).unwrap();

		configure(&service, &memory);
		service.mmio_write(QUEUE_NOTIFY_OFFSET, &0_u32.to_le_bytes());
		let deadline = Instant::now() + Duration::from_secs(1);
		while memory.memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() != 1 {
			assert!(Instant::now() < deadline, "block worker did not complete");
			thread::yield_now();
		}

		assert_eq!(&bytes.lock().unwrap()[..512], &[0x5a; 512]);
		assert_eq!(
			memory.memory.read_obj::<u8>(GuestAddress(0x6000)).unwrap(),
			0
		);
		service.quiesce_and_snapshot().unwrap();
		assert_ne!(flushes.load(Ordering::SeqCst), 0);
		assert!(matches!(
			service.quiesced_backing(),
			Err(Error::DeviceState(_))
		));
	}

	#[test]
	fn read_only_backend_advertises_ro_and_rejects_write_before_backend() {
		let bytes = Arc::new(Mutex::new(vec![0_u8; 1024 * 1024]));
		let backend = MemoryBackend {
			bytes: Arc::clone(&bytes),
			flushes: Arc::new(AtomicUsize::new(0)),
		};
		let memory = GuestRam::anonymous(0x10_000).unwrap();
		let service = BlockService::with_read_only_backend(
			Box::new(backend),
			&memory,
			Arc::new(TestInterrupt::default()),
		)
		.unwrap();

		let mut features = [0_u8; 4];
		service.mmio_read(u64::from(VIRTIO_MMIO_DEVICE_FEATURES), &mut features);
		let features = u32::from_le_bytes(features);
		assert_ne!(features & (1 << VIRTIO_BLK_F_RO), 0);
		assert_eq!(features & (1 << VIRTIO_BLK_F_FLUSH), 0);
		assert_eq!(features & (1 << VIRTIO_BLK_F_DISCARD), 0);

		configure_with_features(&service, &memory, 1 << VIRTIO_BLK_F_RO);
		service.mmio_write(QUEUE_NOTIFY_OFFSET, &0_u32.to_le_bytes());
		let deadline = Instant::now() + Duration::from_secs(1);
		while memory.memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() != 1 {
			assert!(Instant::now() < deadline, "block worker did not complete");
			thread::yield_now();
		}
		assert_eq!(
			memory.memory.read_obj::<u8>(GuestAddress(0x6000)).unwrap(),
			u8::try_from(VIRTIO_BLK_S_IOERR).unwrap()
		);
		assert_eq!(&bytes.lock().unwrap()[..512], &[0; 512]);
	}

	#[test]
	fn discard_reaches_opaque_backend_and_returns_deterministic_zeroes() {
		let bytes = Arc::new(Mutex::new(vec![0x5a_u8; 1024 * 1024]));
		let backend = MemoryBackend {
			bytes: Arc::clone(&bytes),
			flushes: Arc::new(AtomicUsize::new(0)),
		};
		let memory = GuestRam::anonymous(0x10_000).unwrap();
		let service = BlockService::with_backend(
			Box::new(backend),
			&memory,
			Arc::new(TestInterrupt::default()),
		)
		.unwrap();

		configure(&service, &memory);
		let mem = memory.memory.as_ref();
		let mut header = [0_u8; 16];
		header[0..4].copy_from_slice(
			&virtio_bindings::bindings::virtio_blk::VIRTIO_BLK_T_DISCARD.to_le_bytes(),
		);
		mem.write_slice(&header, GuestAddress(0x4000)).unwrap();
		let mut segment = [0_u8; DISCARD_SEGMENT_BYTES];
		segment[0..8].copy_from_slice(&8_u64.to_le_bytes());
		segment[8..12].copy_from_slice(&8_u32.to_le_bytes());
		mem.write_slice(&segment, GuestAddress(0x5000)).unwrap();
		mem.write_obj(
			u32::try_from(DISCARD_SEGMENT_BYTES).unwrap(),
			GuestAddress(0x1018),
		)
		.unwrap();

		service.mmio_write(QUEUE_NOTIFY_OFFSET, &0_u32.to_le_bytes());
		let deadline = Instant::now() + Duration::from_secs(1);
		while mem.read_obj::<u16>(GuestAddress(0x3002)).unwrap() != 1 {
			assert!(Instant::now() < deadline, "discard did not complete");
			thread::yield_now();
		}

		let bytes = bytes.lock().unwrap();
		assert_eq!(&bytes[..4096], &[0x5a; 4096]);
		assert_eq!(&bytes[4096..8192], &[0; 4096]);
		assert!(bytes[8192..].iter().all(|byte| *byte == 0x5a));
		assert_eq!(mem.read_obj::<u8>(GuestAddress(0x6000)).unwrap(), 0);
	}

	#[test]
	fn invalid_later_discard_segment_has_no_partial_side_effect() {
		let bytes = Arc::new(Mutex::new(vec![0x5a_u8; 1024 * 1024]));
		let backend = MemoryBackend {
			bytes: Arc::clone(&bytes),
			flushes: Arc::new(AtomicUsize::new(0)),
		};
		let memory = GuestRam::anonymous(0x10_000).unwrap();
		let service = BlockService::with_backend(
			Box::new(backend),
			&memory,
			Arc::new(TestInterrupt::default()),
		)
		.unwrap();

		configure(&service, &memory);
		let mem = memory.memory.as_ref();
		let mut header = [0_u8; 16];
		header[0..4].copy_from_slice(
			&virtio_bindings::bindings::virtio_blk::VIRTIO_BLK_T_DISCARD.to_le_bytes(),
		);
		mem.write_slice(&header, GuestAddress(0x4000)).unwrap();
		let mut segments = [0_u8; DISCARD_SEGMENT_BYTES * 2];
		segments[0..8].copy_from_slice(&8_u64.to_le_bytes());
		segments[8..12].copy_from_slice(&8_u32.to_le_bytes());
		segments[16..24].copy_from_slice(&16_u64.to_le_bytes());
		segments[24..28].copy_from_slice(&8_u32.to_le_bytes());
		segments[28..32].copy_from_slice(&1_u32.to_le_bytes());
		mem.write_slice(&segments, GuestAddress(0x5000)).unwrap();
		mem.write_obj(u32::try_from(segments.len()).unwrap(), GuestAddress(0x1018))
			.unwrap();

		service.mmio_write(QUEUE_NOTIFY_OFFSET, &0_u32.to_le_bytes());
		let deadline = Instant::now() + Duration::from_secs(1);
		while mem.read_obj::<u16>(GuestAddress(0x3002)).unwrap() != 1 {
			assert!(Instant::now() < deadline, "discard did not complete");
			thread::yield_now();
		}

		assert!(bytes.lock().unwrap().iter().all(|byte| *byte == 0x5a));
		assert_eq!(
			mem.read_obj::<u8>(GuestAddress(0x6000)).unwrap(),
			u8::try_from(VIRTIO_BLK_S_IOERR).unwrap()
		);
	}

	#[test]
	fn stopped_state_round_trips_after_queue_drain() {
		let directory = tempdir().unwrap();
		let path = directory.path().join("upper.ext4");
		let file = OpenOptions::new()
			.create(true)
			.truncate(true)
			.read(true)
			.write(true)
			.open(&path)
			.unwrap();
		file.set_len(1024 * 1024).unwrap();
		let memory = GuestRam::anonymous(0x10_000).unwrap();
		let service = BlockService::new(file, &memory, Arc::new(TestInterrupt::default())).unwrap();
		configure(&service, &memory);
		let state = service.quiesce_and_snapshot().unwrap();
		service.restore_and_resume(&state).unwrap();
		assert_eq!(state.queue.next_avail, 1);
		assert_eq!(state.queue.next_used, 1);
	}

	#[test]
	fn unadvertised_indirect_chain_is_rejected_before_request_parse() {
		let directory = tempdir().unwrap();
		let path = directory.path().join("upper.ext4");
		let file = OpenOptions::new()
			.create(true)
			.truncate(true)
			.read(true)
			.write(true)
			.open(&path)
			.unwrap();
		file.set_len(1024 * 1024).unwrap();
		let memory = GuestRam::anonymous(0x10_000).unwrap();
		let service = BlockService::new(file, &memory, Arc::new(TestInterrupt::default())).unwrap();
		configure(&service, &memory);

		memory
			.memory
			.write_obj(4_u16, GuestAddress(0x100c))
			.unwrap();
		service.mmio_write(QUEUE_NOTIFY_OFFSET, &0_u32.to_le_bytes());
		let deadline = Instant::now() + Duration::from_secs(1);
		while memory.memory.read_obj::<u16>(GuestAddress(0x3002)).unwrap() != 1 {
			assert!(
				Instant::now() < deadline,
				"block worker did not reject chain"
			);
			thread::yield_now();
		}

		let mut status = [0_u8; 4];
		service.mmio_read(u64::from(VIRTIO_MMIO_STATUS), &mut status);
		assert_ne!(
			u32::from_le_bytes(status) & u32::from(DEVICE_NEEDS_RESET),
			0
		);
		assert_eq!(&std::fs::read(path).unwrap()[..512], &[0; 512]);
	}

	#[test]
	fn block_pool_creates_independent_sparse_instances() {
		let directory = tempdir().unwrap();
		let directory_file = File::open(directory.path()).unwrap();
		let pool = BlockFilePool::from_directory(directory_file).unwrap();
		let source_path = directory.path().join("source.ext4");
		let source = OpenOptions::new()
			.create(true)
			.truncate(true)
			.read(true)
			.write(true)
			.open(source_path)
			.unwrap();
		source.set_len(64 * 1024 * 1024).unwrap();
		source.write_all_at(b"baseline", 4 * 1024 * 1024).unwrap();
		let template = pool.snapshot(&source).unwrap();
		let (first, _) = template.instantiate().unwrap();
		let (second, _) = template.instantiate().unwrap();
		first.write_all_at(b"private!", 4 * 1024 * 1024).unwrap();
		let mut baseline = [0_u8; 8];
		let mut sibling = [0_u8; 8];
		template
			.baseline
			.read_exact_at(&mut baseline, 4 * 1024 * 1024)
			.unwrap();
		second.read_exact_at(&mut sibling, 4 * 1024 * 1024).unwrap();
		assert_eq!(&baseline, b"baseline");
		assert_eq!(&sibling, b"baseline");
		assert_eq!(template.len(), 64 * 1024 * 1024);
	}
}
