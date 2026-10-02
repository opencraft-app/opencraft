//! Pure ownership, capability, credit, and reset state machine.

use core::array;

/// A clone-local, generation-checked stream capability.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Capability {
    /// Index into the host-owned capability table.
    pub index: u32,
    /// Non-wrapping generation of that table entry.
    pub generation: u64,
    /// Host-owned clone/reset session in which the capability was created.
    pub session: u64,
}

/// Fixed protocol limits.  All byte counts are bounded before I/O begins.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct Limits {
    /// Bytes in each fixed RX or TX slot.
    pub slot_size: u32,
    /// Maximum uncompleted guest-to-host bytes for one stream.
    pub max_stream_tx_bytes: u32,
    /// Maximum reserved or guest-owned host-to-guest bytes for one stream.
    pub max_stream_rx_bytes: u32,
}

impl Limits {
    /// Conservative prototype defaults: 16 KiB slots and 256 KiB per-stream windows.
    pub const DEFAULT: Self = Self {
        slot_size: 16 * 1024,
        max_stream_tx_bytes: 256 * 1024,
        max_stream_rx_bytes: 256 * 1024,
    };
}

/// Whether normal commands may be accepted or a reset is draining I/O.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MailboxPhase {
    /// Normal operation.
    Running,
    /// No new work; host-owned slots must be cancelled or completed.
    Resetting,
}

/// A rejected transition.  Rejection must not mutate protocol state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MailboxError {
    InvalidConfiguration,
    WrongPhase,
    SlotOutOfRange,
    CapabilityOutOfRange,
    CapabilityUnavailable,
    StaleCapability,
    SlotBusy,
    SlotOwnershipMismatch,
    InvalidLength,
    CreditExceeded,
    InvalidProgress,
    NotQuiescent,
    ArithmeticOverflow,
    SessionExhausted,
    InvariantViolation,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum CapabilitySlot {
    Free {
        generation: u64,
    },
    Open {
        generation: u64,
        tx_bytes: u32,
        rx_bytes: u32,
    },
    Closing {
        generation: u64,
        tx_bytes: u32,
        rx_bytes: u32,
    },
    Retired,
}

impl CapabilitySlot {
    const fn generation(self) -> Option<u64> {
        match self {
            Self::Free { generation }
            | Self::Open { generation, .. }
            | Self::Closing { generation, .. } => Some(generation),
            Self::Retired => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum TxSlot {
    GuestOwned,
    HostSending {
        capability: Capability,
        offset: u32,
        remaining: u32,
    },
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum RxSlot {
    HostFree,
    HostReceiving {
        capability: Capability,
        capacity: u32,
    },
    GuestReading {
        capability: Capability,
        length: u32,
    },
}

/// Work the socket adapter may perform after a successful TX submission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TxWork {
    pub capability: Capability,
    pub slot: u16,
    pub offset: u32,
    pub length: u32,
}

/// Result of reporting synchronous or asynchronous TX progress.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TxProgress {
    /// The same slot remains host-owned and should be retried from this range.
    Pending(TxWork),
    /// All bytes were accepted and the slot may be returned to the guest.
    Complete,
}

/// Work the socket adapter may perform after reserving an RX slot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RxWork {
    pub capability: Capability,
    pub slot: u16,
    pub capacity: u32,
}

/// Whether received bytes were published or dropped during close/reset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RxCompletion {
    Published { length: u32 },
    Dropped,
}

/// Result of beginning a stream close.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseResult {
    /// Host-owned or guest-owned buffers must drain first.
    Draining,
    /// No outstanding ownership remained; the table entry was recycled.
    Complete,
}

/// A bounded mailbox state.  The const parameters are fixed at build time and
/// are intentionally small enough for exhaustive test/model configurations.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MailboxState<const TX: usize, const RX: usize, const CAPS: usize> {
    phase: MailboxPhase,
    session: u64,
    limits: Limits,
    capabilities: [CapabilitySlot; CAPS],
    tx_slots: [TxSlot; TX],
    rx_slots: [RxSlot; RX],
}

impl<const TX: usize, const RX: usize, const CAPS: usize> MailboxState<TX, RX, CAPS> {
    /// Creates an empty running mailbox in session one.
    ///
    /// # Errors
    ///
    /// Returns [`MailboxError::InvalidConfiguration`] for zero or unrepresentable
    /// capacities and limits.
    pub fn new(limits: Limits) -> Result<Self, MailboxError> {
        Self::new_in_session(limits, 1)
    }

    /// Creates an empty mailbox bound to a host-selected nonzero session.
    ///
    /// The session is not read from a guest descriptor. The host ring adapter
    /// supplies it while decoding, which binds otherwise replayable commands
    /// to one clone/reset lifetime without enlarging the wire format.
    ///
    /// # Errors
    ///
    /// Returns [`MailboxError::InvalidConfiguration`] for a zero session or
    /// invalid capacities and limits.
    pub fn new_in_session(limits: Limits, session: u64) -> Result<Self, MailboxError> {
        if TX == 0
            || RX == 0
            || CAPS == 0
            || TX > u16::MAX as usize
            || RX > u16::MAX as usize
            || CAPS > u32::MAX as usize
            || limits.slot_size == 0
            || limits.max_stream_tx_bytes == 0
            || limits.max_stream_rx_bytes == 0
            || session == 0
        {
            return Err(MailboxError::InvalidConfiguration);
        }
        let state = Self {
            phase: MailboxPhase::Running,
            session,
            limits,
            capabilities: array::from_fn(|_| CapabilitySlot::Free { generation: 1 }),
            tx_slots: [TxSlot::GuestOwned; TX],
            rx_slots: [RxSlot::HostFree; RX],
        };
        state.check_invariants()?;
        Ok(state)
    }

    #[must_use]
    pub const fn phase(&self) -> MailboxPhase {
        self.phase
    }

    #[must_use]
    pub const fn session(&self) -> u64 {
        self.session
    }

    #[must_use]
    pub const fn limits(&self) -> Limits {
        self.limits
    }

    /// Returns the currently open/closing handle at `index`, if any.
    #[must_use]
    pub fn capability(&self, index: u32) -> Option<Capability> {
        let slot = *self.capabilities.get(index as usize)?;
        match slot {
            CapabilitySlot::Open { generation, .. }
            | CapabilitySlot::Closing { generation, .. } => Some(Capability {
                index,
                generation,
                session: self.session,
            }),
            CapabilitySlot::Free { .. } | CapabilitySlot::Retired => None,
        }
    }

    /// Opens a host-authorized capability-table entry.
    ///
    /// # Errors
    ///
    /// Returns an error unless the mailbox is running and the entry is free.
    pub fn open_capability(&mut self, index: u32) -> Result<Capability, MailboxError> {
        self.require_running()?;
        let slot = self
            .capabilities
            .get_mut(index as usize)
            .ok_or(MailboxError::CapabilityOutOfRange)?;
        let CapabilitySlot::Free { generation } = *slot else {
            return Err(MailboxError::CapabilityUnavailable);
        };
        *slot = CapabilitySlot::Open {
            generation,
            tx_bytes: 0,
            rx_bytes: 0,
        };
        let capability = Capability {
            index,
            generation,
            session: self.session,
        };
        self.check_invariants()?;
        Ok(capability)
    }

    /// Stops accepting new work for a capability and recycles it once drained.
    ///
    /// # Errors
    ///
    /// Returns an error for a stale/unavailable capability or during reset.
    pub fn close_capability(
        &mut self,
        capability: Capability,
    ) -> Result<CloseResult, MailboxError> {
        self.require_running()?;
        let (tx_bytes, rx_bytes) = self.open_counts(capability)?;
        self.capabilities[capability.index as usize] = CapabilitySlot::Closing {
            generation: capability.generation,
            tx_bytes,
            rx_bytes,
        };
        let complete = self.maybe_finalize_capability(capability.index);
        self.check_invariants()?;
        Ok(if complete {
            CloseResult::Complete
        } else {
            CloseResult::Draining
        })
    }

    /// Transfers a TX slot from the guest to the host socket adapter.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid ownership, capability, range, or credit.
    pub fn submit_tx(
        &mut self,
        capability: Capability,
        slot: u16,
        offset: u32,
        length: u32,
    ) -> Result<TxWork, MailboxError> {
        self.require_running()?;
        self.validate_slot_range(offset, length)?;
        let slot_index = usize::from(slot);
        let tx_slot = self
            .tx_slots
            .get(slot_index)
            .ok_or(MailboxError::SlotOutOfRange)?;
        if *tx_slot != TxSlot::GuestOwned {
            return Err(MailboxError::SlotBusy);
        }
        let (tx_bytes, rx_bytes) = self.open_counts(capability)?;
        let new_tx = tx_bytes
            .checked_add(length)
            .ok_or(MailboxError::ArithmeticOverflow)?;
        if new_tx > self.limits.max_stream_tx_bytes {
            return Err(MailboxError::CreditExceeded);
        }
        self.capabilities[capability.index as usize] = CapabilitySlot::Open {
            generation: capability.generation,
            tx_bytes: new_tx,
            rx_bytes,
        };
        self.tx_slots[slot_index] = TxSlot::HostSending {
            capability,
            offset,
            remaining: length,
        };
        self.check_invariants()?;
        Ok(TxWork {
            capability,
            slot,
            offset,
            length,
        })
    }

    /// Accounts bytes accepted by the host socket without exposing its fd.
    ///
    /// # Errors
    ///
    /// Returns an error unless the completion exactly matches a host-owned slot.
    pub fn complete_tx_progress(
        &mut self,
        capability: Capability,
        slot: u16,
        bytes: u32,
    ) -> Result<TxProgress, MailboxError> {
        let index = usize::from(slot);
        let state = *self
            .tx_slots
            .get(index)
            .ok_or(MailboxError::SlotOutOfRange)?;
        let TxSlot::HostSending {
            capability: owner,
            offset,
            remaining,
        } = state
        else {
            return Err(MailboxError::SlotOwnershipMismatch);
        };
        if owner != capability {
            return Err(MailboxError::SlotOwnershipMismatch);
        }
        self.validate_live_capability(capability)?;
        if bytes == 0 || bytes > remaining {
            return Err(MailboxError::InvalidProgress);
        }
        self.subtract_tx_bytes(capability, bytes)?;
        let remaining = remaining - bytes;
        let offset = offset
            .checked_add(bytes)
            .ok_or(MailboxError::ArithmeticOverflow)?;
        let progress = if remaining == 0 {
            self.tx_slots[index] = TxSlot::GuestOwned;
            self.maybe_finalize_capability(capability.index);
            TxProgress::Complete
        } else {
            self.tx_slots[index] = TxSlot::HostSending {
                capability,
                offset,
                remaining,
            };
            TxProgress::Pending(TxWork {
                capability,
                slot,
                offset,
                length: remaining,
            })
        };
        self.check_invariants()?;
        Ok(progress)
    }

    /// Cancels a host-owned TX slot, for reset or socket failure.
    ///
    /// # Errors
    ///
    /// Returns an error unless `slot` is owned by this live capability.
    pub fn cancel_tx(&mut self, capability: Capability, slot: u16) -> Result<(), MailboxError> {
        let index = usize::from(slot);
        let state = *self
            .tx_slots
            .get(index)
            .ok_or(MailboxError::SlotOutOfRange)?;
        let TxSlot::HostSending {
            capability: owner,
            remaining,
            ..
        } = state
        else {
            return Err(MailboxError::SlotOwnershipMismatch);
        };
        if owner != capability {
            return Err(MailboxError::SlotOwnershipMismatch);
        }
        self.validate_live_capability(capability)?;
        self.subtract_tx_bytes(capability, remaining)?;
        self.tx_slots[index] = TxSlot::GuestOwned;
        self.maybe_finalize_capability(capability.index);
        self.check_invariants()?;
        Ok(())
    }

    /// Reserves a host-owned RX slot before reading from the host socket.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid ownership, capability, capacity, or credit.
    pub fn reserve_rx(
        &mut self,
        capability: Capability,
        slot: u16,
        capacity: u32,
    ) -> Result<RxWork, MailboxError> {
        self.require_running()?;
        if capacity == 0 || capacity > self.limits.slot_size {
            return Err(MailboxError::InvalidLength);
        }
        let index = usize::from(slot);
        let rx_slot = self
            .rx_slots
            .get(index)
            .ok_or(MailboxError::SlotOutOfRange)?;
        if *rx_slot != RxSlot::HostFree {
            return Err(MailboxError::SlotBusy);
        }
        let (tx_bytes, rx_bytes) = self.open_counts(capability)?;
        let new_rx = rx_bytes
            .checked_add(capacity)
            .ok_or(MailboxError::ArithmeticOverflow)?;
        if new_rx > self.limits.max_stream_rx_bytes {
            return Err(MailboxError::CreditExceeded);
        }
        self.capabilities[capability.index as usize] = CapabilitySlot::Open {
            generation: capability.generation,
            tx_bytes,
            rx_bytes: new_rx,
        };
        self.rx_slots[index] = RxSlot::HostReceiving {
            capability,
            capacity,
        };
        self.check_invariants()?;
        Ok(RxWork {
            capability,
            slot,
            capacity,
        })
    }

    /// Completes an RX reservation.  Close/reset races drop bytes rather than
    /// publishing a descriptor into a stopped guest.
    ///
    /// # Errors
    ///
    /// Returns an error unless the completion fits the matching reservation.
    pub fn complete_rx(
        &mut self,
        capability: Capability,
        slot: u16,
        bytes: u32,
    ) -> Result<RxCompletion, MailboxError> {
        let index = usize::from(slot);
        let state = *self
            .rx_slots
            .get(index)
            .ok_or(MailboxError::SlotOutOfRange)?;
        let RxSlot::HostReceiving {
            capability: owner,
            capacity,
        } = state
        else {
            return Err(MailboxError::SlotOwnershipMismatch);
        };
        if owner != capability {
            return Err(MailboxError::SlotOwnershipMismatch);
        }
        self.validate_live_capability(capability)?;
        if bytes > capacity {
            return Err(MailboxError::InvalidProgress);
        }
        self.subtract_rx_bytes(capability, capacity)?;
        let should_publish = bytes > 0
            && self.phase == MailboxPhase::Running
            && matches!(
                self.capabilities[capability.index as usize],
                CapabilitySlot::Open { .. }
            );
        let result = if should_publish {
            self.add_rx_bytes(capability, bytes)?;
            self.rx_slots[index] = RxSlot::GuestReading {
                capability,
                length: bytes,
            };
            RxCompletion::Published { length: bytes }
        } else {
            self.rx_slots[index] = RxSlot::HostFree;
            self.maybe_finalize_capability(capability.index);
            RxCompletion::Dropped
        };
        self.check_invariants()?;
        Ok(result)
    }

    /// Cancels a receive reservation without publishing it.
    ///
    /// # Errors
    ///
    /// Returns an error unless `slot` is reserved by this live capability.
    pub fn cancel_rx(&mut self, capability: Capability, slot: u16) -> Result<(), MailboxError> {
        let index = usize::from(slot);
        let state = *self
            .rx_slots
            .get(index)
            .ok_or(MailboxError::SlotOutOfRange)?;
        let RxSlot::HostReceiving {
            capability: owner,
            capacity,
        } = state
        else {
            return Err(MailboxError::SlotOwnershipMismatch);
        };
        if owner != capability {
            return Err(MailboxError::SlotOwnershipMismatch);
        }
        self.validate_live_capability(capability)?;
        self.subtract_rx_bytes(capability, capacity)?;
        self.rx_slots[index] = RxSlot::HostFree;
        self.maybe_finalize_capability(capability.index);
        self.check_invariants()?;
        Ok(())
    }

    /// Returns a guest-owned RX slot to the host pool.
    ///
    /// # Errors
    ///
    /// Returns an error unless the running guest owns the matching slot.
    pub fn release_rx(&mut self, capability: Capability, slot: u16) -> Result<(), MailboxError> {
        self.require_running()?;
        let index = usize::from(slot);
        let state = *self
            .rx_slots
            .get(index)
            .ok_or(MailboxError::SlotOutOfRange)?;
        let RxSlot::GuestReading {
            capability: owner,
            length,
        } = state
        else {
            return Err(MailboxError::SlotOwnershipMismatch);
        };
        if owner != capability {
            return Err(MailboxError::SlotOwnershipMismatch);
        }
        self.validate_live_capability(capability)?;
        self.subtract_rx_bytes(capability, length)?;
        self.rx_slots[index] = RxSlot::HostFree;
        self.maybe_finalize_capability(capability.index);
        self.check_invariants()?;
        Ok(())
    }

    /// Stops guest work, closes capabilities, and invalidates guest-owned RX.
    /// Host-owned TX/RX remains explicit until cancellation/completion arrives.
    ///
    /// # Errors
    ///
    /// Returns [`MailboxError::WrongPhase`] unless normal operation is running.
    pub fn begin_reset(&mut self) -> Result<(), MailboxError> {
        self.require_running()?;
        self.phase = MailboxPhase::Resetting;
        for capability in &mut self.capabilities {
            if let CapabilitySlot::Open {
                generation,
                tx_bytes,
                rx_bytes,
            } = *capability
            {
                *capability = CapabilitySlot::Closing {
                    generation,
                    tx_bytes,
                    rx_bytes,
                };
            }
        }
        for index in 0..RX {
            if let RxSlot::GuestReading { capability, length } = self.rx_slots[index] {
                self.subtract_rx_bytes(capability, length)?;
                self.rx_slots[index] = RxSlot::HostFree;
            }
        }
        for index in 0..CAPS {
            let index = u32::try_from(index).map_err(|_| MailboxError::InvariantViolation)?;
            self.maybe_finalize_capability(index);
        }
        self.check_invariants()?;
        Ok(())
    }

    /// Completes reset only after no adapter operation can retain a slot pointer.
    ///
    /// A successful reset advances the host-owned session. Guest descriptors
    /// are decoded against that value, so commands copied from the old ring
    /// lifetime become stale even when their table index still exists.
    ///
    /// # Errors
    ///
    /// Returns an error unless reset is active and every resource is quiescent.
    pub fn finish_reset(&mut self) -> Result<u64, MailboxError> {
        if self.phase != MailboxPhase::Resetting {
            return Err(MailboxError::WrongPhase);
        }
        if self.tx_slots.iter().any(|slot| *slot != TxSlot::GuestOwned)
            || self.rx_slots.iter().any(|slot| *slot != RxSlot::HostFree)
            || self
                .capabilities
                .iter()
                .any(|slot| !matches!(slot, CapabilitySlot::Free { .. } | CapabilitySlot::Retired))
        {
            return Err(MailboxError::NotQuiescent);
        }
        let session = self
            .session
            .checked_add(1)
            .ok_or(MailboxError::SessionExhausted)?;
        self.session = session;
        self.phase = MailboxPhase::Running;
        self.check_invariants()?;
        Ok(self.session)
    }

    /// Checks the invariants that proof harnesses and fuzzers assert after every step.
    ///
    /// # Errors
    ///
    /// Returns [`MailboxError::InvariantViolation`] when any ownership, credit,
    /// epoch, or phase relation is inconsistent.
    pub fn check_invariants(&self) -> Result<(), MailboxError> {
        if self.session == 0
            || self.limits.slot_size == 0
            || self.limits.max_stream_tx_bytes == 0
            || self.limits.max_stream_rx_bytes == 0
        {
            return Err(MailboxError::InvariantViolation);
        }
        let mut tx_totals = [0_u64; CAPS];
        let mut rx_totals = [0_u64; CAPS];
        for slot in self.tx_slots {
            if let TxSlot::HostSending {
                capability,
                offset,
                remaining,
            } = slot
            {
                if remaining == 0
                    || offset
                        .checked_add(remaining)
                        .is_none_or(|end| end > self.limits.slot_size)
                {
                    return Err(MailboxError::InvariantViolation);
                }
                let index = self.invariant_capability_index(capability)?;
                tx_totals[index] = tx_totals[index]
                    .checked_add(u64::from(remaining))
                    .ok_or(MailboxError::InvariantViolation)?;
            }
        }
        for slot in self.rx_slots {
            let (capability, bytes) = match slot {
                RxSlot::HostFree => continue,
                RxSlot::HostReceiving {
                    capability,
                    capacity,
                } => (capability, capacity),
                RxSlot::GuestReading { capability, length } => {
                    if self.phase == MailboxPhase::Resetting {
                        return Err(MailboxError::InvariantViolation);
                    }
                    (capability, length)
                }
            };
            if bytes == 0 || bytes > self.limits.slot_size {
                return Err(MailboxError::InvariantViolation);
            }
            let index = self.invariant_capability_index(capability)?;
            rx_totals[index] = rx_totals[index]
                .checked_add(u64::from(bytes))
                .ok_or(MailboxError::InvariantViolation)?;
        }
        for (index, capability) in self.capabilities.iter().copied().enumerate() {
            match capability {
                CapabilitySlot::Free { generation } => {
                    if generation == 0 || tx_totals[index] != 0 || rx_totals[index] != 0 {
                        return Err(MailboxError::InvariantViolation);
                    }
                }
                CapabilitySlot::Open {
                    generation,
                    tx_bytes,
                    rx_bytes,
                }
                | CapabilitySlot::Closing {
                    generation,
                    tx_bytes,
                    rx_bytes,
                } => {
                    if generation == 0
                        || tx_totals[index] != u64::from(tx_bytes)
                        || rx_totals[index] != u64::from(rx_bytes)
                        || tx_bytes > self.limits.max_stream_tx_bytes
                        || rx_bytes > self.limits.max_stream_rx_bytes
                    {
                        return Err(MailboxError::InvariantViolation);
                    }
                    if self.phase == MailboxPhase::Resetting
                        && matches!(capability, CapabilitySlot::Open { .. })
                    {
                        return Err(MailboxError::InvariantViolation);
                    }
                }
                CapabilitySlot::Retired => {
                    if tx_totals[index] != 0 || rx_totals[index] != 0 {
                        return Err(MailboxError::InvariantViolation);
                    }
                }
            }
        }
        Ok(())
    }

    fn require_running(&self) -> Result<(), MailboxError> {
        if self.phase == MailboxPhase::Running {
            Ok(())
        } else {
            Err(MailboxError::WrongPhase)
        }
    }

    fn validate_slot_range(&self, offset: u32, length: u32) -> Result<(), MailboxError> {
        if length == 0
            || offset
                .checked_add(length)
                .is_none_or(|end| end > self.limits.slot_size)
        {
            Err(MailboxError::InvalidLength)
        } else {
            Ok(())
        }
    }

    fn open_counts(&self, capability: Capability) -> Result<(u32, u32), MailboxError> {
        self.validate_epoch_and_index(capability)?;
        match self.capabilities[capability.index as usize] {
            CapabilitySlot::Open {
                generation,
                tx_bytes,
                rx_bytes,
            } if generation == capability.generation => Ok((tx_bytes, rx_bytes)),
            CapabilitySlot::Free { generation }
            | CapabilitySlot::Open { generation, .. }
            | CapabilitySlot::Closing { generation, .. }
                if generation != capability.generation =>
            {
                Err(MailboxError::StaleCapability)
            }
            _ => Err(MailboxError::CapabilityUnavailable),
        }
    }

    fn validate_live_capability(&self, capability: Capability) -> Result<(), MailboxError> {
        self.validate_epoch_and_index(capability)?;
        match self.capabilities[capability.index as usize] {
            CapabilitySlot::Open { generation, .. }
            | CapabilitySlot::Closing { generation, .. }
                if generation == capability.generation =>
            {
                Ok(())
            }
            CapabilitySlot::Free { generation }
            | CapabilitySlot::Open { generation, .. }
            | CapabilitySlot::Closing { generation, .. }
                if generation != capability.generation =>
            {
                Err(MailboxError::StaleCapability)
            }
            _ => Err(MailboxError::CapabilityUnavailable),
        }
    }

    fn validate_epoch_and_index(&self, capability: Capability) -> Result<(), MailboxError> {
        if capability.index as usize >= CAPS {
            return Err(MailboxError::CapabilityOutOfRange);
        }
        if capability.session != self.session || capability.generation == 0 {
            return Err(MailboxError::StaleCapability);
        }
        Ok(())
    }

    fn invariant_capability_index(&self, capability: Capability) -> Result<usize, MailboxError> {
        self.validate_epoch_and_index(capability)
            .map_err(|_| MailboxError::InvariantViolation)?;
        let index = capability.index as usize;
        if self.capabilities[index].generation() != Some(capability.generation)
            || matches!(self.capabilities[index], CapabilitySlot::Free { .. })
        {
            return Err(MailboxError::InvariantViolation);
        }
        Ok(index)
    }

    fn subtract_tx_bytes(
        &mut self,
        capability: Capability,
        bytes: u32,
    ) -> Result<(), MailboxError> {
        let slot = &mut self.capabilities[capability.index as usize];
        match slot {
            CapabilitySlot::Open { tx_bytes, .. } | CapabilitySlot::Closing { tx_bytes, .. } => {
                *tx_bytes = tx_bytes
                    .checked_sub(bytes)
                    .ok_or(MailboxError::InvariantViolation)?;
                Ok(())
            }
            CapabilitySlot::Free { .. } | CapabilitySlot::Retired => {
                Err(MailboxError::CapabilityUnavailable)
            }
        }
    }

    fn subtract_rx_bytes(
        &mut self,
        capability: Capability,
        bytes: u32,
    ) -> Result<(), MailboxError> {
        let slot = &mut self.capabilities[capability.index as usize];
        match slot {
            CapabilitySlot::Open { rx_bytes, .. } | CapabilitySlot::Closing { rx_bytes, .. } => {
                *rx_bytes = rx_bytes
                    .checked_sub(bytes)
                    .ok_or(MailboxError::InvariantViolation)?;
                Ok(())
            }
            CapabilitySlot::Free { .. } | CapabilitySlot::Retired => {
                Err(MailboxError::CapabilityUnavailable)
            }
        }
    }

    fn add_rx_bytes(&mut self, capability: Capability, bytes: u32) -> Result<(), MailboxError> {
        let slot = &mut self.capabilities[capability.index as usize];
        match slot {
            CapabilitySlot::Open { rx_bytes, .. } => {
                *rx_bytes = rx_bytes
                    .checked_add(bytes)
                    .ok_or(MailboxError::ArithmeticOverflow)?;
                if *rx_bytes > self.limits.max_stream_rx_bytes {
                    return Err(MailboxError::CreditExceeded);
                }
                Ok(())
            }
            _ => Err(MailboxError::CapabilityUnavailable),
        }
    }

    fn maybe_finalize_capability(&mut self, index: u32) -> bool {
        let slot = self.capabilities[index as usize];
        if let CapabilitySlot::Closing {
            generation,
            tx_bytes: 0,
            rx_bytes: 0,
        } = slot
        {
            self.capabilities[index as usize] = generation
                .checked_add(1)
                .map_or(CapabilitySlot::Retired, |generation| CapabilitySlot::Free {
                    generation,
                });
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CapabilitySlot, Limits, MailboxError, MailboxState};

    #[test]
    fn exhausted_capability_generation_retires_instead_of_wrapping() {
        let mut mailbox = MailboxState::<1, 1, 1>::new(Limits {
            slot_size: 1,
            max_stream_tx_bytes: 1,
            max_stream_rx_bytes: 1,
        })
        .unwrap();
        mailbox.capabilities[0] = CapabilitySlot::Free {
            generation: u64::MAX,
        };
        let capability = mailbox.open_capability(0).unwrap();
        mailbox.close_capability(capability).unwrap();
        assert_eq!(mailbox.capabilities[0], CapabilitySlot::Retired);
        assert_eq!(
            mailbox.open_capability(0),
            Err(MailboxError::CapabilityUnavailable)
        );
        mailbox.check_invariants().unwrap();
    }
}
