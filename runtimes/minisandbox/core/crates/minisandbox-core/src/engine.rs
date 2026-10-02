//! Safe Rust orchestration of one PVM-backed program run.

use std::{
	collections::{BTreeMap, BTreeSet},
	fs::File,
	io::{self, Read},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicU64, AtomicUsize, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use minisandbox_block_backend::{SqliteBlockBackend, SqliteBlockBackendFactory};
use minisandbox_pvm_sys::{
	PVM_HYPERCALL_PORT, PvmBlockTemplate, PvmBootConfig, PvmDevice, PvmDeviceError, PvmExit,
	PvmHypercall, PvmLinuxState, PvmMachine, PvmMemoryTemplate, PvmReadOnlyRegion, PvmRegisters,
	PvmResumeState,
};
pub use minisandbox_pvm_sys::{
	PvmBlockBackend, PvmBlockCloneMethod, PvmBlockPool, PvmReadOnlyImage, PvmRunCanceller,
	PvmRunStats,
};
pub use pvm_socket_service::{
	AllowAll as NetworkAllowAll, AllowList as TcpAllowList, BandwidthQuota, BrokerStats,
	ConnectPolicy as TcpConnectPolicy, DenyAll as NetworkDenyAll, DnsAllowList,
	DnsPolicy as DnsQueryPolicy, HOST_LOOPBACK_ALIAS, SocketQuotas,
};
use pvm_socket_service::{AllowAll, BrokerHandle, ServiceMemory, SocketBroker};

use crate::{
	memory::GuestAddress,
	paging::{
		CowPage, CowPagePlan, X86_PTE_NO_EXECUTE, X86_PTE_PRESENT, X86_PTE_USER, X86_PTE_WRITABLE,
	},
	program::{Program, ProgramError},
	pvm::{LinuxProcessLayout, PvmImageError, PvmUserImage},
	pvm_linux::{PvmLinuxImage, PvmLinuxImageError, READ_ONLY_APP_GPA, READ_ONLY_ROOTFS_GPA},
};

const SYSCALL_PORT: u16 = 0x80;
const X86_PTE_ADDRESS_MASK: u64 = 0x000f_ffff_ffff_f000;
const X86_PTE_PAGE_SIZE: u64 = 1 << 7;
const INTERPRETER_LOAD_BIAS: u64 = 0x0080_0000;
const SUPPORTED_INTERPRETER_PATH: &[u8] = b"/lib64/ld-linux-x86-64.so.2";
const SUPPORTED_LIBC_PATH: &[u8] = b"/lib64/libc.so.6";
const CONTROLLED_RUNTIME_DEPENDENCIES: &[(&[u8], &str)] = &[
	(SUPPORTED_LIBC_PATH, "/lib64/libc.so.6"),
	(b"/lib64/libstdc++.so.6", "/lib64/libstdc++.so.6"),
	(b"/lib64/libm.so.6", "/lib64/libm.so.6"),
	(b"/lib64/libgcc_s.so.1", "/lib64/libgcc_s.so.1"),
];
const MAX_RUNTIME_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROCESS_FILES: usize = 64;
const MAX_PROCESS_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROCESS_FILE_TOTAL_BYTES: usize = 64 * 1024 * 1024;
static NEXT_SQLITE_BLOCK_ID: AtomicU64 = AtomicU64::new(1);
const SYS_READ: u32 = 0;
const SYS_WRITE: u32 = 1;
const SYS_CLOSE: u32 = 3;
const SYS_FSTAT: u32 = 5;
const SYS_POLL: u32 = 7;
const SYS_MMAP: u32 = 9;
const SYS_MPROTECT: u32 = 10;
const SYS_MUNMAP: u32 = 11;
const SYS_BRK: u32 = 12;
const SYS_RT_SIGACTION: u32 = 13;
const SYS_PREAD64: u32 = 17;
const SYS_WRITEV: u32 = 20;
const SYS_ACCESS: u32 = 21;
const SYS_GETPID: u32 = 39;
const SYS_EXIT: u32 = 60;
const SYS_UNAME: u32 = 63;
const SYS_READLINK: u32 = 89;
const SYS_SIGALTSTACK: u32 = 131;
const SYS_ARCH_PRCTL: u32 = 158;
const SYS_SET_TID_ADDRESS: u32 = 218;
const SYS_CLOCK_GETTIME: u32 = 228;
const SYS_EXIT_GROUP: u32 = 231;
const SYS_OPENAT: u32 = 257;
const SYS_NEWFSTATAT: u32 = 262;
const SYS_READLINKAT: u32 = 267;
const SYS_SET_ROBUST_LIST: u32 = 273;
const SYS_PRLIMIT64: u32 = 302;
const SYS_GETRANDOM: u32 = 318;
const SYS_RSEQ: u32 = 334;
const SYS_MINISANDBOX_BOOTSTRAP: u32 = 0x7f00;
const SYS_MINISANDBOX_CHECKPOINT: u32 = 0x7f01;
const MAX_HOST_EXITS: usize = 1024;
const MAX_LINUX_HOST_EXITS: usize = 1024 * 1024;
const MAX_CAPTURED_OUTPUT: usize = 1024 * 1024;
const MAX_IO_VECTORS: usize = 64;
const MAX_PROCESS_VECTOR_ENTRIES: usize = 1024;
const MAX_PROCESS_STRING_BYTES: usize = 512 * 1024;
const MAX_PROCESS_STDIN: usize = 1024 * 1024;
const MAX_VIRTUAL_FILES: usize = 64;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
static NEXT_SOCKET_SESSION: AtomicU64 = AtomicU64::new(1);

/// Terminal guest outcome returned by the Rust runtime API.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunOutcome {
	/// Guest invoked exit or `exit_group`.
	Exited {
		/// Guest-provided process status.
		code: i32,
	},
	/// Guest reached the supervisor PVM event path.
	GuestFault,
	/// Guest executed HLT.
	Halted,
	/// KVM reported shutdown/triple fault.
	Shutdown,
	/// Host monotonic deadline preempted the guest.
	TimedOut,
	/// Host control terminally cancelled the sandbox runner.
	Cancelled,
}

/// Host-side limits applied to one complete guest run.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunOptions {
	/// Maximum monotonic wall-clock time across all guest entries and syscalls.
	pub timeout: Duration,
}

impl Default for RunOptions {
	fn default() -> Self {
		Self {
			timeout: DEFAULT_TIMEOUT,
		}
	}
}

/// One exact, read-only file exposed to a Linux guest process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessFile<'a> {
	/// Absolute normalized guest path used by `openat`.
	pub path: &'a [u8],
	/// Immutable bytes returned through the guest file descriptor.
	pub bytes: &'a [u8],
}

/// Complete result of a guest run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunResult {
	/// Terminal classification.
	pub outcome: RunOutcome,
	/// Bytes written to guest stdout or stderr.
	pub output: Vec<u8>,
}

#[derive(Debug)]
struct PvmLinuxReadOnlyLayer {
	image: PvmReadOnlyImage,
	guest_phys_address: u64,
}

/// Immutable Linux RAM, CPU/device state, and shared read-only filesystem layers.
#[derive(Debug)]
pub struct PvmLinuxTemplate {
	memory: PvmMemoryTemplate,
	state: PvmLinuxState,
	read_only_layers: Vec<PvmLinuxReadOnlyLayer>,
	block: Option<PvmLinuxBlockTemplate>,
	warm_output: Vec<u8>,
	warmup_latency: Duration,
	snapshot_latency: Duration,
	page_report_descriptor_gpa: u64,
}

#[derive(Debug)]
enum PvmLinuxBlockTemplate {
	File(PvmBlockTemplate),
	Sqlite(PvmSqliteBlockTemplate),
}

#[derive(Debug)]
struct PvmSqliteBlockTemplate {
	factory: SqliteBlockBackendFactory,
	snapshot_id: String,
	logical_size: u64,
}

/// One live Linux VM restored from a [`PvmLinuxTemplate`].
pub struct PvmLinuxInstance {
	broker: BrokerHandle,
	machine: PvmMachine,
	create_latency: Duration,
	reclaimed_pages: usize,
	page_reports: usize,
}

/// Direct PVM adapter for the durable SQLite/COS reference block engine.
///
/// The adapter owns no block-image file descriptor or image path. Its only
/// local file is the `SQLite` metadata/hot-data database opened by the typed
/// storage backend; guest requests never traverse NBD.
#[derive(Debug)]
pub struct PvmSqliteBlockBackend {
	inner: SqliteBlockBackend,
	retire_on_drop: bool,
}

impl PvmSqliteBlockBackend {
	/// Opens or creates one sparse logical volume and acquires its writer epoch.
	///
	/// # Errors
	///
	/// Returns a repository, COS-emulator, geometry, or fencing error.
	pub fn open(
		database: &Path,
		cos_root: &Path,
		volume_id: &str,
		logical_size: u64,
	) -> Result<Self, minisandbox_block_backend::BackendError> {
		let factory = SqliteBlockBackendFactory::open(database, cos_root)?;
		Self::open_with_factory(&factory, volume_id, logical_size, false)
	}

	fn open_ephemeral(
		factory: &SqliteBlockBackendFactory,
		volume_id: &str,
		logical_size: u64,
	) -> Result<Self, minisandbox_block_backend::BackendError> {
		Self::open_with_factory(factory, volume_id, logical_size, true)
	}

	fn open_with_factory(
		factory: &SqliteBlockBackendFactory,
		volume_id: &str,
		logical_size: u64,
		retire_on_drop: bool,
	) -> Result<Self, minisandbox_block_backend::BackendError> {
		Ok(Self {
			inner: factory.open_volume(volume_id, logical_size)?,
			retire_on_drop,
		})
	}
}

impl Drop for PvmSqliteBlockBackend {
	fn drop(&mut self) {
		if self.retire_on_drop {
			let _ = self.inner.retire_volume();
		}
	}
}

impl PvmBlockBackend for PvmSqliteBlockBackend {
	fn size(&self) -> u64 {
		self.inner.size()
	}

	fn read_at(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
		self.inner
			.read_at(offset, length)
			.map_err(|error| io::Error::other(error.to_string()))
	}

	fn write_at(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
		// SQLite range commits are durable before they ACK. The virtio device
		// does not advertise a volatile write cache, so no extra per-write FUA
		// barrier is necessary.
		self.inner
			.write_at(offset, bytes, false)
			.map_err(|error| io::Error::other(error.to_string()))
	}

	fn discard(&mut self, offset: u64, length: u64) -> io::Result<()> {
		self.inner
			.trim(
				offset,
				usize::try_from(length).map_err(io::Error::other)?,
				false,
			)
			.map_err(|error| io::Error::other(error.to_string()))
	}

	fn flush(&mut self) -> io::Result<()> {
		self.inner
			.flush()
			.map_err(|error| io::Error::other(error.to_string()))
	}
}

impl PvmSqliteBlockTemplate {
	fn capture(
		factory: SqliteBlockBackendFactory,
		volume_id: &str,
	) -> Result<Self, minisandbox_block_backend::BackendError> {
		let snapshot_id = unique_sqlite_block_id("template");
		let logical_size = factory.snapshot_volume(volume_id, &snapshot_id)?;
		factory.delete_volume(volume_id, &format!("template-source-retire-{snapshot_id}"))?;
		Ok(Self {
			factory,
			snapshot_id,
			logical_size,
		})
	}

	fn instantiate(
		&self,
	) -> Result<PvmSqliteBlockBackend, minisandbox_block_backend::BackendError> {
		let child_volume_id = unique_sqlite_block_id("clone");
		let logical_size = self
			.factory
			.fork_snapshot(&self.snapshot_id, &child_volume_id)?;
		debug_assert_eq!(logical_size, self.logical_size);
		PvmSqliteBlockBackend::open_ephemeral(&self.factory, &child_volume_id, logical_size)
	}
}

impl Drop for PvmSqliteBlockTemplate {
	fn drop(&mut self) {
		let _ = self.factory.delete_snapshot(&self.snapshot_id);
	}
}

fn unique_sqlite_block_id(kind: &str) -> String {
	let sequence = NEXT_SQLITE_BLOCK_ID.fetch_add(1, Ordering::Relaxed);
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| duration.as_nanos());
	format!("pvm-{kind}-{}-{nanos:x}-{sequence:x}", std::process::id())
}

/// Timings and RAM COW activity from one warm Linux clone.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PvmLinuxCloneResult {
	/// VM construction plus CPU/device-state restore time.
	pub create_latency: Duration,
	/// Time from first `KVM_RUN` until the immediate post-ioctl marker.
	pub resume_latency: Duration,
	/// Time from first `KVM_RUN` until the workload completion marker.
	pub completion_latency: Duration,
	/// Guest-RAM pages currently private after subtracting successful reports.
	pub private_pages: usize,
	/// COW-private pages returned to the sealed template while this clone ran.
	pub reclaimed_pages: usize,
	/// Number of bounded guest free-page report batches handled.
	pub page_reports: usize,
	/// Host-only socket-broker counters sampled at the completion marker.
	pub socket_stats: BrokerStats,
	/// Host-only KVM/PVM run and idle-wait attribution counters.
	pub run_stats: PvmRunStats,
	/// Clone console bytes through the completion marker.
	pub output: Vec<u8>,
}

/// Immutable warmed guest baseline used to create cheap private instances.
#[derive(Debug)]
pub struct Template {
	memory: PvmMemoryTemplate,
	boot: PvmBootConfig,
	cow_pages: Arc<CowPagePlan>,
	resume: Option<PvmResumeState>,
	mailbox: Option<TurnMailbox>,
	linux_process: Option<LinuxProcessState>,
	live_private_data_pages: Arc<AtomicUsize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TurnMailbox {
	address: GuestAddress,
	capacity: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LinuxProcessState {
	brk_current: u64,
	brk_start: u64,
	brk_limit: u64,
	stack_limit: u64,
	stdin: Vec<u8>,
	stdin_offset: usize,
	mmap_start: u64,
	mmap_next: u64,
	mmap_limit: u64,
	mappings: BTreeMap<u64, CowPage>,
	runtime_files: BTreeMap<Vec<u8>, RuntimeFile>,
	open_files: BTreeMap<u64, VirtualFile>,
	next_file_descriptor: u64,
	standard_descriptors: [bool; 3],
	signal_actions: BTreeMap<u32, [u8; 32]>,
	alternate_signal_stack: [u8; 24],
	cow_sealing: bool,
	started: Instant,
	executable_name: &'static [u8],
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct VirtualFile {
	bytes: Arc<[u8]>,
	inode: u64,
	offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeFile {
	bytes: Arc<[u8]>,
	inode: u64,
}

#[derive(Debug)]
struct ControlledRuntime {
	interpreter: Option<Program>,
	files: BTreeMap<Vec<u8>, RuntimeFile>,
}

/// Per-instance copy-on-write activity counters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CowStats {
	/// Number of distinct template data pages private to this instance.
	pub dirty_data_pages: usize,
	/// Number of PVM write faults resolved for this instance.
	pub cow_faults: usize,
}

/// One ephemeral VM/vCPU forked from an immutable [`Template`].
pub struct TurnInstance {
	machine: PvmMachine,
	user_cr3: u64,
	backing_id: u64,
	cow_pages: Arc<CowPagePlan>,
	mailbox: Option<TurnMailbox>,
	linux_process: Option<LinuxProcessState>,
	dirty_pages: BTreeSet<GuestAddress>,
	cow_faults: usize,
	live_private_data_pages: Arc<AtomicUsize>,
	has_run: bool,
}

/// Failure in host-side runtime setup or syscall servicing.
#[derive(Debug)]
pub enum EngineError {
	/// KVM/PVM provider operation failed.
	Pvm(PvmDeviceError),
	/// Safe guest image construction failed.
	Image(PvmImageError),
	/// PVM Linux `bzImage` or its guest-physical boot layout is invalid.
	LinuxImage(PvmLinuxImageError),
	/// Supervisor syscall exit payload was not one 32-bit number.
	InvalidSyscallExit,
	/// Guest exit status does not fit the stable signed result type.
	InvalidExitCode,
	/// A KVM exit is not serviced by the phase-one run loop.
	UnexpectedExit(String),
	/// Guest exceeded the bounded host-exit budget.
	ExitBudgetExceeded,
	/// A page-fault event claimed COW semantics but violated the sealed plan.
	InvalidCowFault,
	/// An ephemeral turn instance cannot execute a second turn.
	InstanceAlreadyRun,
	/// Actor input was supplied to a non-actor template or omitted from one.
	InvalidActorProtocol,
	/// Deployment source or turn input exceeds the guest mailbox.
	ActorPayloadTooLarge,
	/// A Linux process string or virtual-file path is malformed.
	InvalidProcessInput,
	/// Linux process inputs or virtual files exceed a host-side bound.
	ProcessInputTooLarge,
	/// `QuickJS` warm-up terminated before publishing its checkpoint.
	ActorWarmupFailed(String),
	/// Host entropy required by the bounded Linux guest was unavailable.
	HostEntropy(String),
	/// Host wall-clock conversion required by a Linux process failed.
	HostClock(String),
	/// The requested dynamic interpreter is outside the runtime allowlist.
	UnsupportedInterpreter,
	/// A controlled runtime ELF failed strict validation.
	RuntimeElf(ProgramError),
	/// A controlled runtime file could not be read within its bound.
	HostRuntime(String),
	/// Guest stdout/stderr exceeded the per-turn capture budget.
	OutputLimitExceeded,
	/// Linux failed to publish or resume a valid warm-checkpoint boundary.
	LinuxCheckpoint(String),
	/// Clone-local stream mailbox or TCP broker setup failed.
	SocketService(String),
}

/// Open PVM runtime provider and its validated ABI contract.
pub struct Engine {
	device: PvmDevice,
	abi: minisandbox_pvm_sys::PvmAbi,
}

impl Engine {
	/// Opens and validates the PVM provider without a hardware-KVM fallback.
	///
	/// # Errors
	///
	/// Returns [`EngineError::Pvm`] if `/dev/kvm` or the PVM capability
	/// contract is unavailable.
	pub fn open() -> Result<Self, EngineError> {
		let device = PvmDevice::open().map_err(EngineError::Pvm)?;
		let capabilities = device.capabilities().map_err(EngineError::Pvm)?;
		Ok(Self {
			device,
			abi: capabilities.abi,
		})
	}

	/// Runs one validated ELF program to a typed terminal outcome.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for image construction, KVM operations,
	/// malformed syscall exits, unsupported exits, or exit-budget exhaustion.
	pub fn run(&self, program: &Program) -> Result<RunResult, EngineError> {
		self.run_with_options(program, RunOptions::default())
	}

	/// Runs one validated ELF program with explicit host-side limits.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for image construction, KVM operations,
	/// malformed syscall exits, unsupported exits, or exit-budget exhaustion.
	pub fn run_with_options(
		&self,
		program: &Program,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		if program.program_headers().is_none() {
			return self.run_freestanding_with_options(program, options);
		}
		self.run_process_with_options(program, &[b"/minisandbox/program"], &[], &[], options)
	}

	/// Direct-boots one PVM-aware Linux `bzImage` with an optional initramfs.
	///
	/// Linux owns its syscall, task, signal, futex, and VFS semantics. Outbound
	/// TCP and bounded UDP DNS are enabled by default through the socket broker.
	/// Use [`Self::run_pvm_linux_with_socket_policies`] to restrict egress.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if image construction, PVM setup, console
	/// capture, or an unexpected host-visible exit fails.
	pub fn run_pvm_linux(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		self.run_pvm_linux_with_socket_policies(
			kernel,
			initramfs,
			command_line,
			memory_size,
			Arc::new(AllowAll),
			Arc::new(AllowAll),
			options,
		)
	}

	/// Direct-boots Linux with an explicit outbound TCP destination policy.
	/// DNS resolver access remains unrestricted unless the caller uses
	/// [`Self::run_pvm_linux_with_socket_policies`].
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for Linux image, PVM, mailbox, broker, or guest
	/// execution failures.
	#[allow(clippy::too_many_arguments)]
	pub fn run_pvm_linux_with_tcp_policy(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		policy: Arc<dyn TcpConnectPolicy>,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		self.run_pvm_linux_with_socket_policies(
			kernel,
			initramfs,
			command_line,
			memory_size,
			policy,
			Arc::new(AllowAll),
			options,
		)
	}

	/// Direct-boots Linux with independent TCP and restricted UDP DNS policies.
	///
	/// DNS authorization names exact resolver IPv4 addresses; the broker still
	/// enforces UDP port 53 and validates bounded A/AAAA query wire shapes.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for Linux image, PVM, mailbox, broker, or guest
	/// execution failures.
	#[allow(clippy::too_many_arguments)]
	pub fn run_pvm_linux_with_socket_policies(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		tcp_policy: Arc<dyn TcpConnectPolicy>,
		dns_policy: Arc<dyn DnsQueryPolicy>,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		self.run_pvm_linux_with_socket_policies_and_quotas(
			kernel,
			initramfs,
			command_line,
			memory_size,
			tcp_policy,
			dns_policy,
			SocketQuotas::default(),
			options,
		)
	}

	/// Direct-boots Linux with socket policies and clone-local resource quotas.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for an invalid quota or Linux/PVM/socket failure.
	#[allow(clippy::too_many_arguments)]
	pub fn run_pvm_linux_with_socket_policies_and_quotas(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		tcp_policy: Arc<dyn TcpConnectPolicy>,
		dns_policy: Arc<dyn DnsQueryPolicy>,
		quotas: SocketQuotas,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let mut machine = self
			.device
			.create_linux_machine(image.memory_size())
			.map_err(EngineError::Pvm)?;
		let broker = install_socket_service(&mut machine, tcp_policy, dns_policy, quotas)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;
		run_linux_machine(&mut machine, &broker, options)
	}

	/// Direct-boots Linux with one host-sealed, read-only file-backed GPA range.
	///
	/// The range is registered in a separate KVM memory slot only after the
	/// provider reports `KVM_CAP_READONLY_MEM`. The caller describes the same
	/// range to Linux (for example with `memmap=<size>!<gpa>`) in
	/// `command_line`; ordinary guest RAM remains a disjoint writable slot.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if the image is unaligned, sealing fails, the
	/// read-only KVM capability is absent, ranges overlap, or boot fails.
	#[allow(clippy::too_many_arguments)]
	pub fn run_pvm_linux_with_read_only_image(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		read_only_image: &[u8],
		guest_phys_address: u64,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		let read_only_image =
			PvmReadOnlyImage::from_bytes(read_only_image).map_err(EngineError::Pvm)?;
		self.run_pvm_linux_with_sealed_read_only_image(
			kernel,
			initramfs,
			command_line,
			memory_size,
			&read_only_image,
			guest_phys_address,
			options,
		)
	}

	/// Direct-boots Linux while reusing an existing shared read-only image.
	///
	/// Cloning [`PvmReadOnlyImage`] retains one backing file; every machine maps
	/// that same page cache into its own read-only GPA slot. The backing can be
	/// a sealed memfd created from bytes or a host-managed immutable file. This
	/// avoids rebuilding or copying the EROFS backing for each instance.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if the Linux image, guest layout, read-only KVM
	/// slot, or boot state cannot be constructed.
	#[allow(clippy::too_many_arguments)]
	pub fn run_pvm_linux_with_sealed_read_only_image(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		read_only_image: &PvmReadOnlyImage,
		guest_phys_address: u64,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_image(
				image.memory_size(),
				read_only_image,
				guest_phys_address,
			)
			.map_err(EngineError::Pvm)?;
		let broker = install_socket_service(
			&mut machine,
			Arc::new(AllowAll),
			Arc::new(AllowAll),
			SocketQuotas::default(),
		)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;
		run_linux_machine(&mut machine, &broker, options)
	}

	/// Direct-boots Linux with shared read-only PMEM and one writable virtio-blk file.
	///
	/// The caller must include the matching `virtio_mmio.device=` descriptor in
	/// `command_line`. The regular file is consumed by this run and exposed as
	/// `/dev/vda`; its capacity is derived from its existing length.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if either image, the fixed virtio-mmio device,
	/// socket service, Linux boot state, or guest execution fails.
	#[allow(clippy::too_many_arguments)]
	pub fn run_pvm_linux_with_storage(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		read_only_image: &PvmReadOnlyImage,
		read_only_guest_phys_address: u64,
		writable_block: File,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_image(
				image.memory_size(),
				read_only_image,
				read_only_guest_phys_address,
			)
			.map_err(EngineError::Pvm)?;
		machine
			.attach_virtio_block(writable_block)
			.map_err(EngineError::Pvm)?;
		let broker = install_socket_service(
			&mut machine,
			Arc::new(AllowAll),
			Arc::new(AllowAll),
			SocketQuotas::default(),
		)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;
		run_linux_machine(&mut machine, &broker, options)
	}

	/// Direct-boots Linux with shared read-only PMEM and an opaque block engine.
	///
	/// The PVM side receives no block-image file descriptor or path. Requests
	/// are bounded and parsed by virtio-blk, then call `backend` directly.
	/// This is the product-shaped entry point for `SQLite` today and FDB later.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if image loading, block attachment, socket
	/// service setup, Linux boot state, or guest execution fails.
	#[allow(clippy::too_many_arguments)]
	pub fn run_pvm_linux_with_block_backend(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		read_only_image: &PvmReadOnlyImage,
		read_only_guest_phys_address: u64,
		backend: Box<dyn PvmBlockBackend>,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_image(
				image.memory_size(),
				read_only_image,
				read_only_guest_phys_address,
			)
			.map_err(EngineError::Pvm)?;
		machine
			.attach_virtio_block_backend(backend)
			.map_err(EngineError::Pvm)?;
		let broker = install_socket_service(
			&mut machine,
			Arc::new(AllowAll),
			Arc::new(AllowAll),
			SocketQuotas::default(),
		)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;
		run_linux_machine(&mut machine, &broker, options)
	}

	/// Boots Linux once and seals the guest-published warm checkpoint.
	///
	/// The guest must issue [`PvmHypercall::CheckpointReady`] from a completed
	/// four-byte `OUT` after quiescing to one vCPU. Writable RAM is copied into
	/// one sealed memfd; the supplied EROFS backing remains a separate shared
	/// read-only file and is not duplicated into the template.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if boot, checkpoint publication, architectural
	/// state capture, or RAM sealing fails.
	#[allow(clippy::too_many_arguments)]
	pub fn warm_pvm_linux_template(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		read_only_image: &PvmReadOnlyImage,
		guest_phys_address: u64,
		options: RunOptions,
	) -> Result<PvmLinuxTemplate, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_image(
				image.memory_size(),
				read_only_image,
				guest_phys_address,
			)
			.map_err(EngineError::Pvm)?;
		install_mailbox(&mut machine)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;

		let warm_started = Instant::now();
		let warm_output = run_linux_to_checkpoint(&mut machine, options)?;
		let warmup_latency = warm_started.elapsed();
		let page_report_descriptor_gpa = machine
			.checkpoint_page_report_descriptor_gpa()
			.map_err(EngineError::Pvm)?;
		let snapshot_started = Instant::now();
		let state = machine.capture_linux_state().map_err(EngineError::Pvm)?;
		let memory = machine
			.snapshot_memory_template()
			.map_err(EngineError::Pvm)?;
		let snapshot_latency = snapshot_started.elapsed();
		Ok(PvmLinuxTemplate {
			memory,
			state,
			read_only_layers: vec![PvmLinuxReadOnlyLayer {
				image: read_only_image.clone(),
				guest_phys_address,
			}],
			block: None,
			warm_output,
			warmup_latency,
			snapshot_latency,
			page_report_descriptor_gpa,
		})
	}

	/// Boots a writable `OverlayFS` guest once and captures RAM plus virtio-blk.
	///
	/// The checkpoint is a joint VM snapshot: the stopped vCPU prevents new
	/// filesystem activity, the block queue is drained and synchronized, guest
	/// RAM retains dirty page-cache state, and `block_pool` captures the disk
	/// baseline through `FICLONE` or a sparse extent copy. Every later clone
	/// receives a unique unlinked writable block file.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if boot/checkpoint, block quiesce, RAM sealing,
	/// or block-template creation fails.
	#[allow(clippy::too_many_arguments)]
	pub fn warm_pvm_linux_template_with_storage(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		read_only_image: &PvmReadOnlyImage,
		read_only_guest_phys_address: u64,
		writable_block: File,
		block_pool: &PvmBlockPool,
		options: RunOptions,
	) -> Result<PvmLinuxTemplate, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_image(
				image.memory_size(),
				read_only_image,
				read_only_guest_phys_address,
			)
			.map_err(EngineError::Pvm)?;
		machine
			.attach_virtio_block(writable_block)
			.map_err(EngineError::Pvm)?;
		install_mailbox(&mut machine)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;

		let warm_started = Instant::now();
		let warm_output = run_linux_to_checkpoint(&mut machine, options)?;
		let warmup_latency = warm_started.elapsed();
		let page_report_descriptor_gpa = machine
			.checkpoint_page_report_descriptor_gpa()
			.map_err(EngineError::Pvm)?;
		let snapshot_started = Instant::now();
		let state = machine.capture_linux_state().map_err(EngineError::Pvm)?;
		let memory = machine
			.snapshot_memory_template()
			.map_err(EngineError::Pvm)?;
		let block = machine
			.snapshot_virtio_block(block_pool)
			.map_err(EngineError::Pvm)?;
		let snapshot_latency = snapshot_started.elapsed();
		Ok(PvmLinuxTemplate {
			memory,
			state,
			read_only_layers: vec![PvmLinuxReadOnlyLayer {
				image: read_only_image.clone(),
				guest_phys_address: read_only_guest_phys_address,
			}],
			block: Some(PvmLinuxBlockTemplate::File(block)),
			warm_output,
			warmup_latency,
			snapshot_latency,
			page_report_descriptor_gpa,
		})
	}

	/// Boots and checkpoints a writable guest over a `SQLite` logical volume.
	///
	/// The stopped queue is flushed before the repository atomically seals the
	/// warm volume layer. Every later VM clone performs an O(1) metadata fork
	/// and attaches that fresh child directly; no block image, NBD device,
	/// reflink, or sparse copy is involved.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if boot/checkpoint, block quiesce, RAM sealing,
	/// repository snapshot, or typed backend setup fails.
	#[allow(clippy::too_many_arguments)]
	pub fn warm_pvm_linux_template_with_sqlite_storage(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		read_only_image: &PvmReadOnlyImage,
		read_only_guest_phys_address: u64,
		database: &Path,
		cos_root: &Path,
		volume_id: &str,
		logical_size: u64,
		options: RunOptions,
	) -> Result<PvmLinuxTemplate, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let factory = SqliteBlockBackendFactory::open(database, cos_root).map_err(|error| {
			EngineError::LinuxCheckpoint(format!("cannot open SQLite repository: {error}"))
		})?;
		let backend =
			PvmSqliteBlockBackend::open_with_factory(&factory, volume_id, logical_size, false)
				.map_err(|error| {
					EngineError::LinuxCheckpoint(format!(
						"cannot open SQLite block volume: {error}"
					))
				})?;
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_image(
				image.memory_size(),
				read_only_image,
				read_only_guest_phys_address,
			)
			.map_err(EngineError::Pvm)?;
		machine
			.attach_virtio_block_backend(Box::new(backend))
			.map_err(EngineError::Pvm)?;
		install_mailbox(&mut machine)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;

		let warm_started = Instant::now();
		let warm_output = run_linux_to_checkpoint(&mut machine, options)?;
		let warmup_latency = warm_started.elapsed();
		let page_report_descriptor_gpa = machine
			.checkpoint_page_report_descriptor_gpa()
			.map_err(EngineError::Pvm)?;
		let snapshot_started = Instant::now();
		let state = machine.capture_linux_state().map_err(EngineError::Pvm)?;
		let memory = machine
			.snapshot_memory_template()
			.map_err(EngineError::Pvm)?;
		let block = PvmSqliteBlockTemplate::capture(factory, volume_id).map_err(|error| {
			EngineError::LinuxCheckpoint(format!("cannot snapshot SQLite block volume: {error}"))
		})?;
		let snapshot_latency = snapshot_started.elapsed();
		Ok(PvmLinuxTemplate {
			memory,
			state,
			read_only_layers: vec![PvmLinuxReadOnlyLayer {
				image: read_only_image.clone(),
				guest_phys_address: read_only_guest_phys_address,
			}],
			block: Some(PvmLinuxBlockTemplate::Sqlite(block)),
			warm_output,
			warmup_latency,
			snapshot_latency,
			page_report_descriptor_gpa,
		})
	}

	/// Boots and checkpoints the fixed three-layer filesystem profile.
	///
	/// `base_image` is exposed as `/dev/pmem0` at [`READ_ONLY_ROOTFS_GPA`],
	/// `app_image` as `/dev/pmem1` at [`READ_ONLY_APP_GPA`], and the writable
	/// ext4 backing as `/dev/vda`. The guest init combines them as
	/// `upper -> app -> base`; only the ext4 baseline is cloned per sandbox.
	/// Both EROFS files remain demand-paged host mappings shared through the
	/// page cache.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if either immutable range, Linux boot,
	/// checkpoint, or writable block snapshot fails.
	#[allow(clippy::too_many_arguments)]
	pub fn warm_pvm_linux_template_with_layered_storage(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		base_image: &PvmReadOnlyImage,
		app_image: &PvmReadOnlyImage,
		writable_block: File,
		block_pool: &PvmBlockPool,
		options: RunOptions,
	) -> Result<PvmLinuxTemplate, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let regions = [
			PvmReadOnlyRegion::new(base_image, READ_ONLY_ROOTFS_GPA),
			PvmReadOnlyRegion::new(app_image, READ_ONLY_APP_GPA),
		];
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_images(image.memory_size(), &regions)
			.map_err(EngineError::Pvm)?;
		machine
			.attach_virtio_block(writable_block)
			.map_err(EngineError::Pvm)?;
		install_mailbox(&mut machine)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;

		let warm_started = Instant::now();
		let warm_output = run_linux_to_checkpoint(&mut machine, options)?;
		let warmup_latency = warm_started.elapsed();
		let page_report_descriptor_gpa = machine
			.checkpoint_page_report_descriptor_gpa()
			.map_err(EngineError::Pvm)?;
		let snapshot_started = Instant::now();
		let state = machine.capture_linux_state().map_err(EngineError::Pvm)?;
		let memory = machine
			.snapshot_memory_template()
			.map_err(EngineError::Pvm)?;
		let block = machine
			.snapshot_virtio_block(block_pool)
			.map_err(EngineError::Pvm)?;
		let snapshot_latency = snapshot_started.elapsed();
		Ok(PvmLinuxTemplate {
			memory,
			state,
			read_only_layers: vec![
				PvmLinuxReadOnlyLayer {
					image: base_image.clone(),
					guest_phys_address: READ_ONLY_ROOTFS_GPA,
				},
				PvmLinuxReadOnlyLayer {
					image: app_image.clone(),
					guest_phys_address: READ_ONLY_APP_GPA,
				},
			],
			block: Some(PvmLinuxBlockTemplate::File(block)),
			warm_output,
			warmup_latency,
			snapshot_latency,
			page_report_descriptor_gpa,
		})
	}

	/// Boots and checkpoints the three-layer EROFS/EROFS/SQLite profile.
	///
	/// Both immutable layers remain shared PMEM mappings. The writable upper
	/// is a logical database volume whose checkpoint and clone operations are
	/// O(1) metadata updates rather than block-file copies.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if either immutable range, Linux checkpoint,
	/// typed block backend, or repository snapshot fails.
	#[allow(clippy::too_many_arguments)]
	pub fn warm_pvm_linux_template_with_layered_sqlite_storage(
		&self,
		kernel: &[u8],
		initramfs: &[u8],
		command_line: &[u8],
		memory_size: usize,
		base_image: &PvmReadOnlyImage,
		app_image: &PvmReadOnlyImage,
		database: &Path,
		cos_root: &Path,
		volume_id: &str,
		logical_size: u64,
		options: RunOptions,
	) -> Result<PvmLinuxTemplate, EngineError> {
		let image = PvmLinuxImage::from_bzimage(kernel, initramfs, command_line, memory_size)
			.map_err(EngineError::LinuxImage)?;
		let factory = SqliteBlockBackendFactory::open(database, cos_root).map_err(|error| {
			EngineError::LinuxCheckpoint(format!("cannot open SQLite repository: {error}"))
		})?;
		let backend =
			PvmSqliteBlockBackend::open_with_factory(&factory, volume_id, logical_size, false)
				.map_err(|error| {
					EngineError::LinuxCheckpoint(format!(
						"cannot open SQLite block volume: {error}"
					))
				})?;
		let regions = [
			PvmReadOnlyRegion::new(base_image, READ_ONLY_ROOTFS_GPA),
			PvmReadOnlyRegion::new(app_image, READ_ONLY_APP_GPA),
		];
		let mut machine = self
			.device
			.create_linux_machine_with_read_only_images(image.memory_size(), &regions)
			.map_err(EngineError::Pvm)?;
		machine
			.attach_virtio_block_backend(Box::new(backend))
			.map_err(EngineError::Pvm)?;
		install_mailbox(&mut machine)?;
		install_pvm_linux_image(&mut machine, &image)?;
		machine
			.configure_linux_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;

		let warm_started = Instant::now();
		let warm_output = run_linux_to_checkpoint(&mut machine, options)?;
		let warmup_latency = warm_started.elapsed();
		let page_report_descriptor_gpa = machine
			.checkpoint_page_report_descriptor_gpa()
			.map_err(EngineError::Pvm)?;
		let snapshot_started = Instant::now();
		let state = machine.capture_linux_state().map_err(EngineError::Pvm)?;
		let memory = machine
			.snapshot_memory_template()
			.map_err(EngineError::Pvm)?;
		let block = PvmSqliteBlockTemplate::capture(factory, volume_id).map_err(|error| {
			EngineError::LinuxCheckpoint(format!("cannot snapshot SQLite block volume: {error}"))
		})?;
		let snapshot_latency = snapshot_started.elapsed();
		Ok(PvmLinuxTemplate {
			memory,
			state,
			read_only_layers: vec![
				PvmLinuxReadOnlyLayer {
					image: base_image.clone(),
					guest_phys_address: READ_ONLY_ROOTFS_GPA,
				},
				PvmLinuxReadOnlyLayer {
					image: app_image.clone(),
					guest_phys_address: READ_ONLY_APP_GPA,
				},
			],
			block: Some(PvmLinuxBlockTemplate::Sqlite(block)),
			warm_output,
			warmup_latency,
			snapshot_latency,
			page_report_descriptor_gpa,
		})
	}

	/// Creates one dirty-tracked COW VM from a warm Linux template.
	///
	/// # Errors
	///
	/// Returns [`EngineError::Pvm`] if VM construction or checkpoint-state
	/// restore fails.
	pub fn clone_pvm_linux_template(
		&self,
		template: &PvmLinuxTemplate,
	) -> Result<PvmLinuxInstance, EngineError> {
		self.clone_pvm_linux_template_with_socket_policies(
			template,
			Arc::new(AllowAll),
			Arc::new(AllowAll),
		)
	}

	/// Restores one Linux clone with an explicitly authorized host TCP policy.
	/// DNS resolver access remains unrestricted unless the caller supplies
	/// both policies.
	///
	/// The clone receives fresh non-COW G2H/H2G mappings and a new host
	/// capability table. `PF_INET/SOCK_STREAM` remains transparent to native
	/// guest binaries, while every destination is checked by `policy` before
	/// the broker opens a host socket.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if VM restore, mailbox/IRQ registration, or
	/// broker startup fails.
	pub fn clone_pvm_linux_template_with_tcp_policy(
		&self,
		template: &PvmLinuxTemplate,
		policy: Arc<dyn TcpConnectPolicy>,
	) -> Result<PvmLinuxInstance, EngineError> {
		self.clone_pvm_linux_template_with_socket_policies(template, policy, Arc::new(AllowAll))
	}

	/// Restores a clone with independent outbound TCP and DNS policies.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if VM restore, mailbox/IRQ registration, or
	/// broker startup fails.
	pub fn clone_pvm_linux_template_with_socket_policies(
		&self,
		template: &PvmLinuxTemplate,
		tcp_policy: Arc<dyn TcpConnectPolicy>,
		dns_policy: Arc<dyn DnsQueryPolicy>,
	) -> Result<PvmLinuxInstance, EngineError> {
		self.clone_pvm_linux_template_with_socket_policies_and_quotas(
			template,
			tcp_policy,
			dns_policy,
			SocketQuotas::default(),
		)
	}

	/// Restores a clone with socket policies and clone-local resource quotas.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if quotas, restore, mailbox, IRQ, or broker setup fails.
	pub fn clone_pvm_linux_template_with_socket_policies_and_quotas(
		&self,
		template: &PvmLinuxTemplate,
		tcp_policy: Arc<dyn TcpConnectPolicy>,
		dns_policy: Arc<dyn DnsQueryPolicy>,
		quotas: SocketQuotas,
	) -> Result<PvmLinuxInstance, EngineError> {
		self.clone_pvm_linux_template_inner(template, tcp_policy, dns_policy, quotas, None)
	}

	/// Restores one clone and attaches its persistent `ActorVolume` as `/dev/vdb`.
	///
	/// The warm template must not contain a data device. Its system disk, RAM,
	/// and queue state remain an exact joint checkpoint; `actor_volume` starts
	/// from virtio reset state and is bound by the guest only after resume.
	/// The backend is opaque to PVM and may call SQLite/FDB directly without a
	/// host block-image file or NBD transport.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if the template already captured an `ActorVolume`,
	/// or if VM construction, backend attachment, or checkpoint restore fails.
	pub fn clone_pvm_linux_template_with_actor_volume_backend(
		&self,
		template: &PvmLinuxTemplate,
		actor_volume: Box<dyn PvmBlockBackend>,
	) -> Result<PvmLinuxInstance, EngineError> {
		self.clone_pvm_linux_template_inner(
			template,
			Arc::new(AllowAll),
			Arc::new(AllowAll),
			SocketQuotas::default(),
			Some(actor_volume),
		)
	}

	fn clone_pvm_linux_template_inner(
		&self,
		template: &PvmLinuxTemplate,
		tcp_policy: Arc<dyn TcpConnectPolicy>,
		dns_policy: Arc<dyn DnsQueryPolicy>,
		quotas: SocketQuotas,
		actor_volume: Option<Box<dyn PvmBlockBackend>>,
	) -> Result<PvmLinuxInstance, EngineError> {
		if actor_volume.is_some() && template.state.has_actor_volume() {
			return Err(EngineError::LinuxCheckpoint(
				"warm template already contains an ActorVolume device".to_owned(),
			));
		}
		let started = Instant::now();
		let read_only_regions = template
			.read_only_layers
			.iter()
			.map(|layer| PvmReadOnlyRegion::new(&layer.image, layer.guest_phys_address))
			.collect::<Vec<_>>();
		let mut machine = self
			.device
			.create_linux_machine_from_template_with_read_only_images(
				&template.memory,
				&read_only_regions,
			)
			.map_err(EngineError::Pvm)?;
		if let Some(block) = &template.block {
			match block {
				PvmLinuxBlockTemplate::File(block) => {
					let (file, _) = block.instantiate().map_err(|error| {
						EngineError::LinuxCheckpoint(format!(
							"cannot instantiate private virtio-blk file: {error}"
						))
					})?;
					machine
						.attach_virtio_block(file)
						.map_err(EngineError::Pvm)?;
				}
				PvmLinuxBlockTemplate::Sqlite(block) => {
					let backend = block.instantiate().map_err(|error| {
						EngineError::LinuxCheckpoint(format!(
							"cannot fork private SQLite block volume: {error}"
						))
					})?;
					machine
						.attach_virtio_block_backend(Box::new(backend))
						.map_err(EngineError::Pvm)?;
				}
			}
		}
		if let Some(actor_volume) = actor_volume {
			machine
				.attach_actor_volume_backend(actor_volume)
				.map_err(EngineError::Pvm)?;
		}
		let broker = install_socket_service(&mut machine, tcp_policy, dns_policy, quotas)?;
		machine
			.configure_page_reclaim(template.page_report_descriptor_gpa)
			.map_err(EngineError::Pvm)?;
		machine
			.restore_linux_state(&template.state)
			.map_err(EngineError::Pvm)?;
		Ok(PvmLinuxInstance {
			broker,
			machine,
			create_latency: started.elapsed(),
			reclaimed_pages: 0,
			page_reports: 0,
		})
	}

	/// Materializes several independent clones before running any of them.
	///
	/// Keeping all mappings live proves that they concurrently share the same
	/// sealed RAM and shared EROFS baselines. Clones are executed sequentially so the
	/// timing samples do not contend with one another on the benchmark host.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if any clone cannot be created, restored, or
	/// reach both output markers within its deadline.
	pub fn benchmark_pvm_linux_clones(
		&self,
		template: &PvmLinuxTemplate,
		clone_count: usize,
		resumed_marker: &[u8],
		completed_marker: &[u8],
		options: RunOptions,
	) -> Result<Vec<PvmLinuxCloneResult>, EngineError> {
		if clone_count == 0 || resumed_marker.is_empty() || completed_marker.is_empty() {
			return Err(EngineError::LinuxCheckpoint(
				"clone count and both output markers must be nonzero".to_owned(),
			));
		}
		let mut instances = Vec::with_capacity(clone_count);
		for _ in 0..clone_count {
			instances.push(self.clone_pvm_linux_template(template)?);
		}
		instances
			.iter_mut()
			.map(|instance| instance.run_until_markers(resumed_marker, completed_marker, options))
			.collect()
	}

	/// Runs several independent clones concurrently on host worker threads.
	///
	/// Every clone owns its KVM VM, writable RAM mapping, dirty bitmap and
	/// page-reclaim state. The immutable sealed RAM and shared root-image baselines
	/// remain shared between all workers.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if any clone cannot be created, restored, or
	/// reach both output markers within its per-clone deadline. A panicking
	/// worker also fails the complete batch.
	pub fn benchmark_pvm_linux_clones_concurrently(
		&self,
		template: &PvmLinuxTemplate,
		clone_count: usize,
		resumed_marker: &[u8],
		completed_marker: &[u8],
		options: RunOptions,
	) -> Result<Vec<PvmLinuxCloneResult>, EngineError> {
		if clone_count == 0 || resumed_marker.is_empty() || completed_marker.is_empty() {
			return Err(EngineError::LinuxCheckpoint(
				"clone count and both output markers must be nonzero".to_owned(),
			));
		}
		let mut instances = Vec::with_capacity(clone_count);
		for _ in 0..clone_count {
			instances.push(self.clone_pvm_linux_template(template)?);
		}
		std::thread::scope(|scope| {
			let workers: Vec<_> = instances
				.into_iter()
				.map(|mut instance| {
					scope.spawn(move || {
						instance.run_until_markers(resumed_marker, completed_marker, options)
					})
				})
				.collect();
			workers
				.into_iter()
				.map(|worker| {
					worker.join().map_err(|_| {
						EngineError::LinuxCheckpoint(
							"concurrent PVM Linux clone worker panicked".to_owned(),
						)
					})?
				})
				.collect()
		})
	}

	fn run_freestanding_with_options(
		&self,
		program: &Program,
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		let image = PvmUserImage::from_program(self.abi, program).map_err(EngineError::Image)?;
		let mut machine = self
			.device
			.create_machine(image.memory().len())
			.map_err(EngineError::Pvm)?;
		machine
			.write_memory(0, image.memory())
			.map_err(EngineError::Pvm)?;
		let boot = image.boot_config();
		machine
			.configure_user_entry(boot)
			.map_err(EngineError::Pvm)?;
		run_machine(&mut machine, boot.user_cr3, options, None, None, None)
	}

	/// Runs one supported Linux ELF with caller-provided process inputs.
	///
	/// Arguments and environment entries are copied as NUL-terminated byte
	/// strings onto the initial Linux stack. `stdin` is exposed as a bounded
	/// in-memory file descriptor zero.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if process-image construction, PVM execution,
	/// syscall service, or a host-side bound fails.
	pub fn run_process(
		&self,
		program: &Program,
		arguments: &[&[u8]],
		environment: &[&[u8]],
		stdin: &[u8],
	) -> Result<RunResult, EngineError> {
		self.run_process_with_files_and_options(
			program,
			arguments,
			environment,
			stdin,
			&[],
			RunOptions::default(),
		)
	}

	/// Runs one Linux ELF with exact caller-provided read-only guest files.
	///
	/// The files are copied into a bounded in-memory table. Paths must be
	/// absolute and normalized; no host directory lookup is performed for
	/// them. This lets callers supply shared libraries or application data
	/// without granting a guest access to the host filesystem.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] under the same contracts as
	/// [`Self::run_process`], or when the file bundle violates a bound.
	pub fn run_process_with_files(
		&self,
		program: &Program,
		arguments: &[&[u8]],
		environment: &[&[u8]],
		stdin: &[u8],
		files: &[ProcessFile<'_>],
	) -> Result<RunResult, EngineError> {
		self.run_process_with_files_and_options(
			program,
			arguments,
			environment,
			stdin,
			files,
			RunOptions::default(),
		)
	}

	/// Runs one supported Linux ELF with process inputs and an explicit deadline.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] under the same contracts as
	/// [`Self::run_process`].
	pub fn run_process_with_options(
		&self,
		program: &Program,
		arguments: &[&[u8]],
		environment: &[&[u8]],
		stdin: &[u8],
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		self.run_process_with_files_and_options(
			program,
			arguments,
			environment,
			stdin,
			&[],
			options,
		)
	}

	/// Runs one Linux ELF with process inputs, exact read-only files, and a deadline.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] under the same contracts as
	/// [`Self::run_process_with_files`].
	pub fn run_process_with_files_and_options(
		&self,
		program: &Program,
		arguments: &[&[u8]],
		environment: &[&[u8]],
		stdin: &[u8],
		files: &[ProcessFile<'_>],
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		validate_process_inputs(arguments, environment, stdin)?;
		validate_process_files(files)?;
		let runtime = load_controlled_runtime(program, files)?;
		let image = if let Some(interpreter) = runtime.interpreter.as_ref() {
			PvmUserImage::linux_process_with_interpreter(
				self.abi,
				program,
				interpreter,
				arguments,
				environment,
			)
		} else {
			PvmUserImage::linux_process(self.abi, program, arguments, environment)
		}
		.map_err(EngineError::Image)?;
		let mut machine = self
			.device
			.create_machine(image.memory().len())
			.map_err(EngineError::Pvm)?;
		machine
			.write_memory(0, image.memory())
			.map_err(EngineError::Pvm)?;
		let layout = image
			.linux_process_layout()
			.ok_or(EngineError::InvalidActorProtocol)?;
		let mut random_seed = [0_u8; 16];
		fill_host_random(&mut random_seed)?;
		machine
			.write_memory(layout.random_seed().get(), &random_seed)
			.map_err(EngineError::Pvm)?;
		let boot = image.boot_config();
		machine
			.configure_user_entry(boot)
			.map_err(EngineError::Pvm)?;
		let mut process = LinuxProcessState::from(layout);
		process.stdin = stdin.to_vec();
		process.runtime_files = runtime.files;
		let mut writable_pages = image.cow_pages().clone();

		run_machine(
			&mut machine,
			boot.user_cr3,
			options,
			None,
			Some(&mut process),
			Some(&mut writable_pages),
		)
	}

	/// Builds an immutable, sealed copy-on-write baseline from a program.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] when checked image construction or sealed memfd
	/// creation fails.
	pub fn seal_template(&self, program: &Program) -> Result<Template, EngineError> {
		let image = PvmUserImage::cow_template(self.abi, program).map_err(EngineError::Image)?;
		let memory = PvmMemoryTemplate::from_bytes(image.memory()).map_err(EngineError::Pvm)?;
		Ok(Template {
			memory,
			boot: image.boot_config(),
			cow_pages: Arc::new(image.cow_pages().clone()),
			resume: None,
			mailbox: None,
			linux_process: None,
			live_private_data_pages: Arc::new(AtomicUsize::new(0)),
		})
	}

	/// Initializes `QuickJS` and deployment code, then seals its live checkpoint.
	///
	/// The guest runtime requests deployment bytes through the bootstrap
	/// syscall and publishes a mailbox at the checkpoint syscall. The returned
	/// template resumes after that checkpoint, so per-turn children do not
	/// repeat `QuickJS` or deployment initialization.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if the static Linux image, bounded libc syscall
	/// service, `QuickJS` bootstrap, or checkpoint publication fails.
	#[allow(clippy::too_many_lines)]
	pub fn warm_actor_template(
		&self,
		program: &Program,
		deployment: &[u8],
	) -> Result<Template, EngineError> {
		let image = PvmUserImage::actor_warmup(self.abi, program).map_err(EngineError::Image)?;
		let mut machine = self
			.device
			.create_machine(image.memory().len())
			.map_err(EngineError::Pvm)?;
		machine
			.write_memory(0, image.memory())
			.map_err(EngineError::Pvm)?;
		let layout = image
			.linux_process_layout()
			.ok_or(EngineError::InvalidActorProtocol)?;
		let mut random_seed = [0_u8; 16];
		fill_host_random(&mut random_seed)?;
		machine
			.write_memory(layout.random_seed().get(), &random_seed)
			.map_err(EngineError::Pvm)?;
		machine
			.configure_user_entry(image.boot_config())
			.map_err(EngineError::Pvm)?;
		let mut process = LinuxProcessState::from(layout);
		process.cow_sealing = true;
		let mut cow_pages = image.cow_pages().clone();
		let mut bootstrapped = false;
		let mut output = Vec::new();
		let mut run = machine
			.start_timed_run(DEFAULT_TIMEOUT)
			.map_err(EngineError::Pvm)?;

		for _ in 0..MAX_HOST_EXITS {
			match run.run_once().map_err(EngineError::Pvm)? {
				PvmExit::IoOut { port, data } if port == SYSCALL_PORT => {
					let syscall = decode_syscall(&data)?;
					let registers = run.registers().map_err(EngineError::Pvm)?;
					match syscall {
						SYS_MINISANDBOX_BOOTSTRAP if !bootstrapped => {
							let capacity = usize::try_from(registers.rsi)
								.map_err(|_| EngineError::InvalidActorProtocol)?;
							if capacity == 0 || capacity > 1024 * 1024 {
								return Err(EngineError::InvalidActorProtocol);
							}
							if deployment.len() > capacity {
								return Err(EngineError::ActorPayloadTooLarge);
							}
							validate_writable_guest_range(
								&cow_pages,
								run.memory_len(),
								registers.rdi,
								capacity,
							)?;
							run.write_memory(registers.rdi, deployment)
								.map_err(EngineError::Pvm)?;
							run.set_rax(
								u64::try_from(deployment.len())
									.map_err(|_| EngineError::ActorPayloadTooLarge)?,
							)
							.map_err(EngineError::Pvm)?;
							bootstrapped = true;
						}
						SYS_MINISANDBOX_CHECKPOINT if bootstrapped => {
							let capacity = usize::try_from(registers.rsi)
								.map_err(|_| EngineError::InvalidActorProtocol)?;
							if capacity == 0 || capacity > 1024 * 1024 {
								return Err(EngineError::InvalidActorProtocol);
							}
							validate_writable_guest_range(
								&cow_pages,
								run.memory_len(),
								registers.rdi,
								capacity,
							)?;
							let mailbox = TurnMailbox {
								address: GuestAddress::new(registers.rdi)
									.map_err(|_| EngineError::InvalidActorProtocol)?,
								capacity,
							};
							let resume = run
								.capture_resume_state(image.boot_config().retu_rip, 0)
								.map_err(EngineError::Pvm)?;
							prune_unmapped_anonymous_pages(&process, &mut cow_pages)?;
							seal_live_cow_pages(&mut run, &cow_pages)?;
							let bytes = run
								.read_memory(0, run.memory_len())
								.map_err(EngineError::Pvm)?;
							let memory =
								PvmMemoryTemplate::from_bytes(&bytes).map_err(EngineError::Pvm)?;
							return Ok(Template {
								memory,
								boot: image.boot_config(),
								cow_pages: Arc::new(cow_pages),
								resume: Some(resume),
								mailbox: Some(mailbox),
								linux_process: Some(process),
								live_private_data_pages: Arc::new(AtomicUsize::new(0)),
							});
						}
						SYS_EXIT | SYS_EXIT_GROUP => {
							let code = i32::try_from(registers.rdi)
								.map_err(|_| EngineError::InvalidExitCode)?;
							return Err(EngineError::ActorWarmupFailed(format!(
								"guest exited with {code}: {}",
								String::from_utf8_lossy(&output)
							)));
						}
						SYS_WRITE => {
							let result = capture_write(
								&run,
								image.boot_config().user_cr3,
								registers,
								&mut output,
							)?;
							run.set_rax(result).map_err(EngineError::Pvm)?;
						}
						_ => {
							let result = service_linux_syscall(
								&mut run,
								&mut process,
								Some(&mut cow_pages),
								image.boot_config().user_cr3,
								syscall,
								registers,
							)?
							.unwrap_or_else(|| negative_errno(38));
							run.set_rax(result).map_err(EngineError::Pvm)?;
						}
					}
				}
				PvmExit::ConsoleWrite { data } => {
					append_captured_output(&mut output, &data)?;
				}
				PvmExit::GuestExit { status } => {
					return Err(EngineError::ActorWarmupFailed(format!(
						"guest exited with status {status}: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::Event { .. } | PvmExit::IoOut { port: 0xe9, .. } => {
					return Err(EngineError::ActorWarmupFailed(format!(
						"guest faulted: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::TimedOut => {
					return Err(EngineError::ActorWarmupFailed("timed out".to_owned()));
				}
				PvmExit::Cancelled => {
					return Err(EngineError::ActorWarmupFailed("cancelled".to_owned()));
				}
				PvmExit::Halted => {
					return Err(EngineError::ActorWarmupFailed("guest halted".to_owned()));
				}
				PvmExit::Shutdown => {
					return Err(EngineError::ActorWarmupFailed("guest shutdown".to_owned()));
				}
				PvmExit::WaitUntil { .. } => {
					return Err(EngineError::UnexpectedExit(
						"WAIT_UNTIL escaped the timed PVM runner".to_owned(),
					));
				}
				PvmExit::Unexpected { description } => {
					return Err(EngineError::UnexpectedExit(description));
				}
				PvmExit::ReadOnlyMemoryWrite { address, data } => {
					return Err(EngineError::UnexpectedExit(format!(
						"guest write to read-only memory at {address:#x}, data {data:02x?}"
					)));
				}
				PvmExit::ServiceNotify { queues } => {
					return Err(EngineError::UnexpectedExit(format!(
						"service queue notification {:#x} without a configured broker",
						queues.bits()
					)));
				}
				PvmExit::IoOut { port, data } => {
					return Err(EngineError::UnexpectedExit(format!(
						"I/O port {port:#x}, data {data:02x?}"
					)));
				}
			}
		}
		Err(EngineError::ExitBudgetExceeded)
	}

	/// Creates a fresh VM/vCPU with private roots over shared clean pages.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if the private mapping, VM/vCPU, root copies, or
	/// PVM boot state cannot be created.
	pub fn fork_template(&self, template: &Template) -> Result<TurnInstance, EngineError> {
		let mut machine = self
			.device
			.create_machine_from_template(&template.memory)
			.map_err(EngineError::Pvm)?;
		for page in [
			template.boot.supervisor_cr3,
			template.boot.user_cr3,
			template.boot.pvcs_gpa,
		] {
			machine.privatize_page(page).map_err(EngineError::Pvm)?;
		}
		if let Some(resume) = &template.resume {
			machine
				.configure_user_resume(template.boot, resume)
				.map_err(EngineError::Pvm)?;
		} else {
			machine
				.configure_user_entry(template.boot)
				.map_err(EngineError::Pvm)?;
		}
		let backing_id = machine.backing_id().ok_or(EngineError::InvalidCowFault)?;
		Ok(TurnInstance {
			machine,
			user_cr3: template.boot.user_cr3,
			backing_id,
			cow_pages: Arc::clone(&template.cow_pages),
			mailbox: template.mailbox,
			linux_process: template.linux_process.clone(),
			dirty_pages: BTreeSet::new(),
			cow_faults: 0,
			live_private_data_pages: Arc::clone(&template.live_private_data_pages),
			has_run: false,
		})
	}
}

fn next_socket_session() -> Result<u64, EngineError> {
	NEXT_SOCKET_SESSION
		.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |session| {
			session.checked_add(1)
		})
		.map_err(|_| {
			EngineError::SocketService("stream mailbox session counter exhausted".to_owned())
		})
}

fn install_pvm_linux_image(
	machine: &mut PvmMachine,
	image: &PvmLinuxImage,
) -> Result<(), EngineError> {
	machine
		.write_memory(0, image.boot_memory())
		.map_err(EngineError::Pvm)?;
	if !image.initramfs().is_empty() {
		machine
			.write_memory(image.initramfs_range().start, image.initramfs())
			.map_err(EngineError::Pvm)?;
	}
	Ok(())
}

fn install_mailbox(machine: &mut PvmMachine) -> Result<(), EngineError> {
	let memory = ServiceMemory::new(next_socket_session()?).map_err(EngineError::Pvm)?;
	let _irq = memory.attach(machine).map_err(EngineError::Pvm)?;
	Ok(())
}

fn install_socket_service(
	machine: &mut PvmMachine,
	tcp_policy: Arc<dyn TcpConnectPolicy>,
	dns_policy: Arc<dyn DnsQueryPolicy>,
	quotas: SocketQuotas,
) -> Result<BrokerHandle, EngineError> {
	let memory = ServiceMemory::new(next_socket_session()?).map_err(EngineError::Pvm)?;
	let irq = memory.attach(machine).map_err(EngineError::Pvm)?;
	SocketBroker::spawn_with_quotas(memory, irq, tcp_policy, dns_policy, quotas)
		.map_err(|error| EngineError::SocketService(error.to_string()))
}

fn run_linux_machine(
	machine: &mut PvmMachine,
	broker: &BrokerHandle,
	options: RunOptions,
) -> Result<RunResult, EngineError> {
	let mut output = Vec::new();
	let mut run = machine
		.start_timed_run(options.timeout)
		.map_err(EngineError::Pvm)?;
	for _ in 0..MAX_LINUX_HOST_EXITS {
		match run.run_once().map_err(EngineError::Pvm)? {
			PvmExit::ConsoleWrite { data } => append_captured_output(&mut output, &data)?,
			PvmExit::GuestExit { status } => {
				return Ok(RunResult {
					outcome: RunOutcome::Exited {
						code: i32::from(status),
					},
					output,
				});
			}
			PvmExit::Halted => {}
			PvmExit::Shutdown => {
				let state = run.cpu_state().map_err(EngineError::Pvm)?;
				let control = run.pvm_control_state().map_err(EngineError::Pvm)?;
				let page_walk = diagnostic_page_walk(&run, state.cr3, state.cr2)?;
				let pvcs = diagnostic_words(&run, control.pvcs_gpa, 16)?;
				return Err(EngineError::UnexpectedExit(format!(
					"Linux shutdown/triple fault at {state:?}; PVM {control:?}; \
                     PVCS {pvcs:#x?}; page walk {page_walk:#x?}; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::TimedOut => {
				return Ok(RunResult {
					outcome: RunOutcome::TimedOut,
					output,
				});
			}
			PvmExit::Cancelled => {
				return Ok(RunResult {
					outcome: RunOutcome::Cancelled,
					output,
				});
			}
			PvmExit::WaitUntil { .. } => {
				return Err(EngineError::UnexpectedExit(
					"WAIT_UNTIL escaped the timed PVM runner".to_owned(),
				));
			}
			PvmExit::Unexpected { description } => {
				return Err(EngineError::UnexpectedExit(format!(
					"{description}; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::ReadOnlyMemoryWrite { address, data } => {
				return Err(EngineError::UnexpectedExit(format!(
					"Linux write to read-only image at {address:#x}, data {data:02x?}; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::Event { .. } => {
				return Ok(RunResult {
					outcome: RunOutcome::GuestFault,
					output,
				});
			}
			PvmExit::ServiceNotify { queues } => {
				let _ = queues;
				broker
					.notify_guest_requests()
					.map_err(|error| EngineError::SocketService(error.to_string()))?;
			}
			PvmExit::IoOut { port, data }
				if port == PVM_HYPERCALL_PORT
					&& decode_pvm_hypercall(&data) == Some(PvmHypercall::CheckpointReady) =>
			{
				return Err(EngineError::UnexpectedExit(
					"running clone attempted to publish a second checkpoint".to_owned(),
				));
			}
			PvmExit::IoOut { port, data }
				if port == PVM_HYPERCALL_PORT
					&& matches!(
						decode_pvm_hypercall(&data),
						Some(PvmHypercall::BenchmarkPoint | PvmHypercall::PageReport)
					) => {}
			PvmExit::IoOut { port, data } => {
				return Err(EngineError::UnexpectedExit(format!(
					"Linux I/O port {port:#x}, data {data:02x?}; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
		}
	}
	Err(EngineError::ExitBudgetExceeded)
}

fn run_linux_to_checkpoint(
	machine: &mut PvmMachine,
	options: RunOptions,
) -> Result<Vec<u8>, EngineError> {
	let mut output = Vec::new();
	let mut run = machine
		.start_timed_run(options.timeout)
		.map_err(EngineError::Pvm)?;
	for _ in 0..MAX_LINUX_HOST_EXITS {
		match run.run_once().map_err(EngineError::Pvm)? {
			PvmExit::ConsoleWrite { data } => append_captured_output(&mut output, &data)?,
			PvmExit::GuestExit { status } => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"guest exited with status {status} before checkpoint; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::IoOut { port, data } if port == PVM_HYPERCALL_PORT => {
				let word = u32::from_le_bytes(data.as_slice().try_into().map_err(|_| {
					EngineError::LinuxCheckpoint(format!(
						"checkpoint hypercall payload has {} bytes, expected four",
						data.len()
					))
				})?);
				if PvmHypercall::decode(word) != Some(PvmHypercall::CheckpointReady) {
					return Err(EngineError::LinuxCheckpoint(format!(
						"unexpected hypercall {word:#010x}; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				return Ok(output);
			}
			PvmExit::Halted => {}
			PvmExit::TimedOut => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"guest timed out before checkpoint; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::Cancelled => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"guest runner was cancelled before checkpoint; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::Shutdown => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"guest shut down before checkpoint; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::Event {
				vector,
				error_code,
				address,
			} => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"guest event {vector} error {error_code:#x} at {address:#x} before checkpoint; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::ReadOnlyMemoryWrite { address, data } => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"guest wrote read-only image at {address:#x}, data {data:02x?}; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::ServiceNotify { queues } => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"service queue notification {:#x} before the service broker was quiesced; console: {}",
					queues.bits(),
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::IoOut { port, data } => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"unexpected Linux I/O port {port:#x}, data {data:02x?}; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
			PvmExit::WaitUntil { .. } => {
				return Err(EngineError::UnexpectedExit(
					"WAIT_UNTIL escaped the timed PVM runner".to_owned(),
				));
			}
			PvmExit::Unexpected { description } => {
				return Err(EngineError::LinuxCheckpoint(format!(
					"{description}; console: {}",
					String::from_utf8_lossy(&output)
				)));
			}
		}
	}
	Err(EngineError::ExitBudgetExceeded)
}

impl PvmLinuxTemplate {
	/// Returns the console bytes emitted before checkpoint publication.
	#[must_use]
	pub fn warm_output(&self) -> &[u8] {
		&self.warm_output
	}

	/// Returns boot-to-checkpoint wall time.
	#[must_use]
	pub const fn warmup_latency(&self) -> Duration {
		self.warmup_latency
	}

	/// Returns CPU/device capture plus RAM sealing wall time.
	#[must_use]
	pub const fn snapshot_latency(&self) -> Duration {
		self.snapshot_latency
	}

	/// Returns the sealed RAM memfd identity shared by clone mappings.
	#[must_use]
	pub fn memory_backing_id(&self) -> u64 {
		self.memory.backing_id()
	}

	/// Returns the EROFS backing inode shared by clone mappings.
	#[must_use]
	pub fn rootfs_backing_id(&self) -> u64 {
		self.read_only_layers[0].image.backing_id()
	}

	/// Returns the optional application EROFS backing inode.
	#[must_use]
	pub fn appfs_backing_id(&self) -> Option<u64> {
		self.read_only_layers
			.get(1)
			.map(|layer| layer.image.backing_id())
	}

	/// Returns all immutable filesystem backing inodes in base-to-app order.
	#[must_use]
	pub fn read_only_backing_ids(&self) -> Vec<u64> {
		self.read_only_layers
			.iter()
			.map(|layer| layer.image.backing_id())
			.collect()
	}

	/// Returns the writable RAM baseline size in bytes.
	#[must_use]
	pub fn memory_size(&self) -> usize {
		self.memory.len()
	}

	/// Returns whether each clone receives a private writable block volume.
	#[must_use]
	pub const fn has_writable_block(&self) -> bool {
		self.block.is_some()
	}

	/// Returns how the warm writable-disk baseline was materialized.
	///
	/// `None` means either no block device or a database-backed O(1) snapshot;
	/// use [`Self::has_writable_block`] to distinguish those cases.
	#[must_use]
	pub fn block_snapshot_method(&self) -> Option<PvmBlockCloneMethod> {
		match self.block.as_ref() {
			Some(PvmLinuxBlockTemplate::File(block)) => Some(block.snapshot_method()),
			Some(PvmLinuxBlockTemplate::Sqlite(_)) | None => None,
		}
	}

	/// Returns whether clones fork a SQLite/FDB-style logical volume instead
	/// of materializing a block-image file.
	#[must_use]
	pub const fn has_database_backed_block(&self) -> bool {
		matches!(self.block, Some(PvmLinuxBlockTemplate::Sqlite(_)))
	}
}

impl PvmLinuxInstance {
	/// Returns a cloneable capability for terminally cancelling this runner.
	///
	/// The handle can move to a control thread before the instance moves to
	/// its dedicated runner thread. Cancellation is one-shot: destroy the
	/// instance after it returns [`RunOutcome::Cancelled`].
	#[must_use]
	pub fn run_canceller(&self) -> PvmRunCanceller {
		self.machine.run_canceller()
	}

	/// Returns a cloneable high-level command and file client for the in-guest agent.
	#[must_use]
	pub fn sandbox_control(&self) -> crate::control::SandboxControl {
		crate::control::SandboxControl::new(self.broker.ingress_handle())
	}

	/// Returns a cloneable bounded filesystem client for the in-guest agent.
	#[must_use]
	pub fn sandbox_files(&self) -> crate::control::SandboxFiles {
		self.sandbox_control().files()
	}

	/// Returns a cloneable host entrance for explicitly injecting accepted
	/// IPv4 TCP streams while the vCPU is running on another thread.
	#[must_use]
	pub fn socket_ingress(&self) -> pvm_socket_service::SocketIngressHandle {
		self.broker.ingress_handle()
	}

	/// Configures this VM's KVM halt-poll ceiling in nanoseconds.
	///
	/// # Errors
	///
	/// Returns [`EngineError::Pvm`] when the provider rejects the capability.
	pub fn set_halt_poll_ns(&self, nanoseconds: u64) -> Result<(), EngineError> {
		self.machine
			.set_halt_poll_ns(nanoseconds)
			.map_err(EngineError::Pvm)
	}

	/// Returns cumulative host-only KVM/PVM run attribution counters.
	#[must_use]
	pub fn run_stats(&self) -> PvmRunStats {
		self.machine.run_stats()
	}

	/// Returns host-only socket broker attribution counters.
	#[must_use]
	pub fn socket_stats(&self) -> BrokerStats {
		self.broker.stats()
	}

	/// Resets host-only KVM/PVM run attribution counters.
	pub fn reset_run_stats(&mut self) {
		self.machine.reset_run_stats();
	}

	/// Runs this live clone until exit or the supplied host deadline.
	///
	/// This leaves the VM reusable after a timeout and is intended for
	/// steady-state idle attribution after a separate readiness boundary.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for guest faults, invalid exits, or device
	/// failures.
	pub fn run_for(&mut self, options: RunOptions) -> Result<RunResult, EngineError> {
		run_linux_machine(&mut self.machine, &self.broker, options)
	}

	/// Runs a restored Python/Linux clone through its immediate and completed markers.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] on deadline, output bound, guest failure, or if
	/// either expected marker is not observed.
	#[allow(clippy::too_many_lines)]
	pub fn run_until_markers(
		&mut self,
		resumed_marker: &[u8],
		completed_marker: &[u8],
		options: RunOptions,
	) -> Result<PvmLinuxCloneResult, EngineError> {
		validate_clone_markers(resumed_marker, completed_marker)?;
		let started = Instant::now();
		let mut resumed_latency = None;
		let mut output = Vec::new();
		let create_latency = self.create_latency;
		let page_reports = &mut self.page_reports;
		let reclaimed_pages = &mut self.reclaimed_pages;
		let broker = &self.broker;
		let mut run = self
			.machine
			.start_timed_run(options.timeout)
			.map_err(EngineError::Pvm)?;
		for _ in 0..MAX_LINUX_HOST_EXITS {
			match run.run_once().map_err(EngineError::Pvm)? {
				PvmExit::ConsoleWrite { data } => {
					append_captured_output(&mut output, &data)?;
					if resumed_latency.is_none() && contains_bytes(&output, resumed_marker) {
						resumed_latency = Some(started.elapsed());
					}
					if contains_bytes(&output, completed_marker) {
						let completion_latency = started.elapsed();
						let measured_resume_latency = resumed_latency.ok_or_else(|| {
							EngineError::LinuxCheckpoint(format!(
								"completion marker preceded resume marker; console: {}",
								String::from_utf8_lossy(&output)
							))
						})?;
						let private_pages = run.private_page_count().map_err(EngineError::Pvm)?;
						let socket_stats = broker.stats();
						let run_stats = run.run_stats();
						return Ok(PvmLinuxCloneResult {
							create_latency,
							resume_latency: measured_resume_latency,
							completion_latency,
							private_pages,
							reclaimed_pages: *reclaimed_pages,
							page_reports: *page_reports,
							socket_stats,
							run_stats,
							output,
						});
					}
				}
				PvmExit::GuestExit { status } => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"clone exited with status {status} before completion; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::IoOut { port, data }
					if port == PVM_HYPERCALL_PORT
						&& decode_pvm_hypercall(&data) == Some(PvmHypercall::BenchmarkPoint) =>
				{
					resumed_latency.get_or_insert_with(|| started.elapsed());
				}
				PvmExit::IoOut { port, data }
					if port == PVM_HYPERCALL_PORT
						&& decode_pvm_hypercall(&data) == Some(PvmHypercall::PageReport) =>
				{
					reclaim_reported_pages(&mut run, page_reports, reclaimed_pages)?;
				}
				PvmExit::Halted => {}
				PvmExit::TimedOut => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"clone timed out; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::Cancelled => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"clone runner was cancelled; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::Shutdown => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"clone shut down before completion; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::Event {
					vector,
					error_code,
					address,
				} => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"clone event {vector} error {error_code:#x} at {address:#x}; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::ReadOnlyMemoryWrite { address, data } => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"clone wrote read-only image at {address:#x}, data {data:02x?}; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::ServiceNotify { queues } => {
					let _ = queues;
					broker
						.notify_guest_requests()
						.map_err(|error| EngineError::SocketService(error.to_string()))?;
				}
				PvmExit::IoOut { port, data } => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"unexpected clone I/O port {port:#x}, data {data:02x?}; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
				PvmExit::WaitUntil { .. } => {
					return Err(EngineError::UnexpectedExit(
						"WAIT_UNTIL escaped the timed PVM runner".to_owned(),
					));
				}
				PvmExit::Unexpected { description } => {
					return Err(EngineError::LinuxCheckpoint(format!(
						"{description}; console: {}",
						String::from_utf8_lossy(&output)
					)));
				}
			}
		}
		Err(EngineError::ExitBudgetExceeded)
	}
}

fn reclaim_reported_pages(
	machine: &mut PvmMachine,
	page_reports: &mut usize,
	reclaimed_pages: &mut usize,
) -> Result<(), EngineError> {
	*page_reports = page_reports
		.checked_add(1)
		.ok_or_else(|| EngineError::LinuxCheckpoint("page-report counter overflowed".to_owned()))?;
	*reclaimed_pages = reclaimed_pages
		.checked_add(machine.handle_page_report().map_err(EngineError::Pvm)?)
		.ok_or_else(|| {
			EngineError::LinuxCheckpoint("reclaimed page counter overflowed".to_owned())
		})?;
	Ok(())
}

fn validate_clone_markers(resumed: &[u8], completed: &[u8]) -> Result<(), EngineError> {
	if resumed.is_empty() || completed.is_empty() {
		return Err(EngineError::LinuxCheckpoint(
			"both clone output markers must be nonempty".to_owned(),
		));
	}
	Ok(())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
	haystack
		.windows(needle.len())
		.any(|window| window == needle)
}

fn decode_pvm_hypercall(data: &[u8]) -> Option<PvmHypercall> {
	let bytes: [u8; std::mem::size_of::<u32>()] = data.try_into().ok()?;
	PvmHypercall::decode(u32::from_le_bytes(bytes))
}

fn diagnostic_page_walk(
	machine: &PvmMachine,
	cr3: u64,
	linear_address: u64,
) -> Result<Vec<(u64, u64)>, EngineError> {
	let mut table = cr3 & X86_PTE_ADDRESS_MASK;
	let mut entries = Vec::with_capacity(4);
	for shift in [39, 30, 21, 12] {
		let index = (linear_address >> shift) & 0x1ff;
		let entry_address = table
			.checked_add(index * 8)
			.ok_or(EngineError::InvalidCowFault)?;
		let bytes = machine
			.read_memory(entry_address, 8)
			.map_err(EngineError::Pvm)?;
		let entry = u64::from_le_bytes(bytes.try_into().map_err(|_| EngineError::InvalidCowFault)?);
		entries.push((entry_address, entry));
		if entry & X86_PTE_PRESENT == 0 || (shift > 12 && entry & X86_PTE_PAGE_SIZE != 0) {
			break;
		}
		table = entry & X86_PTE_ADDRESS_MASK;
	}
	Ok(entries)
}

fn diagnostic_words(
	machine: &PvmMachine,
	guest_address: u64,
	count: usize,
) -> Result<Vec<u64>, EngineError> {
	if guest_address == 0 {
		return Ok(Vec::new());
	}
	let byte_count = count
		.checked_mul(size_of::<u64>())
		.ok_or(EngineError::InvalidCowFault)?;
	let bytes = machine
		.read_memory(guest_address, byte_count)
		.map_err(EngineError::Pvm)?;
	Ok(bytes
		.chunks_exact(size_of::<u64>())
		.map(|word| u64::from_le_bytes(word.try_into().expect("eight-byte chunk")))
		.collect())
}

impl Template {
	/// Copies bytes from the immutable baseline.
	///
	/// # Errors
	///
	/// Returns [`EngineError::Pvm`] if the range is outside guest memory.
	pub fn read_memory(
		&self,
		address: GuestAddress,
		length: usize,
	) -> Result<Vec<u8>, EngineError> {
		self.memory
			.read_memory(address.get(), length)
			.map_err(EngineError::Pvm)
	}

	/// Returns the sealed memfd identity shared by every child mapping.
	#[must_use]
	pub fn backing_id(&self) -> u64 {
		self.memory.backing_id()
	}

	/// Returns the number of live private data pages across current children.
	#[must_use]
	pub fn live_private_data_pages(&self) -> usize {
		self.live_private_data_pages.load(Ordering::Acquire)
	}

	/// Returns the number of writable pages sealed into the COW plan.
	#[must_use]
	pub fn cow_page_count(&self) -> usize {
		self.cow_pages.len()
	}

	/// Returns whether this template resumes a warmed Actor-turn checkpoint.
	#[must_use]
	pub const fn is_actor_template(&self) -> bool {
		self.mailbox.is_some()
	}
}

impl TurnInstance {
	/// Executes this one-shot instance with the default deadline.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for PVM, syscall, COW, or lifecycle failures.
	pub fn run(&mut self) -> Result<RunResult, EngineError> {
		self.run_with_options(RunOptions::default())
	}

	/// Executes this one-shot instance with explicit host limits.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] for PVM, syscall, COW, or lifecycle failures.
	pub fn run_with_options(&mut self, options: RunOptions) -> Result<RunResult, EngineError> {
		if self.mailbox.is_some() {
			return Err(EngineError::InvalidActorProtocol);
		}
		self.execute(options)
	}

	/// Injects one JSON payload and executes a warmed Actor turn.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] if the instance is not actor-backed, the input
	/// exceeds its mailbox, or PVM/syscall/COW execution fails.
	pub fn run_turn(&mut self, input: &[u8]) -> Result<RunResult, EngineError> {
		self.run_turn_with_options(input, RunOptions::default())
	}

	/// Injects one JSON payload and executes with explicit host limits.
	///
	/// # Errors
	///
	/// Returns [`EngineError`] under the same contracts as [`Self::run_turn`].
	pub fn run_turn_with_options(
		&mut self,
		input: &[u8],
		options: RunOptions,
	) -> Result<RunResult, EngineError> {
		if self.has_run {
			return Err(EngineError::InstanceAlreadyRun);
		}
		let mailbox = self.mailbox.ok_or(EngineError::InvalidActorProtocol)?;
		if input.len() > mailbox.capacity {
			return Err(EngineError::ActorPayloadTooLarge);
		}
		self.machine
			.write_memory(mailbox.address.get(), input)
			.map_err(EngineError::Pvm)?;
		self.machine
			.set_rax(u64::try_from(input.len()).map_err(|_| EngineError::ActorPayloadTooLarge)?)
			.map_err(EngineError::Pvm)?;
		self.execute(options)
	}

	fn execute(&mut self, options: RunOptions) -> Result<RunResult, EngineError> {
		if self.has_run {
			return Err(EngineError::InstanceAlreadyRun);
		}
		self.has_run = true;
		let cow = CowFaultState {
			pages: &self.cow_pages,
			dirty_pages: &mut self.dirty_pages,
			cow_faults: &mut self.cow_faults,
			live_private_data_pages: &self.live_private_data_pages,
		};
		run_machine(
			&mut self.machine,
			self.user_cr3,
			options,
			Some(cow),
			self.linux_process.as_mut(),
			None,
		)
	}

	/// Copies bytes from this child's private guest-memory view.
	///
	/// # Errors
	///
	/// Returns [`EngineError::Pvm`] if the range is outside guest memory.
	pub fn read_memory(
		&self,
		address: GuestAddress,
		length: usize,
	) -> Result<Vec<u8>, EngineError> {
		self.machine
			.read_memory(address.get(), length)
			.map_err(EngineError::Pvm)
	}

	/// Returns this instance's COW counters.
	#[must_use]
	pub fn stats(&self) -> CowStats {
		CowStats {
			dirty_data_pages: self.dirty_pages.len(),
			cow_faults: self.cow_faults,
		}
	}

	/// Returns the sealed backing identity shared with its template.
	#[must_use]
	pub fn backing_id(&self) -> u64 {
		self.backing_id
	}
}

impl Drop for TurnInstance {
	fn drop(&mut self) {
		self.live_private_data_pages
			.fetch_sub(self.dirty_pages.len(), Ordering::AcqRel);
	}
}

impl From<LinuxProcessLayout> for LinuxProcessState {
	fn from(layout: LinuxProcessLayout) -> Self {
		Self {
			brk_current: layout.brk_start().get(),
			brk_start: layout.brk_start().get(),
			brk_limit: layout.brk_limit().get(),
			stack_limit: layout.stack_limit(),
			stdin: Vec::new(),
			stdin_offset: 0,
			mmap_start: layout.mmap_start().get(),
			mmap_next: layout.mmap_start().get(),
			mmap_limit: layout.mmap_limit().get(),
			mappings: BTreeMap::new(),
			runtime_files: BTreeMap::new(),
			open_files: BTreeMap::new(),
			next_file_descriptor: 3,
			standard_descriptors: [true; 3],
			signal_actions: BTreeMap::new(),
			alternate_signal_stack: {
				let mut stack = [0_u8; 24];
				stack[8..12].copy_from_slice(&2_u32.to_le_bytes());
				stack
			},
			cow_sealing: false,
			started: Instant::now(),
			executable_name: layout.executable_name(),
		}
	}
}

struct CowFaultState<'a> {
	pages: &'a CowPagePlan,
	dirty_pages: &'a mut BTreeSet<GuestAddress>,
	cow_faults: &'a mut usize,
	live_private_data_pages: &'a AtomicUsize,
}

#[allow(clippy::too_many_lines)]
fn run_machine(
	machine: &mut PvmMachine,
	user_cr3: u64,
	options: RunOptions,
	mut cow: Option<CowFaultState<'_>>,
	mut linux: Option<&mut LinuxProcessState>,
	mut linux_writable_pages: Option<&mut CowPagePlan>,
) -> Result<RunResult, EngineError> {
	let mut output = Vec::new();
	let mut run = machine
		.start_timed_run(options.timeout)
		.map_err(EngineError::Pvm)?;
	for _ in 0..MAX_HOST_EXITS {
		match run.run_once().map_err(EngineError::Pvm)? {
			PvmExit::IoOut { port, data } if port == SYSCALL_PORT => {
				let syscall = decode_syscall(&data)?;
				let registers = run.registers().map_err(EngineError::Pvm)?;
				match syscall {
					SYS_EXIT | SYS_EXIT_GROUP => {
						let code = i32::try_from(registers.rdi)
							.map_err(|_| EngineError::InvalidExitCode)?;
						return Ok(RunResult {
							outcome: RunOutcome::Exited { code },
							output,
						});
					}
					SYS_WRITE | SYS_WRITEV => {
						let result = if linux.as_deref().is_some_and(|process| {
							!standard_descriptor_is_open(process, registers.rdi)
						}) {
							negative_errno(9)
						} else {
							capture_output_syscall(&run, user_cr3, syscall, registers, &mut output)?
						};
						run.set_rax(result).map_err(EngineError::Pvm)?;
					}
					_ => {
						let result = if let Some(process) = linux.as_deref_mut() {
							service_linux_syscall(
								&mut run,
								process,
								linux_writable_pages.as_deref_mut(),
								user_cr3,
								syscall,
								registers,
							)?
							.unwrap_or_else(|| negative_errno(38))
						} else {
							negative_errno(38)
						};
						run.set_rax(result).map_err(EngineError::Pvm)?;
					}
				}
			}
			PvmExit::ConsoleWrite { data } => {
				append_captured_output(&mut output, &data)?;
			}
			PvmExit::GuestExit { status } => {
				return Ok(RunResult {
					outcome: RunOutcome::Exited {
						code: i32::from(status),
					},
					output,
				});
			}
			PvmExit::IoOut { port: 0xe9, .. } => {
				return Ok(RunResult {
					outcome: RunOutcome::GuestFault,
					output,
				});
			}
			PvmExit::Event {
				vector,
				error_code,
				address,
			} => {
				if let Some(cow) = cow.as_mut()
					&& handle_cow_fault(&mut run, cow, vector, error_code, address)?
				{
					continue;
				}
				return Ok(RunResult {
					outcome: RunOutcome::GuestFault,
					output,
				});
			}
			PvmExit::Halted => {
				return Ok(RunResult {
					outcome: RunOutcome::Halted,
					output,
				});
			}
			PvmExit::Shutdown => {
				return Ok(RunResult {
					outcome: RunOutcome::Shutdown,
					output,
				});
			}
			PvmExit::TimedOut => {
				return Ok(RunResult {
					outcome: RunOutcome::TimedOut,
					output,
				});
			}
			PvmExit::Cancelled => {
				return Ok(RunResult {
					outcome: RunOutcome::Cancelled,
					output,
				});
			}
			PvmExit::WaitUntil { .. } => {
				return Err(EngineError::UnexpectedExit(
					"WAIT_UNTIL escaped the timed PVM runner".to_owned(),
				));
			}
			PvmExit::Unexpected { description } => {
				return Err(EngineError::UnexpectedExit(description));
			}
			PvmExit::ReadOnlyMemoryWrite { address, data } => {
				return Err(EngineError::UnexpectedExit(format!(
					"guest write to read-only memory at {address:#x}, data {data:02x?}"
				)));
			}
			PvmExit::ServiceNotify { queues } => {
				return Err(EngineError::UnexpectedExit(format!(
					"service queue notification {:#x} without a configured broker",
					queues.bits()
				)));
			}
			PvmExit::IoOut { port, data } => {
				return Err(EngineError::UnexpectedExit(format!(
					"I/O port {port:#x}, data {data:02x?}"
				)));
			}
		}
	}
	Err(EngineError::ExitBudgetExceeded)
}

fn decode_syscall(data: &[u8]) -> Result<u32, EngineError> {
	Ok(u32::from_le_bytes(
		data.try_into()
			.map_err(|_| EngineError::InvalidSyscallExit)?,
	))
}

fn capture_write(
	machine: &PvmMachine,
	user_cr3: u64,
	registers: PvmRegisters,
	output: &mut Vec<u8>,
) -> Result<u64, EngineError> {
	if registers.rdi != 1 && registers.rdi != 2 {
		return Ok(negative_errno(9));
	}
	let length = usize::try_from(registers.rdx).map_err(|_| EngineError::InvalidSyscallExit)?;
	let Some(bytes) = read_user_memory(machine, user_cr3, registers.rsi, length)? else {
		return Ok(negative_errno(14));
	};
	append_captured_output(output, &bytes)?;
	Ok(registers.rdx)
}

fn capture_output_syscall(
	machine: &PvmMachine,
	user_cr3: u64,
	syscall: u32,
	registers: PvmRegisters,
	output: &mut Vec<u8>,
) -> Result<u64, EngineError> {
	match syscall {
		SYS_WRITE => capture_write(machine, user_cr3, registers, output),
		SYS_WRITEV => capture_writev(machine, user_cr3, registers, output),
		_ => Err(EngineError::InvalidSyscallExit),
	}
}

fn capture_writev(
	machine: &PvmMachine,
	user_cr3: u64,
	registers: PvmRegisters,
	output: &mut Vec<u8>,
) -> Result<u64, EngineError> {
	if registers.rdi != 1 && registers.rdi != 2 {
		return Ok(negative_errno(9));
	}
	let count = usize::try_from(registers.rdx).map_err(|_| EngineError::InvalidSyscallExit)?;
	if count > MAX_IO_VECTORS {
		return Ok(negative_errno(22));
	}
	let descriptor_bytes = count
		.checked_mul(2 * size_of::<u64>())
		.ok_or(EngineError::InvalidSyscallExit)?;
	let Some(descriptors) = read_user_memory(machine, user_cr3, registers.rsi, descriptor_bytes)?
	else {
		return Ok(negative_errno(14));
	};
	let mut captured = Vec::new();
	for descriptor in descriptors.chunks_exact(2 * size_of::<u64>()) {
		let address = u64::from_le_bytes(
			descriptor[..8]
				.try_into()
				.map_err(|_| EngineError::InvalidSyscallExit)?,
		);
		let length = usize::try_from(u64::from_le_bytes(
			descriptor[8..]
				.try_into()
				.map_err(|_| EngineError::InvalidSyscallExit)?,
		))
		.map_err(|_| EngineError::InvalidSyscallExit)?;
		if captured
			.len()
			.checked_add(length)
			.is_none_or(|total| total > MAX_CAPTURED_OUTPUT)
		{
			return Err(EngineError::OutputLimitExceeded);
		}
		let Some(bytes) = read_user_memory(machine, user_cr3, address, length)? else {
			return Ok(negative_errno(14));
		};
		captured.extend(bytes);
	}
	let length = u64::try_from(captured.len()).map_err(|_| EngineError::InvalidSyscallExit)?;
	append_captured_output(output, &captured)?;
	Ok(length)
}

fn append_captured_output(output: &mut Vec<u8>, bytes: &[u8]) -> Result<(), EngineError> {
	if output
		.len()
		.checked_add(bytes.len())
		.is_none_or(|total| total > MAX_CAPTURED_OUTPUT)
	{
		return Err(EngineError::OutputLimitExceeded);
	}
	output.extend_from_slice(bytes);
	Ok(())
}

#[allow(clippy::too_many_lines)]
fn service_linux_syscall(
	machine: &mut PvmMachine,
	process: &mut LinuxProcessState,
	writable_pages: Option<&mut CowPagePlan>,
	user_cr3: u64,
	syscall: u32,
	registers: PvmRegisters,
) -> Result<Option<u64>, EngineError> {
	const ARCH_SET_FS: u64 = 0x1002;
	const AT_FDCWD: u64 = (-100_i64).cast_unsigned();
	const AT_FDCWD_32: u64 = 0xffff_ff9c;
	const AT_EMPTY_PATH: u64 = 0x1000;
	const O_CLOEXEC: u64 = 0x8_0000;
	const RLIMIT_STACK: u64 = 3;
	const PROT_READ: u64 = 1;
	const PROT_WRITE: u64 = 2;
	const PROT_EXEC: u64 = 4;
	let result = match syscall {
		SYS_READ => {
			let requested =
				usize::try_from(registers.rdx).map_err(|_| EngineError::InvalidSyscallExit)?;
			if requested > MAX_CAPTURED_OUTPUT {
				negative_errno(22)
			} else if let Some(bytes) = read_virtual_descriptor(process, registers.rdi, requested) {
				let Some(pages) = writable_pages.as_deref() else {
					return Ok(Some(negative_errno(38)));
				};
				if write_linux_user_memory(machine, user_cr3, pages, registers.rsi, &bytes)? {
					u64::try_from(bytes.len()).map_err(|_| EngineError::InvalidSyscallExit)?
				} else {
					negative_errno(14)
				}
			} else {
				negative_errno(9)
			}
		}
		SYS_PREAD64 => {
			let requested =
				usize::try_from(registers.rdx).map_err(|_| EngineError::InvalidSyscallExit)?;
			let offset =
				usize::try_from(registers.r10).map_err(|_| EngineError::InvalidSyscallExit)?;
			if requested > MAX_CAPTURED_OUTPUT {
				negative_errno(22)
			} else if let Some(bytes) =
				pread_virtual_descriptor(process, registers.rdi, offset, requested)
			{
				let Some(pages) = writable_pages.as_deref() else {
					return Ok(Some(negative_errno(38)));
				};
				if write_linux_user_memory(machine, user_cr3, pages, registers.rsi, &bytes)? {
					u64::try_from(bytes.len()).map_err(|_| EngineError::InvalidSyscallExit)?
				} else {
					negative_errno(14)
				}
			} else {
				negative_errno(9)
			}
		}
		SYS_ACCESS => {
			let Some(path) = read_guest_c_string(machine, user_cr3, registers.rdi, 4096)? else {
				return Ok(Some(negative_errno(14)));
			};
			if !matches!(registers.rsi, 0 | 4) {
				negative_errno(13)
			} else if process.runtime_files.contains_key(&path) {
				0
			} else {
				negative_errno(2)
			}
		}
		SYS_OPENAT => {
			let Some(path) = read_guest_c_string(machine, user_cr3, registers.rsi, 4096)? else {
				return Ok(Some(negative_errno(14)));
			};
			if !matches!(registers.rdi, AT_FDCWD | AT_FDCWD_32) || registers.rdx & !O_CLOEXEC != 0 {
				negative_errno(22)
			} else {
				open_virtual_file(process, &path)
			}
		}
		SYS_CLOSE => {
			if let Ok(index) = usize::try_from(registers.rdi)
				&& let Some(open) = process.standard_descriptors.get_mut(index)
				&& *open
			{
				*open = false;
				0
			} else if process.open_files.remove(&registers.rdi).is_some() {
				0
			} else {
				negative_errno(9)
			}
		}
		SYS_FSTAT => {
			let Some(file) = process.open_files.get(&registers.rdi) else {
				return Ok(Some(negative_errno(9)));
			};
			let stat = virtual_stat(file.bytes.len(), file.inode)?;
			let Some(pages) = writable_pages.as_deref() else {
				return Ok(Some(negative_errno(38)));
			};
			if write_linux_user_memory(machine, user_cr3, pages, registers.rsi, &stat)? {
				0
			} else {
				negative_errno(14)
			}
		}
		SYS_POLL => {
			let count =
				usize::try_from(registers.rsi).map_err(|_| EngineError::InvalidSyscallExit)?;
			if count > MAX_IO_VECTORS || registers.rdx != 0 {
				negative_errno(22)
			} else {
				let byte_length = count
					.checked_mul(8)
					.ok_or(EngineError::InvalidSyscallExit)?;
				let Some(mut descriptors) =
					read_user_memory(machine, user_cr3, registers.rdi, byte_length)?
				else {
					return Ok(Some(negative_errno(14)));
				};
				let mut ready = 0_u64;
				for descriptor in descriptors.chunks_exact_mut(8) {
					let descriptor_number = i32::from_le_bytes(
						descriptor[..4]
							.try_into()
							.map_err(|_| EngineError::InvalidSyscallExit)?,
					);
					let events = i16::from_le_bytes(
						descriptor[4..6]
							.try_into()
							.map_err(|_| EngineError::InvalidSyscallExit)?,
					);
					let revents = poll_virtual_descriptor(process, descriptor_number, events);
					descriptor[6..8].copy_from_slice(&revents.to_le_bytes());
					ready += u64::from(revents != 0);
				}
				let Some(pages) = writable_pages.as_deref() else {
					return Ok(Some(negative_errno(38)));
				};
				if write_linux_user_memory(machine, user_cr3, pages, registers.rdi, &descriptors)? {
					ready
				} else {
					negative_errno(14)
				}
			}
		}
		SYS_NEWFSTATAT => {
			let Some(path) = read_guest_c_string(machine, user_cr3, registers.rsi, 4096)? else {
				return Ok(Some(negative_errno(14)));
			};
			let file = if path.is_empty() && registers.r10 == AT_EMPTY_PATH {
				process
					.open_files
					.get(&registers.rdi)
					.map(|file| (file.bytes.len(), file.inode))
			} else if matches!(registers.rdi, AT_FDCWD | AT_FDCWD_32) && registers.r10 == 0 {
				process
					.runtime_files
					.get(&path)
					.map(|file| (file.bytes.len(), file.inode))
			} else {
				None
			};
			let Some((size, inode)) = file else {
				return Ok(Some(negative_errno(2)));
			};
			let stat = virtual_stat(size, inode)?;
			let Some(pages) = writable_pages.as_deref() else {
				return Ok(Some(negative_errno(38)));
			};
			if write_linux_user_memory(machine, user_cr3, pages, registers.rdx, &stat)? {
				0
			} else {
				negative_errno(14)
			}
		}
		SYS_BRK => {
			let requested = registers.rdi;
			if requested >= process.brk_start && requested <= process.brk_limit {
				process.brk_current = requested;
			}
			process.brk_current
		}
		SYS_RT_SIGACTION => {
			let signal =
				u32::try_from(registers.rdi).map_err(|_| EngineError::InvalidSyscallExit)?;
			if !(1..=64).contains(&signal)
				|| registers.r10 != 8
				|| (registers.rsi != 0 && matches!(signal, 9 | 19))
			{
				negative_errno(22)
			} else {
				let action = if registers.rsi == 0 {
					None
				} else {
					let Some(bytes) = read_user_memory(machine, user_cr3, registers.rsi, 32)?
					else {
						return Ok(Some(negative_errno(14)));
					};
					Some(
						bytes
							.try_into()
							.map_err(|_| EngineError::InvalidSyscallExit)?,
					)
				};
				if registers.rdx != 0 {
					let previous = process
						.signal_actions
						.get(&signal)
						.copied()
						.unwrap_or([0; 32]);
					let Some(pages) = writable_pages.as_deref() else {
						return Ok(Some(negative_errno(38)));
					};
					if !write_linux_user_memory(machine, user_cr3, pages, registers.rdx, &previous)?
					{
						return Ok(Some(negative_errno(14)));
					}
				}
				if let Some(action) = action {
					process.signal_actions.insert(signal, action);
				}
				0
			}
		}
		SYS_MMAP => {
			let Some(pages) = writable_pages.as_deref() else {
				return Ok(Some(negative_errno(38)));
			};
			service_process_mmap(machine, process, pages, registers)?
		}
		SYS_MUNMAP => {
			let length =
				usize::try_from(registers.rsi).map_err(|_| EngineError::InvalidSyscallExit)?;
			let Some(rounded) = page_rounded_length(length) else {
				return Ok(Some(negative_errno(22)));
			};
			let end = registers
				.rdi
				.checked_add(u64::try_from(rounded).map_err(|_| EngineError::InvalidSyscallExit)?);
			if registers.rdi & 0xfff != 0
				|| registers.rdi < process.mmap_start
				|| end.is_none_or(|end| end > process.mmap_limit)
			{
				negative_errno(22)
			} else {
				unmap_process_range(machine, process, registers.rdi, rounded)?;
				0
			}
		}
		SYS_GETPID | SYS_SET_TID_ADDRESS => 1,
		SYS_UNAME => {
			let Some(pages) = writable_pages.as_deref() else {
				return Ok(Some(negative_errno(38)));
			};
			let bytes = virtual_utsname();
			if write_linux_user_memory(machine, user_cr3, pages, registers.rdi, &bytes)? {
				0
			} else {
				negative_errno(14)
			}
		}
		SYS_CLOCK_GETTIME => {
			let duration = match registers.rdi {
				0 => SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.map_err(|error| EngineError::HostClock(error.to_string()))?,
				1 => process.started.elapsed(),
				_ => return Ok(Some(negative_errno(22))),
			};
			let seconds =
				i64::try_from(duration.as_secs()).map_err(|_| EngineError::InvalidSyscallExit)?;
			let nanoseconds = i64::from(duration.subsec_nanos());
			let mut bytes = Vec::with_capacity(2 * size_of::<i64>());
			bytes.extend(seconds.to_le_bytes());
			bytes.extend(nanoseconds.to_le_bytes());
			let Some(pages) = writable_pages.as_deref() else {
				return Ok(Some(negative_errno(38)));
			};
			if write_linux_user_memory(machine, user_cr3, pages, registers.rsi, &bytes)? {
				0
			} else {
				negative_errno(14)
			}
		}
		SYS_ARCH_PRCTL if registers.rdi == ARCH_SET_FS => {
			machine
				.set_fs_base(registers.rsi)
				.map_err(EngineError::Pvm)?;
			0
		}
		SYS_ARCH_PRCTL => negative_errno(22),
		SYS_SIGALTSTACK => {
			let replacement = if registers.rdi == 0 {
				None
			} else {
				let Some(bytes) = read_user_memory(machine, user_cr3, registers.rdi, 24)? else {
					return Ok(Some(negative_errno(14)));
				};
				Some(
					bytes
						.try_into()
						.map_err(|_| EngineError::InvalidSyscallExit)?,
				)
			};
			if registers.rsi != 0 {
				let Some(pages) = writable_pages.as_deref() else {
					return Ok(Some(negative_errno(38)));
				};
				if !write_linux_user_memory(
					machine,
					user_cr3,
					pages,
					registers.rsi,
					&process.alternate_signal_stack,
				)? {
					return Ok(Some(negative_errno(14)));
				}
			}
			if let Some(replacement) = replacement {
				process.alternate_signal_stack = replacement;
			}
			0
		}
		SYS_SET_ROBUST_LIST => {
			if registers.rsi == 24 {
				0
			} else {
				negative_errno(22)
			}
		}
		SYS_RSEQ => negative_errno(38),
		SYS_PRLIMIT64 => {
			if registers.rdi != 0 || registers.rsi != RLIMIT_STACK || registers.rdx != 0 {
				negative_errno(22)
			} else {
				if registers.r10 != 0 {
					let Some(pages) = writable_pages.as_deref() else {
						return Ok(Some(negative_errno(38)));
					};
					let mut limit = Vec::with_capacity(2 * size_of::<u64>());
					limit.extend(process.stack_limit.to_le_bytes());
					limit.extend(process.stack_limit.to_le_bytes());
					if !write_linux_user_memory(machine, user_cr3, pages, registers.r10, &limit)? {
						return Ok(Some(negative_errno(14)));
					}
				}
				0
			}
		}
		SYS_READLINK => service_executable_readlink(
			machine,
			process,
			writable_pages.as_deref(),
			user_cr3,
			registers.rdi,
			registers.rsi,
			registers.rdx,
		)?,
		SYS_READLINKAT => {
			if matches!(registers.rdi, AT_FDCWD | AT_FDCWD_32) {
				service_executable_readlink(
					machine,
					process,
					writable_pages.as_deref(),
					user_cr3,
					registers.rsi,
					registers.rdx,
					registers.r10,
				)?
			} else {
				negative_errno(9)
			}
		}
		SYS_GETRANDOM => {
			let length =
				usize::try_from(registers.rsi).map_err(|_| EngineError::InvalidSyscallExit)?;
			if length > 64 * 1024 {
				negative_errno(22)
			} else {
				let Some(pages) = writable_pages.as_deref() else {
					return Ok(Some(negative_errno(38)));
				};
				let mut bytes = vec![0; length];
				fill_host_random(&mut bytes)?;
				if write_linux_user_memory(machine, user_cr3, pages, registers.rdi, &bytes)? {
					registers.rsi
				} else {
					negative_errno(14)
				}
			}
		}
		SYS_MPROTECT => {
			let length =
				usize::try_from(registers.rsi).map_err(|_| EngineError::InvalidSyscallExit)?;
			if registers.rdx & PROT_WRITE != 0 && registers.rdx & PROT_EXEC != 0 {
				negative_errno(13)
			} else if registers.rdi & 0xfff != 0
				|| validate_guest_range(machine.memory_len(), registers.rdi, length).is_err()
			{
				negative_errno(22)
			} else {
				match registers.rdx {
					0 => {
						if protect_mapped_range_none(machine, process, registers.rdi, length)? {
							0
						} else {
							negative_errno(12)
						}
					}
					PROT_READ => {
						if let Some(pages) = writable_pages {
							protect_live_range(
								machine,
								pages,
								registers.rdi,
								length,
								process.cow_sealing,
							)?;
							0
						} else {
							negative_errno(38)
						}
					}
					_ => negative_errno(38),
				}
			}
		}
		_ => return Ok(None),
	};
	Ok(Some(result))
}

fn fill_host_random(destination: &mut [u8]) -> Result<(), EngineError> {
	File::open("/dev/urandom")
		.and_then(|mut random| random.read_exact(destination))
		.map_err(|error| EngineError::HostEntropy(error.to_string()))
}

fn load_controlled_runtime(
	program: &Program,
	supplied_files: &[ProcessFile<'_>],
) -> Result<ControlledRuntime, EngineError> {
	let mut files = BTreeMap::new();
	let interpreter = if let Some(path) = program.interpreter() {
		if path != SUPPORTED_INTERPRETER_PATH {
			return Err(EngineError::UnsupportedInterpreter);
		}
		let interpreter_bytes = read_bounded_runtime_file("/lib64/ld-linux-x86-64.so.2")?;
		let interpreter = Program::parse_elf_at_bias(&interpreter_bytes, INTERPRETER_LOAD_BIAS)
			.map_err(EngineError::RuntimeElf)?;
		files.insert(
			SUPPORTED_INTERPRETER_PATH.to_vec(),
			RuntimeFile {
				bytes: Arc::<[u8]>::from(interpreter_bytes),
				inode: 1,
			},
		);
		for (index, &(guest_path, host_path)) in CONTROLLED_RUNTIME_DEPENDENCIES.iter().enumerate()
		{
			files.insert(
				guest_path.to_vec(),
				RuntimeFile {
					bytes: Arc::<[u8]>::from(read_bounded_runtime_file(host_path)?),
					inode: u64::try_from(index + 2).map_err(|_| {
						EngineError::HostRuntime("runtime inode allocation overflow".to_owned())
					})?,
				},
			);
		}
		Some(interpreter)
	} else {
		None
	};
	let mut next_inode =
		u64::try_from(files.len() + 1).map_err(|_| EngineError::InvalidProcessInput)?;
	for file in supplied_files {
		if files.contains_key(file.path) {
			return Err(EngineError::InvalidProcessInput);
		}
		files.insert(
			file.path.to_vec(),
			RuntimeFile {
				bytes: Arc::<[u8]>::from(file.bytes),
				inode: next_inode,
			},
		);
		next_inode = next_inode
			.checked_add(1)
			.ok_or(EngineError::ProcessInputTooLarge)?;
	}
	Ok(ControlledRuntime { interpreter, files })
}

fn read_bounded_runtime_file(path: &str) -> Result<Vec<u8>, EngineError> {
	let file = File::open(path).map_err(|error| EngineError::HostRuntime(error.to_string()))?;
	let limit = u64::try_from(MAX_RUNTIME_FILE_BYTES + 1)
		.map_err(|_| EngineError::HostRuntime("runtime file limit overflow".to_owned()))?;
	let mut bytes = Vec::new();
	file.take(limit)
		.read_to_end(&mut bytes)
		.map_err(|error| EngineError::HostRuntime(error.to_string()))?;
	if bytes.len() > MAX_RUNTIME_FILE_BYTES {
		return Err(EngineError::HostRuntime(
			"runtime file exceeds the 8 MiB bound".to_owned(),
		));
	}
	Ok(bytes)
}

fn open_virtual_file(process: &mut LinuxProcessState, path: &[u8]) -> u64 {
	let Some(file) = process.runtime_files.get(path).cloned() else {
		return negative_errno(2);
	};
	if process.open_files.len() >= MAX_VIRTUAL_FILES {
		return negative_errno(24);
	}
	let descriptor = process.next_file_descriptor;
	let Some(next) = descriptor.checked_add(1) else {
		return negative_errno(24);
	};
	process.next_file_descriptor = next;
	process.open_files.insert(
		descriptor,
		VirtualFile {
			bytes: file.bytes,
			inode: file.inode,
			offset: 0,
		},
	);
	descriptor
}

fn poll_virtual_descriptor(process: &LinuxProcessState, descriptor: i32, events: i16) -> i16 {
	const POLLIN: i16 = 0x0001;
	const POLLOUT: i16 = 0x0004;
	const POLLNVAL: i16 = 0x0020;

	if descriptor < 0 {
		return 0;
	}
	let descriptor = u64::try_from(descriptor).unwrap_or(u64::MAX);
	match descriptor {
		0 if standard_descriptor_is_open(process, descriptor) => events & POLLIN,
		1 | 2 if standard_descriptor_is_open(process, descriptor) => events & POLLOUT,
		descriptor if process.open_files.contains_key(&descriptor) => events & POLLIN,
		_ => POLLNVAL,
	}
}

fn read_virtual_descriptor(
	process: &mut LinuxProcessState,
	descriptor: u64,
	requested: usize,
) -> Option<Vec<u8>> {
	if descriptor == 0 && standard_descriptor_is_open(process, descriptor) {
		let remaining = process.stdin.get(process.stdin_offset..)?;
		let length = requested.min(remaining.len());
		let bytes = remaining[..length].to_vec();
		process.stdin_offset += length;
		return Some(bytes);
	}
	let file = process.open_files.get_mut(&descriptor)?;
	let remaining = file.bytes.get(file.offset..)?;
	let length = requested.min(remaining.len());
	let bytes = remaining[..length].to_vec();
	file.offset += length;
	Some(bytes)
}

fn standard_descriptor_is_open(process: &LinuxProcessState, descriptor: u64) -> bool {
	usize::try_from(descriptor)
		.ok()
		.and_then(|index| process.standard_descriptors.get(index))
		.copied()
		.unwrap_or(false)
}

fn pread_virtual_descriptor(
	process: &LinuxProcessState,
	descriptor: u64,
	offset: usize,
	requested: usize,
) -> Option<Vec<u8>> {
	let file = process.open_files.get(&descriptor)?;
	let remaining = file.bytes.get(offset..)?;
	Some(remaining[..requested.min(remaining.len())].to_vec())
}

fn virtual_stat(size: usize, inode: u64) -> Result<[u8; 144], EngineError> {
	const REGULAR_READ_ONLY_MODE: u32 = 0o100_555;
	let size = i64::try_from(size).map_err(|_| EngineError::InvalidSyscallExit)?;
	let blocks = size
		.checked_add(511)
		.ok_or(EngineError::InvalidSyscallExit)?
		/ 512;
	let mut stat = [0_u8; 144];
	stat[0..8].copy_from_slice(&1_u64.to_le_bytes());
	stat[8..16].copy_from_slice(&inode.to_le_bytes());
	stat[16..24].copy_from_slice(&1_u64.to_le_bytes());
	stat[24..28].copy_from_slice(&REGULAR_READ_ONLY_MODE.to_le_bytes());
	stat[48..56].copy_from_slice(&size.to_le_bytes());
	stat[56..64].copy_from_slice(&4096_i64.to_le_bytes());
	stat[64..72].copy_from_slice(&blocks.to_le_bytes());
	Ok(stat)
}

fn validate_process_inputs(
	arguments: &[&[u8]],
	environment: &[&[u8]],
	stdin: &[u8],
) -> Result<(), EngineError> {
	if arguments.len() > MAX_PROCESS_VECTOR_ENTRIES
		|| environment.len() > MAX_PROCESS_VECTOR_ENTRIES
		|| stdin.len() > MAX_PROCESS_STDIN
	{
		return Err(EngineError::ProcessInputTooLarge);
	}
	let mut string_bytes = 0_usize;
	for value in arguments.iter().chain(environment) {
		if value.contains(&0) {
			return Err(EngineError::InvalidProcessInput);
		}
		string_bytes = string_bytes
			.checked_add(value.len() + 1)
			.ok_or(EngineError::ProcessInputTooLarge)?;
	}
	if string_bytes > MAX_PROCESS_STRING_BYTES {
		return Err(EngineError::ProcessInputTooLarge);
	}
	Ok(())
}

fn validate_process_files(files: &[ProcessFile<'_>]) -> Result<(), EngineError> {
	if files.len() > MAX_PROCESS_FILES {
		return Err(EngineError::ProcessInputTooLarge);
	}
	let mut paths = BTreeSet::new();
	let mut total = 0_usize;
	for file in files {
		let Some(relative) = file.path.strip_prefix(b"/") else {
			return Err(EngineError::InvalidProcessInput);
		};
		if file.path.len() > 4096
			|| file.path.contains(&0)
			|| relative.is_empty()
			|| relative
				.split(|byte| *byte == b'/')
				.any(|component| component.is_empty() || matches!(component, b"." | b".."))
			|| !paths.insert(file.path)
		{
			return Err(EngineError::InvalidProcessInput);
		}
		if file.bytes.len() > MAX_PROCESS_FILE_BYTES {
			return Err(EngineError::ProcessInputTooLarge);
		}
		total = total
			.checked_add(file.bytes.len())
			.ok_or(EngineError::ProcessInputTooLarge)?;
		if total > MAX_PROCESS_FILE_TOTAL_BYTES {
			return Err(EngineError::ProcessInputTooLarge);
		}
	}
	Ok(())
}

fn page_rounded_length(length: usize) -> Option<usize> {
	length
		.checked_add(0xfff)
		.map(|value| value & !0xfff)
		.filter(|value| *value != 0)
}

fn virtual_utsname() -> [u8; 6 * 65] {
	let mut bytes = [0_u8; 6 * 65];
	for (index, value) in [
		b"Linux".as_slice(),
		b"minisandbox".as_slice(),
		b"6.7.0-minisandbox".as_slice(),
		b"#1 PVM sandbox".as_slice(),
		b"x86_64".as_slice(),
		b"".as_slice(),
	]
	.into_iter()
	.enumerate()
	{
		let start = index * 65;
		bytes[start..start + value.len()].copy_from_slice(value);
	}
	bytes
}

fn service_process_mmap(
	machine: &mut PvmMachine,
	process: &mut LinuxProcessState,
	pages: &CowPagePlan,
	registers: PvmRegisters,
) -> Result<u64, EngineError> {
	const PROT_READ: u64 = 1;
	const PROT_WRITE: u64 = 2;
	const PROT_EXEC: u64 = 4;
	const MAP_PRIVATE: u64 = 2;
	const MAP_FIXED: u64 = 0x10;
	const MAP_ANONYMOUS: u64 = 0x20;
	const MAP_DENYWRITE: u64 = 0x800;
	const MAP_STACK: u64 = 0x2_0000;
	let length = usize::try_from(registers.rsi).map_err(|_| EngineError::InvalidSyscallExit)?;
	let Some(rounded) = page_rounded_length(length) else {
		return Ok(negative_errno(22));
	};
	let (writable, executable) = match registers.rdx {
		PROT_READ => (false, false),
		value if value == PROT_READ | PROT_WRITE => (true, false),
		value if value == PROT_READ | PROT_EXEC => (false, true),
		value if value & PROT_WRITE != 0 && value & PROT_EXEC != 0 => {
			return Ok(negative_errno(13));
		}
		_ => return Ok(negative_errno(22)),
	};
	let flags = registers.r10;
	let allowed_flags = MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS | MAP_DENYWRITE | MAP_STACK;
	if flags & MAP_PRIVATE == 0 || flags & !allowed_flags != 0 {
		return Ok(negative_errno(22));
	}
	let fixed = flags & MAP_FIXED != 0;
	let anonymous = flags & MAP_ANONYMOUS != 0;
	let file = if anonymous {
		if !matches!(registers.r8, u64::MAX | 0xffff_ffff) || registers.r9 != 0 {
			return Ok(negative_errno(22));
		}
		None
	} else {
		if registers.r9 & 0xfff != 0 {
			return Ok(negative_errno(22));
		}
		let Some(file) = process.open_files.get(&registers.r8) else {
			return Ok(negative_errno(9));
		};
		Some((Arc::clone(&file.bytes), registers.r9))
	};
	let address = if fixed {
		if registers.rdi == 0 || registers.rdi & 0xfff != 0 {
			return Ok(negative_errno(22));
		}
		registers.rdi
	} else {
		if registers.rdi != 0 {
			return Ok(negative_errno(22));
		}
		process.mmap_next
	};
	let end =
		address.checked_add(u64::try_from(rounded).map_err(|_| EngineError::InvalidSyscallExit)?);
	if address < process.mmap_start || end.is_none_or(|end| end > process.mmap_limit) {
		return Ok(negative_errno(12));
	}
	map_process_range(
		machine,
		process,
		pages,
		address,
		rounded,
		writable,
		executable,
		file.as_ref(),
	)?;
	if !fixed {
		process.mmap_next = end.expect("validated mmap end");
	}
	Ok(address)
}

#[allow(clippy::too_many_arguments)]
fn map_process_range(
	machine: &mut PvmMachine,
	process: &mut LinuxProcessState,
	pages: &CowPagePlan,
	address: u64,
	length: usize,
	writable: bool,
	executable: bool,
	file: Option<&(Arc<[u8]>, u64)>,
) -> Result<(), EngineError> {
	validate_guest_range(machine.memory_len(), address, length)?;
	let end = address
		.checked_add(u64::try_from(length).map_err(|_| EngineError::InvalidSyscallExit)?)
		.ok_or(EngineError::InvalidSyscallExit)?;
	for (index, raw) in (address..end).step_by(4096).enumerate() {
		let virtual_address = GuestAddress::new(raw).map_err(|_| EngineError::InvalidCowFault)?;
		let page = pages
			.page(virtual_address)
			.ok_or(EngineError::InvalidCowFault)?;
		let mut contents = [0_u8; 4096];
		if let Some((bytes, file_offset)) = file {
			let source_start = usize::try_from(*file_offset)
				.ok()
				.and_then(|offset| {
					index
						.checked_mul(4096)
						.and_then(|page| offset.checked_add(page))
				})
				.ok_or(EngineError::InvalidSyscallExit)?;
			if let Some(source) = bytes.get(source_start..) {
				let copied = source.len().min(contents.len());
				contents[..copied].copy_from_slice(&source[..copied]);
			}
		}
		machine
			.write_memory(page.physical_address().get(), &contents)
			.map_err(EngineError::Pvm)?;
		set_user_leaf_permissions(machine, page, true, writable, executable)?;
		process.mappings.insert(raw, page);
	}
	Ok(())
}

fn unmap_process_range(
	machine: &mut PvmMachine,
	process: &mut LinuxProcessState,
	address: u64,
	length: usize,
) -> Result<(), EngineError> {
	let end = address
		.checked_add(u64::try_from(length).map_err(|_| EngineError::InvalidSyscallExit)?)
		.ok_or(EngineError::InvalidSyscallExit)?;
	let zeros = [0_u8; 4096];
	for raw in (address..end).step_by(4096) {
		if let Some(page) = process.mappings.remove(&raw) {
			machine
				.write_memory(page.physical_address().get(), &zeros)
				.map_err(EngineError::Pvm)?;
			set_user_leaf_permissions(machine, page, false, false, false)?;
		}
	}
	Ok(())
}

fn prune_unmapped_anonymous_pages(
	process: &LinuxProcessState,
	pages: &mut CowPagePlan,
) -> Result<(), EngineError> {
	for raw in (process.mmap_start..process.mmap_limit).step_by(4096) {
		if !process.mappings.contains_key(&raw) {
			let address = GuestAddress::new(raw).map_err(|_| EngineError::InvalidCowFault)?;
			pages.remove(address);
		}
	}
	Ok(())
}

fn set_user_leaf_permissions(
	machine: &mut PvmMachine,
	page: CowPage,
	present: bool,
	writable: bool,
	executable: bool,
) -> Result<(), EngineError> {
	for entry_address in [
		page.supervisor_leaf_entry_address(),
		page.user_leaf_entry_address(),
	] {
		let bytes = machine
			.read_memory(entry_address.get(), size_of::<u64>())
			.map_err(EngineError::Pvm)?;
		let mut entry =
			u64::from_le_bytes(bytes.try_into().map_err(|_| EngineError::InvalidCowFault)?);
		if present {
			entry |= X86_PTE_PRESENT;
		} else {
			entry &= !X86_PTE_PRESENT;
		}
		if present && writable {
			entry |= X86_PTE_WRITABLE;
		} else {
			entry &= !X86_PTE_WRITABLE;
		}
		if present && executable {
			entry &= !X86_PTE_NO_EXECUTE;
		} else {
			entry |= X86_PTE_NO_EXECUTE;
		}
		machine
			.write_memory(entry_address.get(), &entry.to_le_bytes())
			.map_err(EngineError::Pvm)?;
	}
	Ok(())
}

fn protect_live_range(
	machine: &mut PvmMachine,
	pages: &mut CowPagePlan,
	address: u64,
	length: usize,
	remove_from_cow_plan: bool,
) -> Result<(), EngineError> {
	let length = u64::try_from(length).map_err(|_| EngineError::InvalidSyscallExit)?;
	let end = address
		.checked_add(length)
		.and_then(|end| end.checked_add(0xfff))
		.ok_or(EngineError::InvalidSyscallExit)?
		& !0xfff;
	for raw in (address..end).step_by(4096) {
		let page_address = GuestAddress::new(raw).map_err(|_| EngineError::InvalidSyscallExit)?;
		let page = if remove_from_cow_plan {
			pages.remove(page_address)
		} else {
			pages.page(page_address)
		};
		if let Some(page) = page {
			set_cow_leaf_writable(machine, page, false)?;
		}
	}
	Ok(())
}

fn protect_mapped_range_none(
	machine: &mut PvmMachine,
	process: &LinuxProcessState,
	address: u64,
	length: usize,
) -> Result<bool, EngineError> {
	let Some(rounded) = page_rounded_length(length) else {
		return Ok(false);
	};
	let end = address
		.checked_add(u64::try_from(rounded).map_err(|_| EngineError::InvalidSyscallExit)?)
		.ok_or(EngineError::InvalidSyscallExit)?;
	if (address..end)
		.step_by(4096)
		.any(|raw| !process.mappings.contains_key(&raw))
	{
		return Ok(false);
	}
	for raw in (address..end).step_by(4096) {
		let page = process
			.mappings
			.get(&raw)
			.copied()
			.ok_or(EngineError::InvalidSyscallExit)?;
		set_user_leaf_permissions(machine, page, false, false, false)?;
	}
	Ok(true)
}

fn read_user_memory(
	machine: &PvmMachine,
	user_cr3: u64,
	address: u64,
	length: usize,
) -> Result<Option<Vec<u8>>, EngineError> {
	if length == 0 {
		return Ok(Some(Vec::new()));
	}
	let last = address
		.checked_add(u64::try_from(length - 1).map_err(|_| EngineError::InvalidSyscallExit)?);
	if GuestAddress::new(address).is_err()
		|| last.is_none_or(|last| GuestAddress::new(last).is_err())
	{
		return Ok(None);
	}

	let mut bytes = Vec::with_capacity(length);
	let mut cursor = address;
	while bytes.len() < length {
		let Some(translation) = translate_user_address(machine, user_cr3, cursor)? else {
			return Ok(None);
		};
		let page_remaining = 4096 - usize::try_from(cursor & 0xfff).unwrap_or(4096);
		let chunk_length = page_remaining.min(length - bytes.len());
		bytes.extend(
			machine
				.read_memory(translation.physical, chunk_length)
				.map_err(EngineError::Pvm)?,
		);
		cursor = cursor
			.checked_add(u64::try_from(chunk_length).map_err(|_| EngineError::InvalidSyscallExit)?)
			.ok_or(EngineError::InvalidSyscallExit)?;
	}
	Ok(Some(bytes))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct UserTranslation {
	physical: u64,
	writable: bool,
}

fn translate_user_address(
	machine: &PvmMachine,
	user_cr3: u64,
	virtual_address: u64,
) -> Result<Option<UserTranslation>, EngineError> {
	if GuestAddress::new(virtual_address).is_err() {
		return Ok(None);
	}
	let indices = [
		usize::try_from((virtual_address >> 39) & 0x1ff).unwrap_or(0),
		usize::try_from((virtual_address >> 30) & 0x1ff).unwrap_or(0),
		usize::try_from((virtual_address >> 21) & 0x1ff).unwrap_or(0),
		usize::try_from((virtual_address >> 12) & 0x1ff).unwrap_or(0),
	];
	let mut table = user_cr3 & X86_PTE_ADDRESS_MASK;
	let mut writable = true;
	for (level, index) in indices.into_iter().enumerate() {
		let entry_address = table
			.checked_add(
				u64::try_from(index * size_of::<u64>())
					.map_err(|_| EngineError::InvalidSyscallExit)?,
			)
			.ok_or(EngineError::InvalidSyscallExit)?;
		let entry = u64::from_le_bytes(
			machine
				.read_memory(entry_address, size_of::<u64>())
				.map_err(EngineError::Pvm)?
				.try_into()
				.map_err(|_| EngineError::InvalidSyscallExit)?,
		);
		if entry & (X86_PTE_PRESENT | X86_PTE_USER) != (X86_PTE_PRESENT | X86_PTE_USER)
			|| (level < 3 && entry & X86_PTE_PAGE_SIZE != 0)
		{
			return Ok(None);
		}
		writable &= entry & X86_PTE_WRITABLE != 0;
		table = entry & X86_PTE_ADDRESS_MASK;
	}
	table
		.checked_add(virtual_address & 0xfff)
		.map(|physical| Some(UserTranslation { physical, writable }))
		.ok_or(EngineError::InvalidSyscallExit)
}

fn write_linux_user_memory(
	machine: &mut PvmMachine,
	user_cr3: u64,
	pages: &CowPagePlan,
	address: u64,
	bytes: &[u8],
) -> Result<bool, EngineError> {
	if validate_writable_guest_range(pages, machine.memory_len(), address, bytes.len()).is_err() {
		return Ok(false);
	}
	let mut chunks = Vec::new();
	let mut copied = 0_usize;
	let mut cursor = address;
	while copied < bytes.len() {
		let Some(translation) = translate_user_address(machine, user_cr3, cursor)? else {
			return Ok(false);
		};
		if !translation.writable {
			return Ok(false);
		}
		let page_remaining = 4096 - usize::try_from(cursor & 0xfff).unwrap_or(4096);
		let length = page_remaining.min(bytes.len() - copied);
		chunks.push((translation.physical, copied, length));
		copied += length;
		cursor = cursor
			.checked_add(u64::try_from(length).map_err(|_| EngineError::InvalidSyscallExit)?)
			.ok_or(EngineError::InvalidSyscallExit)?;
	}
	for (physical, offset, length) in chunks {
		machine
			.write_memory(physical, &bytes[offset..offset + length])
			.map_err(EngineError::Pvm)?;
	}
	Ok(true)
}

fn read_guest_c_string(
	machine: &PvmMachine,
	user_cr3: u64,
	address: u64,
	limit: usize,
) -> Result<Option<Vec<u8>>, EngineError> {
	let mut string = Vec::with_capacity(limit);
	let mut cursor = address;
	while string.len() < limit {
		let page_remaining = 4096 - usize::try_from(cursor & 0xfff).unwrap_or(4096);
		let chunk_length = page_remaining.min(limit - string.len());
		let Some(bytes) = read_user_memory(machine, user_cr3, cursor, chunk_length)? else {
			return Ok(None);
		};
		if let Some(length) = bytes.iter().position(|byte| *byte == 0) {
			string.extend_from_slice(&bytes[..length]);
			return Ok(Some(string));
		}
		string.extend_from_slice(&bytes);
		cursor = cursor
			.checked_add(u64::try_from(chunk_length).map_err(|_| EngineError::InvalidSyscallExit)?)
			.ok_or(EngineError::InvalidSyscallExit)?;
	}
	Err(EngineError::InvalidSyscallExit)
}

fn service_executable_readlink(
	machine: &mut PvmMachine,
	process: &LinuxProcessState,
	writable_pages: Option<&CowPagePlan>,
	user_cr3: u64,
	path_address: u64,
	output_address: u64,
	capacity: u64,
) -> Result<u64, EngineError> {
	let Some(path) = read_guest_c_string(machine, user_cr3, path_address, 256)? else {
		return Ok(negative_errno(14));
	};
	if path != b"/proc/self/exe" {
		return Ok(negative_errno(2));
	}
	let capacity = usize::try_from(capacity).map_err(|_| EngineError::InvalidSyscallExit)?;
	let length = capacity.min(process.executable_name.len());
	let Some(pages) = writable_pages else {
		return Ok(negative_errno(38));
	};
	if write_linux_user_memory(
		machine,
		user_cr3,
		pages,
		output_address,
		&process.executable_name[..length],
	)? {
		u64::try_from(length).map_err(|_| EngineError::InvalidSyscallExit)
	} else {
		Ok(negative_errno(14))
	}
}

fn validate_guest_range(
	allocation_length: usize,
	address: u64,
	length: usize,
) -> Result<(), EngineError> {
	let start = usize::try_from(address).map_err(|_| EngineError::InvalidActorProtocol)?;
	let end = start
		.checked_add(length)
		.ok_or(EngineError::InvalidActorProtocol)?;
	if end > allocation_length {
		return Err(EngineError::InvalidActorProtocol);
	}
	Ok(())
}

fn validate_writable_guest_range(
	pages: &CowPagePlan,
	allocation_length: usize,
	address: u64,
	length: usize,
) -> Result<(), EngineError> {
	validate_guest_range(allocation_length, address, length)?;
	if length == 0 {
		return Ok(());
	}
	let last = address
		.checked_add(u64::try_from(length - 1).map_err(|_| EngineError::InvalidActorProtocol)?)
		.ok_or(EngineError::InvalidActorProtocol)?;
	let first_page = address & !0xfff;
	let last_page = last & !0xfff;
	for raw in (first_page..=last_page).step_by(4096) {
		let page = GuestAddress::new(raw).map_err(|_| EngineError::InvalidActorProtocol)?;
		if pages.page(page).is_none() {
			return Err(EngineError::InvalidActorProtocol);
		}
	}
	Ok(())
}

fn seal_live_cow_pages(machine: &mut PvmMachine, pages: &CowPagePlan) -> Result<(), EngineError> {
	for page in pages.pages() {
		set_cow_leaf_writable(machine, page, false)?;
	}
	Ok(())
}

fn set_cow_leaf_writable(
	machine: &mut PvmMachine,
	page: CowPage,
	writable: bool,
) -> Result<(), EngineError> {
	for entry_address in [
		page.supervisor_leaf_entry_address(),
		page.user_leaf_entry_address(),
	] {
		let bytes = machine
			.read_memory(entry_address.get(), size_of::<u64>())
			.map_err(EngineError::Pvm)?;
		let mut entry =
			u64::from_le_bytes(bytes.try_into().map_err(|_| EngineError::InvalidCowFault)?);
		if entry & X86_PTE_PRESENT == 0 {
			return Err(EngineError::InvalidCowFault);
		}
		if writable {
			entry |= X86_PTE_WRITABLE;
		} else {
			entry &= !X86_PTE_WRITABLE;
		}
		machine
			.write_memory(entry_address.get(), &entry.to_le_bytes())
			.map_err(EngineError::Pvm)?;
	}
	Ok(())
}

fn handle_cow_fault(
	machine: &mut PvmMachine,
	cow: &mut CowFaultState<'_>,
	vector: u8,
	error_code: u32,
	address: u64,
) -> Result<bool, EngineError> {
	const PAGE_FAULT_VECTOR: u8 = 14;
	const PRESENT_WRITE_USER: u32 = 0b111;
	if vector != PAGE_FAULT_VECTOR || error_code & PRESENT_WRITE_USER != PRESENT_WRITE_USER {
		return Ok(false);
	}
	let address = GuestAddress::new(address).map_err(|_| EngineError::InvalidCowFault)?;
	let Some(page) = cow.pages.page_containing(address) else {
		return Ok(false);
	};
	if cow.dirty_pages.contains(&page.virtual_address()) {
		return Err(EngineError::InvalidCowFault);
	}

	machine
		.privatize_page(page.physical_address().get())
		.map_err(EngineError::Pvm)?;
	cow.live_private_data_pages.fetch_add(1, Ordering::AcqRel);
	cow.dirty_pages.insert(page.virtual_address());
	set_cow_leaf_writable(machine, page, true)?;
	*cow.cow_faults += 1;
	Ok(true)
}

const fn negative_errno(errno: i64) -> u64 {
	u64::from_ne_bytes((-errno).to_ne_bytes())
}

#[cfg(test)]
mod tests {
	use super::{
		MAX_PROCESS_FILES, ProcessFile, PvmSqliteBlockBackend, PvmSqliteBlockTemplate,
		validate_process_files, validate_writable_guest_range,
	};
	use crate::{
		memory::GuestAddress,
		paging::{PagePermissions, PageTablePlan},
	};
	use minisandbox_block_backend::{SqliteBlockBackend, SqliteBlockBackendFactory};
	use std::{
		fs,
		path::{Path, PathBuf},
		time::{SystemTime, UNIX_EPOCH},
	};

	struct TestDirectory(PathBuf);

	impl TestDirectory {
		fn new() -> Self {
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("test clock after epoch")
				.as_nanos();
			let path = std::env::temp_dir().join(format!(
				"minisandbox-core-test-{}-{nanos:x}",
				std::process::id()
			));
			fs::create_dir(&path).expect("create unique core test directory");
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn host_write_ranges_stay_inside_planned_writable_user_pages() {
		let writable = GuestAddress::new(0x40_0000).expect("canonical writable page");
		let read_only = GuestAddress::new(0x50_0000).expect("canonical read-only page");
		let mut plan = PageTablePlan::new();
		plan.map_user(writable, writable, PagePermissions::READ_WRITE)
			.expect("map writable user page");
		plan.map_user(read_only, read_only, PagePermissions::READ_ONLY)
			.expect("map read-only user page");
		let image = plan
			.materialize_4k(GuestAddress::new(0x1000).expect("canonical table base"))
			.expect("materialize test page tables");
		let cow = image
			.writable_user_page_plan()
			.expect("capture writable page plan");

		assert!(validate_writable_guest_range(&cow, 8 * 1024 * 1024, 0x40_0ff0, 16).is_ok());
		assert!(validate_writable_guest_range(&cow, 8 * 1024 * 1024, 0x40_0ff0, 17).is_err());
		assert!(validate_writable_guest_range(&cow, 8 * 1024 * 1024, 0x50_0000, 1).is_err());
	}

	#[test]
	fn process_file_bundle_requires_unique_normalized_absolute_paths() {
		let valid = [ProcessFile {
			path: b"/lib64/libfixture.so",
			bytes: b"fixture",
		}];
		assert!(validate_process_files(&valid).is_ok());

		for path in [
			b"relative".as_slice(),
			b"/".as_slice(),
			b"/lib64//file".as_slice(),
			b"/lib64/../file".as_slice(),
			b"/lib64/file\0suffix".as_slice(),
		] {
			let invalid = [ProcessFile {
				path,
				bytes: b"fixture",
			}];
			assert!(validate_process_files(&invalid).is_err());
		}

		let duplicate = [valid[0], valid[0]];
		assert!(validate_process_files(&duplicate).is_err());
		let too_many = vec![valid[0]; MAX_PROCESS_FILES + 1];
		assert!(validate_process_files(&too_many).is_err());
	}

	#[test]
	fn only_ephemeral_pvm_backends_retire_their_volume_on_drop() {
		let directory = TestDirectory::new();
		let database = directory.path().join("blocks.db");
		let cos_root = directory.path().join("cos");
		let logical_size = 2 * 1024 * 1024;
		let source =
			SqliteBlockBackend::open(&database, &cos_root, "lifecycle-source", logical_size)
				.expect("open lifecycle source");
		SqliteBlockBackend::snapshot_volume(&database, "lifecycle-source", "lifecycle-pin")
			.expect("snapshot lifecycle source");
		drop(source);
		SqliteBlockBackend::fork_snapshot(&database, "lifecycle-pin", "ephemeral-child")
			.expect("fork ephemeral child");

		let ephemeral_factory =
			SqliteBlockBackendFactory::open(&database, &cos_root).expect("open ephemeral factory");
		let ephemeral = PvmSqliteBlockBackend::open_ephemeral(
			&ephemeral_factory,
			"ephemeral-child",
			logical_size,
		)
		.expect("open ephemeral PVM backend");
		drop(ephemeral);
		assert!(
			SqliteBlockBackend::open(&database, &cos_root, "ephemeral-child", logical_size)
				.is_err(),
			"destroyed PVM clone volume was reopened"
		);

		let persistent =
			PvmSqliteBlockBackend::open(&database, &cos_root, "persistent-volume", logical_size)
				.expect("open persistent PVM backend");
		drop(persistent);
		SqliteBlockBackend::open(&database, &cos_root, "persistent-volume", logical_size)
			.expect("ordinary PVM backend drop must preserve persistent volume");

		let warm_source = SqliteBlockBackend::open(
			&database,
			&cos_root,
			"consumed-template-source",
			logical_size,
		)
		.expect("open consumed template source");
		drop(warm_source);
		let template_factory =
			SqliteBlockBackendFactory::open(&database, &cos_root).expect("open template factory");
		let template =
			PvmSqliteBlockTemplate::capture(template_factory, "consumed-template-source")
				.expect("capture database-backed PVM template");
		assert!(
			SqliteBlockBackend::open(
				&database,
				&cos_root,
				"consumed-template-source",
				logical_size
			)
			.is_err(),
			"warm source volume remained live after its root was pinned"
		);
		drop(template);
	}
}
