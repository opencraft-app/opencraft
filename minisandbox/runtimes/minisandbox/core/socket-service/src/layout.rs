//! Fixed physical and in-region layout shared with the guest driver.

use std::{
    ptr,
    sync::{Arc, atomic::AtomicU32},
};

use minisandbox_pvm_sys::{
    PVM_VIRTIO_BLK_MMIO_BASE, PvmDeviceError, PvmIrqSender, PvmMachine, PvmSharedMemory,
};

use crate::wire::ABI_VERSION;

/// Guest-writable request/TX memory starts here.
pub const G2H_GPA: u64 = 0x1_0000_0000;
/// Host-writable, guest-read-only completion/RX memory starts here.
pub const H2G_GPA: u64 = 0x1_0004_0000;
/// KVM slot for G2H memory; immutable filesystem images use slots one and four.
pub const G2H_SLOT: u32 = 2;
/// KVM slot for H2G memory.
pub const H2G_SLOT: u32 = 3;
/// Fixed legacy interrupt used only by the stream service.
pub const IRQ_GSI: u32 = 10;
/// Complete bytes in each directional mapping.
pub const REGION_SIZE: usize = 256 * 1024;
/// Descriptor ring capacity.
pub const RING_ENTRIES: usize = 64;
/// Fixed data slots in each direction.
pub const SLOT_COUNT: usize = 32;
/// Bytes in one fixed data slot.
pub const SLOT_SIZE: usize = 4096;
/// Maximum requests handled after one wake before polling sockets again.
pub const DRAIN_BUDGET: usize = 64;

pub(crate) const HEADER_SIZE: usize = 4096;
pub(crate) const DESCRIPTOR_SIZE: usize = 32;
pub(crate) const DESCRIPTORS_OFFSET: usize = HEADER_SIZE;
pub(crate) const DATA_OFFSET: usize = 2 * HEADER_SIZE;

pub(crate) const G2H_REQUEST_PRODUCER: usize = 0;
pub(crate) const G2H_RESPONSE_CONSUMER: usize = 4;
pub(crate) const G2H_RESPONSE_EVENT: usize = 8;
pub(crate) const G2H_REQUEST_CREDIT_EVENT: usize = 12;

pub(crate) const H2G_MAGIC: usize = 0;
pub(crate) const H2G_VERSION: usize = 8;
pub(crate) const H2G_SESSION: usize = 16;
pub(crate) const H2G_REQUEST_CONSUMER: usize = 24;
pub(crate) const H2G_RESPONSE_PRODUCER: usize = 28;
pub(crate) const H2G_FEATURES: usize = 32;
pub(crate) const H2G_REQUEST_EVENT: usize = 40;
pub(crate) const H2G_RESPONSE_CREDIT_EVENT: usize = 44;
pub(crate) const MAGIC: [u8; 8] = *b"PVMSOCK\0";

const _: () = assert!(
    DATA_OFFSET + SLOT_COUNT * SLOT_SIZE <= REGION_SIZE,
    "data slots exceed memory region"
);
const _: () = assert!(
    DESCRIPTORS_OFFSET + RING_ENTRIES * DESCRIPTOR_SIZE <= DATA_OFFSET,
    "descriptor ring overlaps data slots"
);
const _: () = assert!(
    G2H_GPA + REGION_SIZE as u64 == H2G_GPA,
    "directional mailbox mappings must remain contiguous"
);
const _: () = assert!(
    H2G_GPA + REGION_SIZE as u64 <= PVM_VIRTIO_BLK_MMIO_BASE,
    "stream mailbox overlaps the fixed virtio-blk MMIO page"
);

/// One clone-private pair of directional mailbox mappings.
#[derive(Clone, Debug)]
pub struct ServiceMemory {
    pub(crate) g2h: Arc<PvmSharedMemory>,
    pub(crate) h2g: Arc<PvmSharedMemory>,
    session: u64,
}

impl ServiceMemory {
    /// Allocates and initializes a fresh mailbox that is never part of COW RAM.
    ///
    /// # Errors
    ///
    /// Returns an error for a zero session or a host mapping failure.
    pub fn new(session: u64) -> Result<Self, PvmDeviceError> {
        if session == 0 {
            return Err(PvmDeviceError::Memory {
                operation: "create stream service mailbox",
                message: "session must be nonzero".to_owned(),
            });
        }
        let mut g2h = PvmSharedMemory::new(REGION_SIZE)?;
        let mut h2g = PvmSharedMemory::new(REGION_SIZE)?;
        initialize_atomic(&mut g2h, G2H_REQUEST_PRODUCER, 0);
        initialize_atomic(&mut g2h, G2H_RESPONSE_CONSUMER, 0);
        initialize_atomic(&mut g2h, G2H_RESPONSE_EVENT, 0);
        // The guest asks for request-credit IRQs only while blocked on a full
        // command ring. Suppress that channel in the fresh mailbox.
        initialize_atomic(&mut g2h, G2H_REQUEST_CREDIT_EVENT, u32::MAX);
        initialize_atomic(&mut h2g, H2G_REQUEST_CONSUMER, 0);
        initialize_atomic(&mut h2g, H2G_RESPONSE_PRODUCER, 0);
        initialize_atomic(&mut h2g, H2G_REQUEST_EVENT, 0);
        // No response credit notification is needed until the host explicitly
        // blocks on a full response ring. With both cursors initially zero,
        // wrapping -1 suppresses every consumer transition.
        initialize_atomic(&mut h2g, H2G_RESPONSE_CREDIT_EVENT, u32::MAX);
        h2g.initialize(H2G_MAGIC, &MAGIC)?;
        h2g.initialize(H2G_VERSION, &ABI_VERSION.to_le_bytes())?;
        h2g.initialize(H2G_SESSION, &session.to_le_bytes())?;
        // Bit zero is TCP, bit one restricted UDP DNS, bit two bounded host ingress.
        h2g.initialize(H2G_FEATURES, &7_u64.to_le_bytes())?;
        Ok(Self {
            g2h: Arc::new(g2h),
            h2g: Arc::new(h2g),
            session,
        })
    }

    /// Registers both mappings and the fixed service IRQ on a Linux machine.
    ///
    /// G2H is writable by the guest. H2G is registered with
    /// `KVM_MEM_READONLY`, so a compromised guest cannot forge host responses.
    ///
    /// # Errors
    ///
    /// Returns an error when any memslot or the IRQ cannot be registered.
    pub fn attach(&self, machine: &mut PvmMachine) -> Result<PvmIrqSender, PvmDeviceError> {
        machine.register_shared_memory(G2H_SLOT, G2H_GPA, Arc::clone(&self.g2h), false)?;
        machine.register_shared_memory(H2G_SLOT, H2G_GPA, Arc::clone(&self.h2g), true)?;
        machine.register_irq_sender(IRQ_GSI)
    }

    /// Host-selected clone/reset session used to reject replayed descriptors.
    #[must_use]
    pub const fn session(&self) -> u64 {
        self.session
    }
}

#[allow(clippy::cast_ptr_alignment)]
fn initialize_atomic(memory: &mut PvmSharedMemory, offset: usize, value: u32) {
    debug_assert!(offset.is_multiple_of(align_of::<AtomicU32>()));
    // SAFETY: The fresh mmap is exclusively owned, page aligned, and large
    // enough for every fixed header offset. This starts the Rust lifetime of
    // each shared AtomicU32 before guest/worker access begins.
    unsafe {
        ptr::write(
            memory.as_ptr().as_ptr().add(offset).cast::<AtomicU32>(),
            AtomicU32::new(value),
        );
    }
}
