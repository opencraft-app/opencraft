//! Narrow unsafe boundary for one memory-backed PVM vCPU.

mod cancel;
mod legacy_cmos;
mod page_reclaim;
mod timeout;

use cancel::PvmRunCancellation;
pub use cancel::PvmRunCanceller;
use legacy_cmos::LegacyCmos;
pub use timeout::PvmTimedRun;
use timeout::TimeoutTimer;

use std::{
    fmt,
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{FileExt, MetadataExt},
    },
    ptr::NonNull,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use kvm_bindings::{
    KVM_CAP_HALT_POLL, KVM_IRQCHIP_IOAPIC, KVM_IRQCHIP_PIC_MASTER, KVM_IRQCHIP_PIC_SLAVE,
    KVM_MAX_CPUID_ENTRIES, KVM_MEM_LOG_DIRTY_PAGES, KVM_MEM_READONLY, KVM_PIT_SPEAKER_DUMMY, Msrs,
    Xsave, kvm_clock_data, kvm_debugregs, kvm_enable_cap, kvm_fpu, kvm_irqchip, kvm_lapic_state,
    kvm_mp_state, kvm_msr_entry, kvm_pit_config, kvm_pit_state2, kvm_regs, kvm_segment, kvm_sregs,
    kvm_userspace_memory_region, kvm_vcpu_events, kvm_xcrs, kvm_xsave,
};
use kvm_ioctls::{Cap, IoEventAddress, VcpuExit, VcpuFd, VmFd};
pub use pvm_block_service::{
    BlockBackend as PvmBlockBackend, BlockFilePool as PvmBlockPool,
    BlockFileTemplate as PvmBlockTemplate, CloneMethod as PvmBlockCloneMethod,
};
use pvm_block_service::{
    BlockService, BlockState, GuestRam, Interrupt as BlockInterrupt, QUEUE_NOTIFY_OFFSET,
};
use pvm_console_device::{BASE as UART_BASE, Uart};
use vmm_sys_util::eventfd::{EFD_CLOEXEC, EFD_NONBLOCK, EventFd};

use crate::{
    MSR_EVENT_ENTRY, MSR_LINEAR_ADDRESS_RANGE, MSR_RETS_RIP, MSR_RETU_RIP, MSR_SUPERVISOR_RSP,
    MSR_SWITCH_CR3, MSR_VCPU_STRUCT, PVM_EVENT_PORT_BASE, PVM_EVENT_PORT_END, PVM_HYPERCALL_PORT,
    PvmAbi, PvmBootConfig, PvmDevice, PvmDeviceError, PvmExit, PvmHypercall, PvmLinuxBootConfig,
    PvmRegisters, PvmRunStats, PvmServiceQueueSet,
};

const MSR_STAR: u32 = 0xc000_0081;
const MSR_LSTAR: u32 = 0xc000_0082;
const MSR_KERNEL_GS_BASE: u32 = 0xc000_0102;
const STAR_VALUE: u64 = (0x8_u64 << 32) | (0x23_u64 << 48);

const CR0_PE: u64 = 1 << 0;
const CR0_MP: u64 = 1 << 1;
const CR0_ET: u64 = 1 << 4;
const CR0_NE: u64 = 1 << 5;
const CR0_WP: u64 = 1 << 16;
const CR0_AM: u64 = 1 << 18;
const CR0_PG: u64 = 1 << 31;
const CR4_PAE: u64 = 1 << 5;
const CR4_OSFXSR: u64 = 1 << 9;
const CR4_OSXMMEXCPT: u64 = 1 << 10;
const CR4_FSGSBASE: u64 = 1 << 16;
const EFER_SCE: u64 = 1 << 0;
const EFER_LME: u64 = 1 << 8;
const EFER_LMA: u64 = 1 << 10;
const EFER_NXE: u64 = 1 << 11;
const PVM_STATE_MSRS: [u32; 7] = [
    MSR_LINEAR_ADDRESS_RANGE,
    MSR_VCPU_STRUCT,
    MSR_SWITCH_CR3,
    MSR_SUPERVISOR_RSP,
    MSR_EVENT_ENTRY,
    MSR_RETU_RIP,
    MSR_RETS_RIP,
];
/// A VM, registered memory slot, and vCPU whose lifetimes cannot separate.
pub struct PvmMachine {
    vcpu: VcpuFd,
    // The worker must stop before `vm` and the externally-owned RAM mapping are
    // dropped. Rust drops struct fields in declaration order.
    system_block: Option<BlockService>,
    data_block: Option<BlockService>,
    template_block: Option<BlockService>,
    vm: VmFd,
    memory: HostMapping,
    read_only_memory: Vec<ReadOnlyMapping>,
    shared_memory: Vec<RegisteredSharedMemory>,
    irqfds: Vec<RegisteredIrqFd>,
    uart: Option<LegacyUart>,
    cmos: Option<LegacyCmos>,
    msr_indices: Arc<[u32]>,
    tracks_dirty_pages: bool,
    page_reclaim: Option<page_reclaim::PageReclaimState>,
    wait_wake: Arc<EventFd>,
    wait_wake_enabled: Arc<AtomicBool>,
    run_cancel: Arc<PvmRunCancellation>,
    run_stats: PvmRunStats,
    vcpu_has_run: bool,
    timeout_timer: TimeoutTimer,
}

enum BlockAttachment {
    File(File),
    Opaque(Box<dyn PvmBlockBackend>),
}

/// Minimal architectural state useful for diagnosing an early guest failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmCpuState {
    /// Current instruction pointer.
    pub rip: u64,
    /// Current stack pointer.
    pub rsp: u64,
    /// Current flags register.
    pub rflags: u64,
    /// Current page-fault linear address.
    pub cr2: u64,
    /// Current page-table root.
    pub cr3: u64,
    /// Current CR0 value.
    pub cr0: u64,
    /// Current CR4 value.
    pub cr4: u64,
    /// Current extended feature-enable register.
    pub efer: u64,
}

/// PVM control MSRs at one diagnostic boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PvmControlState {
    /// Guest-allowed linear address range descriptor.
    pub linear_address_range: u64,
    /// Guest-physical address currently registered as PVCS.
    pub pvcs_gpa: u64,
    /// Registered event entry point.
    pub event_entry: u64,
    /// Registered return-to-user synthetic instruction address.
    pub retu_rip: u64,
}

/// Complete process-local CPU state needed to resume a checkpoint syscall.
#[derive(Clone, Debug)]
pub struct PvmResumeState {
    registers: kvm_regs,
    fpu: kvm_fpu,
    fs_base: u64,
}

/// Complete single-vCPU and legacy-device state at a Linux checkpoint exit.
///
/// Guest RAM is intentionally kept separately in [`PvmMemoryTemplate`]. This
/// state contains no host pointers and can therefore be replayed into every VM
/// created from that immutable memory baseline.
pub struct PvmLinuxState {
    registers: kvm_regs,
    special_registers: kvm_sregs,
    xsave: PvmXsaveState,
    xcrs: kvm_xcrs,
    debug_registers: kvm_debugregs,
    lapic: kvm_lapic_state,
    mp_state: kvm_mp_state,
    vcpu_events: kvm_vcpu_events,
    msrs: Vec<kvm_msr_entry>,
    irqchips: [kvm_irqchip; 3],
    pit: kvm_pit_state2,
    clock: kvm_clock_data,
    uart: LegacyUart,
    cmos: LegacyCmos,
    system_block: Option<BlockState>,
    data_block: Option<BlockState>,
    template_block: Option<BlockState>,
}

enum PvmXsaveState {
    Legacy(Box<kvm_xsave>),
    Extended(Xsave),
}

impl fmt::Debug for PvmLinuxState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PvmLinuxState")
            .field("rip", &self.registers.rip)
            .field("rsp", &self.registers.rsp)
            .field("cr3", &self.special_registers.cr3)
            .field("msr_count", &self.msrs.len())
            .field("has_system_block", &self.system_block.is_some())
            .field("has_data_block", &self.data_block.is_some())
            .field("has_template_block", &self.template_block.is_some())
            .finish_non_exhaustive()
    }
}

impl PvmLinuxState {
    /// Returns whether the checkpoint captured a bound `ActorVolume` device.
    ///
    /// Globally shared warm templates must return `false`: their data backend
    /// is supplied only after clone construction.
    #[must_use]
    pub const fn has_actor_volume(&self) -> bool {
        self.data_block.is_some() || self.template_block.is_some()
    }
}

/// Immutable guest-memory baseline shared by private per-instance mappings.
#[derive(Clone, Debug)]
pub struct PvmMemoryTemplate {
    backing: Arc<TemplateBacking>,
}

/// File-backed bytes that can be shared as a read-only guest region.
///
/// Every machine created from the same value receives its own GPA mapping, but
/// all host mappings refer to the same page cache. Byte-backed images own a
/// sealed memfd; file-backed images hold the caller's read-only file open. The
/// KVM memory slot is independently marked read-only, so an untrusted guest
/// cannot turn a writable page-table entry into backing-file write access.
#[derive(Clone, Debug)]
pub struct PvmReadOnlyImage {
    backing: Arc<TemplateBacking>,
}

/// One immutable file-backed range to expose at a fixed guest-physical address.
///
/// Linux machines accept at most two regions. They are registered in the
/// audited KVM slots 1 and 4; slots 2 and 3 remain reserved for the directional
/// socket-service mappings. The image mapping is always host read-only and the
/// KVM slot additionally carries `KVM_MEM_READONLY`.
#[derive(Clone, Copy, Debug)]
pub struct PvmReadOnlyRegion<'a> {
    image: &'a PvmReadOnlyImage,
    guest_phys_address: u64,
}

impl<'a> PvmReadOnlyRegion<'a> {
    /// Describes one immutable image mapping without mapping or copying it yet.
    #[must_use]
    pub const fn new(image: &'a PvmReadOnlyImage, guest_phys_address: u64) -> Self {
        Self {
            image,
            guest_phys_address,
        }
    }
}

const READ_ONLY_MEMORY_SLOTS: [u32; 2] = [1, 4];

/// Fresh anonymous host memory that may be registered as a non-template KVM slot.
///
/// The mapping is never included in a [`PvmMemoryTemplate`]. Sharing an
/// `Arc<PvmSharedMemory>` with a device adapter therefore gives every restored
/// clone a distinct mailbox while keeping the generic PVM layer unaware of the
/// device protocol stored in it.
#[derive(Debug)]
pub struct PvmSharedMemory {
    mapping: HostMapping,
}

#[derive(Debug)]
struct RegisteredSharedMemory {
    memory: Arc<PvmSharedMemory>,
    guest_phys_address: u64,
    slot: u32,
    read_only: bool,
}

struct RegisteredIrqFd {
    _event: Arc<EventFd>,
    gsi: u32,
}

/// A narrowly scoped, cloneable capability for asserting one pre-registered IRQ.
///
/// This type deliberately exposes neither the VM descriptor nor an arbitrary
/// interrupt number. A device worker can therefore wake its guest without
/// gaining control over the PVM machine.
#[derive(Clone, Debug)]
pub struct PvmIrqSender {
    event: Arc<EventFd>,
    wait_wake: Arc<EventFd>,
    wait_wake_enabled: Arc<AtomicBool>,
    gsi: u32,
}

impl PvmIrqSender {
    /// Signals the fixed IRQ registered when this capability was created.
    ///
    /// IRQ delivery is a hint: a guest driver must always re-check its shared
    /// ring after waking and tolerate coalesced notifications.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the underlying nonblocking eventfd cannot be
    /// incremented.
    pub fn notify(&self) -> io::Result<()> {
        self.event.write(1)?;
        if self.wait_wake_enabled.load(Ordering::Acquire) {
            // A saturated eventfd already represents a pending wake. Treat
            // that state as success so the primary IRQ is never reported as
            // failed after it has already been injected.
            if let Err(error) = self.wait_wake.write(1)
                && error.kind() != io::ErrorKind::WouldBlock
            {
                return Err(error);
            }
        }
        Ok(())
    }

    /// Returns the immutable guest interrupt number for diagnostics.
    #[must_use]
    pub const fn gsi(&self) -> u32 {
        self.gsi
    }
}

impl BlockInterrupt for PvmIrqSender {
    fn notify(&self) -> io::Result<()> {
        PvmIrqSender::notify(self)
    }
}

/// Fixed GPA of the system-disk virtio-mmio register page.
///
/// PVM Linux RAM may extend to 3 GiB. Keep the register page above the
/// clone-private stream mailbox at 4 GiB and below immutable PMEM at 8 GiB so
/// every supported profile shares one collision-free physical layout.
pub const PVM_VIRTIO_BLK_MMIO_BASE: u64 = 0x1_0010_0000;
/// Fixed legacy GSI used by the system-disk virtio-blk queue.
pub const PVM_VIRTIO_BLK_IRQ_GSI: u32 = 5;
/// Fixed GPA of the independently attached `ActorVolume` register page.
pub const PVM_VIRTIO_BLK_DATA_MMIO_BASE: u64 = PVM_VIRTIO_BLK_MMIO_BASE + 0x1000;
/// Fixed legacy GSI used by the `ActorVolume` virtio-blk queue.
pub const PVM_VIRTIO_BLK_DATA_IRQ_GSI: u32 = 6;
/// Fixed GPA of the immutable ActorVolume template register page.
pub const PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE: u64 = PVM_VIRTIO_BLK_DATA_MMIO_BASE + 0x1000;
/// Fixed legacy GSI used by the immutable ActorVolume template queue.
pub const PVM_VIRTIO_BLK_TEMPLATE_IRQ_GSI: u32 = 7;

/// One fixed virtio-blk attachment point in the PVM Linux physical layout.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PvmBlockDevice {
    /// Clone-private writable root/overlay storage captured with the warm RAM.
    System,
    /// Persistent `ActorVolume` attached only to a restored clone.
    Data,
    /// Immutable filesystem origin composed with `Data` inside the guest.
    Template,
}

impl PvmBlockDevice {
    /// Returns this device's immutable MMIO base.
    #[must_use]
    pub const fn mmio_base(self) -> u64 {
        match self {
            Self::System => PVM_VIRTIO_BLK_MMIO_BASE,
            Self::Data => PVM_VIRTIO_BLK_DATA_MMIO_BASE,
            Self::Template => PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE,
        }
    }

    /// Returns this device's immutable interrupt number.
    #[must_use]
    pub const fn irq_gsi(self) -> u32 {
        match self {
            Self::System => PVM_VIRTIO_BLK_IRQ_GSI,
            Self::Data => PVM_VIRTIO_BLK_DATA_IRQ_GSI,
            Self::Template => PVM_VIRTIO_BLK_TEMPLATE_IRQ_GSI,
        }
    }
}

#[derive(Debug)]
struct TemplateBacking {
    file: File,
    length: usize,
    id: u64,
}

impl PvmMemoryTemplate {
    /// Creates a sealed Linux memfd containing one page-aligned guest image.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] if the image is empty, unaligned, or
    /// cannot be written and sealed without retaining a writable shared map.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, PvmDeviceError> {
        if bytes.is_empty() || !bytes.len().is_multiple_of(4096) {
            return Err(PvmDeviceError::Memory {
                operation: "create template backing",
                message: "template size must be a nonzero multiple of 4096".to_owned(),
            });
        }
        // SAFETY: The static C string is NUL-terminated and flags request a new
        // close-on-exec, sealable anonymous file descriptor.
        let descriptor = unsafe {
            libc::memfd_create(
                c"minisandbox-template".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if descriptor < 0 {
            return Err(memory_error(
                "create template backing",
                io::Error::last_os_error(),
            ));
        }
        // SAFETY: `descriptor` is a newly-created owned fd and ownership moves
        // exactly once into `File` for close-on-drop behavior.
        let file = unsafe { File::from_raw_fd(descriptor) };
        file.set_len(
            u64::try_from(bytes.len()).map_err(|error| memory_error("size template", error))?,
        )
        .map_err(|error| memory_error("size template", error))?;
        write_sparse_template(&file, bytes)?;
        let seals =
            libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE | libc::F_SEAL_SEAL;
        // SAFETY: `file` owns a live memfd and F_ADD_SEALS consumes only the
        // integer seal mask; no shared writable mapping has been created.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
            return Err(memory_error(
                "seal template backing",
                io::Error::last_os_error(),
            ));
        }
        let id = file
            .metadata()
            .map_err(|error| memory_error("identify template backing", error))?
            .ino();
        Ok(Self {
            backing: Arc::new(TemplateBacking {
                file,
                length: bytes.len(),
                id,
            }),
        })
    }

    /// Returns the byte length of the immutable baseline.
    #[must_use]
    pub fn len(&self) -> usize {
        self.backing.length
    }

    /// Returns whether the immutable baseline contains no bytes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.backing.length == 0
    }

    /// Returns the kernel inode identity shared by every private child map.
    #[must_use]
    pub fn backing_id(&self) -> u64 {
        self.backing.id
    }

    /// Copies bytes directly from the immutable baseline.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] when the requested range is invalid
    /// or the sealed backing cannot be read completely.
    pub fn read_memory(
        &self,
        guest_address: u64,
        length: usize,
    ) -> Result<Vec<u8>, PvmDeviceError> {
        let range = checked_range(self.len(), guest_address, length, "read template")?;
        let mut bytes = vec![0; length];
        self.backing
            .file
            .read_exact_at(
                &mut bytes,
                u64::try_from(range.start)
                    .map_err(|error| memory_error("convert template offset", error))?,
            )
            .map_err(|error| memory_error("read template", error))?;
        Ok(bytes)
    }
}

fn write_sparse_template(file: &File, bytes: &[u8]) -> Result<(), PvmDeviceError> {
    const PAGE_SIZE: usize = 4096;

    let mut extent_start = None;
    for (page_index, page) in bytes.chunks_exact(PAGE_SIZE).enumerate() {
        let offset = page_index * PAGE_SIZE;
        if page.iter().any(|byte| *byte != 0) {
            extent_start.get_or_insert(offset);
        } else if let Some(start) = extent_start.take() {
            file.write_all_at(&bytes[start..offset], start as u64)
                .map_err(|error| memory_error("write sparse template", error))?;
        }
    }
    if let Some(start) = extent_start {
        file.write_all_at(&bytes[start..], start as u64)
            .map_err(|error| memory_error("write sparse template", error))?;
    }
    Ok(())
}

impl PvmReadOnlyImage {
    /// Copies one page-aligned image into a sealed, immutable memfd.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] if the image is empty, unaligned, or
    /// cannot be written and sealed before any shared mapping is created.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, PvmDeviceError> {
        if bytes.is_empty() || !bytes.len().is_multiple_of(4096) {
            return Err(PvmDeviceError::Memory {
                operation: "create read-only image backing",
                message: "image size must be a nonzero multiple of 4096".to_owned(),
            });
        }
        // SAFETY: The static C string is NUL-terminated and flags request a new
        // close-on-exec, sealable anonymous file descriptor.
        let descriptor = unsafe {
            libc::memfd_create(
                c"minisandbox-read-only-image".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if descriptor < 0 {
            return Err(memory_error(
                "create read-only image backing",
                io::Error::last_os_error(),
            ));
        }
        // SAFETY: `descriptor` is newly created and ownership moves exactly
        // once into `File`.
        let file = unsafe { File::from_raw_fd(descriptor) };
        file.set_len(
            u64::try_from(bytes.len())
                .map_err(|error| memory_error("size read-only image", error))?,
        )
        .map_err(|error| memory_error("size read-only image", error))?;
        file.write_all_at(bytes, 0)
            .map_err(|error| memory_error("write read-only image", error))?;
        let seals =
            libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE | libc::F_SEAL_SEAL;
        // SAFETY: No mapping of this memfd exists yet, so F_SEAL_WRITE can be
        // installed without racing a writable shared mapping.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
            return Err(memory_error(
                "seal read-only image backing",
                io::Error::last_os_error(),
            ));
        }
        let id = file
            .metadata()
            .map_err(|error| memory_error("identify read-only image backing", error))?
            .ino();
        Ok(Self {
            backing: Arc::new(TemplateBacking {
                file,
                length: bytes.len(),
                id,
            }),
        })
    }

    /// Uses an existing read-only regular file as the demand-paged image backing.
    ///
    /// This path performs no image read or memfd copy. The caller must ensure
    /// that no other descriptor modifies or truncates the file for the lifetime
    /// of this value. The owned descriptor itself must have been opened
    /// read-only; every guest mapping additionally uses `PROT_READ` and
    /// `KVM_MEM_READONLY`.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] if the descriptor is writable, does
    /// not refer to a regular file, or its length is empty, unaligned, or too
    /// large for the host address space.
    pub fn from_file(file: File) -> Result<Self, PvmDeviceError> {
        // SAFETY: F_GETFL only reads the status flags of the live owned fd.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 {
            return Err(memory_error(
                "inspect read-only image file",
                io::Error::last_os_error(),
            ));
        }
        if flags & libc::O_ACCMODE != libc::O_RDONLY {
            return Err(PvmDeviceError::Memory {
                operation: "open read-only image file",
                message: "image descriptor must be opened read-only".to_owned(),
            });
        }
        let metadata = file
            .metadata()
            .map_err(|error| memory_error("inspect read-only image file", error))?;
        if !metadata.is_file() {
            return Err(PvmDeviceError::Memory {
                operation: "open read-only image file",
                message: "image descriptor must refer to a regular file".to_owned(),
            });
        }
        let length = usize::try_from(metadata.len())
            .map_err(|error| memory_error("size read-only image file", error))?;
        if length == 0 || !length.is_multiple_of(4096) {
            return Err(PvmDeviceError::Memory {
                operation: "open read-only image file",
                message: "image size must be a nonzero multiple of 4096".to_owned(),
            });
        }
        Ok(Self {
            backing: Arc::new(TemplateBacking {
                file,
                length,
                id: metadata.ino(),
            }),
        })
    }

    /// Returns the page-aligned image byte length.
    #[must_use]
    pub fn len(&self) -> usize {
        self.backing.length
    }

    /// Returns whether this image contains no bytes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.backing.length == 0
    }

    /// Returns the backing inode shared by every machine mapping.
    #[must_use]
    pub fn backing_id(&self) -> u64 {
        self.backing.id
    }
}

impl PvmSharedMemory {
    /// Allocates one zeroed, page-aligned anonymous mapping.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] unless `length` is nonzero and page
    /// aligned, or if the host mapping cannot be allocated.
    pub fn new(length: usize) -> Result<Self, PvmDeviceError> {
        if length == 0 || !length.is_multiple_of(4096) {
            return Err(PvmDeviceError::Memory {
                operation: "allocate shared guest memory",
                message: "length must be a nonzero multiple of 4096".to_owned(),
            });
        }
        Ok(Self {
            mapping: HostMapping::new_shared(length)?,
        })
    }

    /// Returns the complete mapped byte length.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.mapping.length
    }

    /// Returns whether this mapping contains no bytes.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.mapping.length == 0
    }

    /// Returns the stable base pointer used by a separately audited device adapter.
    ///
    /// Dereferencing this pointer is unsafe because KVM and adapter threads may
    /// concurrently access the mapping. The adapter must use the published
    /// atomic wire protocol and must not create ordinary Rust references to
    /// guest-writable bytes.
    #[must_use]
    pub const fn as_ptr(&self) -> NonNull<u8> {
        self.mapping.pointer
    }

    /// Copies host-owned initialization bytes before the slot is made visible.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] when the offset range is invalid.
    pub fn initialize(&mut self, offset: usize, source: &[u8]) -> Result<(), PvmDeviceError> {
        self.mapping.write(offset as u64, source)
    }

    /// Copies bytes for tests or quiescent diagnostics.
    ///
    /// # Safety
    ///
    /// No vCPU, device worker, or other host thread may access this mapping for
    /// the complete copy. Use protocol atomics/volatile snapshots while shared.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] when the offset range is invalid.
    pub unsafe fn read_quiescent(
        &self,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, PvmDeviceError> {
        self.mapping.read(offset as u64, length)
    }
}

// SAFETY: The mapping address is stable for its complete lifetime. Safe
// methods only permit exclusive initialization; quiescent copies and
// concurrent device access require entering the explicit unsafe pointer/protocol
// boundary.
unsafe impl Send for PvmSharedMemory {}
// SAFETY: See the `Send` justification. The type exposes no shared references
// into guest-writable storage.
unsafe impl Sync for PvmSharedMemory {}

impl PvmDevice {
    /// Creates one vCPU backed by one guest-physical memory slot at GPA zero.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if allocation, memslot registration, CPUID
    /// configuration, VM creation, or vCPU creation fails.
    pub fn create_machine(&self, memory_size: usize) -> Result<PvmMachine, PvmDeviceError> {
        let memory = HostMapping::new(memory_size)?;
        self.create_machine_with_memory(memory, false, Vec::new(), false)
    }

    /// Creates a machine with the in-kernel interrupt controller, PIT, and a
    /// minimal userspace 8250 UART required by the first Linux boot milestone.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if memory, VM, legacy-device, or vCPU setup
    /// fails.
    pub fn create_linux_machine(&self, memory_size: usize) -> Result<PvmMachine, PvmDeviceError> {
        let memory = HostMapping::new(memory_size)?;
        self.create_machine_with_memory(memory, true, Vec::new(), false)
    }

    /// Creates a Linux machine with a separately mapped immutable GPA range.
    ///
    /// The host mapping is `PROT_READ | MAP_SHARED`; KVM slot 1 additionally
    /// uses `KVM_MEM_READONLY`. The operation fails closed when the active KVM
    /// provider does not advertise `KVM_CAP_READONLY_MEM`.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if the ranges overlap, the GPA is unaligned,
    /// the read-only capability is absent, or VM/memory setup fails.
    pub fn create_linux_machine_with_read_only_image(
        &self,
        memory_size: usize,
        image: &PvmReadOnlyImage,
        guest_phys_address: u64,
    ) -> Result<PvmMachine, PvmDeviceError> {
        self.create_linux_machine_with_read_only_images(
            memory_size,
            &[PvmReadOnlyRegion::new(image, guest_phys_address)],
        )
    }

    /// Creates a Linux machine with up to two separately enforced immutable ranges.
    ///
    /// Slot assignment is intentionally fixed rather than caller-controlled:
    /// the first range uses slot 1 and the second uses slot 4, leaving the
    /// clone-private socket slots 2 and 3 unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if more than two ranges are supplied, any
    /// range is invalid or overlaps RAM/another range, read-only KVM memory is
    /// unavailable, or VM construction fails.
    pub fn create_linux_machine_with_read_only_images(
        &self,
        memory_size: usize,
        images: &[PvmReadOnlyRegion<'_>],
    ) -> Result<PvmMachine, PvmDeviceError> {
        let memory = HostMapping::new(memory_size)?;
        let read_only_memory = map_read_only_regions(images)?;
        self.create_machine_with_memory(memory, true, read_only_memory, false)
    }

    /// Creates a new VM/vCPU with a private mapping of one sealed template.
    ///
    /// Clean pages remain backed by the same memfd page cache. Writes can only
    /// affect this machine's `MAP_PRIVATE` mapping.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if mapping, memslot, VM, vCPU, or CPUID setup
    /// fails.
    pub fn create_machine_from_template(
        &self,
        template: &PvmMemoryTemplate,
    ) -> Result<PvmMachine, PvmDeviceError> {
        let memory = HostMapping::from_template(template)?;
        self.create_machine_with_memory(memory, false, Vec::new(), false)
    }

    /// Creates a Linux-capable VM/vCPU with a private mapping of a sealed
    /// warm-memory template.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if the mapping, VM, devices, or vCPU cannot
    /// be created.
    pub fn create_linux_machine_from_template(
        &self,
        template: &PvmMemoryTemplate,
    ) -> Result<PvmMachine, PvmDeviceError> {
        let memory = HostMapping::from_template(template)?;
        self.create_machine_with_memory(memory, true, Vec::new(), true)
    }

    /// Creates a dirty-tracked Linux clone from sealed RAM and shared EROFS.
    ///
    /// RAM uses a private mapping of `template`, while the optional root image
    /// remains a separately enforced read-only mapping shared by every clone.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if either mapping, the KVM VM, or its legacy
    /// devices cannot be constructed.
    pub fn create_linux_machine_from_template_with_read_only_image(
        &self,
        template: &PvmMemoryTemplate,
        image: &PvmReadOnlyImage,
        guest_phys_address: u64,
    ) -> Result<PvmMachine, PvmDeviceError> {
        self.create_linux_machine_from_template_with_read_only_images(
            template,
            &[PvmReadOnlyRegion::new(image, guest_phys_address)],
        )
    }

    /// Creates a dirty-tracked Linux clone with up to two immutable images.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] under the same validation rules as
    /// [`Self::create_linux_machine_with_read_only_images`], or when the RAM
    /// template cannot be privately mapped.
    pub fn create_linux_machine_from_template_with_read_only_images(
        &self,
        template: &PvmMemoryTemplate,
        images: &[PvmReadOnlyRegion<'_>],
    ) -> Result<PvmMachine, PvmDeviceError> {
        let memory = HostMapping::from_template(template)?;
        let read_only_memory = map_read_only_regions(images)?;
        self.create_machine_with_memory(memory, true, read_only_memory, true)
    }

    fn create_machine_with_memory(
        &self,
        memory: HostMapping,
        linux_devices: bool,
        read_only_memory: Vec<ReadOnlyMapping>,
        tracks_dirty_pages: bool,
    ) -> Result<PvmMachine, PvmDeviceError> {
        let page_reclaim =
            tracks_dirty_pages.then(|| page_reclaim::PageReclaimState::new(memory.length));
        let vm = self
            .kvm
            .create_vm()
            .map_err(|error| kvm_error("create runtime VM", error))?;
        let memory_size = u64::try_from(memory.length)
            .map_err(|error| memory_error("convert memory size", error))?;
        let userspace_addr = u64::try_from(memory.pointer.as_ptr().addr())
            .map_err(|error| memory_error("convert host address", error))?;
        let region = kvm_userspace_memory_region {
            slot: 0,
            guest_phys_addr: 0,
            memory_size,
            userspace_addr,
            flags: if tracks_dirty_pages {
                KVM_MEM_LOG_DIRTY_PAGES
            } else {
                0
            },
        };
        // SAFETY: `memory` owns a valid, writable mapping covering the complete
        // region and is stored in `PvmMachine`, where it outlives the VM/vCPU.
        unsafe { vm.set_user_memory_region(region) }
            .map_err(|error| kvm_error("register runtime memory", error))?;

        self.register_read_only_memory(&vm, memory_size, &read_only_memory)?;

        if linux_devices {
            vm.create_irq_chip()
                .map_err(|error| kvm_error("create Linux interrupt controller", error))?;
            vm.create_pit2(kvm_pit_config {
                flags: KVM_PIT_SPEAKER_DUMMY,
                ..Default::default()
            })
            .map_err(|error| kvm_error("create Linux PIT", error))?;
        }

        let vcpu = vm
            .create_vcpu(0)
            .map_err(|error| kvm_error("create runtime vCPU", error))?;
        self.configure_vcpu_cpuid(&vcpu)?;
        let wait_wake = Arc::new(
            EventFd::new(EFD_CLOEXEC | EFD_NONBLOCK)
                .map_err(|error| kvm_error("create PVM wait wakeup eventfd", error))?,
        );
        let wait_wake_enabled = Arc::new(AtomicBool::new(false));
        let run_cancel = Arc::new(PvmRunCancellation::new(
            &self.kvm,
            &vcpu,
            Arc::clone(&wait_wake),
        )?);

        Ok(PvmMachine {
            vcpu,
            system_block: None,
            data_block: None,
            template_block: None,
            vm,
            memory,
            read_only_memory,
            shared_memory: Vec::new(),
            irqfds: Vec::new(),
            uart: linux_devices.then(LegacyUart::default),
            cmos: linux_devices.then(LegacyCmos::default),
            msr_indices: Arc::clone(&self.msr_indices),
            tracks_dirty_pages,
            page_reclaim,
            wait_wake,
            wait_wake_enabled,
            run_cancel,
            run_stats: PvmRunStats::default(),
            vcpu_has_run: false,
            timeout_timer: TimeoutTimer::default(),
        })
    }

    fn register_read_only_memory(
        &self,
        vm: &VmFd,
        ram_end: u64,
        read_only_memory: &[ReadOnlyMapping],
    ) -> Result<(), PvmDeviceError> {
        if !read_only_memory.is_empty() && !self.kvm.check_extension(Cap::ReadonlyMem) {
            return Err(PvmDeviceError::Kvm {
                operation: "validate read-only guest memory",
                message: "KVM_CAP_READONLY_MEM is unavailable".to_owned(),
            });
        }
        for (index, read_only) in read_only_memory.iter().enumerate() {
            let image_start = read_only.guest_phys_address;
            let image_end = image_start
                .checked_add(read_only.length as u64)
                .ok_or_else(|| PvmDeviceError::Memory {
                    operation: "validate read-only guest memory",
                    message: "guest physical range overflowed".to_owned(),
                })?;
            if image_start < ram_end {
                return Err(PvmDeviceError::Memory {
                    operation: "validate read-only guest memory",
                    message: format!(
                        "read-only range {image_start:#x}..{image_end:#x} overlaps RAM 0..{ram_end:#x}"
                    ),
                });
            }
            let candidate = image_start..image_end;
            if let Some(previous) = read_only_memory[..index].iter().find(|previous| {
                let previous_range = previous.guest_phys_address
                    ..previous.guest_phys_address + previous.length as u64;
                ranges_overlap(&candidate, &previous_range)
            }) {
                let previous_end = previous.guest_phys_address + previous.length as u64;
                return Err(PvmDeviceError::Memory {
                    operation: "validate read-only guest memory",
                    message: format!(
                        "read-only range {image_start:#x}..{image_end:#x} overlaps {:#x}..{previous_end:#x}",
                        previous.guest_phys_address
                    ),
                });
            }
        }
        for read_only in read_only_memory {
            let image_start = read_only.guest_phys_address;
            let userspace_addr = u64::try_from(read_only.pointer.as_ptr().addr())
                .map_err(|error| memory_error("convert read-only host address", error))?;
            let region = kvm_userspace_memory_region {
                slot: read_only.slot,
                guest_phys_addr: image_start,
                memory_size: read_only.length as u64,
                userspace_addr,
                flags: KVM_MEM_READONLY,
            };
            // SAFETY: `read_only` owns a live page-aligned PROT_READ mapping
            // for the whole slot and is retained by `PvmMachine`. Capability
            // support was checked before setting KVM_MEM_READONLY.
            unsafe { vm.set_user_memory_region(region) }
                .map_err(|error| kvm_error("register read-only guest memory", error))?;
        }
        Ok(())
    }

    fn configure_vcpu_cpuid(&self, vcpu: &VcpuFd) -> Result<(), PvmDeviceError> {
        let cpuid = self
            .kvm
            .get_supported_cpuid(KVM_MAX_CPUID_ENTRIES)
            .map_err(|error| kvm_error("get runtime CPUID", error))?;
        vcpu.set_cpuid2(&cpuid)
            .map_err(|error| kvm_error("set runtime CPUID", error))
    }
}

impl PvmMachine {
    /// Returns a cloneable, host-only terminal cancellation capability.
    #[must_use]
    pub fn run_canceller(&self) -> PvmRunCanceller {
        self.run_cancel.handle()
    }

    /// Attaches one writable regular file as a modern, single-queue virtio-blk device.
    ///
    /// The device is fixed at [`PVM_VIRTIO_BLK_MMIO_BASE`] and
    /// [`PVM_VIRTIO_BLK_IRQ_GSI`]. Its only DMA view covers slot-zero RAM; the
    /// immutable PMEM image and service-mailbox slots are not addressable by
    /// virtio descriptors. Queue zero's four-byte notify register is connected
    /// directly to KVM ioeventfd, while completions use the existing bounded
    /// irqfd capability.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] unless this is a Linux machine with no prior
    /// block device, the file is regular and opened read-write, the MMIO range
    /// is free, and the rust-vmm service/ioeventfd registrations succeed.
    pub fn attach_virtio_block(&mut self, file: File) -> Result<(), PvmDeviceError> {
        if self.uart.is_none() || self.system_block.is_some() {
            return Err(PvmDeviceError::Kvm {
                operation: "attach virtio-blk",
                message: "machine is not Linux-capable or already has a system block device"
                    .to_owned(),
            });
        }
        let metadata = file
            .metadata()
            .map_err(|error| memory_error("inspect virtio-blk backing", error))?;
        // SAFETY: F_GETFL only reads status flags from the live owned fd.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 {
            return Err(memory_error(
                "inspect virtio-blk descriptor",
                io::Error::last_os_error(),
            ));
        }
        if !metadata.is_file() || flags & libc::O_ACCMODE != libc::O_RDWR {
            return Err(PvmDeviceError::Memory {
                operation: "attach virtio-blk",
                message: "backing must be a regular file opened read-write".to_owned(),
            });
        }
        // SAFETY: `flock` consumes only the live owned descriptor and does not
        // dereference userspace memory. The lock follows the open file into the
        // block worker and is released when that final owner is dropped.
        let lock = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if lock != 0 {
            return Err(memory_error(
                "lock writable virtio-blk backing exclusively",
                io::Error::last_os_error(),
            ));
        }
        self.attach_virtio_block_inner(PvmBlockDevice::System, BlockAttachment::File(file))
    }

    /// Attaches an opaque storage engine as a modern virtio-blk device.
    ///
    /// Unlike [`Self::attach_virtio_block`], this path neither accepts nor
    /// opens a block-image file descriptor. SQLite/FDB-backed implementations
    /// are called directly after the bounded virtio request has been parsed.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] unless this is a Linux machine with no prior
    /// block device, the fixed MMIO range is free, and device registration
    /// succeeds.
    pub fn attach_virtio_block_backend(
        &mut self,
        backend: Box<dyn PvmBlockBackend>,
    ) -> Result<(), PvmDeviceError> {
        self.attach_virtio_block_inner(PvmBlockDevice::System, BlockAttachment::Opaque(backend))
    }

    /// Attaches one persistent `ActorVolume` backend at the independent data-disk slot.
    ///
    /// This device is deliberately separate from the warm system disk. A clone
    /// may attach it immediately before restoring a checkpoint that had no data
    /// device. The service then starts from virtio reset state, allowing the
    /// guest to bind and mount it without replaying another actor's queue state.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] unless this is a Linux machine with no prior
    /// `ActorVolume`, the fixed data MMIO range is free, and device registration
    /// succeeds.
    pub fn attach_actor_volume_backend(
        &mut self,
        backend: Box<dyn PvmBlockBackend>,
    ) -> Result<(), PvmDeviceError> {
        self.attach_virtio_block_inner(PvmBlockDevice::Data, BlockAttachment::Opaque(backend))
    }

    /// Attaches the immutable filesystem origin used by guest Device Mapper.
    ///
    /// The virtio device advertises `VIRTIO_BLK_F_RO`, and the host request
    /// parser rejects writes/flushes and treats validated advisory DISCARD as
    /// a no-op before it reaches the immutable backend.
    pub fn attach_actor_volume_template_backend(
        &mut self,
        backend: Box<dyn PvmBlockBackend>,
    ) -> Result<(), PvmDeviceError> {
        self.attach_virtio_block_inner(PvmBlockDevice::Template, BlockAttachment::Opaque(backend))
    }

    fn attach_virtio_block_inner(
        &mut self,
        device: PvmBlockDevice,
        attachment: BlockAttachment,
    ) -> Result<(), PvmDeviceError> {
        let already_attached = match device {
            PvmBlockDevice::System => self.system_block.is_some(),
            PvmBlockDevice::Data => self.data_block.is_some(),
            PvmBlockDevice::Template => self.template_block.is_some(),
        };
        if self.uart.is_none() || already_attached {
            return Err(PvmDeviceError::Kvm {
                operation: "attach virtio-blk",
                message: format!(
                    "machine is not Linux-capable or already has a {device:?} block device"
                ),
            });
        }
        let mmio = device.mmio_base()..device.mmio_base() + pvm_block_service::MMIO_SIZE;
        let overlaps = |left: &std::ops::Range<u64>, right: &std::ops::Range<u64>| {
            left.start < right.end && right.start < left.end
        };
        if overlaps(&mmio, &(0..self.memory.length as u64))
            || self
                .read_only_memory_ranges()
                .iter()
                .any(|(_, range)| overlaps(&mmio, range))
            || self.shared_memory.iter().any(|region| {
                let range = region.guest_phys_address
                    ..region.guest_phys_address + region.memory.len() as u64;
                overlaps(&mmio, &range)
            })
        {
            return Err(PvmDeviceError::Memory {
                operation: "attach virtio-blk",
                message: format!(
                    "MMIO range {:#x}..{:#x} overlaps guest memory",
                    mmio.start, mmio.end
                ),
            });
        }

        let irq_gsi = device.irq_gsi();
        let irq = self.register_irq_sender(irq_gsi)?;
        // SAFETY: `self.memory` owns this exact mapping, retains it after the
        // block field, and its mmap metadata is recorded at construction.
        let memory = unsafe {
            GuestRam::from_raw_mapping(
                self.memory.pointer,
                self.memory.length,
                self.memory.mmap_protection,
                self.memory.mmap_flags,
            )
        };
        let service = memory
            .map_err(|error| block_error("create virtio-blk RAM view", &error))
            .and_then(|memory| {
                let interrupt: Arc<dyn BlockInterrupt> = Arc::new(irq.clone());
                match attachment {
                    BlockAttachment::File(file) => BlockService::new(file, &memory, interrupt),
                    BlockAttachment::Opaque(backend) if device == PvmBlockDevice::Template => {
                        BlockService::with_read_only_backend(backend, &memory, interrupt)
                    }
                    BlockAttachment::Opaque(backend) => {
                        BlockService::with_backend(backend, &memory, interrupt)
                    }
                }
                .map_err(|error| block_error("create virtio-blk service", &error))
            });
        let service = match service {
            Ok(service) => service,
            Err(error) => {
                let _ = self.vm.unregister_irqfd(&irq.event, irq_gsi);
                self.irqfds.retain(|registered| registered.gsi != irq_gsi);
                return Err(error);
            }
        };
        let doorbell = IoEventAddress::Mmio(device.mmio_base() + QUEUE_NOTIFY_OFFSET);
        if let Err(error) = self
            .vm
            .register_ioevent(service.kick_event(), &doorbell, 0_u32)
        {
            let _ = self.vm.unregister_irqfd(&irq.event, irq_gsi);
            self.irqfds.retain(|registered| registered.gsi != irq_gsi);
            return Err(kvm_error("register virtio-blk ioeventfd", error));
        }
        match device {
            PvmBlockDevice::System => self.system_block = Some(service),
            PvmBlockDevice::Data => self.data_block = Some(service),
            PvmBlockDevice::Template => self.template_block = Some(service),
        }
        Ok(())
    }

    /// Captures the stopped writable block into an unlinked clone baseline.
    ///
    /// The vCPU must be stopped. This method drains the queue and synchronizes
    /// the backing before asking `pool` for a reflink or sparse extent copy.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] when no block device is attached or quiesce,
    /// sync, or pool-local cloning fails.
    pub fn snapshot_virtio_block(
        &self,
        pool: &PvmBlockPool,
    ) -> Result<PvmBlockTemplate, PvmDeviceError> {
        let block = self
            .system_block
            .as_ref()
            .ok_or_else(|| PvmDeviceError::Kvm {
                operation: "snapshot virtio-blk",
                message: "machine has no virtio-blk device".to_owned(),
            })?;
        block
            .quiesce_and_snapshot()
            .map_err(|error| block_error("quiesce virtio-blk snapshot", &error))?;
        let backing = block
            .quiesced_backing()
            .map_err(|error| block_error("duplicate virtio-blk backing", &error))?;
        pool.snapshot(&backing)
            .map_err(|error| block_error("clone virtio-blk baseline", &error))
    }

    /// Registers a fresh shared-memory object as one additional KVM memslot.
    ///
    /// Slots zero, one, and four are reserved for clone RAM and the two optional
    /// immutable images. The requested GPA must not overlap any of those ranges,
    /// the fixed virtio-blk register page, or an earlier device slot. Read-only
    /// registration fails closed when the active provider lacks
    /// `KVM_CAP_READONLY_MEM`.
    ///
    /// The machine retains an [`Arc`] so the mapping outlives KVM. Device code
    /// may retain another clone to access the protocol bytes.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] for a reserved/duplicate slot, unaligned or
    /// overlapping range, unsupported read-only memory, or KVM failure.
    pub fn register_shared_memory(
        &mut self,
        slot: u32,
        guest_phys_address: u64,
        memory: Arc<PvmSharedMemory>,
        read_only: bool,
    ) -> Result<(), PvmDeviceError> {
        if slot == 0
            || READ_ONLY_MEMORY_SLOTS.contains(&slot)
            || self.shared_memory.iter().any(|region| region.slot == slot)
        {
            return Err(PvmDeviceError::Memory {
                operation: "register shared guest memory",
                message: format!("slot {slot} is reserved or already registered"),
            });
        }
        if !guest_phys_address.is_multiple_of(4096) {
            return Err(PvmDeviceError::Memory {
                operation: "register shared guest memory",
                message: format!("GPA {guest_phys_address:#x} is not page aligned"),
            });
        }
        let length = u64::try_from(memory.len())
            .map_err(|error| memory_error("convert shared memory length", error))?;
        let end = guest_phys_address
            .checked_add(length)
            .ok_or_else(|| PvmDeviceError::Memory {
                operation: "register shared guest memory",
                message: "guest physical range overflowed".to_owned(),
            })?;
        let candidate = guest_phys_address..end;
        let ram = 0..self.memory.length as u64;
        let overlaps = |left: &std::ops::Range<u64>, right: &std::ops::Range<u64>| {
            left.start < right.end && right.start < left.end
        };
        if overlaps(&candidate, &ram)
            || self
                .read_only_memory_ranges()
                .iter()
                .any(|(_, range)| overlaps(&candidate, range))
            || [
                PvmBlockDevice::System,
                PvmBlockDevice::Data,
                PvmBlockDevice::Template,
            ]
                .into_iter()
                .any(|device| {
                    overlaps(
                        &candidate,
                        &(device.mmio_base()..device.mmio_base() + pvm_block_service::MMIO_SIZE),
                    )
                })
            || self.shared_memory.iter().any(|region| {
                let range = region.guest_phys_address
                    ..region.guest_phys_address + region.memory.len() as u64;
                overlaps(&candidate, &range)
            })
        {
            return Err(PvmDeviceError::Memory {
                operation: "register shared guest memory",
                message: format!(
                    "GPA range {:#x}..{:#x} overlaps an existing memory slot",
                    candidate.start, candidate.end
                ),
            });
        }
        if read_only && !self.vm.check_extension(Cap::ReadonlyMem) {
            return Err(PvmDeviceError::Kvm {
                operation: "validate read-only shared guest memory",
                message: "KVM_CAP_READONLY_MEM is unavailable".to_owned(),
            });
        }
        let userspace_addr = u64::try_from(memory.as_ptr().as_ptr().addr())
            .map_err(|error| memory_error("convert shared host address", error))?;
        let region = kvm_userspace_memory_region {
            slot,
            guest_phys_addr: candidate.start,
            memory_size: length,
            userspace_addr,
            flags: if read_only { KVM_MEM_READONLY } else { 0 },
        };
        // SAFETY: `memory` owns a stable page-aligned mapping that covers the
        // full region. It is retained below until after the VM is dropped.
        unsafe { self.vm.set_user_memory_region(region) }
            .map_err(|error| kvm_error("register shared guest memory", error))?;
        self.shared_memory.push(RegisteredSharedMemory {
            memory,
            guest_phys_address: candidate.start,
            slot,
            read_only,
        });
        Ok(())
    }

    /// Queues trusted-runtime bytes for the bounded legacy Linux console.
    ///
    /// This method creates no host resource and parses no framing. It copies
    /// only the prefix that fits the UART's fixed receive FIFO, returns that
    /// byte count, and reflects the resulting device level onto fixed IRQ4.
    /// Callers may retry an unaccepted suffix after the guest consumes data.
    ///
    /// Console input must be injected while the vCPU is stopped at a host
    /// boundary. [`PvmTimedRun`] dereferences to `PvmMachine`, so an
    /// interactive runner can call this between [`PvmTimedRun::run_once`]
    /// operations.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] when this is not a Linux-device machine or
    /// KVM cannot update the UART's fixed interrupt line.
    pub fn queue_console_input(&mut self, input: &[u8]) -> Result<usize, PvmDeviceError> {
        let uart = self.uart.as_mut().ok_or_else(|| PvmDeviceError::Kvm {
            operation: "queue console input",
            message: "machine was created without a UART".to_owned(),
        })?;
        let accepted = uart.device.enqueue(input).accepted;
        sync_uart_irq(&self.vm, uart)?;
        Ok(accepted)
    }

    /// Registers one eventfd-backed IRQ and returns only its signaling capability.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] unless this is a Linux-device machine, the
    /// GSI is a usable legacy IRQ, no earlier device owns it, and KVM accepts
    /// irqfd registration.
    pub fn register_irq_sender(&mut self, gsi: u32) -> Result<PvmIrqSender, PvmDeviceError> {
        if self.uart.is_none()
            || !(5..16).contains(&gsi)
            || self.irqfds.iter().any(|irq| irq.gsi == gsi)
        {
            return Err(PvmDeviceError::Kvm {
                operation: "register device IRQ",
                message: format!("GSI {gsi} is unavailable or already registered"),
            });
        }
        let event = Arc::new(
            EventFd::new(EFD_CLOEXEC | EFD_NONBLOCK)
                .map_err(|error| kvm_error("create device IRQ eventfd", error))?,
        );
        self.vm
            .register_irqfd(&event, gsi)
            .map_err(|error| kvm_error("register device IRQ eventfd", error))?;
        self.irqfds.push(RegisteredIrqFd {
            _event: Arc::clone(&event),
            gsi,
        });
        Ok(PvmIrqSender {
            event,
            wait_wake: Arc::clone(&self.wait_wake),
            wait_wake_enabled: Arc::clone(&self.wait_wake_enabled),
            gsi,
        })
    }

    /// Overrides KVM halt polling for this VM.
    ///
    /// A value of zero makes an idle vCPU schedule immediately instead of
    /// busy-polling for a near wakeup. The capability is host policy and is
    /// never controlled by guest input.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when the active provider does not
    /// implement `KVM_CAP_HALT_POLL` or rejects the requested nanoseconds.
    pub fn set_halt_poll_ns(&self, nanoseconds: u64) -> Result<(), PvmDeviceError> {
        let capability = kvm_enable_cap {
            cap: KVM_CAP_HALT_POLL,
            args: [nanoseconds, 0, 0, 0],
            ..Default::default()
        };
        self.vm
            .enable_cap(&capability)
            .map_err(|error| kvm_error("configure PVM halt polling", error))
    }

    /// Returns cumulative host-only execution attribution counters.
    #[must_use]
    pub const fn run_stats(&self) -> PvmRunStats {
        self.run_stats
    }

    /// Resets host-only execution attribution counters.
    pub fn reset_run_stats(&mut self) {
        self.run_stats = PvmRunStats::default();
    }

    fn arm_wait_wake(&self) -> bool {
        !self.wait_wake_enabled.swap(true, Ordering::AcqRel)
    }

    fn wait_for_device_or_timeout(&self, timeout: Duration) -> Result<bool, PvmDeviceError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| PvmDeviceError::Kvm {
                operation: "compute PVM guest wait deadline",
                message: "guest wait exceeds the host monotonic clock range".to_owned(),
            })?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            let seconds = remaining
                .as_secs()
                .try_into()
                .map_err(|error| kvm_error("convert PVM guest wait", error))?;
            let timeout = libc::timespec {
                tv_sec: seconds,
                tv_nsec: libc::c_long::from(remaining.subsec_nanos()),
            };
            let mut descriptor = libc::pollfd {
                fd: self.wait_wake.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: `descriptor` and `timeout` are initialized stack values;
            // the eventfd remains owned by this machine for the complete call.
            let result = unsafe {
                libc::ppoll(
                    std::ptr::addr_of_mut!(descriptor),
                    1,
                    std::ptr::addr_of!(timeout),
                    std::ptr::null(),
                )
            };
            if result > 0 {
                match self.wait_wake.read() {
                    Ok(_) => return Ok(true),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(true),
                    Err(error) => return Err(kvm_error("drain PVM wait wakeup", error)),
                }
            }
            if result == 0 {
                return Ok(false);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(kvm_error("poll PVM guest wait", error));
            }
        }
    }

    /// Returns registered device memory ranges and permissions for diagnostics.
    #[must_use]
    pub fn shared_memory_ranges(&self) -> Vec<(u32, std::ops::Range<u64>, bool)> {
        self.shared_memory
            .iter()
            .map(|region| {
                (
                    region.slot,
                    region.guest_phys_address
                        ..region.guest_phys_address + region.memory.len() as u64,
                    region.read_only,
                )
            })
            .collect()
    }

    /// Returns the backing inode for the optional shared image.
    #[must_use]
    pub fn read_only_backing_id(&self) -> Option<u64> {
        self.read_only_memory
            .first()
            .map(|mapping| mapping.backing_id)
    }

    /// Returns the optional shared image's guest-physical range.
    #[must_use]
    pub fn read_only_memory_range(&self) -> Option<std::ops::Range<u64>> {
        self.read_only_memory.first().map(|mapping| {
            mapping.guest_phys_address..mapping.guest_phys_address + mapping.length as u64
        })
    }

    /// Returns every immutable image's KVM slot and backing inode.
    #[must_use]
    pub fn read_only_backing_ids(&self) -> Vec<(u32, u64)> {
        self.read_only_memory
            .iter()
            .map(|mapping| (mapping.slot, mapping.backing_id))
            .collect()
    }

    /// Returns every immutable image's KVM slot and guest-physical range.
    #[must_use]
    pub fn read_only_memory_ranges(&self) -> Vec<(u32, std::ops::Range<u64>)> {
        self.read_only_memory
            .iter()
            .map(|mapping| {
                (
                    mapping.slot,
                    mapping.guest_phys_address..mapping.guest_phys_address + mapping.length as u64,
                )
            })
            .collect()
    }

    /// Reads a compact architectural snapshot for failure diagnostics.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] if KVM register reads fail.
    pub fn cpu_state(&self) -> Result<PvmCpuState, PvmDeviceError> {
        let registers = self
            .vcpu
            .get_regs()
            .map_err(|error| kvm_error("get diagnostic registers", error))?;
        let special = self
            .vcpu
            .get_sregs()
            .map_err(|error| kvm_error("get diagnostic special registers", error))?;
        Ok(PvmCpuState {
            rip: registers.rip,
            rsp: registers.rsp,
            rflags: registers.rflags,
            cr2: special.cr2,
            cr3: special.cr3,
            cr0: special.cr0,
            cr4: special.cr4,
            efer: special.efer,
        })
    }

    /// Reads the PVM control MSRs for bootstrap and event diagnostics.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] if KVM does not return every requested
    /// control MSR.
    pub fn pvm_control_state(&self) -> Result<PvmControlState, PvmDeviceError> {
        let requested = [
            msr(MSR_LINEAR_ADDRESS_RANGE, 0),
            msr(MSR_VCPU_STRUCT, 0),
            msr(MSR_EVENT_ENTRY, 0),
            msr(MSR_RETU_RIP, 0),
        ];
        let mut msrs =
            Msrs::from_entries(&requested).map_err(|error| PvmDeviceError::AbiBuffer {
                message: error.to_string(),
            })?;
        let read = self
            .vcpu
            .get_msrs(&mut msrs)
            .map_err(|error| kvm_error("get PVM diagnostic MSRs", error))?;
        if read != requested.len() {
            return Err(PvmDeviceError::Kvm {
                operation: "get PVM diagnostic MSRs",
                message: format!("short read: {read}/{} entries", requested.len()),
            });
        }
        let values = msrs.as_slice();
        Ok(PvmControlState {
            linear_address_range: values[0].data,
            pvcs_gpa: values[1].data,
            event_entry: values[2].data,
            retu_rip: values[3].data,
        })
    }

    /// Copies bytes into the registered guest-physical memory slot.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] if address conversion, range
    /// arithmetic, or allocation bounds validation fails.
    pub fn write_memory(
        &mut self,
        guest_address: u64,
        source: &[u8],
    ) -> Result<(), PvmDeviceError> {
        self.memory.write(guest_address, source)
    }

    /// Copies bytes from registered guest-physical memory.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] if conversion, range arithmetic, or
    /// bounds validation fails.
    pub fn read_memory(
        &self,
        guest_address: u64,
        length: usize,
    ) -> Result<Vec<u8>, PvmDeviceError> {
        self.memory.read(guest_address, length)
    }

    /// Returns the registered guest-physical memory length.
    #[must_use]
    pub const fn memory_len(&self) -> usize {
        self.memory.length
    }

    /// Returns the sealed backing identity for a template-derived machine.
    #[must_use]
    pub const fn backing_id(&self) -> Option<u64> {
        self.memory.backing_id
    }

    /// Forces exactly one page in a private template mapping to materialize.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] for an unaligned or out-of-bounds GPA.
    pub fn privatize_page(&mut self, guest_address: u64) -> Result<(), PvmDeviceError> {
        self.memory.privatize_page(guest_address)
    }

    /// Reads the syscall-visible general-purpose register subset.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] if `KVM_GET_REGS` fails.
    pub fn registers(&self) -> Result<PvmRegisters, PvmDeviceError> {
        let registers = self
            .vcpu
            .get_regs()
            .map_err(|error| kvm_error("get general registers", error))?;
        Ok(PvmRegisters {
            rax: registers.rax,
            rdi: registers.rdi,
            rsi: registers.rsi,
            rdx: registers.rdx,
            r10: registers.r10,
            r8: registers.r8,
            r9: registers.r9,
        })
    }

    /// Replaces RAX before resuming a supervisor syscall stub.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] if register read/write fails.
    pub fn set_rax(&self, value: u64) -> Result<(), PvmDeviceError> {
        let mut registers = self
            .vcpu
            .get_regs()
            .map_err(|error| kvm_error("get return register", error))?;
        registers.rax = value;
        self.vcpu
            .set_regs(&registers)
            .map_err(|error| kvm_error("set return register", error))
    }

    /// Replaces the user FS base used by a resumed static Linux process.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] if special-register access fails.
    pub fn set_fs_base(&self, value: u64) -> Result<(), PvmDeviceError> {
        let mut special = self
            .vcpu
            .get_sregs()
            .map_err(|error| kvm_error("get FS base", error))?;
        special.fs.base = value;
        self.vcpu
            .set_sregs(&special)
            .map_err(|error| kvm_error("set FS base", error))
    }

    /// Captures the syscall-boundary state needed by template children.
    ///
    /// The returned state starts at the supervisor ERETU stub rather than in
    /// the reporting `OUT` instruction and supplies the chosen syscall return.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] if register or FPU state cannot be read.
    pub fn capture_resume_state(
        &self,
        retu_rip: u64,
        return_value: u64,
    ) -> Result<PvmResumeState, PvmDeviceError> {
        let mut registers = self
            .vcpu
            .get_regs()
            .map_err(|error| kvm_error("capture checkpoint registers", error))?;
        registers.rip = retu_rip;
        registers.rax = return_value;
        let fpu = self
            .vcpu
            .get_fpu()
            .map_err(|error| kvm_error("capture checkpoint FPU", error))?;
        let fs_base = self
            .vcpu
            .get_sregs()
            .map_err(|error| kvm_error("capture checkpoint FS base", error))?
            .fs
            .base;
        Ok(PvmResumeState {
            registers,
            fpu,
            fs_base,
        })
    }

    /// Captures a stopped single-vCPU Linux machine at a completed host exit.
    ///
    /// The checkpoint protocol uses a completed four-byte `OUT`, so there is no
    /// pending userspace I/O completion to serialize. Callers must not run the
    /// vCPU concurrently with this method.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if any architectural, interrupt-controller,
    /// timer, clock, or userspace legacy-device state cannot be captured.
    pub fn capture_linux_state(&self) -> Result<PvmLinuxState, PvmDeviceError> {
        let uart = self.uart.clone().ok_or_else(|| PvmDeviceError::Kvm {
            operation: "capture Linux checkpoint",
            message: "machine was created without a UART".to_owned(),
        })?;
        if uart.device.pending_input() != 0 {
            return Err(PvmDeviceError::Kvm {
                operation: "capture Linux checkpoint",
                message: "console input must be drained before checkpoint".to_owned(),
            });
        }
        let cmos = self.cmos.clone().ok_or_else(|| PvmDeviceError::Kvm {
            operation: "capture Linux checkpoint",
            message: "machine was created without CMOS state".to_owned(),
        })?;
        let system_block = self
            .system_block
            .as_ref()
            .map(BlockService::quiesce_and_snapshot)
            .transpose()
            .map_err(|error| block_error("quiesce system virtio-blk", &error))?;
        let data_block = self
            .data_block
            .as_ref()
            .map(BlockService::quiesce_and_snapshot)
            .transpose()
            .map_err(|error| block_error("quiesce data virtio-blk", &error))?;
        let template_block = self
            .template_block
            .as_ref()
            .map(BlockService::quiesce_and_snapshot)
            .transpose()
            .map_err(|error| block_error("quiesce template virtio-blk", &error))?;
        let mut irqchips = std::array::from_fn(|_| kvm_irqchip::default());
        for (irqchip, chip_id) in irqchips.iter_mut().zip([
            KVM_IRQCHIP_PIC_MASTER,
            KVM_IRQCHIP_PIC_SLAVE,
            KVM_IRQCHIP_IOAPIC,
        ]) {
            irqchip.chip_id = chip_id;
            self.vm
                .get_irqchip(irqchip)
                .map_err(|error| kvm_error("capture Linux IRQ chip", error))?;
        }
        Ok(PvmLinuxState {
            registers: self
                .vcpu
                .get_regs()
                .map_err(|error| kvm_error("capture Linux registers", error))?,
            special_registers: self
                .vcpu
                .get_sregs()
                .map_err(|error| kvm_error("capture Linux special registers", error))?,
            xsave: self.capture_xsave()?,
            xcrs: self
                .vcpu
                .get_xcrs()
                .map_err(|error| kvm_error("capture Linux XCRs", error))?,
            debug_registers: self
                .vcpu
                .get_debug_regs()
                .map_err(|error| kvm_error("capture Linux debug registers", error))?,
            lapic: self
                .vcpu
                .get_lapic()
                .map_err(|error| kvm_error("capture Linux LAPIC", error))?,
            mp_state: self
                .vcpu
                .get_mp_state()
                .map_err(|error| kvm_error("capture Linux MP state", error))?,
            vcpu_events: self
                .vcpu
                .get_vcpu_events()
                .map_err(|error| kvm_error("capture Linux vCPU events", error))?,
            msrs: self.capture_linux_msrs()?,
            irqchips,
            pit: self
                .vm
                .get_pit2()
                .map_err(|error| kvm_error("capture Linux PIT", error))?,
            clock: self
                .vm
                .get_clock()
                .map_err(|error| kvm_error("capture Linux clock", error))?,
            uart,
            cmos,
            system_block,
            data_block,
            template_block,
        })
    }

    /// Restores a complete single-vCPU Linux checkpoint into a fresh VM.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] when this is not a Linux machine or any KVM
    /// state component cannot be replayed completely.
    pub fn restore_linux_state(&mut self, state: &PvmLinuxState) -> Result<(), PvmDeviceError> {
        if self.uart.is_none() || self.cmos.is_none() {
            return Err(PvmDeviceError::Kvm {
                operation: "restore Linux checkpoint",
                message: "machine was created without Linux devices".to_owned(),
            });
        }
        match (&self.system_block, &state.system_block) {
            (Some(block), Some(saved)) => block
                .restore_and_resume(saved)
                .map_err(|error| block_error("restore system virtio-blk", &error))?,
            (None, None) => {}
            _ => {
                return Err(PvmDeviceError::Kvm {
                    operation: "restore Linux checkpoint",
                    message: "system virtio-blk attachment does not match saved state".to_owned(),
                });
            }
        }
        validate_actor_volume_restore(
            self.data_block.is_some(),
            state.data_block.is_some(),
            self.vcpu_has_run,
        )
        .map_err(|message| PvmDeviceError::Kvm {
            operation: "restore Linux checkpoint",
            message: message.to_owned(),
        })?;
        match (&self.data_block, &state.data_block) {
            (Some(block), Some(saved)) => block
                .restore_and_resume(saved)
                .map_err(|error| block_error("restore data virtio-blk", &error))?,
            (None | Some(_), None) => {}
            (None, Some(_)) => unreachable!("validated missing ActorVolume"),
        }
        validate_actor_volume_restore(
            self.template_block.is_some(),
            state.template_block.is_some(),
            self.vcpu_has_run,
        )
        .map_err(|message| PvmDeviceError::Kvm {
            operation: "restore Linux checkpoint",
            message: message.to_owned(),
        })?;
        match (&self.template_block, &state.template_block) {
            (Some(block), Some(saved)) => block
                .restore_and_resume(saved)
                .map_err(|error| block_error("restore template virtio-blk", &error))?,
            (None | Some(_), None) => {}
            (None, Some(_)) => unreachable!("validated missing ActorVolume template"),
        }
        self.vm
            .set_clock(&state.clock)
            .map_err(|error| kvm_error("restore Linux clock", error))?;
        for irqchip in &state.irqchips {
            self.vm
                .set_irqchip(irqchip)
                .map_err(|error| kvm_error("restore Linux IRQ chip", error))?;
        }
        self.vm
            .set_pit2(&state.pit)
            .map_err(|error| kvm_error("restore Linux PIT", error))?;
        self.vcpu
            .set_sregs(&state.special_registers)
            .map_err(|error| kvm_error("restore Linux special registers", error))?;
        for entries in state.msrs.chunks(kvm_bindings::KVM_MAX_MSR_ENTRIES) {
            let msrs = Msrs::from_entries(entries).map_err(|error| PvmDeviceError::AbiBuffer {
                message: error.to_string(),
            })?;
            let written = self
                .vcpu
                .set_msrs(&msrs)
                .map_err(|error| kvm_error("restore Linux MSRs", error))?;
            if written != entries.len() {
                return Err(PvmDeviceError::Kvm {
                    operation: "restore Linux MSRs",
                    message: format!("short write: {written}/{} entries", entries.len()),
                });
            }
        }
        self.vcpu
            .set_lapic(&state.lapic)
            .map_err(|error| kvm_error("restore Linux LAPIC", error))?;
        self.vcpu
            .set_xcrs(&state.xcrs)
            .map_err(|error| kvm_error("restore Linux XCRs", error))?;
        match &state.xsave {
            PvmXsaveState::Legacy(xsave) => {
                // SAFETY: The legacy state was returned by KVM_GET_XSAVE on
                // the same provider and no dynamic xfeature buffer is used.
                unsafe { self.vcpu.set_xsave(xsave) }
                    .map_err(|error| kvm_error("restore Linux XSAVE", error))?;
            }
            PvmXsaveState::Extended(xsave) => {
                // SAFETY: The wrapper retains the exact buffer size obtained
                // from KVM_CAP_XSAVE2 at capture time. Clones use the same KVM
                // provider and CPUID, and the stopped guest cannot enable a new
                // dynamic xfeature between capture and restore.
                unsafe { self.vcpu.set_xsave2(xsave) }
                    .map_err(|error| kvm_error("restore Linux XSAVE2", error))?;
            }
        }
        self.vcpu
            .set_debug_regs(&state.debug_registers)
            .map_err(|error| kvm_error("restore Linux debug registers", error))?;
        self.vcpu
            .set_regs(&state.registers)
            .map_err(|error| kvm_error("restore Linux registers", error))?;
        self.vcpu
            .set_vcpu_events(&state.vcpu_events)
            .map_err(|error| kvm_error("restore Linux vCPU events", error))?;
        self.vcpu
            .set_mp_state(state.mp_state)
            .map_err(|error| kvm_error("restore Linux MP state", error))?;
        self.uart = Some(state.uart.clone());
        // Calendar bytes from a long-lived warm template are stale. Re-arm the
        // boot RTC so a later guest RTC read observes clone-start UTC. Linux's
        // active realtime and monotonic clocks continue on the same-host TSC.
        self.cmos = Some(LegacyCmos::resumed_from(&state.cmos));
        Ok(())
    }

    /// Seals the stopped machine's complete writable RAM as a shared baseline.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Memory`] if the memfd cannot be created,
    /// populated, or sealed.
    pub fn snapshot_memory_template(&self) -> Result<PvmMemoryTemplate, PvmDeviceError> {
        // SAFETY: `memory` owns this live range. The vCPU is stopped at a KVM
        // exit and this shared borrow prevents host mutation during the copy.
        let bytes =
            unsafe { std::slice::from_raw_parts(self.memory.pointer.as_ptr(), self.memory.length) };
        PvmMemoryTemplate::from_bytes(bytes)
    }

    fn capture_xsave(&self) -> Result<PvmXsaveState, PvmDeviceError> {
        let xsave_size = self.vm.check_extension_int(Cap::Xsave2);
        if xsave_size <= 0 {
            return self
                .vcpu
                .get_xsave()
                .map(Box::new)
                .map(PvmXsaveState::Legacy)
                .map_err(|error| kvm_error("capture Linux XSAVE", error));
        }
        let xsave_size = usize::try_from(xsave_size)
            .map_err(|error| memory_error("convert XSAVE2 size", error))?;
        let base_size = std::mem::size_of::<kvm_xsave>();
        let extra_bytes =
            xsave_size
                .checked_sub(base_size)
                .ok_or_else(|| PvmDeviceError::AbiBuffer {
                    message: format!(
                        "KVM_CAP_XSAVE2 size {xsave_size} is smaller than {base_size}"
                    ),
                })?;
        let mut xsave =
            Xsave::new(extra_bytes.div_ceil(std::mem::size_of::<u32>())).map_err(|error| {
                PvmDeviceError::AbiBuffer {
                    message: error.to_string(),
                }
            })?;
        // SAFETY: The FAM allocation uses the exact KVM_CAP_XSAVE2 byte size,
        // rounded up only to its u32 entry unit as required by kvm-bindings.
        unsafe { self.vcpu.get_xsave2(&mut xsave) }
            .map_err(|error| kvm_error("capture Linux XSAVE2", error))?;
        Ok(PvmXsaveState::Extended(xsave))
    }

    fn capture_linux_msrs(&self) -> Result<Vec<kvm_msr_entry>, PvmDeviceError> {
        let requested: Vec<_> = self
            .msr_indices
            .iter()
            .copied()
            .map(|index| msr(index, 0))
            .collect();
        let mut values = Vec::with_capacity(requested.len() + PVM_STATE_MSRS.len());
        for entries in requested.chunks(kvm_bindings::KVM_MAX_MSR_ENTRIES) {
            let mut msrs =
                Msrs::from_entries(entries).map_err(|error| PvmDeviceError::AbiBuffer {
                    message: error.to_string(),
                })?;
            let read = self
                .vcpu
                .get_msrs(&mut msrs)
                .map_err(|error| kvm_error("capture Linux MSRs", error))?;
            if read != entries.len() {
                return Err(PvmDeviceError::Kvm {
                    operation: "capture Linux MSRs",
                    message: format!("short read: {read}/{} entries", entries.len()),
                });
            }
            values.extend_from_slice(msrs.as_slice());
        }
        for index in PVM_STATE_MSRS {
            if values.iter().any(|entry| entry.index == index) {
                continue;
            }
            let mut msrs = Msrs::from_entries(&[msr(index, 0)]).map_err(|error| {
                PvmDeviceError::AbiBuffer {
                    message: error.to_string(),
                }
            })?;
            let read = self
                .vcpu
                .get_msrs(&mut msrs)
                .map_err(|error| kvm_error("capture PVM Linux MSR", error))?;
            if read == 1 {
                values.push(msrs.as_slice()[0]);
            }
        }
        Ok(values)
    }

    /// Programs long mode, PVM MSRs, and the first supervisor ERETU frame.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if any KVM register or MSR operation fails.
    pub fn configure_user_entry(&mut self, config: PvmBootConfig) -> Result<(), PvmDeviceError> {
        self.configure_user_state(config, None)
    }

    /// Programs PVM and restores a complete checkpoint syscall boundary.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if any KVM register, FPU, or MSR operation
    /// fails.
    pub fn configure_user_resume(
        &mut self,
        config: PvmBootConfig,
        state: &PvmResumeState,
    ) -> Result<(), PvmDeviceError> {
        self.configure_user_state(config, Some(state))
    }

    /// Programs the standard Linux `x86_64` direct-boot register contract.
    ///
    /// PVM mode is intentionally not configured here. The guest begins at the
    /// normal Linux 64-bit entry, detects the PVM provider, and owns all later
    /// PVCS/MSR setup itself.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError`] if special or general register setup fails.
    pub fn configure_linux_entry(
        &mut self,
        config: PvmLinuxBootConfig,
    ) -> Result<(), PvmDeviceError> {
        if self.uart.is_none() {
            return Err(PvmDeviceError::Kvm {
                operation: "configure Linux entry",
                message: "machine was created without Linux devices".to_owned(),
            });
        }
        let mut sregs = self
            .vcpu
            .get_sregs()
            .map_err(|error| kvm_error("get Linux bootstrap registers", error))?;
        sregs.cr0 = CR0_PE | CR0_MP | CR0_ET | CR0_NE | CR0_WP | CR0_AM | CR0_PG;
        sregs.cr3 = config.bootstrap_cr3;
        sregs.cr4 = CR4_PAE | CR4_OSFXSR | CR4_OSXMMEXCPT | CR4_FSGSBASE;
        sregs.efer = EFER_LME | EFER_LMA | EFER_NXE;
        sregs.cs = code_segment(0x10, 0);
        let data = data_segment(0x18, 0);
        sregs.ss = data;
        sregs.ds = data;
        sregs.es = data;
        sregs.fs = data;
        sregs.gs = data;
        sregs.gdt.base = config.gdt_base;
        sregs.gdt.limit = config.gdt_limit;
        self.vcpu
            .set_sregs(&sregs)
            .map_err(|error| kvm_error("set Linux bootstrap registers", error))?;
        self.vcpu
            .set_regs(&kvm_regs {
                rip: config.entry_rip,
                rsp: config.stack_pointer,
                rsi: config.boot_params_gpa,
                rflags: 0x2,
                ..Default::default()
            })
            .map_err(|error| kvm_error("set Linux entry registers", error))
    }

    fn configure_user_state(
        &mut self,
        config: PvmBootConfig,
        resume: Option<&PvmResumeState>,
    ) -> Result<(), PvmDeviceError> {
        let mut sregs = self
            .vcpu
            .get_sregs()
            .map_err(|error| kvm_error("get special registers", error))?;
        sregs.cr0 = CR0_PE | CR0_MP | CR0_ET | CR0_NE | CR0_WP | CR0_AM | CR0_PG;
        sregs.cr3 = config.supervisor_cr3;
        sregs.cr4 = CR4_PAE | CR4_OSFXSR | CR4_OSXMMEXCPT | CR4_FSGSBASE;
        sregs.efer = EFER_SCE | EFER_LME | EFER_LMA | EFER_NXE;
        sregs.cs = code_segment(0x8, 0);
        let data = data_segment(0x10, 0);
        sregs.ss = data;
        sregs.ds = data;
        sregs.es = data;
        sregs.fs = data;
        sregs.gs = data;
        sregs.gdt.base = config.gdt_base;
        sregs.gdt.limit = config.gdt_limit;
        if let Some(resume) = resume {
            sregs.fs.base = resume.fs_base;
        }
        self.vcpu
            .set_sregs(&sregs)
            .map_err(|error| kvm_error("set special registers", error))?;

        self.set_boot_msrs(config)?;
        let regs = if let Some(resume) = resume {
            resume.registers
        } else {
            kvm_regs {
                rip: config.retu_rip,
                rsp: if config.abi == PvmAbi::Legacy {
                    config.supervisor_rsp
                } else {
                    config.user_rsp
                },
                rflags: 2,
                ..Default::default()
            }
        };
        self.vcpu
            .set_regs(&regs)
            .map_err(|error| kvm_error("set general registers", error))?;
        if let Some(resume) = resume {
            self.vcpu
                .set_fpu(&resume.fpu)
                .map_err(|error| kvm_error("set checkpoint FPU", error))?;
        }
        Ok(())
    }

    /// Runs until the next host-visible KVM exit and copies its payload.
    ///
    /// # Errors
    ///
    /// Returns [`PvmDeviceError::Kvm`] when `KVM_RUN` fails.
    pub fn run_once(&mut self) -> Result<PvmExit, PvmDeviceError> {
        loop {
            self.vcpu_has_run = true;
            self.run_stats.kvm_runs = self.run_stats.kvm_runs.saturating_add(1);
            let exit = self
                .vcpu
                .run()
                .map_err(|error| kvm_error("run PVM vCPU", error))?;
            match &exit {
                VcpuExit::IoIn(port, _) | VcpuExit::IoOut(port, _)
                    if LegacyUart::contains(*port) =>
                {
                    self.run_stats.uart_io_exits = self.run_stats.uart_io_exits.saturating_add(1);
                }
                VcpuExit::IoIn(port, _) | VcpuExit::IoOut(port, _)
                    if LegacyCmos::contains(*port) =>
                {
                    self.run_stats.cmos_io_exits = self.run_stats.cmos_io_exits.saturating_add(1);
                }
                VcpuExit::IoOut(0x80, _) => {
                    self.run_stats.io_delay_exits = self.run_stats.io_delay_exits.saturating_add(1);
                }
                VcpuExit::MmioRead(address, _) | VcpuExit::MmioWrite(address, _)
                    if BlockService::contains(PVM_VIRTIO_BLK_MMIO_BASE, *address)
                        || BlockService::contains(PVM_VIRTIO_BLK_DATA_MMIO_BASE, *address)
                        || BlockService::contains(PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE, *address) =>
                {
                    self.run_stats.block_mmio_exits =
                        self.run_stats.block_mmio_exits.saturating_add(1);
                }
                _ => {}
            }
            if let Some(exit) = service_legacy_exit(&self.vm, &mut self.uart, &mut self.cmos, exit)?
                && let Some(exit) =
                    service_block_exit(self.system_block.as_ref(), PVM_VIRTIO_BLK_MMIO_BASE, exit)
                && let Some(exit) = service_block_exit(
                    self.data_block.as_ref(),
                    PVM_VIRTIO_BLK_DATA_MMIO_BASE,
                    exit,
                )
                && let Some(exit) = service_block_exit(
                    self.template_block.as_ref(),
                    PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE,
                    exit,
                )
            {
                let mut exit = classify_exit(exit, &self.read_only_memory);
                self.enrich_exit(&mut exit)?;
                match &exit {
                    PvmExit::Halted => {
                        self.run_stats.hlt_exits = self.run_stats.hlt_exits.saturating_add(1);
                    }
                    PvmExit::WaitUntil { timeout_ns } => {
                        self.run_stats.wait_until_exits =
                            self.run_stats.wait_until_exits.saturating_add(1);
                        self.run_stats.requested_wait_ns =
                            self.run_stats.requested_wait_ns.saturating_add(*timeout_ns);
                    }
                    _ => {}
                }
                return Ok(exit);
            }
        }
    }

    fn enrich_exit(&self, exit: &mut PvmExit) -> Result<(), PvmDeviceError> {
        match exit {
            PvmExit::Event { address, .. } => {
                *address = self
                    .vcpu
                    .get_regs()
                    .map_err(|error| kvm_error("read PVM event registers", error))?
                    .rdi;
            }
            PvmExit::IoOut { port, data }
                if *port == PVM_HYPERCALL_PORT
                    && decode_hypercall_word(data) == Some(PvmHypercall::ServiceNotify) =>
            {
                let bits = self
                    .vcpu
                    .get_regs()
                    .map_err(|error| kvm_error("read service-notify registers", error))?
                    .rdi;
                *exit = PvmServiceQueueSet::from_bits(bits).map_or_else(
                    || PvmExit::Unexpected {
                        description: format!("invalid service queue set {bits:#x}"),
                    },
                    |queues| PvmExit::ServiceNotify { queues },
                );
            }
            PvmExit::IoOut { port, data }
                if *port == PVM_HYPERCALL_PORT
                    && decode_hypercall_word(data) == Some(PvmHypercall::Exit) =>
            {
                let status = self
                    .vcpu
                    .get_regs()
                    .map_err(|error| kvm_error("read guest-exit registers", error))?
                    .rdi;
                *exit = classify_guest_exit(status);
            }
            PvmExit::IoOut { port, data }
                if *port == PVM_HYPERCALL_PORT
                    && decode_hypercall_word(data) == Some(PvmHypercall::WaitUntil) =>
            {
                let timeout_ns = self
                    .vcpu
                    .get_regs()
                    .map_err(|error| kvm_error("read guest wait deadline", error))?
                    .rdi;
                *exit = PvmExit::WaitUntil { timeout_ns };
            }
            _ => {}
        }
        Ok(())
    }

    fn set_boot_msrs(&self, config: PvmBootConfig) -> Result<(), PvmDeviceError> {
        let mut entries = vec![
            msr(MSR_STAR, STAR_VALUE),
            msr(MSR_LSTAR, config.lstar),
            msr(MSR_LINEAR_ADDRESS_RANGE, 0),
            msr(MSR_VCPU_STRUCT, config.pvcs_gpa),
            msr(MSR_EVENT_ENTRY, config.event_entry),
            msr(MSR_RETU_RIP, config.retu_rip),
            msr(MSR_KERNEL_GS_BASE, config.pvcs_gpa),
        ];
        if config.abi == PvmAbi::Legacy {
            entries.extend([
                msr(MSR_SWITCH_CR3, config.user_cr3),
                msr(MSR_SUPERVISOR_RSP, config.supervisor_rsp),
                msr(MSR_RETS_RIP, config.legacy_rets_rip),
            ]);
        }
        let msrs = Msrs::from_entries(&entries).map_err(|error| PvmDeviceError::AbiBuffer {
            message: error.to_string(),
        })?;
        let written = self
            .vcpu
            .set_msrs(&msrs)
            .map_err(|error| kvm_error("set PVM boot MSRs", error))?;
        if written != entries.len() {
            return Err(PvmDeviceError::Kvm {
                operation: "set PVM boot MSRs",
                message: format!("short write: {written}/{} entries", entries.len()),
            });
        }
        Ok(())
    }
}

impl Drop for PvmMachine {
    fn drop(&mut self) {
        // The cancellation handle may outlive this machine. Remove its second
        // kvm_run mapping before declaration-order drop closes the vCPU.
        self.run_cancel.detach();
    }
}

fn decode_hypercall_word(data: &[u8]) -> Option<PvmHypercall> {
    let bytes: [u8; size_of::<u32>()] = data.try_into().ok()?;
    PvmHypercall::decode(u32::from_le_bytes(bytes))
}

fn classify_guest_exit(status: u64) -> PvmExit {
    u8::try_from(status).map_or_else(
        |_| PvmExit::Unexpected {
            description: format!("invalid guest exit status {status:#x}"),
        },
        |status| PvmExit::GuestExit { status },
    )
}

fn classify_exit(exit: VcpuExit<'_>, read_only_memory: &[ReadOnlyMapping]) -> PvmExit {
    match exit {
        VcpuExit::IoOut(UART_BASE, data) => PvmExit::ConsoleWrite {
            data: data.to_vec(),
        },
        VcpuExit::IoOut(port @ PVM_EVENT_PORT_BASE..=PVM_EVENT_PORT_END, data)
            if data.len() == size_of::<u32>() =>
        {
            PvmExit::Event {
                vector: u8::try_from(port - PVM_EVENT_PORT_BASE)
                    .expect("PVM event ports fit one byte"),
                error_code: u32::from_le_bytes(
                    data.try_into()
                        .expect("guard requires one 32-bit event code"),
                ),
                address: 0,
            }
        }
        VcpuExit::IoOut(port, data) => PvmExit::IoOut {
            port,
            data: data.to_vec(),
        },
        VcpuExit::MmioWrite(address, data)
            if read_only_memory
                .iter()
                .any(|mapping| mapping.contains(address)) =>
        {
            PvmExit::ReadOnlyMemoryWrite {
                address,
                data: data.to_vec(),
            }
        }
        VcpuExit::Hlt => PvmExit::Halted,
        VcpuExit::Shutdown => PvmExit::Shutdown,
        other => PvmExit::Unexpected {
            description: format!("{other:?}"),
        },
    }
}

fn service_block_exit<'a>(
    block: Option<&BlockService>,
    mmio_base: u64,
    exit: VcpuExit<'a>,
) -> Option<VcpuExit<'a>> {
    match exit {
        VcpuExit::MmioRead(address, data) if BlockService::contains(mmio_base, address) => {
            if let Some(block) = block {
                block.mmio_read(address - mmio_base, data);
            } else {
                // The platform descriptor exists in the warm guest, but the
                // ActorVolume backend is deliberately injected only into a
                // clone. All-zero MMIO makes the virtio-mmio probe fail cleanly
                // on its magic check without exposing an unexpected VM exit.
                data.fill(0);
            }
            None
        }
        VcpuExit::MmioWrite(address, data) if BlockService::contains(mmio_base, address) => {
            if let Some(block) = block {
                block.mmio_write(address - mmio_base, data);
            }
            None
        }
        other => Some(other),
    }
}

fn validate_actor_volume_restore(
    attached: bool,
    saved: bool,
    vcpu_has_run: bool,
) -> Result<(), &'static str> {
    if saved && !attached {
        return Err("saved ActorVolume is missing from restored machine");
    }
    if attached && !saved && vcpu_has_run {
        return Err("fresh ActorVolume was exposed before checkpoint restore");
    }
    Ok(())
}

fn block_error(operation: &'static str, error: &pvm_block_service::Error) -> PvmDeviceError {
    PvmDeviceError::Kvm {
        operation,
        message: error.to_string(),
    }
}

fn service_legacy_exit<'a>(
    vm: &VmFd,
    uart: &mut Option<LegacyUart>,
    cmos: &mut Option<LegacyCmos>,
    exit: VcpuExit<'a>,
) -> Result<Option<VcpuExit<'a>>, PvmDeviceError> {
    let (Some(uart), Some(cmos)) = (uart.as_mut(), cmos.as_mut()) else {
        return Ok(Some(exit));
    };
    let serviced = match exit {
        VcpuExit::IoIn(port, data) if LegacyUart::contains(port) => {
            uart.read(port, data);
            None
        }
        VcpuExit::IoOut(port, data) if LegacyUart::contains(port) => uart
            .write(port, data)
            .map(|transmitted| VcpuExit::IoOut(port, transmitted)),
        VcpuExit::IoIn(port, data) if LegacyCmos::contains(port) => {
            cmos.read(port, data).map_err(|error| PvmDeviceError::Kvm {
                operation: "read host-backed boot RTC",
                message: error.to_string(),
            })?;
            None
        }
        VcpuExit::IoOut(port, data) if LegacyCmos::contains(port) => {
            cmos.write(port, data);
            None
        }
        // Linux uses port 0x80 as a legacy I/O-delay sink during early boot.
        // It is deliberately consumed only on a Linux-device machine; 0x80
        // remains the minisandbox syscall exit on the freestanding path.
        VcpuExit::IoOut(0x80, _) => None,
        other => Some(other),
    };
    sync_uart_irq(vm, uart)?;
    Ok(serviced)
}

fn sync_uart_irq(vm: &VmFd, uart: &mut LegacyUart) -> Result<(), PvmDeviceError> {
    let irq_active = uart.device.interrupt_pending();
    if irq_active != uart.irq_asserted {
        vm.set_irq_line(4, irq_active)
            .map_err(|error| kvm_error("set legacy UART IRQ4", error))?;
        uart.irq_asserted = irq_active;
    }
    Ok(())
}

#[derive(Clone, Default)]
struct LegacyUart {
    device: Uart,
    irq_asserted: bool,
}

impl LegacyUart {
    const fn contains(port: u16) -> bool {
        Uart::contains(port)
    }

    fn read(&mut self, port: u16, output: &mut [u8]) {
        self.device.read(port, output);
    }

    fn write<'a>(&mut self, port: u16, data: &'a [u8]) -> Option<&'a [u8]> {
        self.device.write(port, data)
    }
}

#[derive(Debug)]
struct HostMapping {
    pointer: NonNull<u8>,
    length: usize,
    backing_id: Option<u64>,
    mmap_protection: i32,
    mmap_flags: i32,
}

struct ReadOnlyMapping {
    pointer: NonNull<u8>,
    length: usize,
    guest_phys_address: u64,
    backing_id: u64,
    slot: u32,
}

// SAFETY: Each wrapper exclusively owns one process mapping and carries no
// thread-affine state. Moving it transfers the only Rust access path; all byte
// access remains bounded and requires shared or exclusive wrapper references.
unsafe impl Send for HostMapping {}

// SAFETY: The mapping is immutable for its complete lifetime, has no
// thread-affine state, and moving the owner cannot invalidate its address.
unsafe impl Send for ReadOnlyMapping {}

impl ReadOnlyMapping {
    fn from_image(
        image: &PvmReadOnlyImage,
        guest_phys_address: u64,
        slot: u32,
    ) -> Result<Self, PvmDeviceError> {
        if !guest_phys_address.is_multiple_of(4096) {
            return Err(PvmDeviceError::Memory {
                operation: "map read-only guest memory",
                message: format!(
                    "guest physical address {guest_phys_address:#x} is not page aligned"
                ),
            });
        }
        let length = image.len();
        // SAFETY: The owned descriptor refers to a regular file at least
        // `length` bytes long. Only a shared read-only mapping is requested.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ,
                libc::MAP_SHARED,
                image.backing.file.as_raw_fd(),
                0,
            )
        };
        if address == libc::MAP_FAILED {
            return Err(memory_error(
                "map read-only guest memory",
                io::Error::last_os_error(),
            ));
        }
        let Some(pointer) = NonNull::new(address.cast::<u8>()) else {
            // SAFETY: `address` is the successful mapping returned above.
            unsafe { libc::munmap(address, length) };
            return Err(PvmDeviceError::Memory {
                operation: "map read-only guest memory",
                message: "mmap returned a null address".to_owned(),
            });
        };
        Ok(Self {
            pointer,
            length,
            guest_phys_address,
            backing_id: image.backing_id(),
            slot,
        })
    }

    fn contains(&self, guest_phys_address: u64) -> bool {
        guest_phys_address
            .checked_sub(self.guest_phys_address)
            .is_some_and(|offset| offset < self.length as u64)
    }
}

fn map_read_only_regions(
    images: &[PvmReadOnlyRegion<'_>],
) -> Result<Vec<ReadOnlyMapping>, PvmDeviceError> {
    if images.len() > READ_ONLY_MEMORY_SLOTS.len() {
        return Err(PvmDeviceError::Memory {
            operation: "map read-only guest memory",
            message: format!(
                "at most {} immutable images are supported, got {}",
                READ_ONLY_MEMORY_SLOTS.len(),
                images.len()
            ),
        });
    }
    images
        .iter()
        .zip(READ_ONLY_MEMORY_SLOTS)
        .map(|(region, slot)| {
            ReadOnlyMapping::from_image(region.image, region.guest_phys_address, slot)
        })
        .collect()
}

fn ranges_overlap(left: &std::ops::Range<u64>, right: &std::ops::Range<u64>) -> bool {
    left.start < right.end && right.start < left.end
}

impl HostMapping {
    fn new(length: usize) -> Result<Self, PvmDeviceError> {
        Self::new_anonymous(length, libc::MAP_PRIVATE, "allocate guest memory")
    }

    fn new_shared(length: usize) -> Result<Self, PvmDeviceError> {
        Self::new_anonymous(length, libc::MAP_SHARED, "allocate shared guest memory")
    }

    fn new_anonymous(
        length: usize,
        visibility: i32,
        operation: &'static str,
    ) -> Result<Self, PvmDeviceError> {
        if length == 0 {
            return Err(PvmDeviceError::Memory {
                operation,
                message: "zero-length memory is invalid".to_owned(),
            });
        }
        // SAFETY: The arguments request a new anonymous private mapping. The
        // returned address is checked before constructing the owning wrapper.
        let mmap_protection = libc::PROT_READ | libc::PROT_WRITE;
        let mmap_flags = visibility | libc::MAP_ANONYMOUS | libc::MAP_NORESERVE;
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                mmap_protection,
                mmap_flags,
                -1,
                0,
            )
        };
        if address == libc::MAP_FAILED {
            return Err(memory_error(operation, io::Error::last_os_error()));
        }
        let Some(pointer) = NonNull::new(address.cast::<u8>()) else {
            // SAFETY: `address` is the successful mapping returned immediately
            // above and `length` is the exact mapped length.
            unsafe { libc::munmap(address, length) };
            return Err(PvmDeviceError::Memory {
                operation,
                message: "mmap returned a null address".to_owned(),
            });
        };
        Ok(Self {
            pointer,
            length,
            backing_id: None,
            mmap_protection,
            mmap_flags,
        })
    }

    fn from_template(template: &PvmMemoryTemplate) -> Result<Self, PvmDeviceError> {
        let length = template.len();
        // SAFETY: The descriptor is a sealed memfd at least `length` bytes
        // long. MAP_PRIVATE permits child-local writes without changing it.
        let mmap_protection = libc::PROT_READ | libc::PROT_WRITE;
        let mmap_flags = libc::MAP_PRIVATE;
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                mmap_protection,
                mmap_flags,
                template.backing.file.as_raw_fd(),
                0,
            )
        };
        if address == libc::MAP_FAILED {
            return Err(memory_error(
                "map template backing",
                io::Error::last_os_error(),
            ));
        }
        let Some(pointer) = NonNull::new(address.cast::<u8>()) else {
            // SAFETY: `address` is the successful mapping returned above.
            unsafe { libc::munmap(address, length) };
            return Err(PvmDeviceError::Memory {
                operation: "map template backing",
                message: "mmap returned a null address".to_owned(),
            });
        };
        Ok(Self {
            pointer,
            length,
            backing_id: Some(template.backing_id()),
            mmap_protection,
            mmap_flags,
        })
    }

    fn write(&mut self, guest_address: u64, source: &[u8]) -> Result<(), PvmDeviceError> {
        let start = usize::try_from(guest_address)
            .map_err(|error| memory_error("convert guest address", error))?;
        let end = start
            .checked_add(source.len())
            .ok_or_else(|| PvmDeviceError::Memory {
                operation: "validate guest write",
                message: "address plus length overflowed".to_owned(),
            })?;
        if end > self.length {
            return Err(PvmDeviceError::Memory {
                operation: "validate guest write",
                message: format!("range {start:#x}..{end:#x} exceeds {:#x}", self.length),
            });
        }
        // SAFETY: Bounds were checked against the live owned mapping, the
        // source slice is valid, and `&mut self` excludes concurrent writes.
        unsafe {
            std::ptr::copy_nonoverlapping(
                source.as_ptr(),
                self.pointer.as_ptr().add(start),
                source.len(),
            );
        }
        Ok(())
    }

    fn read(&self, guest_address: u64, length: usize) -> Result<Vec<u8>, PvmDeviceError> {
        let range = checked_range(self.length, guest_address, length, "validate guest read")?;
        let mut destination = vec![0; length];
        // SAFETY: Bounds were checked against the live owned mapping, the
        // destination vector owns `length` writable bytes, and no KVM run is
        // active while this synchronous method executes.
        unsafe {
            std::ptr::copy_nonoverlapping(
                self.pointer.as_ptr().add(range.start),
                destination.as_mut_ptr(),
                length,
            );
        }
        Ok(destination)
    }

    fn privatize_page(&mut self, guest_address: u64) -> Result<(), PvmDeviceError> {
        const PAGE_SIZE: usize = 4096;
        if guest_address & 0xfff != 0 {
            return Err(PvmDeviceError::Memory {
                operation: "privatize template page",
                message: format!("guest address {guest_address:#x} is not page aligned"),
            });
        }
        if self.backing_id.is_none() {
            return Err(PvmDeviceError::Memory {
                operation: "privatize template page",
                message: "machine is not backed by a sealed template".to_owned(),
            });
        }
        let bytes = self.read(guest_address, PAGE_SIZE)?;
        self.write(guest_address, &bytes)
    }
}

fn checked_range(
    allocation_length: usize,
    guest_address: u64,
    length: usize,
    operation: &'static str,
) -> Result<std::ops::Range<usize>, PvmDeviceError> {
    let start = usize::try_from(guest_address)
        .map_err(|error| memory_error("convert guest address", error))?;
    let end = start
        .checked_add(length)
        .ok_or_else(|| PvmDeviceError::Memory {
            operation,
            message: "address plus length overflowed".to_owned(),
        })?;
    if end > allocation_length {
        return Err(PvmDeviceError::Memory {
            operation,
            message: format!("range {start:#x}..{end:#x} exceeds {allocation_length:#x}"),
        });
    }
    Ok(start..end)
}

impl Drop for HostMapping {
    fn drop(&mut self) {
        // SAFETY: This wrapper owns the exact successful mmap range and drops
        // once, after the vCPU and VM fields have been dropped.
        unsafe { libc::munmap(self.pointer.as_ptr().cast(), self.length) };
    }
}

impl Drop for ReadOnlyMapping {
    fn drop(&mut self) {
        // SAFETY: This wrapper owns the exact successful mmap range and drops
        // once, after the vCPU and VM fields have been dropped.
        unsafe { libc::munmap(self.pointer.as_ptr().cast(), self.length) };
    }
}

fn code_segment(selector: u16, dpl: u8) -> kvm_segment {
    kvm_segment {
        base: 0,
        limit: 0x000f_ffff,
        selector,
        type_: 11,
        present: 1,
        dpl,
        db: 0,
        s: 1,
        l: 1,
        g: 1,
        avl: 0,
        unusable: 0,
        padding: 0,
    }
}

fn data_segment(selector: u16, dpl: u8) -> kvm_segment {
    kvm_segment {
        base: 0,
        limit: 0x000f_ffff,
        selector,
        type_: 3,
        present: 1,
        dpl,
        db: 1,
        s: 1,
        l: 0,
        g: 1,
        avl: 0,
        unusable: 0,
        padding: 0,
    }
}

const fn msr(index: u32, data: u64) -> kvm_msr_entry {
    kvm_msr_entry {
        index,
        reserved: 0,
        data,
    }
}

fn kvm_error(operation: &'static str, error: impl fmt::Display) -> PvmDeviceError {
    PvmDeviceError::Kvm {
        operation,
        message: error.to_string(),
    }
}

fn memory_error(operation: &'static str, error: impl fmt::Display) -> PvmDeviceError {
    PvmDeviceError::Memory {
        operation,
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::{self, Write},
        os::fd::AsRawFd,
        os::unix::fs::MetadataExt,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use vmm_sys_util::eventfd::{EFD_CLOEXEC, EFD_NONBLOCK, EventFd};

    use super::{
        PVM_VIRTIO_BLK_DATA_IRQ_GSI, PVM_VIRTIO_BLK_DATA_MMIO_BASE, PVM_VIRTIO_BLK_IRQ_GSI,
        PVM_VIRTIO_BLK_MMIO_BASE, PVM_VIRTIO_BLK_TEMPLATE_IRQ_GSI,
        PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE, PvmBlockDevice, PvmExit, PvmIrqSender,
        PvmMemoryTemplate, PvmReadOnlyImage, PvmReadOnlyRegion, READ_ONLY_MEMORY_SLOTS,
        ReadOnlyMapping, classify_guest_exit, map_read_only_regions, service_block_exit,
        validate_actor_volume_restore,
    };
    use kvm_ioctls::VcpuExit;

    #[test]
    fn guest_exit_status_is_bounded_to_one_byte() {
        assert_eq!(classify_guest_exit(0), PvmExit::GuestExit { status: 0 });
        assert_eq!(classify_guest_exit(255), PvmExit::GuestExit { status: 255 });
        assert!(matches!(
            classify_guest_exit(256),
            PvmExit::Unexpected { .. }
        ));
        assert!(matches!(
            classify_guest_exit(u64::MAX),
            PvmExit::Unexpected { .. }
        ));
    }

    #[test]
    fn device_wait_wakeup_is_forwarded_only_after_wait_opt_in() {
        let event = Arc::new(EventFd::new(EFD_CLOEXEC | EFD_NONBLOCK).expect("IRQ eventfd"));
        let wait_wake = Arc::new(EventFd::new(EFD_CLOEXEC | EFD_NONBLOCK).expect("wait eventfd"));
        let wait_wake_enabled = Arc::new(AtomicBool::new(false));
        let sender = PvmIrqSender {
            event: Arc::clone(&event),
            wait_wake: Arc::clone(&wait_wake),
            wait_wake_enabled: Arc::clone(&wait_wake_enabled),
            gsi: 5,
        };

        sender.notify().expect("baseline IRQ");
        assert_eq!(event.read().expect("drain IRQ"), 1);
        assert_eq!(
            wait_wake
                .read()
                .expect_err("wait wake must remain empty")
                .kind(),
            io::ErrorKind::WouldBlock
        );

        wait_wake_enabled.store(true, Ordering::Release);
        sender.notify().expect("wait-aware IRQ");
        assert_eq!(event.read().expect("drain IRQ"), 1);
        assert_eq!(wait_wake.read().expect("drain wait wake"), 1);
    }

    #[test]
    fn system_and_actor_volume_have_disjoint_fixed_capabilities() {
        assert_eq!(PvmBlockDevice::System.mmio_base(), PVM_VIRTIO_BLK_MMIO_BASE);
        assert_eq!(PvmBlockDevice::System.irq_gsi(), PVM_VIRTIO_BLK_IRQ_GSI);
        assert_eq!(
            PvmBlockDevice::Data.mmio_base(),
            PVM_VIRTIO_BLK_DATA_MMIO_BASE
        );
        assert_eq!(PvmBlockDevice::Data.irq_gsi(), PVM_VIRTIO_BLK_DATA_IRQ_GSI);
        assert_eq!(
            PvmBlockDevice::Template.mmio_base(),
            PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE
        );
        assert_eq!(
            PvmBlockDevice::Template.irq_gsi(),
            PVM_VIRTIO_BLK_TEMPLATE_IRQ_GSI
        );
        assert_ne!(
            PvmBlockDevice::System.mmio_base(),
            PvmBlockDevice::Data.mmio_base()
        );
        assert_ne!(
            PvmBlockDevice::System.irq_gsi(),
            PvmBlockDevice::Data.irq_gsi()
        );
        assert_ne!(
            PvmBlockDevice::Data.mmio_base(),
            PvmBlockDevice::Template.mmio_base()
        );
        assert_ne!(
            PvmBlockDevice::Data.irq_gsi(),
            PvmBlockDevice::Template.irq_gsi()
        );
    }

    #[test]
    fn absent_actor_volume_probe_reads_zero_without_escaping_to_host() {
        let mut data = [0xa5; 4];
        let exit = VcpuExit::MmioRead(PVM_VIRTIO_BLK_DATA_MMIO_BASE, &mut data);
        assert!(service_block_exit(None, PVM_VIRTIO_BLK_DATA_MMIO_BASE, exit).is_none());
        assert_eq!(data, [0; 4]);

        let mut template = [0xa5; 4];
        let exit = VcpuExit::MmioRead(PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE, &mut template);
        assert!(
            service_block_exit(None, PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE, exit).is_none()
        );
        assert_eq!(template, [0; 4]);

        let mut outside = [0x5a; 4];
        let exit = VcpuExit::MmioRead(PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE + 0x1000, &mut outside);
        assert!(service_block_exit(None, PVM_VIRTIO_BLK_DATA_MMIO_BASE, exit).is_some());
        assert_eq!(outside, [0x5a; 4]);
    }

    #[test]
    fn actor_volume_restore_transition_is_exhaustive_and_fail_closed() {
        for attached in [false, true] {
            for saved in [false, true] {
                for vcpu_has_run in [false, true] {
                    let accepted =
                        validate_actor_volume_restore(attached, saved, vcpu_has_run).is_ok();
                    let expected = (saved && attached)
                        || (!saved && !attached)
                        || (attached && !saved && !vcpu_has_run);
                    assert_eq!(
                        accepted, expected,
                        "attached={attached} saved={saved} vcpu_has_run={vcpu_has_run}"
                    );
                }
            }
        }
    }

    #[test]
    fn read_only_image_is_sealed_and_shared_by_clone() {
        let image = PvmReadOnlyImage::from_bytes(&[0x5a; 4096]).expect("sealed image");
        let clone = image.clone();
        assert_eq!(image.len(), 4096);
        assert_eq!(image.backing_id(), clone.backing_id());

        // SAFETY: The image owns a live memfd and F_GET_SEALS only reads its
        // integer seal mask.
        let seals = unsafe { libc::fcntl(image.backing.file.as_raw_fd(), libc::F_GET_SEALS) };
        let expected =
            libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE | libc::F_SEAL_SEAL;
        assert_eq!(seals & expected, expected);
    }

    #[test]
    fn read_only_mapping_cannot_be_upgraded_to_writable() {
        let image = PvmReadOnlyImage::from_bytes(&[0xa5; 4096]).expect("sealed image");
        let mapping = ReadOnlyMapping::from_image(&image, 0x2000_0000, 1).expect("read-only map");
        // SAFETY: The pointer and length identify the live mapping owned by
        // `mapping`; this deliberately asks the kernel to reject an unsafe
        // permission upgrade on the F_SEAL_WRITE backing.
        let result = unsafe {
            libc::mprotect(
                mapping.pointer.as_ptr().cast(),
                mapping.length,
                libc::PROT_READ | libc::PROT_WRITE,
            )
        };
        assert_eq!(result, -1);
    }

    #[test]
    fn read_only_image_uses_existing_file_without_copy() {
        let path = std::env::temp_dir().join(format!(
            "minisandbox-read-only-image-{}.img",
            std::process::id()
        ));
        let mut writable = File::create(&path).expect("create test image");
        writable.write_all(&[0x6b; 4096]).expect("write test image");
        assert!(PvmReadOnlyImage::from_file(writable).is_err());

        let file = File::open(&path).expect("open test image read-only");
        let inode = file.metadata().expect("stat test image").ino();
        let image = PvmReadOnlyImage::from_file(file).expect("file-backed image");
        fs::remove_file(&path).expect("unlink test image");
        assert_eq!(image.len(), 4096);
        assert_eq!(image.backing_id(), inode);

        let mapping = ReadOnlyMapping::from_image(&image, 0x4000_0000, 1).expect("map image");
        // SAFETY: `mapping` owns a readable mapping at least one byte long.
        assert_eq!(unsafe { *mapping.pointer.as_ptr() }, 0x6b);
    }

    #[test]
    fn read_only_image_rejects_unaligned_input_and_gpa() {
        assert!(PvmReadOnlyImage::from_bytes(&[0; 4095]).is_err());
        let image = PvmReadOnlyImage::from_bytes(&[0; 4096]).expect("sealed image");
        assert!(ReadOnlyMapping::from_image(&image, 1, 1).is_err());
    }

    #[test]
    fn immutable_image_slots_are_fixed_and_bounded() {
        let first = PvmReadOnlyImage::from_bytes(&[1; 4096]).expect("first image");
        let second = PvmReadOnlyImage::from_bytes(&[2; 4096]).expect("second image");
        let regions = [
            PvmReadOnlyRegion::new(&first, 0x2_0000_0000),
            PvmReadOnlyRegion::new(&second, 0x4_0000_0000),
        ];
        let mappings = map_read_only_regions(&regions).expect("two fixed layers");
        assert_eq!(
            mappings
                .iter()
                .map(|mapping| mapping.slot)
                .collect::<Vec<_>>(),
            READ_ONLY_MEMORY_SLOTS
        );
        assert!(
            map_read_only_regions(&[
                regions[0],
                regions[1],
                PvmReadOnlyRegion::new(&first, 0x6_0000_0000),
            ])
            .is_err()
        );
    }

    #[test]
    fn memory_template_preserves_zero_pages_as_sparse_holes() {
        let mut bytes = vec![0_u8; 3 * 4096];
        bytes[0] = 0x51;
        bytes[2 * 4096] = 0xa7;
        let template = PvmMemoryTemplate::from_bytes(&bytes).expect("sparse template");

        assert_eq!(
            template.read_memory(0, bytes.len()).expect("read template"),
            bytes
        );
        let allocated = template
            .backing
            .file
            .metadata()
            .expect("stat template")
            .blocks()
            * 512;
        assert!(allocated < bytes.len() as u64);
    }
}
