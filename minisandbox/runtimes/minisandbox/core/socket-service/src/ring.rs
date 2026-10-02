//! Acquire/release adapter over adversarial shared memory.

use std::{
    error::Error,
    fmt, ptr,
    sync::atomic::{AtomicU32, Ordering, fence},
};

use pvm_stream_mailbox::{
    cursor::{ConsumerCursor, CursorError, ProducerCursor},
    wire::{Command, WireError},
};

use crate::{
    layout::{
        DATA_OFFSET, DESCRIPTOR_SIZE, DESCRIPTORS_OFFSET, G2H_REQUEST_CREDIT_EVENT,
        G2H_REQUEST_PRODUCER, G2H_RESPONSE_CONSUMER, G2H_RESPONSE_EVENT, H2G_REQUEST_CONSUMER,
        H2G_REQUEST_EVENT, H2G_RESPONSE_CREDIT_EVENT, H2G_RESPONSE_PRODUCER, RING_ENTRIES,
        SLOT_COUNT, SLOT_SIZE, ServiceMemory,
    },
    wire::Event,
};

/// Ring parser/publisher failure. A cursor violation is fatal for this clone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RingError {
    /// A peer cursor violates bounded producer/consumer distance.
    Cursor(CursorError),
    /// One private descriptor snapshot is noncanonical.
    Wire(WireError),
    /// A fixed slot index is outside the negotiated table.
    SlotOutOfRange,
    /// Offset plus length does not fit one fixed slot.
    RangeOutOfBounds,
}

/// One bounded request drain plus whether consumed request credit crossed the
/// guest's explicitly armed interrupt index.
#[derive(Debug, Eq, PartialEq)]
pub struct DrainBatch {
    /// Private descriptor snapshots decoded independently of guest memory.
    pub requests: Vec<Result<Command, WireError>>,
    /// Whether the guest requested an IRQ when request-ring credit advanced.
    pub notify_guest: bool,
}

impl fmt::Display for RingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for RingError {}

impl From<CursorError> for RingError {
    fn from(error: CursorError) -> Self {
        Self::Cursor(error)
    }
}

/// Host-private cursors and pointers for one mailbox.
pub struct HostRing {
    memory: ServiceMemory,
    requests: ConsumerCursor<RING_ENTRIES>,
    responses: ProducerCursor<RING_ENTRIES>,
}

impl HostRing {
    /// Creates empty private cursors over freshly initialized memory.
    ///
    /// # Errors
    ///
    /// Returns an error only if the compile-time ring size is invalid.
    pub fn new(memory: ServiceMemory) -> Result<Self, RingError> {
        Ok(Self {
            memory,
            requests: ConsumerCursor::new()?,
            responses: ProducerCursor::new()?,
        })
    }

    /// Returns the immutable clone/reset session bound to descriptor decoding.
    #[must_use]
    pub const fn session(&self) -> u64 {
        self.memory.session()
    }

    /// Copies and consumes at most `budget` guest requests.
    ///
    /// Producer is loaded with Acquire after the guest wrote descriptors with
    /// Release. Each descriptor is copied byte-by-byte with volatile reads;
    /// no Rust reference aliases guest-writable storage.
    ///
    /// # Errors
    ///
    /// A producer jump beyond the ring is fatal. Malformed descriptors are
    /// returned as individual results after being safely consumed.
    pub fn drain(&mut self, budget: usize) -> Result<DrainBatch, RingError> {
        let published = self.load_g2h_atomic(G2H_REQUEST_PRODUCER, Ordering::Acquire);
        let count = self.requests.available(published)?.min(budget);
        let mut output = Vec::with_capacity(count);
        let old_consumed = self.requests.consumed();
        for _ in 0..count {
            let index = self.requests.consume_one(published)?;
            let bytes = self.read_g2h_descriptor(index);
            output.push(Command::decode(&bytes, self.memory.session()));
        }
        let new_consumed = self.requests.consumed();
        if new_consumed != old_consumed {
            self.store_h2g_atomic(H2G_REQUEST_CONSUMER, new_consumed, Ordering::Release);
            // Pair the cursor publication with the guest's arm/recheck fence.
            // Release+Acquire alone permits the Store->Load outcome in which
            // both peers observe the other's old value and sleep forever.
            fence(Ordering::SeqCst);
        }
        let event = self.load_g2h_atomic(G2H_REQUEST_CREDIT_EVENT, Ordering::Acquire);
        Ok(DrainBatch {
            requests: output,
            notify_guest: notification_needed(event, new_consumed, old_consumed),
        })
    }

    /// Arms one guest doorbell for the next request producer transition, then
    /// rechecks the producer so publication concurrent with arming cannot be
    /// stranded in a sleeping broker.
    ///
    /// # Errors
    ///
    /// A producer jump beyond the fixed ring is fatal.
    pub fn arm_request_notification(&self) -> Result<bool, RingError> {
        let consumed = self.requests.consumed();
        self.store_h2g_atomic(H2G_REQUEST_EVENT, consumed, Ordering::Release);
        fence(Ordering::SeqCst);
        let published = self.load_g2h_atomic(G2H_REQUEST_PRODUCER, Ordering::Acquire);
        Ok(self.requests.available(published)? != 0)
    }

    /// Returns whether one host event can be published after validating the
    /// untrusted guest consumer cursor.
    ///
    /// # Errors
    ///
    /// Returns a fatal cursor error if the guest claims unproduced entries.
    pub fn can_publish(&mut self) -> Result<bool, RingError> {
        let consumed = self.load_g2h_atomic(G2H_RESPONSE_CONSUMER, Ordering::Acquire);
        self.responses.observe_consumer(consumed)?;
        Ok(self.responses.free() != 0)
    }

    /// Publishes one fully initialized response followed by a Release producer store.
    ///
    /// # Errors
    ///
    /// Returns an error for a forged consumer cursor or full response ring.
    pub fn publish(&mut self, event: Event) -> Result<bool, RingError> {
        let consumed = self.load_g2h_atomic(G2H_RESPONSE_CONSUMER, Ordering::Acquire);
        self.responses.observe_consumer(consumed)?;
        let old_produced = self.responses.produced();
        let index = self.responses.reserve_one()?;
        self.write_h2g_descriptor(index, &event.encode());
        let new_produced = self.responses.produced();
        self.store_h2g_atomic(H2G_RESPONSE_PRODUCER, new_produced, Ordering::Release);
        // See `drain`: every producer must publish its cursor before sampling
        // the peer's event index, not merely order descriptor initialization.
        fence(Ordering::SeqCst);
        let requested = self.load_g2h_atomic(G2H_RESPONSE_EVENT, Ordering::Acquire);
        Ok(notification_needed(requested, new_produced, old_produced))
    }

    /// Requests a guest doorbell only when it next frees response-ring credit,
    /// then rechecks the untrusted consumer to close the arm/sleep race.
    ///
    /// # Errors
    ///
    /// A guest consumer that advances through unproduced responses is fatal.
    pub fn arm_response_credit_notification(&mut self) -> Result<bool, RingError> {
        let consumed = self.load_g2h_atomic(G2H_RESPONSE_CONSUMER, Ordering::Acquire);
        self.responses.observe_consumer(consumed)?;
        self.store_h2g_atomic(H2G_RESPONSE_CREDIT_EVENT, consumed, Ordering::Release);
        fence(Ordering::SeqCst);
        let latest = self.load_g2h_atomic(G2H_RESPONSE_CONSUMER, Ordering::Acquire);
        self.responses.observe_consumer(latest)?;
        Ok(self.responses.free() != 0)
    }

    /// Suppresses response-credit doorbells while the host has no blocked
    /// response to publish. The guest cannot consume beyond this host-owned
    /// producer index, so no valid consumer transition can cross it.
    pub fn suppress_response_credit_notifications(&self) {
        self.store_h2g_atomic(
            H2G_RESPONSE_CREDIT_EVENT,
            self.responses.produced(),
            Ordering::Release,
        );
    }

    /// Copies a validated TX/endpoint range into private host memory.
    ///
    /// # Errors
    ///
    /// Returns an error unless slot, offset, and length fit one fixed slot.
    pub fn copy_tx(&self, slot: u16, offset: u32, length: u32) -> Result<Vec<u8>, RingError> {
        let slot = usize::from(slot);
        if slot >= SLOT_COUNT {
            return Err(RingError::SlotOutOfRange);
        }
        let offset = usize::try_from(offset).map_err(|_| RingError::RangeOutOfBounds)?;
        let length = usize::try_from(length).map_err(|_| RingError::RangeOutOfBounds)?;
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= SLOT_SIZE)
            .ok_or(RingError::RangeOutOfBounds)?;
        let start = DATA_OFFSET + slot * SLOT_SIZE + offset;
        let mut bytes = Vec::with_capacity(length);
        for index in start..start + (end - offset) {
            // SAFETY: The computed byte lies in the live G2H mapping. Volatile
            // copying prevents references or compiler-coalesced reads across
            // memory that an adversarial vCPU may mutate concurrently.
            bytes.push(unsafe { ptr::read_volatile(self.memory.g2h.as_ptr().as_ptr().add(index)) });
        }
        Ok(bytes)
    }

    /// Returns a validated raw source for opaque TCP payload bytes.
    ///
    /// The pointer is intended only as a `send(2)` source after the caller has
    /// transferred the slot to the host ownership state machine. Guest-writable
    /// storage may still change concurrently, so callers must not create Rust
    /// references or use this path for policy-bearing metadata. The fixed
    /// mapping remains live for the complete `HostRing` lifetime.
    pub(crate) fn tx_source(
        &self,
        slot: u16,
        offset: u32,
        length: u32,
    ) -> Result<*const u8, RingError> {
        let slot = usize::from(slot);
        if slot >= SLOT_COUNT {
            return Err(RingError::SlotOutOfRange);
        }
        let offset = usize::try_from(offset).map_err(|_| RingError::RangeOutOfBounds)?;
        let length = usize::try_from(length).map_err(|_| RingError::RangeOutOfBounds)?;
        offset
            .checked_add(length)
            .filter(|end| *end <= SLOT_SIZE)
            .ok_or(RingError::RangeOutOfBounds)?;
        // SAFETY: The checked fixed-slot range lies in the live G2H mapping.
        Ok(unsafe {
            self.memory
                .g2h
                .as_ptr()
                .as_ptr()
                .add(DATA_OFFSET + slot * SLOT_SIZE + offset)
        })
    }

    /// Returns the raw host destination for one guest-read-only RX slot.
    ///
    /// The pointer is intended only as a `recv(2)` destination. The caller must
    /// reserve the slot in the ownership state machine before using it and
    /// publish with Release only after the syscall completes.
    pub(crate) fn rx_destination(&self, slot: u16) -> Result<*mut u8, RingError> {
        self.rx_destination_at(slot, 0)
    }

    /// Returns a host-only destination at a validated offset in an RX slot.
    pub(crate) fn rx_destination_at(&self, slot: u16, offset: usize) -> Result<*mut u8, RingError> {
        let slot = usize::from(slot);
        if slot >= SLOT_COUNT || offset > SLOT_SIZE {
            return Err(RingError::SlotOutOfRange);
        }
        // SAFETY: Layout assertions ensure every slot fits the live mapping.
        Ok(unsafe {
            self.memory
                .h2g
                .as_ptr()
                .as_ptr()
                .add(DATA_OFFSET + slot * SLOT_SIZE + offset)
        })
    }

    /// Writes a small host-authenticated prefix before publishing an RX slot.
    pub(crate) fn write_rx_prefix(&self, slot: u16, bytes: &[u8]) -> Result<(), RingError> {
        if bytes.len() > SLOT_SIZE {
            return Err(RingError::RangeOutOfBounds);
        }
        let destination = self.rx_destination_at(slot, 0)?;
        for (offset, byte) in bytes.iter().copied().enumerate() {
            // SAFETY: The caller reserved this H2G slot and the checked prefix
            // remains within it. Guest access is read-only and unpublished.
            unsafe { ptr::write_volatile(destination.add(offset), byte) };
        }
        Ok(())
    }

    /// Takes a private volatile snapshot of host-written RX bytes for validation.
    pub(crate) fn copy_rx(
        &self,
        slot: u16,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, RingError> {
        let end = offset
            .checked_add(length)
            .filter(|end| *end <= SLOT_SIZE)
            .ok_or(RingError::RangeOutOfBounds)?;
        let source = self.rx_destination_at(slot, offset)?;
        let mut bytes = Vec::with_capacity(length);
        for index in 0..end - offset {
            // SAFETY: The broker owns this unpublished RX slot and the range
            // was checked. Volatile copying avoids forming shared references.
            bytes.push(unsafe { ptr::read_volatile(source.add(index)) });
        }
        Ok(bytes)
    }

    fn read_g2h_descriptor(&self, index: usize) -> [u8; DESCRIPTOR_SIZE] {
        let mut bytes = [0_u8; DESCRIPTOR_SIZE];
        let start = DESCRIPTORS_OFFSET + index * DESCRIPTOR_SIZE;
        for (offset, byte) in bytes.iter_mut().enumerate() {
            // SAFETY: The cursor bounds `index`; the descriptor layout fits the mapping.
            *byte = unsafe {
                ptr::read_volatile(self.memory.g2h.as_ptr().as_ptr().add(start + offset))
            };
        }
        bytes
    }

    fn write_h2g_descriptor(&self, index: usize, bytes: &[u8; DESCRIPTOR_SIZE]) {
        let start = DESCRIPTORS_OFFSET + index * DESCRIPTOR_SIZE;
        for (offset, byte) in bytes.iter().copied().enumerate() {
            // SAFETY: The private producer cursor bounds `index`; the host
            // mapping is writable even though KVM exposes it read-only.
            unsafe {
                ptr::write_volatile(self.memory.h2g.as_ptr().as_ptr().add(start + offset), byte);
            }
        }
    }

    #[allow(clippy::cast_ptr_alignment)]
    fn load_g2h_atomic(&self, offset: usize, ordering: Ordering) -> u32 {
        // SAFETY: Header offsets are four-byte aligned, initialized before
        // sharing, and all protocol writers use 32-bit atomics.
        unsafe {
            (&*self
                .memory
                .g2h
                .as_ptr()
                .as_ptr()
                .add(offset)
                .cast::<AtomicU32>())
                .load(ordering)
        }
    }

    #[allow(clippy::cast_ptr_alignment)]
    fn store_h2g_atomic(&self, offset: usize, value: u32, ordering: Ordering) {
        // SAFETY: Same alignment/initialization contract as `load_g2h_atomic`;
        // only the broker writes H2G cursors.
        unsafe {
            (&*self
                .memory
                .h2g
                .as_ptr()
                .as_ptr()
                .add(offset)
                .cast::<AtomicU32>())
                .store(value, ordering);
        }
    }
}

/// Returns whether `[old, new)` crossed an explicitly requested wrapping
/// cursor. This is the 32-bit form of virtio's `vring_need_event` predicate.
#[must_use]
pub(crate) const fn notification_needed(event: u32, new: u32, old: u32) -> bool {
    new.wrapping_sub(event).wrapping_sub(1) < new.wrapping_sub(old)
}

#[cfg(test)]
mod tests {
    use std::{
        ptr,
        sync::atomic::{AtomicU32, Ordering},
        thread,
    };

    use pvm_stream_mailbox::{
        Capability,
        cursor::CursorError,
        wire::{Command, CommandKind},
    };

    use super::{HostRing, RingError, notification_needed};
    use crate::{
        layout::{
            DESCRIPTOR_SIZE, DESCRIPTORS_OFFSET, G2H_REQUEST_CREDIT_EVENT, G2H_REQUEST_PRODUCER,
            G2H_RESPONSE_CONSUMER, G2H_RESPONSE_EVENT, H2G_REQUEST_EVENT,
            H2G_RESPONSE_CREDIT_EVENT, H2G_RESPONSE_PRODUCER, RING_ENTRIES, ServiceMemory,
        },
        wire::{Event, EventKind},
    };

    #[allow(clippy::cast_ptr_alignment)]
    fn store_atomic(memory: &minisandbox_pvm_sys::PvmSharedMemory, offset: usize, value: u32) {
        // SAFETY: Test offsets are protocol-aligned initialized atomic fields.
        unsafe {
            (&*memory.as_ptr().as_ptr().add(offset).cast::<AtomicU32>())
                .store(value, Ordering::Release);
        }
    }

    #[allow(clippy::cast_ptr_alignment)]
    fn load_atomic(memory: &minisandbox_pvm_sys::PvmSharedMemory, offset: usize) -> u32 {
        // SAFETY: Same atomic field contract as `store_atomic`.
        unsafe {
            (&*memory.as_ptr().as_ptr().add(offset).cast::<AtomicU32>()).load(Ordering::Acquire)
        }
    }

    fn write_request(
        memory: &minisandbox_pvm_sys::PvmSharedMemory,
        index: usize,
        bytes: &[u8; DESCRIPTOR_SIZE],
    ) {
        let start = DESCRIPTORS_OFFSET + index * DESCRIPTOR_SIZE;
        for (offset, byte) in bytes.iter().copied().enumerate() {
            // SAFETY: The test index is within the fixed descriptor ring.
            unsafe { ptr::write_volatile(memory.as_ptr().as_ptr().add(start + offset), byte) };
        }
    }

    #[test]
    fn fresh_mailboxes_do_not_share_cow_state() {
        let first = ServiceMemory::new(7).expect("first mailbox");
        let second = ServiceMemory::new(7).expect("second mailbox");
        store_atomic(&first.g2h, G2H_REQUEST_PRODUCER, 9);
        assert_eq!(load_atomic(&first.g2h, G2H_REQUEST_PRODUCER), 9);
        assert_eq!(load_atomic(&second.g2h, G2H_REQUEST_PRODUCER), 0);
        assert_ne!(first.g2h.as_ptr(), second.g2h.as_ptr());
        assert_eq!(load_atomic(&first.g2h, G2H_REQUEST_CREDIT_EVENT), u32::MAX);
    }

    #[test]
    fn tcp_tx_source_is_bounded_to_one_fixed_slot() {
        let memory = ServiceMemory::new(9).expect("mailbox");
        let ring = HostRing::new(memory).expect("ring");
        assert!(ring.tx_source(0, 0, 4096).is_ok());
        assert!(ring.tx_source(31, 4095, 1).is_ok());
        assert_eq!(ring.tx_source(32, 0, 1), Err(RingError::SlotOutOfRange));
        assert_eq!(ring.tx_source(0, 4095, 2), Err(RingError::RangeOutOfBounds));
        assert_eq!(
            ring.tx_source(0, u32::MAX, 1),
            Err(RingError::RangeOutOfBounds)
        );
    }

    #[test]
    fn release_publish_is_observed_by_acquire_drain() {
        let memory = ServiceMemory::new(11).expect("mailbox");
        let mut ring = HostRing::new(memory.clone()).expect("ring");
        let command = Command {
            sequence: 19,
            capability: Capability {
                index: 3,
                generation: 1,
                session: 11,
            },
            kind: CommandKind::Shutdown { how: 1 },
        };
        let guest_memory = memory.g2h.clone();
        let producer = thread::spawn(move || {
            write_request(&guest_memory, 0, &command.encode());
            store_atomic(&guest_memory, G2H_REQUEST_PRODUCER, 1);
        });
        producer.join().expect("producer");
        let drained = ring.drain(1).expect("drain");
        assert_eq!(drained.requests, vec![Ok(command)]);
        assert!(!drained.notify_guest);
    }

    #[test]
    fn forged_cursor_jumps_fail_closed() {
        let memory = ServiceMemory::new(3).expect("mailbox");
        let mut ring = HostRing::new(memory.clone()).expect("ring");
        store_atomic(&memory.g2h, G2H_REQUEST_PRODUCER, 65);
        assert_eq!(
            ring.drain(64),
            Err(RingError::Cursor(CursorError::PeerAdvancedTooFar))
        );

        let memory = ServiceMemory::new(4).expect("mailbox");
        let mut ring = HostRing::new(memory.clone()).expect("ring");
        store_atomic(&memory.g2h, G2H_RESPONSE_CONSUMER, 1);
        assert_eq!(
            ring.can_publish(),
            Err(RingError::Cursor(CursorError::PeerAdvancedTooFar))
        );
    }

    #[test]
    fn host_event_is_complete_before_release_producer() {
        let memory = ServiceMemory::new(5).expect("mailbox");
        let mut ring = HostRing::new(memory.clone()).expect("ring");
        let event = Event {
            kind: EventKind::RxReady,
            capability: Capability {
                index: 2,
                generation: 8,
                session: 5,
            },
            slot: 7,
            status: 0,
            length: 123,
            sequence: 0,
        };
        assert!(ring.publish(event).expect("publish requests first IRQ"));
        assert_eq!(load_atomic(&memory.h2g, H2G_RESPONSE_PRODUCER), 1);
        // SAFETY: No vCPU or broker thread accesses this unit-test mailbox.
        let bytes = unsafe {
            memory
                .h2g
                .read_quiescent(DESCRIPTORS_OFFSET, DESCRIPTOR_SIZE)
                .expect("response snapshot")
        };
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), 3);
        assert_eq!(u16::from_le_bytes([bytes[16], bytes[17]]), 7);
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 123);
    }

    #[test]
    fn event_indices_coalesce_and_handle_cursor_wrap() {
        assert!(notification_needed(0, 1, 0));
        assert!(!notification_needed(0, 2, 1));
        assert!(notification_needed(u32::MAX, 0, u32::MAX));
        assert!(!notification_needed(7, 7, 7));
    }

    #[test]
    fn request_arm_recheck_observes_work_without_a_second_doorbell() {
        let memory = ServiceMemory::new(17).expect("mailbox");
        let ring = HostRing::new(memory.clone()).expect("ring");
        assert!(!ring.arm_request_notification().expect("arm empty ring"));
        assert_eq!(load_atomic(&memory.h2g, H2G_REQUEST_EVENT), 0);
        store_atomic(&memory.g2h, G2H_REQUEST_PRODUCER, 1);
        assert!(
            ring.arm_request_notification()
                .expect("recheck published request")
        );
    }

    #[test]
    fn response_irq_is_one_edge_until_the_guest_rearms() {
        let memory = ServiceMemory::new(19).expect("mailbox");
        let mut ring = HostRing::new(memory.clone()).expect("ring");
        let event = Event {
            kind: EventKind::Shutdown,
            capability: Capability {
                index: 1,
                generation: 1,
                session: 19,
            },
            slot: 0,
            status: 0,
            length: 0,
            sequence: 1,
        };
        assert!(ring.publish(event).expect("first response"));
        assert!(!ring.publish(event).expect("coalesced response"));
        store_atomic(&memory.g2h, G2H_RESPONSE_EVENT, 2);
        assert!(ring.publish(event).expect("rearmed response"));

        // An adversarial event index can suppress its own notification but
        // cannot block publication or mutate host cursor ownership.
        store_atomic(&memory.g2h, G2H_RESPONSE_EVENT, u32::MAX);
        assert!(!ring.publish(event).expect("untrusted hint remains bounded"));
        assert_eq!(load_atomic(&memory.h2g, H2G_RESPONSE_PRODUCER), 4);
    }

    #[test]
    fn response_credit_is_armed_only_after_the_ring_fills() {
        let memory = ServiceMemory::new(23).expect("mailbox");
        let mut ring = HostRing::new(memory.clone()).expect("ring");
        let event = Event {
            kind: EventKind::Shutdown,
            capability: Capability {
                index: 1,
                generation: 1,
                session: 23,
            },
            slot: 0,
            status: 0,
            length: 0,
            sequence: 1,
        };
        for _ in 0..RING_ENTRIES {
            ring.publish(event).expect("fill response ring");
        }
        assert!(
            !ring
                .arm_response_credit_notification()
                .expect("arm full ring")
        );
        assert_eq!(load_atomic(&memory.h2g, H2G_RESPONSE_CREDIT_EVENT), 0);
        store_atomic(&memory.g2h, G2H_RESPONSE_CONSUMER, 1);
        assert!(
            ring.arm_response_credit_notification()
                .expect("arm observes concurrent credit")
        );
        ring.suppress_response_credit_notifications();
        assert_eq!(
            load_atomic(&memory.h2g, H2G_RESPONSE_CREDIT_EVENT),
            u32::try_from(RING_ENTRIES).expect("ring capacity fits wire cursor")
        );
    }
}
